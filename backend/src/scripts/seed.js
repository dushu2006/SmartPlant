'use strict';

/** CLI: force a demo re-seed into an empty database. */
const { bootstrap } = require('../db');
const config = require('../config');

bootstrap();
const db = require('../db').getDb();
const { seedDemo } = require('../seed/demo');

const { countReadings } = require('../store/telemetry');
console.log(JSON.stringify({
  db: config.dbPath,
  mode: config.demoMode ? 'demo' : 'production',
  machines: db.prepare('SELECT COUNT(*) AS n FROM machines').get().n,
  users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  telemetry_readings: countReadings(),
  seeded: true,
}, null, 2));
