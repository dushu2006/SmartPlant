'use strict';

/**
 * Backend alert engine (PRD §52–53):
 *   Telemetry → Rule engine (static thresholds) → Baseline analysis →
 *   Anomaly detection → Alert decision → Alert DB → Notifications.
 *
 * Alert lifecycle: DETECTED → ACTIVE → ACKNOWLEDGED → RESOLVED (or DISMISSED).
 * Every transition is audited. Alerts are deduplicated per machine+type:
 * while one is open, new evidence only refreshes it.
 */
const crypto = require('crypto');
const config = require('../config');
const { rankOf } = require('@smartplant/shared');
const alertsStore = require('../store/alerts');
const telemetryStore = require('../store/telemetry');
const machinesStore = require('../store/machines');
const { audit } = require('./audit');
const { notify } = require('./notifications');
const logger = require('../logger');

const WINDOW_N = 60; // rolling window for baseline (5h at 5-min cadence)
const Z_THRESHOLD = 3.0; // z-score anomaly threshold
const TREND_RATE_TEMP_C_PER_H = 5.0; // sustained temp rise rate → trend alert
const TREND_RATE_POWER_KW_PER_H = 3.0;
const TREND_WINDOW_N = 12; // last 60 min for slope

function severityForExceedance(exceedRatio) {
  if (exceedRatio >= 2.0) return 'CRITICAL';
  if (exceedRatio >= 1.5) return 'HIGH';
  if (exceedRatio >= 1.2) return 'MEDIUM';
  return 'LOW';
}

/** Linear slope (value/hour) over the last n readings via least squares. */
function slopeOf(rows) {
  const n = rows.length;
  if (n < 3) return 0;
  const xs = rows.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = rows.reduce((a, r) => a + r.value, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (rows[i].value - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return 0;
  const perBucket = num / den;
  const bucketH = 5 / 60; // 5-minute buckets → hours
  return perBucket / bucketH;
}

function createAlertEngine() {
  const cache = new Map(); // machine_id -> { metric -> readings[] }

  function windowRows(machineId, metric, value, ts) {
    let entry = cache.get(machineId);
    if (!entry) {
      entry = {};
      cache.set(machineId, entry);
    }
    let rows = entry[metric];
    if (!rows) {
      rows = telemetryStore.rollingWindow(machineId, metric, WINDOW_N);
      entry[metric] = rows;
    }
    rows.push({ ts, value });
    if (rows.length > WINDOW_N + TREND_WINDOW_N) rows.splice(0, rows.length - (WINDOW_N + TREND_WINDOW_N));
    return rows;
  }

  function baselineStats(rows) {
    const n = rows.length;
    if (n < 10) return null;
    const mean = rows.reduce((a, r) => a + r.value, 0) / n;
    const variance = rows.reduce((a, r) => a + (r.value - mean) ** 2, 0) / n;
    return { mean, std: Math.sqrt(variance), n };
  }

  /**
   * Evaluate one reading against thresholds + baseline + trend.
   * Returns alerts to create/refresh. `silent` suppresses notifications
   * (used during seed replay).
   */
  function processReading(machineId, reading, opts = {}) {
    const silent = !!opts.silent;
    const machine = machinesStore.findById(machineId);
    if (!machine) return [];

    const created = [];
    const metric = reading.metric;
    const thresholds = machine.thresholds || {};
    const rows = windowRows(machineId, metric, reading.value, reading.ts);

    // ----- 1. quality rules (sensor failure)
    if (reading.quality === 'bad' || reading.quality === 'missing') {
      const alert = ensureAlert({
        machine,
        type: 'SENSOR_FAILURE',
        severity: 'MEDIUM',
        message: `${machine.name} is reporting ${reading.quality} readings on ${metric}.`,
        evidence: { metric, quality: reading.quality, ts: reading.ts },
        silent,
      });
      if (alert) created.push(alert);
      return created;
    }

    // ----- 2. static threshold rules
    const thresholdCfg = thresholds[metric];
    if (thresholdCfg) {
      const max = thresholdCfg.max !== null && thresholdCfg.max !== undefined ? thresholdCfg.max : metric === 'temperature_c' ? config.alertTempMaxC : metric === 'power_kw' ? config.alertPowerMaxKw : null;
      const min = thresholdCfg.min ?? null;
      if (max !== null && reading.value > max) {
        const type = metric === 'temperature_c' ? 'TEMPERATURE_HIGH' : metric === 'power_kw' ? 'POWER_HIGH' : null;
        if (type) {
          const exceedRatio = (reading.value - max) / Math.max(max, 0.001) / 0.05; // 5% steps
          const alert = ensureAlert({
            machine,
            type,
            severity: severityForExceedance(exceedRatio),
            message: `${machine.name} ${metricLabel(metric)} ${reading.value}${reading.unit} exceeds threshold ${max}${reading.unit}.`,
            evidence: { metric, value: reading.value, unit: reading.unit, threshold: max, ts: reading.ts },
            silent,
            resolveWhenBelow: { threshold: max, hysteresis: 2 },
          });
          if (alert) created.push(alert);
          return created;
        }
      }
      if (min !== null && reading.value < min) {
        const alert = ensureAlert({
          machine,
          type: 'ANOMALY_TREND',
          severity: 'LOW',
          message: `${machine.name} ${metricLabel(metric)} ${reading.value}${reading.unit} below minimum threshold ${min}${reading.unit}.`,
          evidence: { metric, value: reading.value, threshold: min, ts: reading.ts },
          silent,
        });
        if (alert) created.push(alert);
        return created;
      }
    }

    // ----- 3. baseline / anomaly detection (only for temp & power)
    if (metric === 'temperature_c' || metric === 'power_kw') {
      const stats = baselineStats(rows);
      if (stats && stats.std > 0) {
        const z = (reading.value - stats.mean) / stats.std;
        if (z > Z_THRESHOLD) {
          const type = metric === 'temperature_c' ? 'ANOMALY_TEMPERATURE' : 'ANOMALY_POWER';
          const alert = ensureAlert({
            machine,
            type,
            severity: z > 5 ? 'HIGH' : z > 4 ? 'MEDIUM' : 'LOW',
            message: `${machine.name} ${metricLabel(metric)} deviates from its recent baseline (z=${z.toFixed(1)}, mean ${stats.mean.toFixed(1)}${reading.unit}).`,
            evidence: { metric, value: reading.value, baselineMean: stats.mean, baselineStd: stats.std, zScore: z, window: stats.n, ts: reading.ts },
            silent,
            resolveWhenNormal: true,
          });
          if (alert) created.push(alert);
        } else {
          maybeResolveAnomaly(machine, typeOf(metric), z);
        }
      }

      // ----- 4. trend detection (sustained rate of change)
      const trendRows = rows.slice(-TREND_WINDOW_N);
      if (trendRows.length >= TREND_WINDOW_N) {
        const slope = slopeOf(trendRows);
        const limit = metric === 'temperature_c' ? TREND_RATE_TEMP_C_PER_H : TREND_RATE_POWER_KW_PER_H;
        if (slope > limit) {
          const alert = ensureAlert({
            machine,
            type: 'ANOMALY_TREND',
            severity: slope > limit * 2 ? 'HIGH' : 'MEDIUM',
            message: `${machine.name} ${metricLabel(metric)} is rising ${slope.toFixed(1)}${reading.unit}/h over the last hour.`,
            evidence: { metric, ratePerHour: slope, window: TREND_WINDOW_N, current: reading.value, ts: reading.ts },
            silent,
            resolveWhenNormal: true,
          });
          if (alert) created.push(alert);
        } else {
          maybeResolveTrend(machine, trendRows, slope);
        }
      }
    }

    // ----- 5. auto-resolve threshold alerts when back to normal
    autoResolveThreshold(machine, metric, reading);
    return created;
  }

  function typeOf(metric) {
    return metric === 'temperature_c' ? 'ANOMALY_TEMPERATURE' : 'ANOMALY_POWER';
  }

  function metricLabel(metric) {
    return metric === 'temperature_c' ? 'temperature' : metric === 'power_kw' ? 'power' : metric;
  }

  /** Create alert or refresh evidence of an open one. */
  function ensureAlert({ machine, type, severity, message, evidence, silent, resolveWhenBelow, resolveWhenNormal }) {
    const existing = alertsStore.findActiveByType(machine.id, type);
    if (existing) {
      // Escalate severity when higher; refresh evidence with the latest values.
      if (rankOf(severity) > rankOf(existing.severity)) {
        alertsStore.updateSeverity(existing.id, severity);
      }
      alertsStore.updateEvidence(existing.id, { ...existing.evidence, ...evidence });
      return null;
    }

    const alert = alertsStore.create({
      id: crypto.randomUUID(),
      machine_id: machine.id,
      type,
      severity,
      message,
      evidence,
    });
    // DETECTED → ACTIVE immediately (engine confirmation)
    alertsStore.transition(alert.id, 'ACTIVE');
    audit({
      actorId: 'system',
      action: 'ALERT.CREATE',
      entityType: 'alert',
      entityId: alert.id,
      after: { machine_id: machine.id, type, severity, message },
    });
    if (!silent) {
      notify({
        type: severity === 'CRITICAL' ? 'CRITICAL_ALERT' : type === 'TEMPERATURE_HIGH' ? 'HIGH_TEMPERATURE' : type === 'POWER_HIGH' ? 'HIGH_POWER' : type === 'MACHINE_OFFLINE' ? 'MACHINE_OFFLINE' : 'SYSTEM',
        title: `${severity}: ${machine.name} — ${alertMessageShort(type)}`,
        body: message,
        entityType: 'alert',
        entityId: alert.id,
        dedupeKey: `alert:${machine.id}:${type}:${dayKey()}`,
      });
    }
    return alertsStore.findById(alert.id);
  }

  function alertMessageShort(type) {
    return type.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
  }

  function dayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  /** Auto-resolve threshold alerts once value returns below threshold − hysteresis. */
  function autoResolveThreshold(machine, metric, reading) {
    const types = metric === 'temperature_c' ? ['TEMPERATURE_HIGH'] : metric === 'power_kw' ? ['POWER_HIGH'] : [];
    for (const type of types) {
      const open = alertsStore.findActiveByType(machine.id, type);
      if (!open) continue;
      const threshold = (machine.thresholds || {})[metric]?.max ?? (metric === 'temperature_c' ? config.alertTempMaxC : config.alertPowerMaxKw);
      if (reading.value <= threshold - 2) {
        const resolved = alertsStore.transition(open.id, 'RESOLVED', 'system');
        audit({
          actorId: 'system',
          action: 'ALERT.RESOLVE',
          entityType: 'alert',
          entityId: open.id,
          before: { status: open.status },
          after: { status: 'RESOLVED', value: reading.value },
        });
        notify({
          type: 'SYSTEM',
          title: `Resolved: ${machine.name}`,
          body: `${metricLabel(metric)} returned to normal (${reading.value}${reading.unit}).`,
          entityType: 'alert',
          entityId: open.id,
          dedupeKey: `alert-resolved:${open.id}`,
        });
      }
    }
  }

  /** Resolve z-score/trend anomaly alerts once reading is back within bounds. */
  function maybeResolveAnomaly(machine, type, z) {
    const open = alertsStore.findActiveByType(machine.id, type);
    if (open && Math.abs(z) < 0.8) {
      const resolved = alertsStore.transition(open.id, 'RESOLVED', 'system');
      audit({
        actorId: 'system',
        action: 'ALERT.RESOLVE',
        entityType: 'alert',
        entityId: open.id,
        before: { status: open.status },
        after: { status: 'RESOLVED', z },
      });
    }
  }

  function maybeResolveTrend(machine, rows, slope) {
    const open = alertsStore.findActiveByType(machine.id, 'ANOMALY_TREND');
    if (!open) return;
    const last = rows[rows.length - 1].value;
    const first = rows[0].value;
    const flat = Math.abs(last - first) < 0.4;
    if (flat && slope <= 0.5) {
      const resolved = alertsStore.transition(open.id, 'RESOLVED', 'system');
      audit({
        actorId: 'system',
        action: 'ALERT.RESOLVE',
        entityType: 'alert',
        entityId: open.id,
        before: { status: open.status },
        after: { status: 'RESOLVED', slope },
      });
    }
  }

  /**
   * Offline detection — RUNNING machines with no telemetry for N minutes.
   * Called by the scheduler every minute.
   */
  function checkOfflineMachines() {
    const machines = machinesStore.listRunning();
    const now = Date.now();
    const staleMs = config.telemetryStaleMin * 60000;
    for (const m of machines) {
      const latest = telemetryStore.latestForMachine(m.id);
      const latestTs = latest.temperature_c?.ts || latest.power_kw?.ts;
      if (!latestTs) continue;
      const ageMin = (now - new Date(latestTs).getTime()) / 60000;
      if (ageMin > config.telemetryStaleMin) {
        const open = alertsStore.findActiveByType(m.id, 'MACHINE_OFFLINE');
        if (!open) {
          const alert = alertsStore.create({
            id: crypto.randomUUID(),
            machine_id: m.id,
            type: 'MACHINE_OFFLINE',
            severity: ageMin > 30 ? 'CRITICAL' : 'HIGH',
            message: `${m.name} stopped reporting telemetry ${Math.round(ageMin)} minutes ago.`,
            evidence: { lastReading: latestTs, ageMinutes: Math.round(ageMin), staleAfterMin: config.telemetryStaleMin },
          });
          alertsStore.transition(alert.id, 'ACTIVE');
          audit({ actorId: 'system', action: 'ALERT.CREATE', entityType: 'alert', entityId: alert.id, after: { machine_id: m.id, type: 'MACHINE_OFFLINE' } });
          notify({
            type: 'MACHINE_OFFLINE',
            title: `Machine offline: ${m.name}`,
            body: alert.message,
            entityType: 'alert',
            entityId: alert.id,
            dedupeKey: `alert:${m.id}:MACHINE_OFFLINE:${dayKey()}`,
          });
        }
      }
    }
  }

  /** Called when telemetry resumes — resolve MACHINE_OFFLINE. */
  function resolveOffline(machineId) {
    const open = alertsStore.findActiveByType(machineId, 'MACHINE_OFFLINE');
    if (open) {
      alertsStore.transition(open.id, 'RESOLVED', 'system');
      audit({ actorId: 'system', action: 'ALERT.RESOLVE', entityType: 'alert', entityId: open.id, before: { status: open.status }, after: { status: 'RESOLVED' } });
    }
  }

  return { processReading, checkOfflineMachines, resolveOffline };
}

module.exports = { createAlertEngine, slopeOf, severityForExceedance };
