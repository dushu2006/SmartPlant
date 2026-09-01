'use strict';

const { db, parseJson, nowIso } = require('./util');

const PUBLIC_FIELDS =
  'id, email, display_name, role, status, locale, created_at, updated_at, last_login_at';

function toPublic(row) {
  if (!row) return null;
  const { password_hash, token_version, ...pub } = row;
  return pub;
}

function findByEmail(email) {
  return db().prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
}

function findById(id) {
  return db().prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(id);
}

function findWithHash(id) {
  return db().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function list({ search, role, status, page = 1, pageSize = 50 }) {
  const where = [];
  const params = [];
  if (search) {
    where.push('(email LIKE ? OR display_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  if (role) {
    where.push('role = ?');
    params.push(role);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db().prepare(`SELECT COUNT(*) AS n FROM users ${w}`).get(...params).n;
  const rows = db()
    .prepare(
      `SELECT ${PUBLIC_FIELDS} FROM users ${w} ORDER BY created_at ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return { rows, total };
}

function create({ id, email, passwordHash, displayName, role, locale = 'en' }) {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO users (id, email, password_hash, display_name, role, locale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, email, passwordHash, displayName, role, locale, ts, ts);
  return findById(id);
}

function update(id, fields) {
  const sets = [];
  const params = [];
  if (fields.displayName !== undefined) {
    sets.push('display_name = ?');
    params.push(fields.displayName);
  }
  if (fields.role !== undefined) {
    sets.push('role = ?');
    params.push(fields.role);
  }
  if (fields.status !== undefined) {
    sets.push('status = ?');
    params.push(fields.status);
  }
  if (fields.locale !== undefined) {
    sets.push('locale = ?');
    params.push(fields.locale);
  }
  if (fields.passwordHash !== undefined) {
    sets.push('password_hash = ?');
    params.push(fields.passwordHash);
  }
  if (fields.tokenVersion !== undefined) {
    sets.push('token_version = ?');
    params.push(fields.tokenVersion);
  }
  if (!sets.length) return findById(id);
  sets.push('updated_at = ?');
  params.push(nowIso());
  db().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return findById(id);
}

function touchLastLogin(id) {
  db().prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(
    nowIso(),
    nowIso(),
    id,
  );
}

function bumpTokenVersion(id) {
  db().prepare('UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?').run(
    nowIso(),
    id,
  );
  const row = db().prepare('SELECT token_version FROM users WHERE id = ?').get(id);
  return row ? row.token_version : 0;
}

function count() {
  return db().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

module.exports = {
  PUBLIC_FIELDS,
  toPublic,
  findByEmail,
  findById,
  findWithHash,
  list,
  create,
  update,
  touchLastLogin,
  bumpTokenVersion,
  count,
  parseJson,
};
