'use strict';

/**
 * Scheduling service (PRD §54): tasks with date/time, timezone, recurrence,
 * priority, assignment. Recurring tasks auto-expand after completion.
 */
const crypto = require('crypto');
const opsStore = require('../store/ops');
const usersStore = require('../store/users');
const { errors } = require('../errors');
const { audit } = require('./audit');
const { notify } = require('./notifications');

function validateRecurrence(recurrence, intervalDays) {
  if (!recurrence || recurrence === 'none') return null;
  const valid = ['daily', 'weekly', 'monthly', 'custom_days'];
  if (!valid.includes(recurrence)) throw errors.validation('invalid recurrence');
  if (recurrence === 'custom_days' && (!Number.isInteger(intervalDays) || intervalDays <= 0)) {
    throw errors.validation('recurrence_interval is required for custom_days');
  }
  return recurrence;
}

/** Compute the next occurrence after `from` (ISO). */
function nextOccurrence(recurrence, intervalDays, from) {
  if (!recurrence || recurrence === 'none') return null;
  const d = new Date(from);
  switch (recurrence) {
    case 'daily':
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString();
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      return d.toISOString();
    case 'monthly': {
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d.toISOString();
    }
    case 'custom_days':
      d.setUTCDate(d.getUTCDate() + intervalDays);
      return d.toISOString();
    default:
      return null;
  }
}

function createTask({ machineId, taskType, title, description, dueAt, recurrence, recurrenceInterval, priority, assignedTo, createdBy }) {
  if (!title || !title.trim()) throw errors.validation('title is required');
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw errors.validation('due_at must be a valid date');
  if (assignedTo && !usersStore.findById(assignedTo)) throw errors.notFound('Assigned user not found.');

  const rec = validateRecurrence(recurrence, recurrenceInterval);
  const task = opsStore.createTask({
    id: crypto.randomUUID(),
    machine_id: machineId ?? null,
    task_type: taskType ?? 'GENERAL',
    title: title.trim(),
    description: description ?? null,
    due_at: due.toISOString(),
    recurrence: rec || 'none',
    recurrence_interval: rec === 'custom_days' ? recurrenceInterval : null,
    priority: priority ?? 'MEDIUM',
    assigned_to: assignedTo ?? null,
    created_by: createdBy,
  });

  audit({
    actorId: createdBy,
    action: 'TASK.CREATE',
    entityType: 'scheduled_task',
    entityId: task.id,
    after: { title: task.title, due_at: task.due_at, recurrence: task.recurrence },
  });
  notify({
    recipients: task.assigned_to ? [task.assigned_to] : null,
    type: 'TASK_ASSIGNED',
    title: `Task: ${task.title}`,
    body: `Due ${new Date(task.due_at).toLocaleString()}.`,
    entityType: 'scheduled_task',
    entityId: task.id,
    dedupeKey: `task:${task.id}:created`,
  });
  return task;
}

function assignTask(taskId, assigneeId, actorId) {
  const task = opsStore.findTask(taskId);
  if (!task) throw errors.notFound('Task not found.');
  if (!usersStore.findById(assigneeId)) throw errors.notFound('Assignee not found.');
  const updated = opsStore.updateTask(taskId, { assigned_to: assigneeId, status: task.status === 'OPEN' ? 'ASSIGNED' : task.status });
  audit({
    actorId,
    action: 'TASK.ASSIGN',
    entityType: 'scheduled_task',
    entityId: taskId,
    before: { assigned_to: task.assigned_to, status: task.status },
    after: { assigned_to: assigneeId, status: updated.status },
  });
  notify({
    recipients: [assigneeId],
    type: 'TASK_ASSIGNED',
    title: `Task assigned: ${task.title}`,
    body: `You have been assigned a task due ${new Date(task.due_at).toLocaleString()}.`,
    entityType: 'scheduled_task',
    entityId: taskId,
    dedupeKey: `task:${taskId}:assigned:${assigneeId}`,
  });
  return opsStore.findTask(taskId);
}

/** Complete a task; if recurring, expand to the next occurrence. */
function completeTask(taskId, actorId) {
  const task = opsStore.findTask(taskId);
  if (!task) throw errors.notFound('Task not found.');
  if (task.status === 'COMPLETED') throw errors.conflict('Task is already completed.');

  const updated = opsStore.updateTask(taskId, { status: 'COMPLETED' });
  audit({
    actorId,
    action: 'TASK.COMPLETE',
    entityType: 'scheduled_task',
    entityId: taskId,
    before: { status: task.status },
    after: { status: 'COMPLETED' },
  });

  let next = null;
  if (task.recurrence && task.recurrence !== 'none') {
    const nextDue = nextOccurrence(task.recurrence, task.recurrence_interval, task.due_at);
    if (nextDue) {
      next = opsStore.createTask({
        id: crypto.randomUUID(),
        machine_id: task.machine_id,
        task_type: task.task_type,
        title: task.title,
        description: task.description,
        due_at: nextDue,
        recurrence: task.recurrence,
        recurrence_interval: task.recurrence_interval,
        priority: task.priority,
        assigned_to: task.assigned_to,
        created_by: task.created_by,
      });
    }
  }
  return { task: opsStore.findTask(taskId), nextOccurrence: next };
}

function cancelTask(taskId, actorId) {
  const task = opsStore.findTask(taskId);
  if (!task) throw errors.notFound('Task not found.');
  const updated = opsStore.updateTask(taskId, { status: 'CANCELLED' });
  audit({
    actorId,
    action: 'TASK.CANCEL',
    entityType: 'scheduled_task',
    entityId: taskId,
    before: { status: task.status },
    after: { status: 'CANCELLED' },
  });
  return updated;
}

/** Scheduler job: notify about due/overdue tasks (once per task). */
function checkDueTasks() {
  const nowIso = new Date().toISOString();
  const due = opsStore.openTasksDueBefore(nowIso);
  for (const t of due) {
    notify({
      recipients: t.assigned_to ? [t.assigned_to] : null,
      type: 'TASK_DUE',
      title: `Task due: ${t.title}`,
      body: `${t.machine_name || 'Machine'} — due ${new Date(t.due_at).toLocaleString()}.`,
      entityType: 'scheduled_task',
      entityId: t.id,
      dedupeKey: `task-due:${t.id}:${new Date().toISOString().slice(0, 10)}`,
    });
  }
}

module.exports = { createTask, assignTask, completeTask, cancelTask, checkDueTasks, nextOccurrence };
