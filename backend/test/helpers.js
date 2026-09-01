'use strict';

/**
 * Test helpers — boot the real app against a temporary database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartplant-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.DEMO_MODE = 'true';
process.env.SEED_DEMO_DATA = 'true';
process.env.SIMULATE_TELEMETRY = 'false';
process.env.AI_MODE = 'fallback';
process.env.LOG_LEVEL = 'error';

const { bootstrap } = require('../src/db');
bootstrap();

const { createAlertEngine } = require('../src/services/alertEngine');
const alertEngine = createAlertEngine();
const { setAlertEngine: setAppEngine } = require('../src/app');
const { setAlertEngine: setTelemetryEngine } = require('../src/services/telemetry');
setAppEngine(alertEngine);
setTelemetryEngine(alertEngine);

const { createApp } = require('../src/app');
const app = createApp();

let server = null;
let baseUrl = null;

async function startServer() {
  if (server) return baseUrl;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function stopServer() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
}

async function login(email, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body.data?.token) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`);
  return body.data;
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const demoUsers = {
  admin: ['admin@smartplant.local', 'Admin123!'],
  manager: ['manager@smartplant.local', 'Manager123!'],
  supervisor: ['supervisor@smartplant.local', 'Supervisor123!'],
  technician: ['technician@smartplant.local', 'Technician123!'],
  worker: ['worker@smartplant.local', 'Worker123!'],
  viewer: ['viewer@smartplant.local', 'Viewer123!'],
};

module.exports = { startServer, stopServer, login, api, demoUsers, tmpDir };
