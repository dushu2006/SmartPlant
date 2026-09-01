'use strict';

/**
 * Database bootstrap: open SQLite (node:sqlite), apply schema, seed demo data.
 * The repository layer (store/*) is the ONLY place SQL lives, so PostgreSQL
 * can be swapped in for production (see docs/ARCHITECTURE.md).
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const logger = require('./logger');

let db = null;

function openDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  logger.info('database ready', { path: config.dbPath });
  return db;
}

function countTables() {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .get();
  return row.n;
}

function isEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM machines').get();
  return row.n === 0;
}

/** Seed demo data on first boot (DEMO_MODE). Production never auto-seeds. */
function bootstrap() {
  openDb();
  const seedable = config.demoMode && config.seedDemoData;
  if (seedable && isEmpty()) {
    logger.info('empty database with DEMO_MODE enabled — seeding demo data');
    const { seedDemo } = require('./seed/demo');
    seedDemo(db);
  }
  return db;
}

module.exports = { openDb, bootstrap, getDb: () => db };
