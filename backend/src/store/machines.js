'use strict';

const { db, parseJson, json, paged, nowIso } = require('./util');

function rowToMachine(row) {
  if (!row) return null;
  return {
    ...row,
    configuration: parseJson(row.configuration, {}),
    thresholds: parseJson(row.thresholds, {}),
    schedule: parseJson(row.schedule, {}),
    metadata: parseJson(row.metadata, {}),
  };
}

function findById(id) {
  return rowToMachine(db().prepare('SELECT * FROM machines WHERE id = ?').get(id));
}

function findByExternalDevice(deviceId) {
  return rowToMachine(
    db().prepare('SELECT * FROM machines WHERE external_device_id = ?').get(deviceId),
  );
}

function list({ status, plantId, search, page = 1, pageSize = 200 }) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (plantId) {
    where.push('plant_id = ?');
    params.push(plantId);
  }
  if (search) {
    where.push('(name LIKE ? OR type LIKE ? OR id LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db().prepare(`SELECT COUNT(*) AS n FROM machines ${w}`).get(...params).n;
  const rows = db()
    .prepare(`SELECT * FROM machines ${w} ORDER BY name ASC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize)
    .map(rowToMachine);
  return paged(rows, total, page, pageSize);
}

function create(machine) {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO machines (id, plant_id, external_device_id, name, type, status, configuration,
        thresholds, schedule, metadata, image, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      machine.id,
      machine.plant_id ?? null,
      machine.external_device_id ?? null,
      machine.name,
      machine.type ?? null,
      machine.status ?? 'OFF',
      json(machine.configuration),
      json(machine.thresholds),
      json(machine.schedule),
      json(machine.metadata),
      machine.image ?? null,
      ts,
      ts,
    );
  return findById(machine.id);
}

function update(id, fields) {
  const sets = [];
  const params = [];
  const scalars = ['name', 'type', 'status', 'plant_id', 'external_device_id', 'image'];
  for (const key of scalars) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  for (const key of ['configuration', 'thresholds', 'schedule', 'metadata']) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(json(fields[key]));
    }
  }
  if (!sets.length) return findById(id);
  sets.push('updated_at = ?');
  params.push(nowIso());
  db().prepare(`UPDATE machines SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return findById(id);
}

function setStatus(id, status) {
  db().prepare('UPDATE machines SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    nowIso(),
    id,
  );
}

function listRunning() {
  return db()
    .prepare("SELECT * FROM machines WHERE status IN ('RUNNING','IDLE','FAULT','MAINTENANCE')")
    .all()
    .map(rowToMachine);
}

function countByStatus() {
  return db()
    .prepare('SELECT status, COUNT(*) AS n FROM machines GROUP BY status')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});
}

function allMachines() {
  return db().prepare('SELECT * FROM machines ORDER BY name').all().map(rowToMachine);
}

function remove(id) {
  return db().prepare('DELETE FROM machines WHERE id = ?').run(id).changes;
}

module.exports = { findById, findByExternalDevice, list, create, update, setStatus, remove, listRunning, countByStatus, allMachines };
