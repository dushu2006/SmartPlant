'use strict';

/**
 * Maintenance workflow service (PRD §55):
 * Issue detected → Alert/Worker request → Triage → Priority →
 * Technician assignment → Spare part requirement → Maintenance →
 * Verification → Resolution → Maintenance history.
 */
const crypto = require('crypto');
const opsStore = require('../store/ops');
const usersStore = require('../store/users');
const machinesStore = require('../store/machines');
const { errors } = require('../errors');
const { audit } = require('./audit');
const { notify } = require('./notifications');

const STATUS_FLOW = {
  OPEN: ['TRIAGED', 'CANCELLED'],
  TRIAGED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'VERIFICATION', 'CANCELLED'],
  IN_PROGRESS: ['VERIFICATION', 'RESOLVED', 'CANCELLED'],
  VERIFICATION: ['RESOLVED'],
  RESOLVED: [],
  CANCELLED: [],
};

function assertTransition(from, to) {
  const allowed = STATUS_FLOW[from] || [];
  if (!allowed.includes(to)) {
    throw errors.conflict(`Invalid maintenance request transition ${from} → ${to}.`);
  }
}

function createRequest({ machineId, issue, priority, requesterId, aiTriage }) {
  if (!issue || !issue.trim()) throw errors.validation('issue is required');
  if (machineId && !machinesStore.findById(machineId)) throw errors.notFound('Machine not found.');

  const req = opsStore.createMaintenanceRequest({
    id: crypto.randomUUID(),
    machine_id: machineId ?? null,
    requester_id: requesterId,
    issue: issue.trim(),
    priority: priority ?? 'MEDIUM',
    ai_triage: aiTriage ?? null,
  });
  audit({
    actorId: requesterId,
    action: 'MAINTENANCE.REQUEST_CREATE',
    entityType: 'maintenance_request',
    entityId: req.id,
    after: { machine_id: machineId, issue: issue.trim(), priority: req.priority },
  });
  notify({
    type: 'REQUEST_UPDATE',
    title: `Maintenance request created: ${req.issue.slice(0, 60)}`,
    body: `Priority ${req.priority}.`,
    entityType: 'maintenance_request',
    entityId: req.id,
    dedupeKey: `mreq:${req.id}:created`,
  });
  return req;
}

function triageRequest(id, aiTriage, actorId) {
  const req = opsStore.findMaintenanceRequest(id);
  if (!req) throw errors.notFound('Maintenance request not found.');
  assertTransition(req.status, 'TRIAGED');
  const updated = opsStore.updateMaintenanceRequest(id, { status: 'TRIAGED', ai_triage: aiTriage ?? req.ai_triage });
  audit({
    actorId,
    action: 'MAINTENANCE.TRIAGE',
    entityType: 'maintenance_request',
    entityId: id,
    before: { status: req.status },
    after: { status: 'TRIAGED', ai_triage: updated.ai_triage },
  });
  return updated;
}

function assignTechnician(id, technicianId, actorId) {
  const req = opsStore.findMaintenanceRequest(id);
  if (!req) throw errors.notFound('Maintenance request not found.');
  if (!usersStore.findById(technicianId)) throw errors.notFound('Technician not found.');
  if (!['OPEN', 'TRIAGED', 'ASSIGNED'].includes(req.status)) {
    throw errors.conflict(`Cannot assign a ${req.status} request.`);
  }
  const updated = opsStore.updateMaintenanceRequest(id, {
    technician_id: technicianId,
    status: req.status === 'OPEN' ? 'TRIAGED' : req.status === 'TRIAGED' ? 'ASSIGNED' : req.status,
  });
  audit({
    actorId,
    action: 'MAINTENANCE.ASSIGN',
    entityType: 'maintenance_request',
    entityId: id,
    before: { technician_id: req.technician_id, status: req.status },
    after: { technician_id: technicianId, status: updated.status },
  });
  notify({
    recipients: [technicianId],
    type: 'TECHNICIAN_ASSIGNED',
    title: `Maintenance request assigned to you`,
    body: req.issue.slice(0, 120),
    entityType: 'maintenance_request',
    entityId: id,
    dedupeKey: `mreq:${id}:assigned:${technicianId}`,
  });
  return opsStore.findMaintenanceRequest(id);
}

function startWork(id, actorId) {
  const req = opsStore.findMaintenanceRequest(id);
  if (!req) throw errors.notFound('Maintenance request not found.');
  assertTransition(req.status, 'IN_PROGRESS');
  const updated = opsStore.updateMaintenanceRequest(id, { status: 'IN_PROGRESS' });
  audit({ actorId, action: 'MAINTENANCE.ASSIGN', entityType: 'maintenance_request', entityId: id, before: { status: req.status }, after: { status: 'IN_PROGRESS' } });
  return updated;
}

function submitVerification(id, actorId) {
  const req = opsStore.findMaintenanceRequest(id);
  if (!req) throw errors.notFound('Maintenance request not found.');
  assertTransition(req.status, 'VERIFICATION');
  const updated = opsStore.updateMaintenanceRequest(id, { status: 'VERIFICATION' });
  audit({ actorId, action: 'MAINTENANCE.TRIAGE', entityType: 'maintenance_request', entityId: id, before: { status: req.status }, after: { status: 'VERIFICATION' } });
  return updated;
}

/**
 * Complete: record a maintenance event, resolve the request, update the
 * machine status if it was FAULT/MAINTENANCE.
 */
function completeRequest(id, { type, diagnosis, action, outcome, notes, startedAt, completedAt, actorId }) {
  const req = opsStore.findMaintenanceRequest(id);
  if (!req) throw errors.notFound('Maintenance request not found.');
  assertTransition(req.status, 'RESOLVED');

  const ts = new Date().toISOString();
  const evt = opsStore.createMaintenanceEvent({
    id: crypto.randomUUID(),
    machine_id: req.machine_id,
    request_id: req.id,
    type: type ?? 'CORRECTIVE',
    diagnosis: diagnosis ?? null,
    action: action ?? null,
    technician_id: req.technician_id ?? actorId,
    started_at: startedAt ?? req.updated_at,
    completed_at: completedAt ?? ts,
    outcome: outcome ?? 'SUCCESS',
    notes: notes ?? null,
  });

  const updated = opsStore.updateMaintenanceRequest(id, { status: 'RESOLVED' });

  // If machine was in FAULT or MAINTENANCE, restore to RUNNING/IDLE.
  let machine = null;
  if (req.machine_id) {
    const m = machinesStore.findById(req.machine_id);
    if (m && (m.status === 'FAULT' || m.status === 'MAINTENANCE')) {
      machinesStore.setStatus(m.id, 'RUNNING');
      machine = machinesStore.findById(m.id);
    }
  }

  audit({
    actorId,
    action: 'MAINTENANCE.COMPLETE',
    entityType: 'maintenance_request',
    entityId: id,
    before: { status: req.status },
    after: { status: 'RESOLVED', event_id: evt.id, outcome: evt.outcome },
  });
  notify({
    recipients: [req.requester_id],
    type: 'REQUEST_UPDATE',
    title: `Maintenance completed: ${req.issue.slice(0, 60)}`,
    body: `Outcome: ${evt.outcome}. ${evt.action || ''}`,
    entityType: 'maintenance_request',
    entityId: id,
    dedupeKey: `mreq:${id}:resolved`,
  });
  return { request: updated, event: evt, machine };
}

function cancelRequest(id, actorId) {
  const req = opsStore.findMaintenanceRequest(id);
  if (!req) throw errors.notFound('Maintenance request not found.');
  assertTransition(req.status, 'CANCELLED');
  const updated = opsStore.updateMaintenanceRequest(id, { status: 'CANCELLED' });
  audit({ actorId, action: 'MAINTENANCE.CANCEL', entityType: 'maintenance_request', entityId: id, before: { status: req.status }, after: { status: 'CANCELLED' } });
  return updated;
}

module.exports = { createRequest, triageRequest, assignTechnician, startWork, submitVerification, completeRequest, cancelRequest };
