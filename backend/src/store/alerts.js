'use strict';

const { db, parseJson, paged, nowIso } = require('./util');

function toAlert(row) {
  if (!row) return null;
  return { ...row, evidence: parseJson(row.evidence, {}) };
}

function findById(id) {
  return toAlert(db().prepare('SELECT * FROM alerts WHERE id = ?').get(id));
}

function findActiveByType(machineId, type) {
  return toAlert(
    db()
      .prepare(
        `SELECT * FROM alerts
         WHERE machine_id = ? AND type = ? AND status IN ('DETECTED','ACTIVE','ACKNOWLEDGED')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .all(machineId, type)[0] || null,
  );
}

function listActive({ machineId, severity, type, page = 1, pageSize = 100 }) {
  return list({ machineId, severity, type, statuses: ['DETECTED', 'ACTIVE', 'ACKNOWLEDGED'], page, pageSize });
}

function list({ machineId, severity, type, statuses, from, to, page = 1, pageSize = 100 }) {
  const where = [];
  const params = [];
  if (machineId) {
    where.push('machine_id = ?');
    params.push(machineId);
  }
  if (severity) {
    where.push('severity = ?');
    params.push(severity);
  }
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (statuses && statuses.length) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (from) {
    where.push('created_at >= ?');
    params.push(new Date(from).toISOString());
  }
  if (to) {
    where.push('created_at <= ?');
    params.push(new Date(to).toISOString());
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db().prepare(`SELECT COUNT(*) AS n FROM alerts ${w}`).get(...params).n;
  const rows = db()
    .prepare(`SELECT * FROM alerts ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize)
    .map(toAlert);
  return paged(rows, total, page, pageSize);
}

function create(alert) {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO alerts (id, machine_id, type, severity, status, message, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(alert.id, alert.machine_id, alert.type, alert.severity, 'DETECTED', alert.message, JSON.stringify(alert.evidence || {}), ts);
  return findById(alert.id);
}

function updateEvidence(id, evidence) {
  db().prepare('UPDATE alerts SET evidence = ? WHERE id = ?').run(JSON.stringify(evidence), id);
  return findById(id);
}

function updateSeverity(id, severity) {
  db().prepare('UPDATE alerts SET severity = ? WHERE id = ?').run(severity, id);
  return findById(id);
}

function transition(id, status, byUserId, opts = {}) {
  const sets = ['status = ?'];
  const params = [status];
  const ts = nowIso();
  if (status === 'ACKNOWLEDGED') {
    sets.push('acknowledged_at = ?');
    params.push(ts);
    if (byUserId) {
      sets.push('acknowledged_by = ?');
      params.push(byUserId);
    }
  } else if (status === 'RESOLVED') {
    sets.push('resolved_at = ?');
    params.push(ts);
    if (byUserId) {
      sets.push('resolved_by = ?');
      params.push(byUserId);
    }
  } else if (status === 'DISMISSED') {
    sets.push('dismissed_at = ?');
    params.push(ts);
    if (byUserId) {
      sets.push('dismissed_by = ?');
      params.push(byUserId);
    }
  }
  db().prepare(`UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return findById(id);
}

function countsBySeverity() {
  return db()
    .prepare('SELECT severity, COUNT(*) AS n FROM alerts GROUP BY severity')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.severity]: r.n }), {});
}

function countActive() {
  return db()
    .prepare("SELECT COUNT(*) AS n FROM alerts WHERE status IN ('DETECTED','ACTIVE','ACKNOWLEDGED')")
    .get().n;
}

module.exports = { findById, findActiveByType, listActive, list, create, updateEvidence, updateSeverity, transition, countsBySeverity, countActive, parseJson };
