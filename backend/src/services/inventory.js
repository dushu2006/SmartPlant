'use strict';

/**
 * Inventory workflows (PRD §56–57). All stock movements are transactional:
 *   PENDING → APPROVED (reserve qty) → DELIVERED (stock -= reserved)
 *   PENDING → REJECTED / CANCELLED (no movement)
 * Available = stock − reserved, computed server-side.
 */
const crypto = require('crypto');
const inventoryStore = require('../store/inventory');
const { errors } = require('../errors');
const { audit } = require('./audit');
const { notify } = require('./notifications');

function assertPart(partId) {
  const part = inventoryStore.findPart(partId);
  if (!part) throw errors.notFound('Spare part not found.');
  return part;
}

function createSpareRequest({ machineId, partId, quantity, requesterId, eta }) {
  const part = assertPart(partId);
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) throw errors.validation('quantity must be a positive integer');

  // Available check at request time (soft, advisory).
  if (qty > part.available_qty) {
    // still allowed — goes through approval; reserved check happens at approve
  }

  const req = inventoryStore.createSpareRequest({
    id: crypto.randomUUID(),
    machine_id: machineId ?? null,
    part_id: partId,
    quantity: qty,
    requester_id: requesterId,
    eta: eta ? new Date(eta).toISOString() : null,
  });

  audit({
    actorId: requesterId,
    action: 'SPARE.REQUEST_CREATE',
    entityType: 'spare_request',
    entityId: req.id,
    after: { part_id: partId, part_name: part.name, quantity: qty },
  });
  notify({
    recipients: [requesterId],
    type: 'REQUEST_UPDATE',
    title: `Spare request created: ${part.name} ×${qty}`,
    body: `Waiting for approval.`,
    entityType: 'spare_request',
    entityId: req.id,
    dedupeKey: `spreq:${req.id}:created`,
  });
  return req;
}

/**
 * Approve → reserve stock in a transaction. Fails if insufficient available.
 */
function approveSpareRequest(id, approverId) {
  const req = inventoryStore.findSpareRequest(id);
  if (!req) throw errors.notFound('Spare request not found.');
  if (req.status !== 'PENDING') throw errors.conflict(`Cannot approve a ${req.status} request.`);

  const part = assertPart(req.part_id);
  if (part.available_qty < req.quantity) {
    throw errors.conflict(
      `Insufficient available stock for ${part.name}: available ${part.available_qty}, requested ${req.quantity}.`,
    );
  }

  const db = require('../store/util').db();
  db.exec('BEGIN IMMEDIATE');
  try {
    const updated = inventoryStore.adjustPartQty(req.part_id, 0, req.quantity);
    if (!updated || updated.available_qty < 0) throw errors.conflict('Insufficient stock.');
    inventoryStore.updateSpareRequest(id, { status: 'APPROVED', approver_id: approverId });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const updatedReq = inventoryStore.findSpareRequest(id);
  audit({
    actorId: approverId,
    action: 'SPARE.APPROVE',
    entityType: 'spare_request',
    entityId: id,
    before: { status: req.status },
    after: { status: 'APPROVED', part_id: req.part_id, quantity: req.quantity },
  });
  notify({
    recipients: [req.requester_id],
    type: 'SPARE_REQUEST_APPROVED',
    title: `Spare request approved: ${part.name} ×${req.quantity}`,
    body: `Stock reserved. ETA: ${req.eta || 'not set'}.`,
    entityType: 'spare_request',
    entityId: id,
    dedupeKey: `spreq:${id}:approved`,
  });
  return { request: updatedReq, part: inventoryStore.findPart(req.part_id) };
}

function rejectSpareRequest(id, approverId) {
  const req = inventoryStore.findSpareRequest(id);
  if (!req) throw errors.notFound('Spare request not found.');
  if (req.status !== 'PENDING') throw errors.conflict(`Cannot reject a ${req.status} request.`);
  inventoryStore.updateSpareRequest(id, { status: 'REJECTED', approver_id: approverId });
  audit({
    actorId: approverId,
    action: 'SPARE.REJECT',
    entityType: 'spare_request',
    entityId: id,
    before: { status: req.status },
    after: { status: 'REJECTED' },
  });
  notify({
    recipients: [req.requester_id],
    type: 'SPARE_REQUEST_REJECTED',
    title: `Spare request rejected: ${inventoryStore.findPart(req.part_id).name}`,
    entityType: 'spare_request',
    entityId: id,
    dedupeKey: `spreq:${id}:rejected`,
  });
  return inventoryStore.findSpareRequest(id);
}

/** Deliver: stock_qty -= reserved, reserved -= qty. */
function deliverSpareRequest(id, actorId) {
  const req = inventoryStore.findSpareRequest(id);
  if (!req) throw errors.notFound('Spare request not found.');
  if (req.status !== 'APPROVED') throw errors.conflict(`Cannot deliver a ${req.status} request.`);

  const db = require('../store/util').db();
  db.exec('BEGIN IMMEDIATE');
  try {
    const updated = inventoryStore.adjustPartQty(req.part_id, -req.quantity, -req.quantity);
    if (!updated || updated.stock_qty < 0) throw errors.conflict('Insufficient stock for delivery.');
    inventoryStore.updateSpareRequest(id, { status: 'DELIVERED' });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  audit({
    actorId,
    action: 'SPARE.DELIVER',
    entityType: 'spare_request',
    entityId: id,
    before: { status: 'APPROVED' },
    after: { status: 'DELIVERED' },
  });
  return inventoryStore.findSpareRequest(id);
}

function markUsedSpareRequest(id, actorId) {
  const req = inventoryStore.findSpareRequest(id);
  if (!req) throw errors.notFound('Spare request not found.');
  if (req.status !== 'DELIVERED') throw errors.conflict(`Cannot mark a ${req.status} request as used.`);
  inventoryStore.updateSpareRequest(id, { status: 'USED' });
  audit({
    actorId,
    action: 'SPARE.USE',
    entityType: 'spare_request',
    entityId: id,
    before: { status: 'DELIVERED' },
    after: { status: 'USED' },
  });
  return inventoryStore.findSpareRequest(id);
}

function cancelSpareRequest(id, actorId) {
  const req = inventoryStore.findSpareRequest(id);
  if (!req) throw errors.notFound('Spare request not found.');
  if (req.status !== 'PENDING') throw errors.conflict(`Cannot cancel a ${req.status} request.`);
  inventoryStore.updateSpareRequest(id, { status: 'CANCELLED' });
  audit({
    actorId,
    action: 'SPARE.CANCEL',
    entityType: 'spare_request',
    entityId: id,
    before: { status: 'PENDING' },
    after: { status: 'CANCELLED' },
  });
  return inventoryStore.findSpareRequest(id);
}

/** Admin restock: adds to stock_qty. */
function restockPart(partId, quantity, actorId) {
  assertPart(partId);
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) throw errors.validation('quantity must be a positive integer');
  const updated = inventoryStore.updatePart(partId, { stock_qty: inventoryStore.findPart(partId).stock_qty + qty });
  audit({
    actorId,
    action: 'PART.RESTOCK',
    entityType: 'spare_part',
    entityId: partId,
    before: { stock_qty: inventoryStore.findPart(partId).stock_qty - qty },
    after: { stock_qty: updated.stock_qty },
  });
  return updated;
}

function createPart(data, actorId) {
  const part = inventoryStore.createPart({ id: crypto.randomUUID(), ...data });
  audit({ actorId, action: 'PART.CREATE', entityType: 'spare_part', entityId: part.id, after: { sku: part.sku, name: part.name } });
  return part;
}

module.exports = {
  createSpareRequest,
  approveSpareRequest,
  rejectSpareRequest,
  deliverSpareRequest,
  markUsedSpareRequest,
  cancelSpareRequest,
  restockPart,
  createPart,
};
