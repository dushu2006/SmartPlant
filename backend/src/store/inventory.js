'use strict';

const { db, parseJson, paged, nowIso } = require('./util');

// ================================================================= spare parts
function partToRow(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata, {}),
    available_qty: row.stock_qty - row.reserved_qty,
  };
}

function findPart(id) {
  return partToRow(db().prepare('SELECT * FROM spare_parts WHERE id = ?').get(id));
}

function findBySku(sku) {
  return partToRow(db().prepare('SELECT * FROM spare_parts WHERE sku = ?').get(String(sku).trim().toUpperCase()));
}

function listParts({ search, lowStock, page = 1, pageSize = 100 }) {
  const where = [];
  const params = [];
  if (search) {
    where.push('(name LIKE ? OR sku LIKE ? OR supplier LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (lowStock) {
    where.push('(stock_qty - reserved_qty) <= reorder_level');
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db().prepare(`SELECT COUNT(*) AS n FROM spare_parts ${w}`).get(...params).n;
  const rows = db()
    .prepare(`SELECT * FROM spare_parts ${w} ORDER BY name ASC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize)
    .map(partToRow);
  return paged(rows, total, page, pageSize);
}

function createPart(part) {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO spare_parts
         (id, sku, name, description, image_url, stock_qty, reserved_qty, reorder_level,
          supplier, lead_time_days, status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      part.id,
      part.sku,
      part.name,
      part.description ?? null,
      part.image_url ?? null,
      part.stock_qty ?? 0,
      part.reorder_level ?? 0,
      part.supplier ?? null,
      part.lead_time_days ?? null,
      part.status ?? 'ACTIVE',
      JSON.stringify(part.metadata ?? {}),
      ts,
      ts,
    );
  return findPart(part.id);
}

function updatePart(id, fields) {
  const sets = [];
  const params = [];
  const allowed = ['name', 'description', 'image_url', 'reorder_level', 'supplier', 'lead_time_days', 'status'];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (fields.stock_qty !== undefined) {
    sets.push('stock_qty = ?');
    params.push(fields.stock_qty);
  }
  if (!sets.length) return findPart(id);
  sets.push('updated_at = ?');
  params.push(nowIso());
  db().prepare(`UPDATE spare_parts SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return findPart(id);
}

/** Adjust stock/reserved inside a transaction. */
function adjustPartQty(partId, deltaStock, deltaReserved) {
  db()
    .prepare(
      `UPDATE spare_parts
       SET stock_qty = stock_qty + ?, reserved_qty = reserved_qty + ?,
           updated_at = ?
       WHERE id = ? AND stock_qty + ? >= 0 AND reserved_qty + ? >= 0`,
    )
    .run(deltaStock, deltaReserved, nowIso(), partId, deltaStock, deltaReserved);
  return findPart(partId);
}

function compatiblePartIds(machineId) {
  return db()
    .prepare('SELECT part_id FROM machine_parts WHERE machine_id = ?')
    .all(machineId)
    .map((r) => r.part_id);
}

function addMachinePart(machineId, partId) {
  db().prepare('INSERT OR IGNORE INTO machine_parts (machine_id, part_id) VALUES (?, ?)').run(machineId, partId);
}

function listPartsForMachine(machineId) {
  return db()
    .prepare(
      `SELECT p.* FROM spare_parts p
       JOIN machine_parts mp ON mp.part_id = p.id
       WHERE mp.machine_id = ? ORDER BY p.name ASC`,
    )
    .all(machineId)
    .map(partToRow);
}

function lowStockParts() {
  return db()
    .prepare(
      `SELECT * FROM spare_parts WHERE (stock_qty - reserved_qty) <= reorder_level ORDER BY (stock_qty - reserved_qty) ASC`,
    )
    .all()
    .map(partToRow);
}

// =============================================================== spare requests
function spareReqToRow(row) {
  return row;
}

function findSpareRequest(id) {
  return spareReqToRow(db().prepare('SELECT * FROM spare_requests WHERE id = ?').get(id));
}

function listSpareRequests({ status, machineId, requesterId, page = 1, pageSize = 100 }) {
  const where = [];
  const params = [];
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (machineId) {
    where.push('r.machine_id = ?');
    params.push(machineId);
  }
  if (requesterId) {
    where.push('r.requester_id = ?');
    params.push(requesterId);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db().prepare(`SELECT COUNT(*) AS n FROM spare_requests r ${w}`).get(...params).n;
  const rows = db()
    .prepare(
      `SELECT r.*, m.name AS machine_name, p.name AS part_name, p.sku, u.display_name AS requester_name,
              ap.display_name AS approver_name
       FROM spare_requests r
       LEFT JOIN machines m ON m.id = r.machine_id
       LEFT JOIN spare_parts p ON p.id = r.part_id
       LEFT JOIN users u ON u.id = r.requester_id
       LEFT JOIN users ap ON ap.id = r.approver_id
       ${w} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return paged(rows, total, page, pageSize);
}

function createSpareRequest(req) {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO spare_requests
         (id, machine_id, part_id, quantity, requester_id, status, eta, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
    )
    .run(req.id, req.machine_id ?? null, req.part_id, req.quantity, req.requester_id, req.eta ?? null, ts, ts);
  return findSpareRequest(req.id);
}

function updateSpareRequest(id, fields) {
  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(fields)) {
    sets.push(`${col} = ?`);
    params.push(val);
  }
  if (!sets.length) return findSpareRequest(id);
  sets.push('updated_at = ?');
  params.push(nowIso());
  db().prepare(`UPDATE spare_requests SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return findSpareRequest(id);
}

function clearMachineParts(machineId) {
  return db().prepare('DELETE FROM machine_parts WHERE machine_id = ?').run(machineId).changes;
}

module.exports = {
  findPart,
  findBySku,
  listParts,
  createPart,
  updatePart,
  adjustPartQty,
  compatiblePartIds,
  addMachinePart,
  clearMachineParts,
  listPartsForMachine,
  lowStockParts,
  findSpareRequest,
  listSpareRequests,
  createSpareRequest,
  updateSpareRequest,
};
