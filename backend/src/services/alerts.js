'use strict';

/**
 * Alert lifecycle service (PRD §53): every transition is audited.
 * DETECTED → ACTIVE → ACKNOWLEDGED → RESOLVED (or DISMISSED).
 */
const alertsStore = require('../store/alerts');
const machinesStore = require('../store/machines');
const { errors } = require('../errors');
const { audit } = require('./audit');

function assertMachine(alert) {
  const m = machinesStore.findById(alert.machine_id);
  if (!m) throw errors.notFound('Machine not found.');
  return m;
}

function acknowledgeAlert(id, userId) {
  const alert = alertsStore.findById(id);
  if (!alert) throw errors.notFound('Alert not found.');
  if (!['DETECTED', 'ACTIVE', 'ACKNOWLEDGED'].includes(alert.status)) {
    throw errors.conflict(`Cannot acknowledge a ${alert.status} alert.`);
  }
  const updated = alertsStore.transition(id, 'ACKNOWLEDGED', userId);
  audit({
    actorId: userId,
    action: 'ALERT.ACK',
    entityType: 'alert',
    entityId: id,
    before: { status: alert.status },
    after: { status: 'ACKNOWLEDGED' },
  });
  return updated;
}

function resolveAlert(id, userId) {
  const alert = alertsStore.findById(id);
  if (!alert) throw errors.notFound('Alert not found.');
  if (!['DETECTED', 'ACTIVE', 'ACKNOWLEDGED'].includes(alert.status)) {
    throw errors.conflict(`Cannot resolve a ${alert.status} alert.`);
  }
  const updated = alertsStore.transition(id, 'RESOLVED', userId);
  audit({
    actorId: userId,
    action: 'ALERT.RESOLVE',
    entityType: 'alert',
    entityId: id,
    before: { status: alert.status },
    after: { status: 'RESOLVED' },
  });
  return updated;
}

function dismissAlert(id, userId) {
  const alert = alertsStore.findById(id);
  if (!alert) throw errors.notFound('Alert not found.');
  if (alert.status === 'RESOLVED' || alert.status === 'DISMISSED') {
    throw errors.conflict(`Alert is already ${alert.status}.`);
  }
  const updated = alertsStore.transition(id, 'DISMISSED', userId);
  audit({
    actorId: userId,
    action: 'ALERT.DISMISS',
    entityType: 'alert',
    entityId: id,
    before: { status: alert.status },
    after: { status: 'DISMISSED' },
  });
  return updated;
}

module.exports = { acknowledgeAlert, resolveAlert, dismissAlert };
