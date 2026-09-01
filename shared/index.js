'use strict';

/**
 * SmartPlant shared constants, permission matrix and telemetry contract.
 * This module is used by BOTH the backend (authorization enforcement) and
 * the frontend (UI visibility). The backend is always the source of truth;
 * the frontend never grants access.
 */

// ---------------------------------------------------------------- roles
const ROLES = ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'];

const ROLE_RANK = Object.freeze({
  VIEWER: 0,
  WORKER: 1,
  TECHNICIAN: 2,
  SUPERVISOR: 3,
  MANAGER: 4,
  ADMIN: 5,
});

// ---------------------------------------------------------------- enums
const MACHINE_STATUSES = Object.freeze(['RUNNING', 'IDLE', 'OFF', 'OFFLINE', 'MAINTENANCE', 'FAULT']);

const ALERT_STATUSES = Object.freeze(['DETECTED', 'ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']);
const ALERT_SEVERITIES = Object.freeze(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const SEVERITY_RANK = Object.freeze({ INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });

const ALERT_TYPES = Object.freeze([
  'TEMPERATURE_HIGH',
  'POWER_HIGH',
  'ANOMALY_TEMPERATURE',
  'ANOMALY_POWER',
  'ANOMALY_TREND',
  'MACHINE_OFFLINE',
  'MACHINE_ONLINE',
  'SENSOR_FAILURE',
  'MAINTENANCE_DUE',
  'SPARE_LOW',
]);

const TELEMETRY_QUALITIES = Object.freeze(['good', 'suspect', 'bad', 'missing']);
const TELEMETRY_SOURCES = Object.freeze(['device', 'simulator', 'imported']);

const METRICS = Object.freeze({
  temperature_c: { unit: 'C', label: 'Temperature', decimals: 1 },
  power_kw: { unit: 'kW', label: 'Power', decimals: 2 },
  load_pct: { unit: '%', label: 'Load', decimals: 0 },
  vibration_mm_s: { unit: 'mm/s', label: 'Vibration', decimals: 2 },
  rpm: { unit: 'rpm', label: 'Speed', decimals: 0 },
  pressure_bar: { unit: 'bar', label: 'Pressure', decimals: 2 },
});

const TASK_STATUSES = Object.freeze(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);
const TASK_PRIORITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const RECURRENCES = Object.freeze(['none', 'daily', 'weekly', 'monthly', 'custom_days']);

const MAINTENANCE_REQUEST_STATUSES = Object.freeze([
  'OPEN', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'VERIFICATION', 'RESOLVED', 'CANCELLED',
]);
const MAINTENANCE_EVENT_TYPES = Object.freeze([
  'PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'PREDICTIVE', 'CALIBRATION', 'REPAIR', 'REPLACEMENT',
]);
const MAINTENANCE_OUTCOMES = Object.freeze(['SUCCESS', 'PARTIAL', 'FAILED', 'DEFERRED']);

const SPARE_REQUEST_STATUSES = Object.freeze([
  'PENDING', 'APPROVED', 'REJECTED', 'DELIVERED', 'USED', 'CANCELLED',
]);

const DOCUMENT_TYPES = Object.freeze([
  'MACHINE_MANUAL', 'MAINTENANCE_MANUAL', 'SOP', 'SAFETY', 'TROUBLESHOOTING',
  'SPECIFICATION', 'WIRING_DIAGRAM', 'SERVICE', 'PARTS_MANUAL', 'OTHER',
]);

const INSIGHT_CATEGORIES = Object.freeze([
  'ANOMALY', 'RISK', 'MAINTENANCE', 'ENERGY', 'INVENTORY', 'ALERT_EXPLANATION', 'TICKET_TRIAGE',
]);
const INSIGHT_FEEDBACK = Object.freeze(['useful', 'not_useful', 'correct', 'incorrect', 'accepted', 'rejected', 'partial']);

const NOTIFICATION_TYPES = Object.freeze([
  'CRITICAL_ALERT', 'HIGH_TEMPERATURE', 'HIGH_POWER', 'MACHINE_OFFLINE', 'MAINTENANCE_DUE',
  'SPARE_REQUEST_APPROVED', 'SPARE_REQUEST_REJECTED', 'TECHNICIAN_ASSIGNED', 'AI_HIGH_RISK',
  'TASK_DUE', 'TASK_ASSIGNED', 'REQUEST_UPDATE', 'SYSTEM',
]);

const AUDIT_ACTIONS = Object.freeze([
  'AUTH.LOGIN', 'AUTH.LOGOUT', 'AUTH.PASSWORD_CHANGE',
  'USER.CREATE', 'USER.UPDATE', 'USER.ROLE_CHANGE', 'USER.DEACTIVATE', 'USER.ACTIVATE',
  'MACHINE.CREATE', 'MACHINE.UPDATE', 'MACHINE.CONFIGURE',
  'TELEMETRY.INGEST', 'ALERT.CREATE', 'ALERT.ACK', 'ALERT.RESOLVE', 'ALERT.DISMISS',
  'TASK.CREATE', 'TASK.ASSIGN', 'TASK.COMPLETE', 'TASK.CANCEL',
  'MAINTENANCE.REQUEST_CREATE', 'MAINTENANCE.TRIAGE', 'MAINTENANCE.ASSIGN',
  'MAINTENANCE.COMPLETE', 'MAINTENANCE.CANCEL',
  'SPARE.REQUEST_CREATE', 'SPARE.APPROVE', 'SPARE.REJECT', 'SPARE.DELIVER', 'SPARE.USE', 'SPARE.CANCEL',
  'PART.CREATE', 'PART.UPDATE', 'PART.RESTOCK',
  'DOCUMENT.UPLOAD', 'DOCUMENT.DELETE',
  'AI.CHAT', 'AI.INSIGHT_GENERATE', 'AI.INSIGHT_FEEDBACK', 'AI.ACTION_EXECUTE', 'AI.ACTION_REJECT',
  'REPORT.EXPORT',
]);

// ---------------------------------------------------------------- permissions
/**
 * Permission matrix. The backend middleware `requirePermission` is the only
 * enforcement mechanism that matters. The frontend may hide UI, never more.
 */
const PERMISSIONS = Object.freeze({
  'dashboard.view': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'],

  'machines.view': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'],
  'machines.manage': ['ADMIN', 'MANAGER'],
  'machines.configure': ['ADMIN'],

  'telemetry.view': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'],
  'telemetry.ingest': ['ADMIN', 'MANAGER'], // device tokens in real deployments

  'alerts.view': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'],
  'alerts.ack': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER'],
  'alerts.resolve': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN'],
  'alerts.dismiss': ['ADMIN', 'MANAGER', 'SUPERVISOR'],

  'tasks.view': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'],
  'tasks.create': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER'],
  'tasks.assign': ['ADMIN', 'MANAGER', 'SUPERVISOR'],
  'tasks.complete': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN'],

  'maintenance.view': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'],
  'maintenance.create': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER'],
  'maintenance.triage': ['ADMIN', 'MANAGER', 'SUPERVISOR'],
  'maintenance.assign': ['ADMIN', 'MANAGER', 'SUPERVISOR'],
  'maintenance.complete': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN'],

  'inventory.view': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'],
  'inventory.manage': ['ADMIN', 'MANAGER'],
  'spare.request': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER'],
  'spare.approve': ['ADMIN', 'MANAGER'],

  'documents.view': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'],
  'documents.upload': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN'],

  'users.view': ['ADMIN', 'MANAGER'],
  'users.manage': ['ADMIN'],

  'audit.view': ['ADMIN'],

  'reports.export': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'],

  'ai.chat': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'],
  'ai.insights.view': ['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'],
  'ai.usage.view': ['ADMIN'],

  'system.health': ['ADMIN'],
  'system.export': ['ADMIN'],
});

const ALL_ROLES = Object.freeze([...ROLES]);

function isRole(role) {
  return ROLES.includes(role);
}

/** Backend authorization check. */
function can(role, permission) {
  const allowed = PERMISSIONS[permission];
  if (!allowed) return false;
  return allowed.includes(role);
}

/** Frontend visibility hint only — never a security boundary. */
function canView(role, permission) {
  return can(role, permission);
}

function rankOf(severity) {
  return SEVERITY_RANK[severity] ?? 0;
}

// ---------------------------------------------------------------- telemetry contract (PRD §10)
function validateTelemetryReading(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return ['reading must be an object'];
  if (typeof r.machine_id !== 'string' || r.machine_id.length === 0) errors.push('machine_id is required');
  if (typeof r.metric !== 'string' || !METRICS[r.metric]) errors.push(`unsupported metric: ${r.metric}`);
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) errors.push('value must be a finite number');
  if (r.timestamp) {
    const t = new Date(r.timestamp);
    if (Number.isNaN(t.getTime())) errors.push('timestamp must be a valid date');
    else if (Math.abs(t.getTime() - Date.now()) > 7 * 24 * 3600 * 1000) errors.push('timestamp is outside the 7-day acceptance window');
  }
  if (r.quality && !TELEMETRY_QUALITIES.includes(r.quality)) errors.push(`invalid quality: ${r.quality}`);
  if (r.source && !TELEMETRY_SOURCES.includes(r.source)) errors.push(`invalid source: ${r.source}`);
  return errors;
}

function normalizeTelemetryReading(r, receivedAt) {
  const ts = r.timestamp ? new Date(r.timestamp).toISOString() : receivedAt;
  return {
    id: r.id || null,
    machine_id: r.machine_id,
    ts,
    metric: r.metric,
    value: r.value,
    unit: r.unit || METRICS[r.metric].unit,
    quality: r.quality || 'good',
    source: r.source || 'device',
    sequence: Number.isInteger(r.sequence) ? r.sequence : null,
    received_at: receivedAt,
  };
}

function defaultThresholds(overrides = {}) {
  return {
    temperature_c: { min: null, max: 60 },
    power_kw: { min: null, max: 12 },
    ...overrides,
  };
}

module.exports = {
  ROLES,
  ROLE_RANK,
  MACHINE_STATUSES,
  ALERT_STATUSES,
  ALERT_SEVERITIES,
  SEVERITY_RANK,
  ALERT_TYPES,
  TELEMETRY_QUALITIES,
  TELEMETRY_SOURCES,
  METRICS,
  TASK_STATUSES,
  TASK_PRIORITIES,
  RECURRENCES,
  MAINTENANCE_REQUEST_STATUSES,
  MAINTENANCE_EVENT_TYPES,
  MAINTENANCE_OUTCOMES,
  SPARE_REQUEST_STATUSES,
  DOCUMENT_TYPES,
  INSIGHT_CATEGORIES,
  INSIGHT_FEEDBACK,
  NOTIFICATION_TYPES,
  AUDIT_ACTIONS,
  PERMISSIONS,
  ALL_ROLES,
  isRole,
  can,
  canView,
  rankOf,
  validateTelemetryReading,
  normalizeTelemetryReading,
  defaultThresholds,
};
