'use strict';

/** Demo machine documents with extracted text (feed for document RAG). */

const EXTRUDER_MANUAL = `PRIMARY EXTRUDER MAINTENANCE MANUAL — Model EX-450
Temperature control system: The extruder barrel is divided into four heating zones. Each zone uses ceramic heater bands and a PT100 temperature sensor. Normal operating temperature range is 48 to 57 degrees Celsius. The high temperature alarm threshold is 60 degrees Celsius.

Troubleshooting high temperature:
1. Check cooling water flow through the barrel cooling jacket. Minimum flow is 12 litres per minute. Low flow causes temperature to rise steadily.
2. Inspect the PT100 temperature sensor. A faulty sensor can report readings higher than actual barrel temperature.
3. Verify heater band behaviour. A stuck-on heater band in any zone will cause slow continuous temperature increase.
4. Confirm operating load. Higher screw speed or higher back pressure increases melt temperature.
5. Check the extrusion screw and barrel liner for excessive wear, which increases friction heating.

Preventive maintenance schedule: every 500 operating hours inspect heater bands and wiring. Every 1000 hours replace the temperature sensor. Every 3000 hours inspect the extrusion screw. Every 6000 hours replace barrel liner and screw if worn.

Safety: lock out and tag out the extruder before any maintenance. Wait for barrel temperature below 40 degrees Celsius before opening the barrel. Use heat resistant gloves.`;

const MIXER_MANUAL = `CHEMICAL MIXER TROUBLESHOOTING GUIDE — Model CM-200
The chemical mixer uses an agitator blade driven by a 7.5 kW motor. Normal temperature range is 36 to 46 degrees Celsius. Normal power draw is 4 to 6.5 kW.

Common issues:
- Seal leakage: inspect cylinder seals and shaft seals. Replace seal kit if oil contamination detected.
- Unusual noise: check agitator blade clearance and motor coupling wear.
- Temperature increase: verify cooling jacket supply and inspect agitator blades for deposits.
- Vibration: balance agitator blades and check bearings.

Spare parts: agitator blade set, cylinder seal kit, temperature sensor, motor coupling.`;

const CONVEYOR_SOP = `CONVEYOR BELT SYSTEM C5 STANDARD OPERATING PROCEDURE
Startup sequence: 1. Verify belt alignment. 2. Check drive roller rotation by hand. 3. Confirm emergency stop is reset. 4. Start at low speed. 5. Ramp to operating speed 0.8 m/s.
Daily checks: belt tension, idler bearing temperature, drive roller wear, splicing condition.
Weekly: clean belt surface, lubricate idlers.
Monthly: inspect full belt length for cuts, check motor pulley V-belt tension.
High temperature of drive roller above 50 degrees Celsius indicates bearing wear or belt slippage. Stop the line and inspect idler bearings and drive roller.`;

const ROBOT_DOC = `ASSEMBLY ROBOT R1 SERVICE DOCUMENT
The assembly robot uses servo encoders for joint position feedback. Flex cables must be inspected for chafing every 2000 operating hours.
Gripper tool claw replacement: remove two mounting screws, slide claw off, fit new claw, torque to 8 Nm.
Actuator motor faults produce error code 47 on the controller. Replace actuator motor and re-home the axis.
Safety sensors must be tested daily with the test rod.`;

const LASER_DOC = `LASER CUTTER LC-1 TECHNICAL SPECIFICATION
Laser source: 3kW fiber laser. Assist gas: nitrogen at 12 bar for stainless steel.
Cooling: closed loop chiller, coolant flow 25 L/min, coolant temperature setpoint 24 degrees Celsius.
Optics: protective lens inspected weekly, replaced when power loss exceeds 5 percent.
Beam alignment checked monthly. Linear guides lubricated every 500 hours.`;

const WELDING_DOC = `WELDING STATION WS2 SAFETY PROCEDURE
Personal protective equipment: welding helmet with auto-darkening filter, flame resistant jacket, leather gloves.
Ventilation must run for 5 minutes before and after welding operations.
Gas nozzle and torch tip inspection before each shift. Replace torch tip when wire feed becomes erratic.
Fire watch required for any welding above 2 metres height.`;

const COMPRESSOR_DOC = `AIR COMPRESSOR AC-2 SERVICE DOCUMENT
Reciprocating compressor, 22 kW. Normal discharge pressure 7.2 bar. High pressure alarm at 9 bar.
Maintenance: replace air filter every 1000 hours. Check pressure relief valve annually. Change oil every 2000 hours.
Vibration above 4.5 mm/s indicates bearing or valve wear.`;

const PRESS_DOC = `PRESSING MACHINE PARTS MANUAL
Hydraulic press components: clamp solenoid valve, tie bar bushings, cylinder seals, pressure relief valve, pressure sensor.
Clamp solenoid valve: 24V DC, coil resistance 22 ohms. If press does not clamp, verify solenoid voltage and coil continuity.
Tie bar bushings: replace when clamping force drops below 90 percent of rated.
Hydraulic oil: ISO VG 46, change every 2000 hours or annually.`;

const DOCS = [
  { id: 'doc_extruder_manual', machineId: 'mach_extruder', type: 'MAINTENANCE_MANUAL', title: 'Primary Extruder — Maintenance Manual', text: EXTRUDER_MANUAL, uploader: 'usr_admin' },
  { id: 'doc_extruder_sop', machineId: 'mach_extruder', type: 'SOP', title: 'Primary Extruder — Startup SOP', text: 'Extruder startup: verify heater zone temperatures within 5 degrees of setpoint before starting screw. Run screw at 20 rpm for 5 minutes. Bring up to operating speed gradually. Shutdown: purge barrel with cleaning compound, reduce temperatures to 150C, stop screw.', uploader: 'usr_supervisor' },
  { id: 'doc_extruder_safety', machineId: 'mach_extruder', type: 'SAFETY', title: 'Extruder — Safety Procedure', text: 'Lock out and tag out before maintenance. Wait for barrel temperature below 40C before opening. Use heat resistant gloves. Never reach into the hopper while the screw is running.', uploader: 'usr_admin' },
  { id: 'doc_mixer_troubleshooting', machineId: 'mach_mixer', type: 'TROUBLESHOOTING', title: 'Chemical Mixer — Troubleshooting Guide', text: MIXER_MANUAL, uploader: 'usr_technician' },
  { id: 'doc_conveyor_sop', machineId: 'mach_conveyor', type: 'SOP', title: 'Conveyor C5 — Standard Operating Procedure', text: CONVEYOR_SOP, uploader: 'usr_supervisor' },
  { id: 'doc_robot_service', machineId: 'mach_robot', type: 'SERVICE', title: 'Assembly Robot R1 — Service Document', text: ROBOT_DOC, uploader: 'usr_technician' },
  { id: 'doc_laser_spec', machineId: 'mach_laser', type: 'SPECIFICATION', title: 'Laser Cutter LC-1 — Technical Specification', text: LASER_DOC, uploader: 'usr_technician' },
  { id: 'doc_welding_safety', machineId: 'mach_welding', type: 'SAFETY', title: 'Welding Station WS2 — Safety Procedure', text: WELDING_DOC, uploader: 'usr_supervisor' },
  { id: 'doc_compressor_service', machineId: 'mach_compressor', type: 'SERVICE', title: 'Air Compressor AC-2 — Service Document', text: COMPRESSOR_DOC, uploader: 'usr_technician' },
  { id: 'doc_press_parts', machineId: 'mach_press', type: 'PARTS_MANUAL', title: 'Pressing Machine — Parts Manual', text: PRESS_DOC, uploader: 'usr_technician' },
];

function seedDocuments(db) {
  const stmt = db.prepare(
    `INSERT INTO machine_documents (id, machine_id, type, title, storage_url, extracted_text, version, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
  );
  const ts = new Date().toISOString();
  for (const d of DOCS) {
    stmt.run(d.id, d.machineId, d.type, d.title, d.text, d.uploader, ts);
  }
}

module.exports = { DOCS, seedDocuments };
