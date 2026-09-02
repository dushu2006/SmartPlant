'use strict';

/**
 * Machine management service (PRD §26): create / edit / delete machines.
 * Machines are real assets in a real deployment — in production-like mode
 * (DEMO_MODE=false, SEED_DEMO_DATA=false) NOTHING is seeded; the operator
 * registers an account, then adds machines (manually or via the AI copilot)
 * and feeds telemetry through the ingestion endpoint.
 */
const crypto = require('crypto');
const machinesStore = require('../store/machines');
const inventoryStore = require('../store/inventory');
const { errors } = require('../errors');
const { audit } = require('./audit');

const MACHINE_TYPES = [
  'EXTRUSION', 'MILLING', 'MIXING', 'PRESSING', 'ROBOT', 'MOLDING',
  'WELDING', 'CONVEYOR', 'PACKAGING', 'COOLING', 'LASER', 'LATHE',
  'PALLETIZER', 'TESTBENCH', 'OTHER',
];

// Machine-type → default product image + human label (used by the AI generator).
const TYPE_DEFAULTS = {
  EXTRUSION: { image: 'images/extruder.jpg', label: 'Extruder' },
  MILLING: { image: 'images/milling.jpg', label: 'Milling Machine' },
  MIXING: { image: 'images/mixer.jpg', label: 'Mixer' },
  PRESSING: { image: 'images/press.jpg', label: 'Pressing Machine' },
  ROBOT: { image: 'images/robot.jpg', label: 'Robot' },
  MOLDING: { image: 'images/molder.jpg', label: 'Molder' },
  WELDING: { image: 'images/welding.jpg', label: 'Welding Machine' },
  CONVEYOR: { image: 'images/conveyor.jpg', label: 'Conveyor' },
  OTHER: { image: 'images/logo.png', label: 'Machine' },
};

function normalizeType(type) {
  const t = String(type || 'OTHER').toUpperCase().replace(/[^A-Z_]/g, '_');
  return MACHINE_TYPES.includes(t) ? t : 'OTHER';
}

function makeId(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'machine';
  return `mach_${slug.slice(0, 24)}_${crypto.randomBytes(3).toString('hex')}`;
}

function createMachine(data, actorId) {
  const name = String(data.name || '').trim();
  if (!name) throw errors.validation('Machine name is required.');
  if (name.length > 80) throw errors.validation('Machine name is too long (max 80 chars).');

  const type = normalizeType(data.type);
  const machine = machinesStore.create({
    id: makeId(name),
    plant_id: data.plant_id ?? null,
    external_device_id: data.external_device_id ?? null,
    name,
    type,
    status: data.status || 'OFF',
    configuration: { metrics: data.metrics || ['temperature_c', 'power_kw', 'load_pct'] },
    thresholds: data.thresholds || { temperature_c: { min: null, max: 60 }, power_kw: { min: null, max: 12 } },
    schedule: data.schedule || { startTime: '08:00', sleepTime: '17:00' },
    metadata: data.metadata || {},
    image: data.image || TYPE_DEFAULTS[type].image,
  });
  audit({ actorId, action: 'MACHINE.CREATE', entityType: 'machine', entityId: machine.id, after: { name: machine.name, type: machine.type, status: machine.status } });
  return machine;
}

function updateMachine(id, data, actorId) {
  const machine = machinesStore.findById(id);
  if (!machine) throw errors.notFound('Machine not found.');
  const before = { name: machine.name, type: machine.type, status: machine.status };
  const fields = {};
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw errors.validation('Machine name cannot be empty.');
    fields.name = name;
  }
  if (data.type !== undefined) fields.type = normalizeType(data.type);
  if (data.status !== undefined) fields.status = String(data.status).toUpperCase();
  if (data.external_device_id !== undefined) fields.external_device_id = data.external_device_id || null;
  if (data.image !== undefined) fields.image = data.image || null;
  if (data.thresholds !== undefined) fields.thresholds = data.thresholds;
  if (data.schedule !== undefined) fields.schedule = data.schedule;
  const updated = machinesStore.update(id, fields);
  if (!fields.status || fields.status !== before.status) {
    audit({ actorId, action: 'MACHINE.UPDATE', entityType: 'machine', entityId: id, before, after: { name: updated.name, type: updated.type, status: updated.status } });
  } else {
    audit({ actorId, action: 'MACHINE.UPDATE', entityType: 'machine', entityId: id, before, after: { name: updated.name, type: updated.type } });
  }
  return updated;
}

function deleteMachine(id, actorId) {
  const machine = machinesStore.findById(id);
  if (!machine) throw errors.notFound('Machine not found.');
  // Remove compatibility links; historical telemetry/alerts remain for audit.
  inventoryStore.clearMachineParts(id);
  machinesStore.remove(id);
  audit({ actorId, action: 'MACHINE.UPDATE', entityType: 'machine', entityId: id, metadata: { deleted: true, name: machine.name } });
  return { ok: true };
}

/** Build machine configs from a natural-language description (AI generator). */
function parseMachineDescription(description) {
  const text = String(description || '').toLowerCase();
  const specs = [];
  const patterns = [
    ['extruder', 'EXTRUSION'], ['extrusion', 'EXTRUSION'],
    ['mill', 'MILLING'], ['milling', 'MILLING'],
    ['mixer', 'MIXING'], ['mixing', 'MIXING'],
    ['press', 'PRESSING'],
    ['robot', 'ROBOT'],
    ['molder', 'MOLDING'], ['injection', 'MOLDING'],
    ['welding', 'WELDING'],
    ['conveyor', 'CONVEYOR'],
    ['packaging', 'PACKAGING'],
    ['cooling', 'COOLING'], ['chiller', 'COOLING'],
    ['laser', 'LASER'],
    ['lathe', 'LATHE'],
    ['palletizer', 'PALLETIZER'],
    ['test bench', 'TESTBENCH'],
  ];
  const seen = new Set();
  let matched = false;
  for (const [word, type] of patterns) {
    const re = new RegExp(`(\\d+)?\\s*${word}s?\\b`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      matched = true;
      const count = m[1] ? parseInt(m[1], 10) : 1;
      for (let i = 0; i < Math.min(count, 12); i++) {
        const label = TYPE_DEFAULTS[type].label;
        let name = `${label} ${i + 1}`;
        let n = 2;
        while (seen.has(name.toLowerCase())) name = `${label} ${i + 1} (${n++})`;
        seen.add(name.toLowerCase());
        specs.push({
          name,
          type,
          status: 'OFF',
          image: TYPE_DEFAULTS[type].image,
          schedule: { startTime: '08:00', sleepTime: '17:00' },
          thresholds: { temperature_c: { min: null, max: 60 }, power_kw: { min: null, max: 12 } },
        });
      }
    }
  }
  if (!matched) {
    // Fallback: one machine per comma-separated phrase that looks like equipment.
    for (const part of text.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12)) {
      if (part.length > 2 && part.length <= 60) {
        const label = part.replace(/\b(machine|line|unit)\b/g, '').trim() || 'Machine';
        const name = label.charAt(0).toUpperCase() + label.slice(1);
        if (!seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          specs.push({ name, type: 'OTHER', status: 'OFF', image: TYPE_DEFAULTS.OTHER.image, schedule: { startTime: '08:00', sleepTime: '17:00' }, thresholds: { temperature_c: { min: null, max: 60 }, power_kw: { min: null, max: 12 } } });
        }
      }
    }
  }
  return specs.slice(0, 24);
}

module.exports = { createMachine, updateMachine, deleteMachine, parseMachineDescription, TYPE_DEFAULTS };
