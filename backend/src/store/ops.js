'use strict';

const { db, paged, nowIso } = require('./util');

// =================================================================== tasks
function taskToRow(row) {
  return row;
}

function findTask(id) {
  return taskToRow(db().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id));
}

function listTasks({ machineId, status, assignedTo, priority, dueBefore, dueAfter, page = 1, pageSize = 100 }) {
  const where = [];
  const params = [];
  if (machineId) {
    where.push('machine_id = ?');
    params.push(machineId);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (assignedTo) {
    where.push('assigned_to = ?');
    params.push(assignedTo);
  }
  if (priority) {
    where.push('priority = ?');
    params.push(priority);
  }
  if (dueBefore) {
    where.push('due_at <= ?');
    params.push(new Date(dueBefore).toISOString());
  }
  if (dueAfter) {
    where.push('due_at >= ?');
    params.push(new Date(dueAfter).toISOString());
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db().prepare(`SELECT COUNT(*) AS n FROM scheduled_tasks ${w}`).get(...params).n;
  const rows = db()
    .prepare(
      `SELECT t.*, u.display_name AS assigned_name, u2.display_name AS created_name
       FROM scheduled_tasks t
       LEFT JOIN users u ON u.id = t.assigned_to
       LEFT JOIN users u2 ON u2.id = t.created_by
       ${w} ORDER BY t.due_at ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return paged(rows, total, page, pageSize);
}

function createTask(task) {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO scheduled_tasks
         (id, machine_id, task_type, title, description, due_at, recurrence, recurrence_interval,
          priority, status, assigned_to, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      task.machine_id ?? null,
      task.task_type ?? 'GENERAL',
      task.title,
      task.description ?? null,
      new Date(task.due_at).toISOString(),
      task.recurrence ?? 'none',
      task.recurrence_interval ?? null,
      task.priority ?? 'MEDIUM',
      task.assigned_to ?? null,
      task.created_by ?? null,
      ts,
      ts,
    );
  return findTask(task.id);
}

function updateTask(id, fields) {
  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(fields)) {
    sets.push(`${col} = ?`);
    params.push(val);
  }
  if (!sets.length) return findTask(id);
  sets.push('updated_at = ?');
  params.push(nowIso());
  db().prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return findTask(id);
}

function openTasksDueBefore(iso) {
  return db()
    .prepare(
      `SELECT t.*, m.name AS machine_name FROM scheduled_tasks t
       LEFT JOIN machines m ON m.id = t.machine_id
       WHERE t.status IN ('OPEN','ASSIGNED','IN_PROGRESS') AND t.due_at <= ?
       ORDER BY t.due_at ASC`,
    )
    .all(iso);
}

function upcomingTasks(limit = 10) {
  return db()
    .prepare(
      `SELECT t.*, m.name AS machine_name FROM scheduled_tasks t
       LEFT JOIN machines m ON m.id = t.machine_id
       WHERE t.status IN ('OPEN','ASSIGNED','IN_PROGRESS')
       ORDER BY t.due_at ASC LIMIT ?`,
    )
    .all(limit);
}

// ====================================================== maintenance requests
function reqToRow(row) {
  return row;
}

function findMaintenanceRequest(id) {
  return reqToRow(db().prepare('SELECT * FROM maintenance_requests WHERE id = ?').get(id));
}

function listMaintenanceRequests({ machineId, status, priority, assignedTo, page = 1, pageSize = 100 }) {
  const where = [];
  const params = [];
  if (machineId) {
    where.push('r.machine_id = ?');
    params.push(machineId);
  }
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (priority) {
    where.push('r.priority = ?');
    params.push(priority);
  }
  if (assignedTo) {
    where.push('r.technician_id = ?');
    params.push(assignedTo);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db().prepare(`SELECT COUNT(*) AS n FROM maintenance_requests r ${w}`).get(...params).n;
  const rows = db()
    .prepare(
      `SELECT r.*, m.name AS machine_name, req.display_name AS requester_name,
              tech.display_name AS technician_name
       FROM maintenance_requests r
       LEFT JOIN machines m ON m.id = r.machine_id
       LEFT JOIN users req ON req.id = r.requester_id
       LEFT JOIN users tech ON tech.id = r.technician_id
       ${w} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return paged(rows, total, page, pageSize);
}

function createMaintenanceRequest(req) {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO maintenance_requests
         (id, machine_id, requester_id, issue, priority, status, ai_triage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
    )
    .run(req.id, req.machine_id ?? null, req.requester_id, req.issue, req.priority ?? 'MEDIUM', req.ai_triage ? JSON.stringify(req.ai_triage) : null, ts, ts);
  return findMaintenanceRequest(req.id);
}

function updateMaintenanceRequest(id, fields) {
  const sets = [];
  const params = [];
  if (fields.issue !== undefined) {
    sets.push('issue = ?');
    params.push(fields.issue);
  }
  if (fields.priority !== undefined) {
    sets.push('priority = ?');
    params.push(fields.priority);
  }
  if (fields.status !== undefined) {
    sets.push('status = ?');
    params.push(fields.status);
  }
  if (fields.technician_id !== undefined) {
    sets.push('technician_id = ?');
    params.push(fields.technician_id);
  }
  if (fields.ai_triage !== undefined) {
    sets.push('ai_triage = ?');
    params.push(JSON.stringify(fields.ai_triage));
  }
  if (!sets.length) return findMaintenanceRequest(id);
  sets.push('updated_at = ?');
  params.push(nowIso());
  db().prepare(`UPDATE maintenance_requests SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  return findMaintenanceRequest(id);
}

// ======================================================== maintenance events
function listMaintenanceEvents({ machineId, limit = 100 }) {
  const where = [];
  const params = [];
  if (machineId) {
    where.push('e.machine_id = ?');
    params.push(machineId);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db()
    .prepare(
      `SELECT e.*, m.name AS machine_name, u.display_name AS technician_name
       FROM maintenance_events e
       LEFT JOIN machines m ON m.id = e.machine_id
       LEFT JOIN users u ON u.id = e.technician_id
       ${w} ORDER BY e.completed_at DESC LIMIT ?`,
    )
    .all(...params, limit);
}

function createMaintenanceEvent(evt) {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO maintenance_events
         (id, machine_id, request_id, type, diagnosis, action, technician_id, started_at, completed_at, outcome, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      evt.id,
      evt.machine_id,
      evt.request_id ?? null,
      evt.type ?? 'CORRECTIVE',
      evt.diagnosis ?? null,
      evt.action ?? null,
      evt.technician_id ?? null,
      evt.started_at ?? null,
      evt.completed_at ?? null,
      evt.outcome ?? 'SUCCESS',
      evt.notes ?? null,
      ts,
    );
  return db().prepare('SELECT * FROM maintenance_events WHERE id = ?').get(evt.id);
}

function lastMaintenanceForMachine(machineId) {
  return (
    db()
      .prepare(
        'SELECT * FROM maintenance_events WHERE machine_id = ? ORDER BY completed_at DESC LIMIT 1',
      )
      .all(machineId)[0] || null
  );
}

function maintenanceEventCount(machineId) {
  return db()
    .prepare('SELECT COUNT(*) AS n FROM maintenance_events WHERE machine_id = ?')
    .get(machineId).n;
}

module.exports = {
  findTask,
  listTasks,
  createTask,
  updateTask,
  openTasksDueBefore,
  upcomingTasks,
  findMaintenanceRequest,
  listMaintenanceRequests,
  createMaintenanceRequest,
  updateMaintenanceRequest,
  listMaintenanceEvents,
  createMaintenanceEvent,
  lastMaintenanceForMachine,
  maintenanceEventCount,
};
