'use strict';

/**
 * Demo spare-parts catalog with machine compatibility matrix.
 * Compatibility is the ONLY source the AI may use (PRD §42).
 */

const PARTS = [
  { id: 'part_temp_sensor', sku: 'SP-TS-001', name: 'Temperature Sensor PT100', description: 'PT100 RTD temperature probe with 4-20mA transmitter.', image_url: 'images/temp_probe.jpg', stock_qty: 8, reorder_level: 3, supplier: 'Wika Instruments', lead_time_days: 7 },
  { id: 'part_heating_element', sku: 'SP-HE-102', name: 'Heating Element 3kW', description: '3kW cartridge heating element for extrusion barrels.', image_url: 'images/heating_element.jpg', stock_qty: 2, reorder_level: 4, supplier: 'Watlow', lead_time_days: 14 },
  { id: 'part_heater_bands', sku: 'SP-HB-103', name: 'Heater Bands 220V', description: 'Ceramic heater band set for barrel zones.', image_url: 'images/heater_bands.jpg', stock_qty: 6, reorder_level: 3, supplier: 'Watlow', lead_time_days: 10 },
  { id: 'part_extrusion_screw', sku: 'SP-ES-201', name: 'Extrusion Screw 45mm', description: 'Nitrided extrusion screw, 45mm diameter, L/D 25.', image_url: 'images/extrusion_screw.jpg', stock_qty: 1, reorder_level: 1, supplier: 'Bimex', lead_time_days: 45 },
  { id: 'part_barrel_liner', sku: 'SP-BL-202', name: 'Barrel Liner', description: 'Bimetallic barrel liner for extrusion section.', image_url: 'images/barrel_liner.jpg', stock_qty: 1, reorder_level: 1, supplier: 'Bimex', lead_time_days: 60 },
  { id: 'part_hopper_screw', sku: 'SP-HF-203', name: 'Hopper Feed Screw', description: 'Stainless feed screw for hopper dosing.', image_url: 'images/hopper_feed.jpg', stock_qty: 4, reorder_level: 2, supplier: 'Nordson', lead_time_days: 21 },
  { id: 'part_spindle_bearing', sku: 'SP-SB-204', name: 'Spindle Bearing 7014', description: 'Angular contact spindle bearing pair.', image_url: 'images/spindle_bearing.jpg', stock_qty: 3, reorder_level: 2, supplier: 'SKF', lead_time_days: 15 },
  { id: 'part_agitator_blade', sku: 'SP-AB-301', name: 'Agitator Blade Set', description: 'Teflon-coated agitator blade set for chemical mixers.', image_url: 'images/agitator_blade.jpg', stock_qty: 5, reorder_level: 2, supplier: 'Chemineer', lead_time_days: 12 },
  { id: 'part_drive_roller', sku: 'SP-DR-401', name: 'Drive Roller 80mm', description: 'Rubberized drive roller, 80mm, for conveyor systems.', image_url: 'images/drive_roller.jpg', stock_qty: 6, reorder_level: 3, supplier: 'Rulmeca', lead_time_days: 9 },
  { id: 'part_conveyor_belt', sku: 'SP-CB-402', name: 'Conveyor Belt 600mm', description: 'PVC conveyor belt, 600mm width, 10m length.', image_url: 'images/conveyor.jpg', stock_qty: 2, reorder_level: 1, supplier: 'Habasit', lead_time_days: 20 },
  { id: 'part_idler_bearing', sku: 'SP-IB-403', name: 'Idler Bearing 6204', description: 'Deep-groove idler bearing 6204-2RS.', image_url: 'images/idler_bearing.jpg', stock_qty: 12, reorder_level: 5, supplier: 'SKF', lead_time_days: 5 },
  { id: 'part_feeder_roller', sku: 'SP-FR-404', name: 'Feeder Roller', description: 'Serrated feeder roller for packaging line.', image_url: 'images/feeder_roller.jpg', stock_qty: 4, reorder_level: 2, supplier: 'Rulmeca', lead_time_days: 8 },
  { id: 'part_splicing_kit', sku: 'SP-SK-405', name: 'Belt Splicing Kit', description: 'Hot splicing kit for PVC conveyor belts.', image_url: 'images/splicing_kit.jpg', stock_qty: 3, reorder_level: 1, supplier: 'Habasit', lead_time_days: 7 },
  { id: 'part_tool_claw', sku: 'SP-GC-501', name: 'Gripper Tool Claw', description: 'Two-finger tool claw for assembly robot.', image_url: 'images/tool_claw.jpg', stock_qty: 4, reorder_level: 2, supplier: 'SCHUNK', lead_time_days: 18 },
  { id: 'part_actuator_motor', sku: 'SP-AM-502', name: 'Actuator Motor 24V', description: '24V DC actuator motor with encoder.', image_url: 'images/actuator_motor.jpg', stock_qty: 5, reorder_level: 2, supplier: 'Festo', lead_time_days: 14 },
  { id: 'part_servo_encoder', sku: 'SP-SE-503', name: 'Servo Encoder 17-bit', description: '17-bit absolute servo encoder.', image_url: 'images/servo_encoder.jpg', stock_qty: 3, reorder_level: 2, supplier: 'HEIDENHAIN', lead_time_days: 25 },
  { id: 'part_flex_cable', sku: 'SP-FC-506', name: 'Robot Flex Cable', description: 'High-flex robot arm cable, 3m.', image_url: 'images/flex_cable.jpg', stock_qty: 7, reorder_level: 3, supplier: 'Igus', lead_time_days: 10 },
  { id: 'part_safety_sensor', sku: 'SP-SS-505', name: 'Safety Light Sensor', description: 'Type-4 safety light curtain sensor.', image_url: 'images/safety_sensor.jpg', stock_qty: 4, reorder_level: 2, supplier: 'SICK', lead_time_days: 12 },
  { id: 'part_clamp_solenoid', sku: 'SP-CS-601', name: 'Clamp Solenoid Valve', description: '24V DC solenoid valve for press clamping.', image_url: 'images/clamp_solenoid.jpg', stock_qty: 3, reorder_level: 5, supplier: 'Bosch Rexroth', lead_time_days: 16 },
  { id: 'part_tie_bar_bushings', sku: 'SP-TB-602', name: 'Tie Bar Bushings', description: 'Bronze tie-bar bushing set for injection molder.', image_url: 'images/tie_bar_bushings.jpg', stock_qty: 4, reorder_level: 2, supplier: 'Engel', lead_time_days: 30 },
  { id: 'part_cylinder_seal', sku: 'SP-CYK-903', name: 'Cylinder Seal Kit', description: 'Hydraulic cylinder seal kit, 80mm bore.', image_url: 'images/cylinder_seal.jpg', stock_qty: 6, reorder_level: 3, supplier: 'Parker', lead_time_days: 9 },
  { id: 'part_gas_nozzle', sku: 'SP-GN-701', name: 'Gas Nozzle MIG', description: 'MIG welding gas nozzle, copper.', image_url: 'images/gas_nozzle.jpg', stock_qty: 15, reorder_level: 6, supplier: 'ESAB', lead_time_days: 6 },
  { id: 'part_torch_tip', sku: 'SP-WT-702', name: 'Welding Torch Tip', description: 'Contact tip for welding torch, 1.2mm wire.', image_url: 'images/torch_tip.jpg', stock_qty: 20, reorder_level: 8, supplier: 'ESAB', lead_time_days: 6 },
  { id: 'part_coolant_filter', sku: 'SP-CF-801', name: 'Coolant Filter', description: 'Coolant filtration cartridge, 25 micron.', image_url: 'images/coolant_filter.jpg', stock_qty: 6, reorder_level: 3, supplier: 'Pall', lead_time_days: 11 },
  { id: 'part_pump_impeller', sku: 'SP-PI-802', name: 'Pump Impeller', description: 'Stainless impeller for cooling tower pump.', image_url: 'images/pump_impeller.jpg', stock_qty: 1, reorder_level: 2, supplier: 'Grundfos', lead_time_days: 21 },
  { id: 'part_pressure_sensor', sku: 'SP-PS-901', name: 'Pressure Sensor 0-16bar', description: 'Hydraulic pressure transducer, 4-20mA.', image_url: 'images/pressure_sensor.jpg', stock_qty: 5, reorder_level: 2, supplier: 'Wika Instruments', lead_time_days: 8 },
  { id: 'part_force_sensor', sku: 'SP-FS-902', name: 'Force Sensor 5kN', description: 'Strain-gauge force sensor, 5kN range.', image_url: 'images/force_sensor.jpg', stock_qty: 2, reorder_level: 1, supplier: 'HBM', lead_time_days: 28 },
  { id: 'part_motor_coupling', sku: 'SP-MC-904', name: 'Motor Coupling', description: 'Flexible jaw coupling, 28mm bore.', image_url: 'images/motor_coupling.jpg', stock_qty: 5, reorder_level: 2, supplier: 'KTR', lead_time_days: 9 },
  { id: 'part_motor_pulley', sku: 'SP-MP-905', name: 'Motor Pulley', description: 'Cast iron V-belt pulley, 3-groove.', image_url: 'images/motor_pulley.jpg', stock_qty: 4, reorder_level: 2, supplier: 'Martin', lead_time_days: 12 },
  { id: 'part_linear_guide', sku: 'SP-LG-906', name: 'Linear Guide Rail', description: 'Linear guide rail, 600mm, with carriage.', image_url: 'images/linear_guide.jpg', stock_qty: 2, reorder_level: 1, supplier: 'THK', lead_time_days: 28 },
  { id: 'part_relief_valve', sku: 'SP-RV-907', name: 'Relief Valve', description: 'Hydraulic pressure relief valve.', image_url: 'images/relief_valve.jpg', stock_qty: 3, reorder_level: 2, supplier: 'Parker', lead_time_days: 10 },
];

/** machine_id → compatible part ids (AI may only use this). */
const MACHINE_PARTS = {
  mach_extruder: ['part_temp_sensor', 'part_heating_element', 'part_heater_bands', 'part_extrusion_screw', 'part_barrel_liner', 'part_hopper_screw', 'part_spindle_bearing', 'part_motor_coupling'],
  mach_mill: ['part_spindle_bearing', 'part_linear_guide', 'part_coolant_filter', 'part_servo_encoder', 'part_motor_pulley'],
  mach_mixer: ['part_agitator_blade', 'part_cylinder_seal', 'part_temp_sensor', 'part_motor_coupling'],
  mach_press: ['part_clamp_solenoid', 'part_tie_bar_bushings', 'part_cylinder_seal', 'part_pressure_sensor', 'part_relief_valve'],
  mach_robot: ['part_tool_claw', 'part_actuator_motor', 'part_servo_encoder', 'part_flex_cable', 'part_safety_sensor'],
  mach_molder: ['part_heater_bands', 'part_tie_bar_bushings', 'part_temp_sensor', 'part_hopper_screw', 'part_clamp_solenoid'],
  mach_welding: ['part_gas_nozzle', 'part_torch_tip', 'part_flex_cable', 'part_safety_sensor'],
  mach_conveyor: ['part_drive_roller', 'part_conveyor_belt', 'part_idler_bearing', 'part_feeder_roller', 'part_splicing_kit', 'part_motor_pulley'],
  mach_lathe: ['part_spindle_bearing', 'part_linear_guide', 'part_coolant_filter', 'part_servo_encoder'],
  mach_hpress: ['part_clamp_solenoid', 'part_cylinder_seal', 'part_pressure_sensor', 'part_relief_valve'],
  mach_cooling: ['part_pump_impeller', 'part_motor_coupling', 'part_coolant_filter'],
  mach_compressor: ['part_motor_pulley', 'part_motor_coupling', 'part_relief_valve', 'part_pressure_sensor'],
  mach_packaging: ['part_feeder_roller', 'part_drive_roller', 'part_conveyor_belt', 'part_splicing_kit'],
  mach_palletizer: ['part_tool_claw', 'part_actuator_motor', 'part_servo_encoder', 'part_flex_cable'],
  mach_laser: ['part_coolant_filter', 'part_linear_guide', 'part_servo_encoder', 'part_flex_cable'],
  mach_testbench: ['part_force_sensor', 'part_temp_sensor', 'part_pressure_sensor'],
};

module.exports = { PARTS, MACHINE_PARTS };
