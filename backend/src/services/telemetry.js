'use strict';

/**
 * Telemetry ingestion pipeline (PRD §11):
 * validate → normalize → deduplicate → store → update latest →
 * alert engine → (device status bookkeeping).
 */
const crypto = require('crypto');
const { validateTelemetryReading, normalizeTelemetryReading } = require('@smartplant/shared');
const telemetryStore = require('../store/telemetry');
const machinesStore = require('../store/machines');
const { errors } = require('../errors');
const logger = require('../logger');

let alertEngine = null;
function setAlertEngine(engine) {
  alertEngine = engine;
}

/**
 * Ingest one or many readings.
 * Returns { inserted, duplicates, rejected, alertsCreated }.
 */
function ingest(readings, opts = {}) {
  if (!Array.isArray(readings)) readings = [readings];
  const receivedAt = new Date().toISOString();
  const result = { inserted: 0, duplicates: 0, rejected: [], alertsCreated: [] };
  const knownMachines = new Set();

  for (const raw of readings) {
    const errors_ = validateTelemetryReading(raw);
    if (errors_.length) {
      result.rejected.push({ reason: errors_, reading: raw });
      continue;
    }
    const r = normalizeTelemetryReading(raw, receivedAt);
    const machine = machinesStore.findById(r.machine_id);
    if (!machine) {
      result.rejected.push({ reason: ['unknown machine_id'], reading: raw });
      continue;
    }
    knownMachines.add(machine.id);

    // Device-source readings from an unknown device id → reject (device auth).
    if (opts.requireDeviceMatch && machine.external_device_id && opts.deviceId && machine.external_device_id !== opts.deviceId) {
      result.rejected.push({ reason: ['device_id mismatch'], reading: raw });
      continue;
    }

    const inserted = telemetryStore.insertReading({ ...r, id: crypto.randomUUID() });
    if (!inserted) {
      result.duplicates++;
      continue;
    }
    telemetryStore.upsertLatest(r);
    result.inserted++;

    if (alertEngine) {
      const created = alertEngine.processReading(machine.id, { ...r, received_at: receivedAt });
      if (created.length) result.alertsCreated.push(...created.map((a) => a.id));
    }
  }

  // Machine came back online?
  for (const machineId of knownMachines) {
    if (alertEngine) alertEngine.resolveOffline(machineId);
  }

  return result;
}

/** Batch of readings from the simulator (no auth needed, source fixed). */
function ingestSimulated(readings) {
  return ingest(
    readings.map((r) => ({ ...r, source: 'simulator' })),
    {},
  );
}

module.exports = { ingest, ingestSimulated, setAlertEngine, validateReading: validateTelemetryReading };
