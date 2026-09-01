'use strict';

/**
 * Structured JSON logger with level filtering and a bounded in-memory ring
 * buffer so /api/admin/health can expose recent log lines (observability).
 */
const config = require('./config');

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 99 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

const ring = [];
const RING_MAX = 2000;

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = JSON.stringify(entry);
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  ring.push(line);
  if (ring.length > RING_MAX) ring.shift();
}

const logger = {
  trace: (msg, fields) => emit('trace', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
  ring: () => ring.slice(),
};

module.exports = logger;
