'use strict';

/** Shared store helpers. */
const { getDb } = require('../db');

function db() {
  return getDb();
}

/** Parse a JSON column safely. */
function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return fallback ?? null;
  }
}

function json(value) {
  return JSON.stringify(value ?? {});
}

/** Build a paginated envelope. */
function paged(rows, total, page, pageSize) {
  return {
    data: rows,
    meta: { total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = { db, parseJson, json, paged, nowIso };
