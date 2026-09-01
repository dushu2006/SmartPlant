'use strict';

/**
 * Deterministic intelligence functions used by the AI tools, the background
 * insight job and the fallback chat engine. All numbers come from the
 * database/backend — nothing is invented (PRD §34–35).
 */
const analytics = require('../services/analytics');
const telemetryStore = require('../store/telemetry');
const alertsStore = require('../store/alerts');
const opsStore = require('../store/ops');
const aiStore = require('../store/ai');

const MODEL_VERSION = 'deterministic-v1';

function fmt1(v) {
  return v === null || v === undefined ? '—' : Math.round(v * 10) / 10;
}

function fmt2(v) {
  return v === null || v === undefined ? '—' : Math.round(v * 100) / 100;
}

function ageMin(iso) {
  return iso ? Math.round((Date.now() - new Date(iso).getTime()) / 60000) : null;
}

/**
 * Deep machine analysis: telemetry + baseline + alerts + maintenance +
 * documents → grounded narrative, evidence, confidence, next steps.
 */
function analyzeMachine(machine) {
  const ov = analytics.machineOverview(machine);
  const latest = telemetryStore.latestForMachine(machine.id);
  const active = alertsStore.listActive({ machineId: machine.id, pageSize: 50 }).data;
  const events = opsStore.listMaintenanceEvents({ machineId: machine.id, limit: 3 });
  const docs = aiStore.listDocuments({ machineId: machine.id, pageSize: 20 }).data;

  const findings = [];
  const evidence = [];

  const temp = latest.temperature_c;
  if (temp) {
    const win = telemetryStore.rollingWindow(machine.id, 'temperature_c', 60);
    const freshMin = ageMin(temp.ts);
    if (win.length >= 12) {
      const first = win[win.length - 12].value;
      const slope = (temp.value - first) / 12; // per 5-min bucket
      const slopeH = slope * 12; // per hour
      const mean = win.reduce((a, r) => a + r.value, 0) / win.length;
      const variance = win.reduce((a, r) => a + (r.value - mean) ** 2, 0) / win.length;
      const std = Math.sqrt(variance);
      const z = std > 0 ? (temp.value - mean) / std : 0;
      evidence.push({ ref: 'telemetry', metric: 'temperature_c', current: temp.value, baseline_mean: fmt1(mean), z: fmt1(z), freshness_min: freshMin });
      if (z > 2.5) {
        findings.push(`Temperature ${fmt1(temp.value)}°C is ${fmt1(z)}σ above the recent baseline (mean ${fmt1(mean)}°C).`);
      }
      if (slopeH > 2) {
        findings.push(`Temperature is rising at ~${fmt1(slopeH)}°C per hour — a sustained increasing trend.`);
      }
      if (freshMin !== null && freshMin > 10) {
        findings.push(`Latest temperature reading is ${freshMin} minutes old — data may be stale.`);
      }
    }
  }

  const power = latest.power_kw;
  if (power) {
    evidence.push({ ref: 'telemetry', metric: 'power_kw', current: power.value, freshness_min: ageMin(power.ts) });
  }

  for (const a of active) {
    findings.push(`${a.message}`);
    evidence.push({ ref: 'alert', alert_id: a.id, type: a.type, severity: a.severity });
  }

  if (events.length) {
    const last = events[0];
    evidence.push({ ref: 'maintenance', event_id: last.id, type: last.type, outcome: last.outcome, completed_at: last.completed_at });
    findings.push(`Last maintenance: ${last.type} (${last.outcome}) on ${(last.completed_at || '').slice(0, 10)}.`);
  } else {
    findings.push('No maintenance events recorded for this machine.');
  }

  if (docs.length) {
    evidence.push({ ref: 'documents', count: docs.length, titles: docs.slice(0, 3).map((d) => d.title) });
  }

  // Next steps (deterministic, document-driven when available)
  const nextSteps = [];
  if (active.some((a) => a.type === 'TEMPERATURE_HIGH' || a.type === 'ANOMALY_TEMPERATURE')) {
    nextSteps.push('Inspect the cooling system and verify the temperature sensor (see maintenance manual).');
    nextSteps.push('Check operating load against the historical baseline.');
  }
  if (active.some((a) => a.type === 'POWER_HIGH' || a.type === 'ANOMALY_POWER')) {
    nextSteps.push('Investigate drive/mechanical load; check for jams or excessive friction.');
  }
  if (active.some((a) => a.type === 'SENSOR_FAILURE')) {
    nextSteps.push('Verify the sensor connection and replace the sensor if readings stay bad.');
  }
  if (nextSteps.length === 0 && machine.status === 'FAULT') {
    nextSteps.push('Machine is in FAULT state — perform a full diagnostic per the service manual.');
  }
  if (nextSteps.length === 0) {
    nextSteps.push('No immediate action required; continue routine monitoring.');
  }

  const severity =
    active.some((a) => a.severity === 'CRITICAL') ? 'CRITICAL'
      : active.some((a) => a.severity === 'HIGH') ? 'HIGH'
        : active.some((a) => a.severity === 'MEDIUM') ? 'MEDIUM'
          : active.length ? 'LOW' : 'INFO';

  const confidence = active.length >= 2 ? 0.75 : active.length === 1 ? 0.6 : 0.4;

  return {
    machine_id: machine.id,
    machine: machine.name,
    status: machine.status,
    health_score: ov.health_score,
    risk: ov.risk,
    findings,
    evidence,
    next_steps: nextSteps,
    confidence,
    model_version: MODEL_VERSION,
    data_freshness_seconds: ov.current.data_freshness_seconds,
  };
}

/** Explain one alert: current telemetry + baseline + related history + docs. */
function explainAlert(alert) {
  const machine = require('../store/machines').findById(alert.machine_id);
  const parts = [];
  const evidence = [];

  if (machine) {
    const latest = telemetryStore.latestForMachine(machine.id);
    const metric = alert.evidence.metric || (alert.type.includes('TEMPERATURE') ? 'temperature_c' : alert.type.includes('POWER') ? 'power_kw' : null);
    if (metric && latest[metric]) {
      const win = telemetryStore.rollingWindow(machine.id, metric, 60);
      const mean = win.length ? win.reduce((a, r) => a + r.value, 0) / win.length : null;
      parts.push(`Current ${metric}: ${latest[metric].value}${latest[metric].unit || ''} (recent baseline mean: ${fmt1(mean)}${latest[metric].unit || ''}).`);
      evidence.push({ ref: 'telemetry', metric, current: latest[metric].value, baseline_mean: fmt1(mean), freshness_min: ageMin(latest[metric].ts) });
    }
    const alertEvidence = alert.evidence;
    if (alertEvidence.threshold !== undefined) {
      parts.push(`Alert threshold: ${alertEvidence.threshold}${alertEvidence.unit || ''}.`);
    }
    if (alertEvidence.zScore !== undefined) {
      parts.push(`The reading was ${fmt1(alertEvidence.zScore)} standard deviations above the rolling baseline.`);
    }
    if (alertEvidence.ratePerHour !== undefined) {
      parts.push(`The metric was rising at ${fmt1(alertEvidence.ratePerHour)}${alertEvidence.unit || ''}/h at detection time.`);
    }
    const events = opsStore.listMaintenanceEvents({ machineId: machine.id, limit: 2 });
    if (events.length) {
      parts.push(`Recent maintenance: ${events[0].type} (${events[0].outcome}) on ${(events[0].completed_at || '').slice(0, 10)}.`);
      evidence.push({ ref: 'maintenance', event_id: events[0].id });
    }
    const docs = aiStore.searchDocuments({ machineId: machine.id, query: 'troubleshoot high temperature' });
    if (docs.length) {
      parts.push(`Document reference — ${docs[0].title}: ${docs[0].snippet}`);
      evidence.push({ ref: 'document', doc_id: docs[0].id, title: docs[0].title });
    }
  }

  return {
    alert_id: alert.id,
    type: alert.type,
    severity: alert.severity,
    message: alert.message,
    explanation: parts,
    evidence,
    confidence: parts.length >= 2 ? 0.7 : 0.5,
    model_version: MODEL_VERSION,
  };
}

/** Ticket triage (PRD §43) — deterministic keyword rules + human oversight note. */
function triageTicket(issue, machine) {
  const text = String(issue || '').toLowerCase();
  const symptoms = [];
  const subsystems = [];

  const rules = [
    { words: ['heat', 'hot', 'overheat', 'temperature', 'temp'], symptom: 'Abnormal temperature', subsystem: 'Cooling system' },
    { words: ['sound', 'noise', 'grinding', 'squeal', 'rattle', 'vibrat'], symptom: 'Abnormal sound', subsystem: 'Motor / Bearing' },
    { words: ['power', 'current', 'energy', 'draw', 'consumption'], symptom: 'High power consumption', subsystem: 'Drive system' },
    { words: ['leak', 'oil', 'fluid', 'hydraulic'], symptom: 'Leakage', subsystem: 'Seals / Hydraulics' },
    { words: ['smoke', 'burn', 'smell'], symptom: 'Smoke / burning smell', subsystem: 'Electrical / Heating' },
    { words: ['jam', 'stuck', 'block', 'feed'], symptom: 'Jamming / feed issue', subsystem: 'Material handling' },
    { words: ['sensor', 'reading', 'wrong value', 'gauge'], symptom: 'Sensor/reading fault', subsystem: 'Instrumentation' },
    { words: ['stop', 'halt', 'shutdown', 'won\'t start', 'offline'], symptom: 'Machine stopped', subsystem: 'Control system' },
  ];
  for (const rule of rules) {
    if (rule.words.some((w) => text.includes(w))) {
      if (!symptoms.includes(rule.symptom)) symptoms.push(rule.symptom);
      if (!subsystems.includes(rule.subsystem)) subsystems.push(rule.subsystem);
    }
  }
  if (!symptoms.length) {
    symptoms.push('Unspecified');
    subsystems.push('General');
  }

  const critical = ['smoke', 'burn', 'stop', 'emergency', 'shutdown', 'fire', 'leak'];
  const high = ['heat', 'overheat', 'noise', 'power', 'jam'];
  let priority = 'MEDIUM';
  if (critical.some((w) => text.includes(w))) priority = 'CRITICAL';
  else if (high.some((w) => text.includes(w))) priority = 'HIGH';

  return {
    machine: machine ? machine.name : null,
    category: subsystems.join(' / ') || 'General',
    priority,
    symptoms,
    possible_subsystems: subsystems,
    note: 'AI triage only — final priority is subject to deterministic business rules and human oversight (PRD §43).',
    model_version: MODEL_VERSION,
  };
}

module.exports = { analyzeMachine, explainAlert, triageTicket, MODEL_VERSION };
