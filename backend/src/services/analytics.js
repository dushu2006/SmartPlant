'use strict';

/**
 * Deterministic analytics (PRD §35, §39): health score, risk indicators,
 * energy consumption and cost. These are explicit formulas computed by the
 * backend — never by the LLM.
 */
const config = require('../config');
const telemetryStore = require('../store/telemetry');
const alertsStore = require('../store/alerts');
const opsStore = require('../store/ops');
const { rankOf } = require('@smartplant/shared');

const BUCKET_MS = 5 * 60000;

// ------------------------------------------------------------- energy/cost
/**
 * Energy (kWh) from power readings via trapezoidal integration.
 */
function energyKwh(machineId, fromIso, toIso) {
  const rows = telemetryStore.readingsBetween(machineId, 'power_kw', fromIso, toIso);
  if (rows.length < 2) return rows.length === 1 ? (rows[0].value * 5) / 60 : 0;
  let energy = 0;
  for (let i = 1; i < rows.length; i++) {
    const dtH = (new Date(rows[i].ts) - new Date(rows[i - 1].ts)) / 3600000;
    if (dtH <= 0 || dtH > 2) continue; // skip gaps > 2h
    energy += ((rows[i - 1].value + rows[i].value) / 2) * dtH;
  }
  return energy;
}

function startOfTodayUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function energyTodayKwh(machineId) {
  return energyKwh(machineId, startOfTodayUtc(), new Date().toISOString());
}

function costTodayUsd(machineId) {
  return energyTodayKwh(machineId) * config.tariffUsdPerKwh;
}

function monthlyEstimateUsd(machineId) {
  // Average daily energy over available history (up to 7 days) × 30 × tariff.
  const now = Date.now();
  const to = new Date(now).toISOString();
  const from = new Date(now - 7 * 86400000).toISOString();
  const energy7 = energyKwh(machineId, from, to);
  const range = telemetryStore.machineTimeRange(machineId);
  let days = 7;
  if (range && range.min_ts && range.max_ts) {
    const covered = Math.min(7, Math.max(0.25, (new Date(range.max_ts) - new Date(range.min_ts)) / 86400000));
    days = covered;
  }
  return (energy7 / days) * 30 * config.tariffUsdPerKwh;
}

function fleetEnergyTodayKwh() {
  const machines = require('../store/machines').allMachines();
  return machines.reduce((acc, m) => acc + energyTodayKwh(m.id), 0);
}

// ------------------------------------------------------------- operating
function operatingHoursToday(machineId) {
  const from = startOfTodayUtc();
  const rows = telemetryStore.readingsBetween(machineId, 'power_kw', from, new Date().toISOString());
  return (rows.filter((r) => r.value > 0.5).length * BUCKET_MS) / 3600000;
}

function currentLoadPct(machineId) {
  const latest = telemetryStore.latestForMachine(machineId);
  return latest.load_pct ? latest.load_pct.value : null;
}

// ------------------------------------------------------------- health/risk
/**
 * Health score 0–100. Deterministic weighted formula:
 *   start 100
 *   − active alerts (severity-weighted, capped 30)
 *   − telemetry deviation from baseline (capped 20)
 *   − data staleness / offline (capped 15)
 *   − maintenance overdue (capped 15)
 *   − load/power stress (capped 10)
 *   + recent successful maintenance bonus (max 5)
 */
function healthScore(machine) {
  let score = 100;

  // 1. active alerts
  const active = alertsStore.listActive({ machineId: machine.id, pageSize: 50 }).data;
  let alertPenalty = 0;
  for (const a of active) {
    alertPenalty += { CRITICAL: 10, HIGH: 7, MEDIUM: 4, LOW: 2 }[a.severity] || 2;
  }
  score -= Math.min(30, alertPenalty);

  // 2. telemetry deviation from rolling baseline (z-score of latest)
  const latest = telemetryStore.latestForMachine(machine.id);
  let devPenalty = 0;
  for (const metric of ['temperature_c', 'power_kw']) {
    const reading = latest[metric];
    if (!reading) continue;
    const win = telemetryStore.rollingWindow(machine.id, metric, 60);
    if (win.length < 10) continue;
    const mean = win.reduce((a, r) => a + r.value, 0) / win.length;
    const variance = win.reduce((a, r) => a + (r.value - mean) ** 2, 0) / win.length;
    const std = Math.sqrt(variance);
    if (std > 0) {
      const z = Math.abs((reading.value - mean) / std);
      devPenalty += Math.min(10, z * 2.5);
    }
  }
  score -= Math.min(20, devPenalty);

  // 3. staleness
  const latestTs = latest.temperature_c?.ts || latest.power_kw?.ts;
  if (latestTs) {
    const ageMin = (Date.now() - new Date(latestTs).getTime()) / 60000;
    score -= Math.min(15, ageMin * 0.5);
  } else {
    score -= 15;
  }

  // 4. overdue/urgent open tasks
  const tasks = opsStore.listTasks({ machineId: machine.id, pageSize: 50 }).data;
  for (const t of tasks) {
    if (t.status === 'COMPLETED' || t.status === 'CANCELLED') continue;
    const overdueMin = (Date.now() - new Date(t.due_at).getTime()) / 60000;
    if (overdueMin > 0) {
      score -= Math.min(10, (overdueMin / 1440) * 5);
    }
    if (t.priority === 'CRITICAL') score -= 3;
  }

  // 5. load stress
  const load = latest.load_pct?.value;
  if (load !== undefined && load > 90) score -= Math.min(10, (load - 90) * 1.5);

  // 6. recent successful maintenance bonus
  const lastEvt = opsStore.lastMaintenanceForMachine(machine.id);
  if (lastEvt && lastEvt.outcome === 'SUCCESS') {
    const daysAgo = (Date.now() - new Date(lastEvt.completed_at || lastEvt.created_at).getTime()) / 86400000;
    if (daysAgo < 7) score += Math.max(0, 5 - daysAgo);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Risk output per PRD §38 but explicitly labelled as risk INDICATORS
 * (not validated failure probabilities — PRD §39).
 */
function riskAssessment(machine) {
  const health = healthScore(machine);
  const active = alertsStore.listActive({ machineId: machine.id, pageSize: 50 }).data;
  const latest = telemetryStore.latestForMachine(machine.id);

  const signals = [];
  for (const a of active) {
    signals.push(`${a.type.replace(/_/g, ' ')} (${a.severity})`);
  }
  const temp = latest.temperature_c;
  if (temp) {
    const win = telemetryStore.rollingWindow(machine.id, 'temperature_c', 60);
    if (win.length >= 12) {
      const first = win[win.length - 12].value;
      const slopePerH = ((temp.value - first) / 12) * 12; // per hour over 12 buckets
      if (slopePerH > 2) signals.push(`temperature rising ${slopePerH.toFixed(1)}°C/h`);
    }
  }

  const riskScore = (100 - health) / 100;
  const riskLevel = riskScore >= 0.7 ? 'HIGH' : riskScore >= 0.4 ? 'MEDIUM' : riskScore >= 0.2 ? 'LOW' : 'LOW';
  return {
    machine_id: machine.id,
    machine: machine.name,
    risk_level: riskScore >= 0.7 ? 'HIGH' : riskScore >= 0.4 ? 'MEDIUM' : 'LOW',
    risk_score: Math.round(riskScore * 100) / 100,
    health_score: health,
    confidence: Math.min(0.9, 0.5 + active.length * 0.1),
    top_signals: signals.slice(0, 5),
    model_version: 'deterministic-health-v1',
    // Honest label per PRD §39 — not a validated failure probability.
    caveat: 'Risk indicators from deterministic formulas; not a validated failure probability.',
  };
}

/** Machine overview payload for the machine detail page (PRD §8). */
function machineOverview(machine) {
  const latest = telemetryStore.latestForMachine(machine.id);
  const health = healthScore(machine);
  const risk = riskAssessment(machine);
  const lastMaint = opsStore.lastMaintenanceForMachine(machine.id);
  const activeAlerts = alertsStore.listActive({ machineId: machine.id, pageSize: 50 }).data;
  const dataFreshness = latest.temperature_c || latest.power_kw
    ? Math.max(0, Math.round((Date.now() - new Date((latest.temperature_c || latest.power_kw).ts).getTime()) / 1000))
    : null;

  return {
    machine: {
      id: machine.id,
      name: machine.name,
      type: machine.type,
      status: machine.status,
      image: machine.image,
      plant_id: machine.plant_id,
      external_device_id: machine.external_device_id,
      thresholds: machine.thresholds,
    },
    current: {
      temperature_c: latest.temperature_c ? { value: latest.temperature_c.value, unit: 'C', ts: latest.temperature_c.ts, quality: latest.temperature_c.quality, source: latest.temperature_c.source } : null,
      power_kw: latest.power_kw ? { value: latest.power_kw.value, unit: 'kW', ts: latest.power_kw.ts, quality: latest.power_kw.quality, source: latest.power_kw.source } : null,
      load_pct: latest.load_pct ? { value: latest.load_pct.value, unit: '%', ts: latest.load_pct.ts } : null,
      data_freshness_seconds: dataFreshness,
    },
    operating_hours_today: operatingHoursToday(machine.id),
    energy_today_kwh: Math.round(energyTodayKwh(machine.id) * 100) / 100,
    cost_today_usd: Math.round(costTodayUsd(machine.id) * 100) / 100,
    monthly_estimate_usd: Math.round(monthlyEstimateUsd(machine.id) * 100) / 100,
    health_score: health,
    risk: risk,
    active_alerts: activeAlerts.map((a) => ({ id: a.id, type: a.type, severity: a.severity, status: a.status, message: a.message, created_at: a.created_at })),
    last_maintenance: lastMaint
      ? { id: lastMaint.id, type: lastMaint.type, outcome: lastMaint.outcome, completed_at: lastMaint.completed_at, notes: lastMaint.notes }
      : null,
  };
}

/**
 * Machine forecast (grounded in schedule + telemetry + history):
 *  - estimated shutdown ("when will it turn off")
 *  - failure outlook over coming weeks ("will it go wrong after some weeks")
 * Both are honest estimates based on deterministic indicators, never
 * validated failure probabilities (PRD §39).
 */
function machineForecast(machine) {
  const now = new Date();
  const latest = telemetryStore.latestForMachine(machine.id);
  const active = alertsStore.listActive({ machineId: machine.id, pageSize: 50 }).data;
  const schedule = machine.schedule || {};

  // ---------------- shutdown estimate -----------------------------------
  let estimatedOffAt = null;
  let offBasis = null;
  let offConfidence = 'low';

  if (machine.status === 'RUNNING') {
    // 1) explicit shift window (e.g. { startTime: '08:00', sleepTime: '17:00' })
    if (schedule.sleepTime) {
      const [h, m] = String(schedule.sleepTime).split(':').map((n) => parseInt(n, 10));
      if (Number.isFinite(h)) {
        const off = new Date(now);
        off.setUTCHours(h, Number.isFinite(m) ? m : 0, 0, 0);
        if (off <= now) off.setUTCDate(off.getUTCDate() + 1);
        estimatedOffAt = off.toISOString();
        offBasis = `shift schedule (end ${schedule.sleepTime} UTC)`;
        offConfidence = 'high';
      }
    }
    // 2) fallback: typical daily runtime from the last 72h of power data
    if (!estimatedOffAt) {
      const from = new Date(Date.now() - 72 * 3600000).toISOString();
      const rows = telemetryStore.readingsBetween(machine.id, 'power_kw', from, new Date().toISOString());
      const running = rows.filter((r) => r.value > 0.5);
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const todayRows = telemetryStore.readingsBetween(machine.id, 'power_kw', dayStart.toISOString(), new Date().toISOString());
      const todayRunH = (todayRows.filter((r) => r.value > 0.5).length * 5) / 60;
      if (running.length >= 12) {
        const daysCovered = Math.max(0.25, (new Date() - new Date(rows[0].ts)) / 86400000);
        const typicalRunH = (running.length * 5) / 60 / daysCovered;
        const remainingH = Math.max(0, typicalRunH - todayRunH);
        if (remainingH > 0.05) {
          estimatedOffAt = new Date(Date.now() + remainingH * 3600000).toISOString();
          offBasis = `typical runtime pattern (${typicalRunH.toFixed(1)}h/day from 72h of power readings; ${todayRunH.toFixed(1)}h today)`;
          offConfidence = running.length >= 100 ? 'medium' : 'low';
        } else {
          estimatedOffAt = new Date().toISOString();
          offBasis = 'today runtime already matches the typical daily pattern';
          offConfidence = 'medium';
        }
      }
    }
    if (!estimatedOffAt) {
      estimatedOffAt = null;
      offBasis = 'insufficient telemetry history to estimate';
    }
  } else {
    offBasis = `machine is currently ${machine.status} — not running`;
  }

  // ---------------- failure outlook --------------------------------------
  const health = healthScore(machine);
  let alertPenalty = 0;
  for (const a of active) alertPenalty += { CRITICAL: 25, HIGH: 16, MEDIUM: 9, LOW: 4 }[a.severity] || 4;
  const events = opsStore.listMaintenanceEvents({ machineId: machine.id, limit: 50 });
  const last30d = events.filter((e) => e.completed_at && (Date.now() - new Date(e.completed_at).getTime()) / 86400000 <= 30);
  const failures30d = last30d.filter((e) => ['FAILED', 'PARTIAL'].includes(e.outcome) || ['REPAIR', 'REPLACEMENT', 'CORRECTIVE'].includes(e.type)).length;

  // temperature trend (per hour, last 60 min)
  const temp = latest.temperature_c;
  let trendPerHour = 0;
  if (temp) {
    const win = telemetryStore.rollingWindow(machine.id, 'temperature_c', 60);
    if (win.length >= 12) {
      const first = win[win.length - 12].value;
      trendPerHour = ((temp.value - first) / 12) * 12;
    }
  }
  const trendPenalty = Math.max(0, trendPerHour) > 2 ? Math.min(20, Math.max(0, trendPerHour) * 4) : 0;

  const deterioration = Math.max(0, Math.min(100,
    (100 - health) * 0.55 + alertPenalty * 0.8 + failures30d * 12 + trendPenalty,
  ));

  let band; // [weeksLow, weeksHigh | null for >]
  if (deterioration >= 70) band = [0, 2];
  else if (deterioration >= 50) band = [2, 4];
  else if (deterioration >= 30) band = [4, 8];
  else band = [8, 26];
  const criticalNow = active.some((a) => a.severity === 'CRITICAL') || machine.status === 'FAULT';
  if (criticalNow && band[0] > 0) band = [0, 2];

  const outlookConfidence = telemetryStore.machineTimeRange(machine.id)?.min_ts ? 'medium' : 'low';

  return {
    machine_id: machine.id,
    machine: machine.name,
    status: machine.status,
    health_score: health,
    estimated_off_at: estimatedOffAt,
    estimated_off_basis: offBasis,
    estimated_off_confidence: offConfidence,
    deterioration_index: Math.round(deterioration * 10) / 10,
    failure_outlook_weeks: band[1] >= 26 ? `more than ${band[0]} weeks` : `${band[0]}–${band[1]} weeks`,
    failure_outlook_horizon_at: band[1] >= 26 ? null : new Date(Date.now() + band[1] * 7 * 86400000).toISOString(),
    outlook_confidence: outlookConfidence,
    signals: {
      active_alerts: active.length,
      alert_severity_max: active.reduce((mx, a) => (({ INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[a.severity] || 0) > ({ INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[mx] || 0) ? a.severity : mx), 'INFO'),
      failures_last_30d: failures30d,
      temperature_trend_per_hour: Math.round(trendPerHour * 10) / 10,
    },
    caveat: 'Heuristic estimate from schedule, telemetry, health score, alert and maintenance history — not a validated failure probability.',
  };
}

module.exports = {
  energyKwh,
  energyTodayKwh,
  costTodayUsd,
  monthlyEstimateUsd,
  fleetEnergyTodayKwh,
  operatingHoursToday,
  currentLoadPct,
  healthScore,
  riskAssessment,
  machineOverview,
  machineForecast,
};
