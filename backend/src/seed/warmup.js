'use strict';

/**
 * Deterministic telemetry warm-up (source='simulator').
 * Generates ~48h of 5-minute readings per machine from behavior profiles,
 * including engineered episodes (rising temperature, power spike, vibration
 * drift, sensor failure) so the alert engine and AI have realistic history.
 * These records are clearly tagged source=simulator and are NEVER presented
 * as real device history (PRD §9, §62).
 */
const { rng } = require('../random');
const telemetryStore = require('../store/telemetry');

const BUCKET_MIN = 5;
const HISTORY_MIN = 48 * 60;

function episodeValue(ep, minutesAgo, base) {
  if (!ep) return 0;
  const t = HISTORY_MIN - minutesAgo; // elapsed minutes from start of history
  const start = HISTORY_MIN + ep.startMin; // history-relative start
  const end = start + ep.durationMin;
  if (t < start || t > end) return 0;
  if (ep.kind === 'spike') {
    // rise quickly, decay slowly
    const rise = Math.min(1, (t - start) / 15);
    const decay = Math.max(0, 1 - (t - start) / ep.durationMin);
    return ep.delta * rise * decay * 0.6 + ep.delta * 0.4 * decay;
  }
  // 'rise': linear ramp
  return ep.delta * ((t - start) / ep.durationMin);
}

/**
 * @param {Array} machines machine seed rows with .telemetry profiles
 * @returns {Array} generated readings [{machine_id, metric, value, ts, quality, source}]
 */
function generateWarmup(machines, now = Date.now()) {
  const readings = [];
  // Anchor the series at the exact current moment so the newest reading is
  // fresh at boot (no artificial staleness).
  const anchor = now;

  for (let mi = 0; mi < machines.length; mi++) {
    const m = machines[mi];
    const profile = m.telemetry || {};
    const rand = rng(1000 + mi * 97);
    const metrics = Object.keys(profile);
    const lastActive = m.lastActiveMin !== undefined ? m.lastActiveMin : -999;

    for (let step = 0; step < HISTORY_MIN / BUCKET_MIN; step++) {
      const minutesAgo = step * BUCKET_MIN;
      const ts = new Date(anchor - minutesAgo * 60000).toISOString();

      // Machines that went offline stop reporting at lastActiveMin.
      if (lastActive >= 0 && minutesAgo < lastActive) continue;

      for (const metric of metrics) {
        const p = profile[metric];
        const phase = p.phase || 0;
        const day = (2 * Math.PI * minutesAgo) / 1440;
        let value =
          p.base +
          p.amp * Math.sin(day + phase) +
          rand.gaussian(0, p.noise || 0.2) * 0.4 +
          rand.gaussian(0, p.noise || 0.2) * 0.6;

        const ep = m.episode && m.episode.metric === metric ? m.episode : null;
        if (ep) value += episodeValue(ep, minutesAgo, p.base);

        // Sensor failure window (test bench): last 35 minutes report 'bad'
        let quality = 'good';
        if (m.sensorFailure && minutesAgo < 35 && minutesAgo >= 5) {
          quality = 'bad';
          value = p.base + rand.gaussian(0, 6);
        }

        // Round for realism
        value = Math.round(value * 100) / 100;

        readings.push({
          machine_id: m.id,
          ts,
          metric,
          value,
          unit: metric === 'temperature_c' ? 'C' : metric === 'power_kw' ? 'kW' : metric === 'load_pct' ? '%' : metric === 'vibration_mm_s' ? 'mm/s' : 'bar',
          quality,
          source: 'simulator',
          sequence: step,
        });
      }
    }
  }
  return readings;
}

/**
 * Insert warm-up readings, then replay them through the alert engine in
 * chronological order so alerts are engine-generated (never fabricated).
 */
function applyWarmup(db, machines, alertEngine) {
  const readings = generateWarmup(machines);
  const batch = [];
  const BATCH = 5000;
  for (const r of readings) {
    batch.push(r);
    if (batch.length >= BATCH) {
      flush(batch);
      batch.length = 0;
    }
  }
  flush(batch);

  // Replay through alert engine chronologically (per machine).
  const byMachine = {};
  for (const r of readings) {
    (byMachine[r.machine_id] ||= []).push(r);
  }
  for (const machine of machines) {
    const rows = (byMachine[machine.id] || []).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    for (const r of rows) {
      alertEngine.processReading(machine.id, r, { silent: true });
    }
  }
}

function flush(batch) {
  for (const r of batch) {
    const rec = { ...r, received_at: r.ts };
    const inserted = telemetryStore.insertReading(rec);
    if (inserted) telemetryStore.upsertLatest(rec);
  }
}

module.exports = { generateWarmup, applyWarmup };
