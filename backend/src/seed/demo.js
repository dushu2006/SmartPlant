'use strict';

/**
 * Demo seed — runs only when the database is empty AND DEMO_MODE=true.
 * Production (DEMO_MODE=false) never seeds.
 */
const { MACHINES } = require('./machines');
const { PARTS, MACHINE_PARTS } = require('./parts');
const { seedUsers } = require('./users');
const { seedDocuments } = require('./docs');
const { applyWarmup } = require('./warmup');
const machinesStore = require('../store/machines');
const inventoryStore = require('../store/inventory');

function seedDemo(db) {
  const ts = new Date().toISOString();

  // plants
  db.prepare(
    `INSERT INTO plants (id, name, location, timezone, status, created_at, updated_at)
     VALUES ('plant_main', 'SmartPlant Main Factory', 'Visakhapatnam, Andhra Pradesh, India', 'Asia/Kolkata', 'ACTIVE', ?, ?)`,
  ).run(ts, ts);
  db.prepare(
    `INSERT INTO plants (id, name, location, timezone, status, created_at, updated_at)
     VALUES ('plant_secondary', 'SmartPlant Unit 2', 'Chennai, Tamil Nadu, India', 'Asia/Kolkata', 'ACTIVE', ?, ?)`,
  ).run(ts, ts);

  // users
  seedUsers(db);

  // machines
  for (const m of MACHINES) {
    machinesStore.create({
      id: m.id,
      plant_id: m.plantId,
      external_device_id: m.externalDeviceId,
      name: m.name,
      type: m.type,
      status: m.status,
      image: m.image,
      thresholds: m.thresholds,
      configuration: { metrics: Object.keys(m.telemetry || {}) },
      schedule: m.schedule || {},
      metadata: { demo: true, model: 'EX-450' },
    });
  }

  // spare parts + compatibility
  for (const p of PARTS) {
    inventoryStore.createPart(p);
  }
  for (const [machineId, partIds] of Object.entries(MACHINE_PARTS)) {
    for (const partId of partIds) {
      inventoryStore.addMachinePart(machineId, partId);
    }
  }

  // documents
  seedDocuments(db);

  // operational demo rows (tasks, requests, events, alerts history, insights)
  seedOperations(db);

  // telemetry warm-up (must run through the alert engine to generate alerts)
  const { createAlertEngine } = require('../services/alertEngine');
  const engine = createAlertEngine({ replay: true });
  applyWarmup(db, MACHINES, engine);

  return { machines: MACHINES.length, parts: PARTS.length };
}

function seedOperations(db) {
  const ts = new Date().toISOString();
  const now = Date.now();
  const iso = (minOffset) => new Date(now + minOffset * 60000).toISOString();
  const day = 1440;

  // scheduled tasks
  const taskStmt = db.prepare(
    `INSERT INTO scheduled_tasks
       (id, machine_id, task_type, title, description, due_at, recurrence, recurrence_interval, priority, status, assigned_to, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  taskStmt.run('task_lubrication', 'mach_extruder', 'PREVENTIVE', 'Lubricate extruder drive bearings', 'Grease drive-side bearings per manual (500h service).', iso(4 * 60), 'none', null, 'MEDIUM', 'OPEN', 'usr_technician', 'usr_supervisor', ts, ts);
  taskStmt.run('task_cooling_check', 'mach_cooling', 'INSPECTION', 'Inspect cooling tower pump', 'Check pump impeller and coolant flow after yesterday spike.', iso(7 * 60), 'none', null, 'HIGH', 'ASSIGNED', 'usr_technician', 'usr_technician', ts, ts);
  taskStmt.run('task_daily_inspection', 'mach_conveyor', 'INSPECTION', 'Daily conveyor belt inspection', 'Belt alignment, idler temperature, splicing condition.', iso(2 * 60), 'daily', null, 'MEDIUM', 'OPEN', 'usr_worker', 'usr_supervisor', ts, ts);
  taskStmt.run('task_weekly_robot', 'mach_robot', 'PREVENTIVE', 'Weekly robot flex-cable check', 'Inspect flex cables for chafing (service doc).', iso(3 * day), 'weekly', null, 'MEDIUM', 'OPEN', 'usr_technician', 'usr_supervisor', ts, ts);
  taskStmt.run('task_filter_swap', 'mach_mill', 'PREVENTIVE', 'Replace coolant filter', 'Coolant filter is due for 500h replacement.', iso(-2 * day), 'none', null, 'LOW', 'COMPLETED', 'usr_technician', 'usr_technician', ts, ts);
  taskStmt.run('task_sensor_cal', 'mach_testbench', 'CALIBRATION', 'Calibrate test bench sensors', 'Force sensor 5kN calibration with certified weights.', iso(26 * 60), 'monthly', null, 'LOW', 'OPEN', null, 'usr_manager', ts, ts);
  taskStmt.run('task_packaging_diag', 'mach_packaging', 'CORRECTIVE', 'Diagnose packaging line fault', 'Power draw above threshold — investigate drive roller and feeder.', iso(-30), 'none', null, 'CRITICAL', 'IN_PROGRESS', 'usr_technician', 'usr_worker', ts, ts);

  // maintenance requests
  const reqStmt = db.prepare(
    `INSERT INTO maintenance_requests
       (id, machine_id, requester_id, issue, priority, status, technician_id, ai_triage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  reqStmt.run('mreq_packaging', 'mach_packaging', 'usr_worker', 'Packaging line making grinding noise and power consumption is very high.', 'CRITICAL', 'IN_PROGRESS', 'usr_technician', JSON.stringify({ machine: 'Packaging Line PL-1', category: 'Mechanical / Drive', priority: 'CRITICAL', symptoms: ['Grinding noise', 'High power consumption'], possible_subsystems: ['Drive roller', 'Feeder roller', 'Belt drive'] }), iso(-2 * 60), iso(-2 * 60));
  reqStmt.run('mreq_extruder_heat', 'mach_extruder', 'usr_worker', 'Extruder temperature rising steadily during the shift.', 'HIGH', 'ASSIGNED', 'usr_technician', null, iso(-70), iso(-70));
  reqStmt.run('mreq_cooling', 'mach_cooling', 'usr_supervisor', 'Cooling tower temperature spiked yesterday evening.', 'MEDIUM', 'TRIAGED', null, null, iso(-20 * 60), iso(-19 * 60));
  reqStmt.run('mreq_laser_lens', 'mach_laser', 'usr_technician', 'Protective lens shows signs of contamination.', 'LOW', 'RESOLVED', 'usr_technician', null, iso(-3 * day), iso(-2 * day));

  // maintenance events
  const evtStmt = db.prepare(
    `INSERT INTO maintenance_events
       (id, machine_id, request_id, type, diagnosis, action, technician_id, started_at, completed_at, outcome, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  evtStmt.run('mevt_filter', 'mach_mill', null, 'PREVENTIVE', 'Coolant filter clogged (500h service).', 'Replaced coolant filter cartridge, verified flow 25 L/min.', 'usr_technician', iso(-2 * day - 30), iso(-2 * day), 'SUCCESS', 'Next service due in 500h.', ts);
  evtStmt.run('mevt_laser_lens', 'mach_laser', 'mreq_laser_lens', 'REPAIR', 'Lens contamination from assist gas residue.', 'Cleaned optics, replaced protective lens, realigned beam.', 'usr_technician', iso(-3 * day - 60), iso(-3 * day - 10), 'SUCCESS', 'Power output restored to 98%.', ts);
  evtStmt.run('mevt_press_seal', 'mach_press', null, 'CORRECTIVE', 'Clamping pressure loss traced to cylinder seal wear.', 'Replaced cylinder seal kit, bled hydraulic system.', 'usr_technician', iso(-6 * day), iso(-6 * day + 120), 'SUCCESS', null, ts);
  evtStmt.run('mevt_extruder_sensor', 'mach_extruder', null, 'CALIBRATION', 'Temperature sensor drift 1.2C.', 'Replaced PT100 sensor, verified zone readings.', 'usr_technician', iso(-9 * day), iso(-9 * day + 90), 'SUCCESS', 'Sensor replaced; calibration within tolerance.', ts);

  // spare requests
  const spStmt = db.prepare(
    `INSERT INTO spare_requests
       (id, machine_id, part_id, quantity, requester_id, status, approver_id, eta, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  spStmt.run('spreq_1', 'mach_extruder', 'part_heating_element', 2, 'usr_technician', 'PENDING', null, null, iso(-5 * 60), iso(-5 * 60));
  spStmt.run('spreq_2', 'mach_packaging', 'part_drive_roller', 1, 'usr_worker', 'APPROVED', 'usr_manager', iso(2 * day), iso(-90), iso(-40));
  spStmt.run('spreq_3', 'mach_cooling', 'part_pump_impeller', 1, 'usr_technician', 'DELIVERED', 'usr_admin', iso(-1 * day), iso(-2 * day), iso(-1 * day));
  spStmt.run('spreq_4', 'mach_mill', 'part_coolant_filter', 2, 'usr_technician', 'USED', 'usr_manager', null, iso(-4 * day), iso(-2 * day));

  // alerts history (resolved) — engine-generated alerts come from warm-up replay
  const alertStmt = db.prepare(
    `INSERT INTO alerts
       (id, machine_id, type, severity, status, message, evidence, created_at, acknowledged_at, acknowledged_by, resolved_at, resolved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  alertStmt.run('alert_seed_1', 'mach_cooling', 'TEMPERATURE_HIGH', 'HIGH', 'RESOLVED', 'Cooling Tower CT-3 temperature exceeded 45 °C.', JSON.stringify({ value: 46.8, threshold: 45, window: '14:30–16:00' }), iso(-20 * 60), iso(-19 * 60), 'usr_supervisor', iso(-16 * 60), 'usr_technician');
  alertStmt.run('alert_seed_2', 'mach_palletizer', 'MACHINE_OFFLINE', 'MEDIUM', 'RESOLVED', 'Palletizer Robot PR-1 stopped reporting telemetry.', JSON.stringify({ lastReading: iso(-40), durationMin: 22 }), iso(-9 * day), iso(-9 * day + 30), 'usr_supervisor', iso(-9 * day + 120), 'usr_technician');

  // AI insights (historical, with evidence and feedback)
  const insStmt = db.prepare(
    `INSERT INTO ai_insights
       (id, machine_id, category, severity, description, evidence_refs, confidence, model_version, created_at, expires_at, feedback, feedback_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insStmt.run('insight_1', 'mach_cooling', 'ANOMALY', 'MEDIUM', 'Cooling Tower CT-3 temperature exceeded its baseline by 6.2 °C for ~90 minutes yesterday evening. Pattern is consistent with pump flow degradation; recommend inspecting the pump impeller.', JSON.stringify(['alert_seed_1', 'mreq_cooling']), 0.72, 'deterministic-v1', iso(-19 * 60), iso(5 * day), 'useful', iso(-18 * 60));
  insStmt.run('insight_2', 'mach_lathe', 'RISK', 'LOW', 'CNC Lathe TL-2 vibration shows a slow upward drift over the last 4 hours (+2.1 mm/s). Current vibration is still within normal bounds; schedule a bearing inspection within 7 days.', JSON.stringify([]), 0.55, 'deterministic-v1', iso(-3 * 60), iso(7 * day), null, null);
}

module.exports = { seedDemo };
