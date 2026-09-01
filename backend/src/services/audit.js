'use strict';

const { createAudit } = require('../store/audit');

/**
 * Audit wrapper — every important operation leaves an audit record (PRD §21).
 */
function audit({ actorId, action, entityType, entityId, before, after, metadata }) {
  try {
    createAudit({
      id: require('crypto').randomUUID(),
      actorId,
      action,
      entityType,
      entityId,
      before,
      after,
      metadata,
    });
  } catch (err) {
    // Audit must never break the primary operation.
    require('../logger').error('audit write failed', { error: err.message, action });
  }
}

module.exports = { audit };
