'use strict';

const { db, parseJson, paged, nowIso } = require('./util');

// ------------------------------------------------------------------ writes
function insertReading(r) {
  const stmt = db().prepare(
    `INSERT OR IGNORE INTO telemetry_readings
       (id, machine_id, ts, metric, value, unit, quality, source, sequence, received_at, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const dedupeKey =
    r.dedupe_key ||
    (r.sequence !== null && r.sequence !== undefined
      ? `${r.machine_id}|${r.metric}|${r.sequence}`
      : null);
  const result = stmt.run(
    r.id || crypto.randomUUID(),
    r.machine_id,
    r.ts,
    r.metric,
    r.value,
    r.unit || null,
    r.quality || 'good',
    r.source || 'device',
    r.sequence ?? null,
    r.received_at,
    dedupeKey,
  );
  return result.changes > 0;
}

function upsertLatest(r) {
  db()
    .prepare(
      `INSERT INTO telemetry_latest (machine_id, metric, ts, value, unit, quality, source, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(machine_id, metric) DO UPDATE SET
         ts = excluded.ts, value = excluded.value, unit = excluded.unit,
         quality = excluded.quality, source = excluded.source, received_at = excluded.received_at`,
    )
    .run(r.machine_id, r.metric, r.ts, r.value, r.unit || null, r.quality || 'good', r.source || 'device', r.received_at);
}

// ------------------------------------------------------------------ reads
function latestForMachine(machineId) {
  const rows = db()
    .prepare('SELECT * FROM telemetry_latest WHERE machine_id = ?')
    .all(machineId);
  const out = {};
  for (const r of rows) {
    out[r.metric] = { ts: r.ts, value: r.value, unit: r.unit, quality: r.quality, source: r.source, received_at: r.received_at };
  }
  return out;
}

function latestForAll() {
  const rows = db().prepare('SELECT * FROM telemetry_latest').all();
  const out = {};
  for (const r of rows) {
    if (!out[r.machine_id]) out[r.machine_id] = {};
    out[r.machine_id][r.metric] = { ts: r.ts, value: r.value, unit: r.unit, quality: r.quality, source: r.source, received_at: r.received_at };
  }
  return out;
}

/**
 * Query telemetry with optional downsampling.
 * agg: 'raw' | 'avg' | 'min' | 'max' | 'sum'
 */
function query({ machineId, metric, from, to, agg = 'raw', bucketMinutes = 5, limit = 10000, page = 1 }) {
  const where = ['machine_id = ?'];
  const params = [machineId];
  if (metric) {
    where.push('metric = ?');
    params.push(metric);
  }
  if (from) {
    where.push('ts >= ?');
    params.push(new Date(from).toISOString());
  }
  if (to) {
    where.push('ts <= ?');
    params.push(new Date(to).toISOString());
  }
  const w = `WHERE ${where.join(' AND ')}`;

  if (agg === 'raw') {
    const total = db().prepare(`SELECT COUNT(*) AS n FROM telemetry_readings ${w}`).get(...params).n;
    const rows = db()
      .prepare(
        `SELECT id, machine_id, ts, metric, value, unit, quality, source, sequence, received_at
         FROM telemetry_readings ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, (page - 1) * limit);
    return paged(rows, total, page, limit);
  }

  const bucket = bucketMinutes * 60;
  const aggFn = agg === 'sum' ? 'SUM' : agg === 'min' ? 'MIN' : agg === 'max' ? 'MAX' : 'AVG';
  const rows = db()
    .prepare(
      `SELECT
         strftime('%Y-%m-%dT%H:%M:%fZ', (strftime('%s', ts) / ${bucket}) * ${bucket}, 'unixepoch') AS bucket_ts,
         metric,
         ${aggFn}(value) AS value,
         COUNT(*) AS samples
       FROM telemetry_readings ${w}
       GROUP BY bucket_ts, metric
       ORDER BY bucket_ts ASC`,
    )
    .all(...params);
  return { data: rows, meta: { total: rows.length } };
}

/** Roll-up used for energy computation: consecutive readings per machine. */
function readingsBetween(machineId, metric, from, to, order = 'ASC', limit = 50000) {
  return db()
    .prepare(
      `SELECT ts, value FROM telemetry_readings
       WHERE machine_id = ? AND metric = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ${order} LIMIT ?`,
    )
    .all(machineId, metric, from, to, limit);
}

function lastReadingBefore(machineId, metric, before) {
  return db()
    .prepare(
      `SELECT * FROM telemetry_readings
       WHERE machine_id = ? AND metric = ? AND ts <= ?
       ORDER BY ts DESC LIMIT 1`,
    )
    .all(machineId, metric, before)[0] || null;
}

function firstReadingAfter(machineId, metric, after) {
  return db()
    .prepare(
      `SELECT * FROM telemetry_readings
       WHERE machine_id = ? AND metric = ? AND ts >= ?
       ORDER BY ts ASC LIMIT 1`,
    )
    .all(machineId, metric, after)[0] || null;
}

function latestReading(machineId, metric) {
  return (
    db()
      .prepare(
        `SELECT * FROM telemetry_readings
         WHERE machine_id = ? AND metric = ?
         ORDER BY ts DESC LIMIT 1`,
      )
      .all(machineId, metric)[0] || null
  );
}

/** Rolling window (most recent n readings) for anomaly detection. */
function rollingWindow(machineId, metric, n) {
  return db()
    .prepare(
      `SELECT ts, value FROM telemetry_readings
       WHERE machine_id = ? AND metric = ?
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(machineId, metric, n)
    .reverse();
}

function machineTimeRange(machineId) {
  const row = db()
    .prepare('SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM telemetry_readings WHERE machine_id = ?')
    .get(machineId);
  return row;
}

function countReadings() {
  return db().prepare('SELECT COUNT(*) AS n FROM telemetry_readings').get().n;
}

function countBySource() {
  return db()
    .prepare('SELECT source, COUNT(*) AS n FROM telemetry_readings GROUP BY source')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.source]: r.n }), {});
}

function deleteOlderThan(iso) {
  const res = db().prepare('DELETE FROM telemetry_readings WHERE ts < ?').run(iso);
  return res.changes;
}

module.exports = {
  insertReading,
  upsertLatest,
  latestForMachine,
  latestForAll,
  query,
  readingsBetween,
  lastReadingBefore,
  firstReadingAfter,
  latestReading,
  rollingWindow,
  machineTimeRange,
  countReadings,
  countBySource,
  deleteOlderThan,
  parseJson,
};
