'use strict';

const { db, parseJson, paged, nowIso } = require('./util');

// ================================================================== audit
function createAudit({ id, actorId, action, entityType, entityId, before, after, metadata }) {
  db()
    .prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, before, after, ts, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      actorId ?? null,
      action,
      entityType ?? null,
      entityId ?? null,
      before !== undefined ? JSON.stringify(before) : null,
      after !== undefined ? JSON.stringify(after) : null,
      nowIso(),
      metadata !== undefined ? JSON.stringify(metadata) : null,
    );
}

function listAudit({ actorId, action, entityType, entityId, from, to, page = 1, pageSize = 100 }) {
  const where = [];
  const params = [];
  if (actorId) {
    where.push('actor_id = ?');
    params.push(actorId);
  }
  if (action) {
    where.push('action = ?');
    params.push(action);
  }
  if (entityType) {
    where.push('entity_type = ?');
    params.push(entityType);
  }
  if (entityId) {
    where.push('entity_id = ?');
    params.push(entityId);
  }
  if (from) {
    where.push('ts >= ?');
    params.push(new Date(from).toISOString());
  }
  if (to) {
    where.push('ts <= ?');
    params.push(new Date(to).toISOString());
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db().prepare(`SELECT COUNT(*) AS n FROM audit_events ${w}`).get(...params).n;
  const rows = db()
    .prepare(
      `SELECT a.*, u.display_name AS actor_name FROM audit_events a
       LEFT JOIN users u ON u.id = a.actor_id
       ${w} ORDER BY a.ts DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return paged(rows, total, page, pageSize);
}

function countAudit() {
  return db().prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
}

// ============================================================= notifications
function createNotification(n) {
  const result = db()
    .prepare(
      `INSERT OR IGNORE INTO notifications
         (id, user_id, type, title, body, entity_type, entity_id, read_at, created_at, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(n.id, n.user_id, n.type, n.title, n.body ?? null, n.entity_type ?? null, n.entity_id ?? null, nowIso(), n.dedupe_key ?? null);
  return result.changes > 0;
}

function listNotifications({ userId, unreadOnly = false, page = 1, pageSize = 50 }) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (unreadOnly) {
    where.push('read_at IS NULL');
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const total = db().prepare(`SELECT COUNT(*) AS n FROM notifications ${w}`).get(...params).n;
  const rows = db()
    .prepare(`SELECT * FROM notifications ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  return paged(rows, total, page, pageSize);
}

function markRead(id, userId) {
  return db().prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').run(nowIso(), id, userId).changes;
}

function markAllRead(userId) {
  return db().prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowIso(), userId).changes;
}

function countUnread(userId) {
  return db().prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
}

module.exports = {
  createAudit,
  listAudit,
  countAudit,
  createNotification,
  listNotifications,
  markRead,
  markAllRead,
  countUnread,
  parseJson,
};
