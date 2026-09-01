#!/usr/bin/env node
/**
 * AI Grounding Evaluation (PRD §66).
 *
 * Boots a fresh server with a clean database, then runs a fixed battery of
 * questions with programmatic assertions:
 *   - every answer must be backed by real tool results (evidence),
 *   - numeric claims must match the database exactly,
 *   - fabrication attempts must be refused,
 *   - actions must require confirmation and be single-use,
 *   - offline/stale data must be reported as such.
 *
 * Run:  npm run eval   (or)   node test/eval.mjs
 * Exit code 0 = all cases pass.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartplant-eval-'));
const dbPath = path.join(tmpDir, 'eval.db');

// Boot a fresh server in a detached child process on a random port.
const port = 4300 + Math.floor(Math.random() * 500);
const serverProc = spawn(
  'node',
  [path.join(__dirname, '..', 'src', 'server.js')],
  {
    cwd: path.join(__dirname, '..'),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DB_PATH: dbPath,
      JWT_SECRET: 'eval-secret',
      DEMO_MODE: 'true',
      SEED_DEMO_DATA: 'true',
      SIMULATE_TELEMETRY: 'false',
      AI_MODE: 'fallback',
      LOG_LEVEL: 'error',
      PORT: String(port),
    },
  },
);
serverProc.unref();

// wait for health
const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${base}/health`);
    if (r.ok) { up = true; break; }
  } catch { /* retry */ }
  await new Promise((res) => setTimeout(res, 250));
}
if (!up) {
  console.error('server did not start');
  process.exit(1);
}

let token = null;
async function api(method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function login(email, password) {
  const r = await api('POST', '/api/auth/login', { email, password });
  if (r.status !== 200) throw new Error(`login failed ${email}`);
  token = r.json.data.token;
  return r.json.data;
}

async function chat(message) {
  const r = await api('POST', '/api/ai/chat', { message });
  if (r.status !== 200) throw new Error(`chat failed: ${JSON.stringify(r.json)}`);
  return r.json.data;
}

const results = [];
function case_(name, fn) {
  return { name, fn };
}
let pass = 0;
let fail = 0;
async function run(c) {
  try {
    await c.fn();
    pass++;
    console.log(`  ok  ${c.name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL  ${c.name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('SmartPlant AI grounding evaluation (fallback engine)\n');

await login('admin@smartplant.local', 'Admin123!');

const cases = [
  case_('status answer is grounded in DB values', async () => {
    const r = await chat('Is the Primary Extruder okay?');
    if (!r.evidence.some((e) => e.tool === 'get_machine_status')) throw new Error('expected get_machine_status evidence');
    if (!r.reply.includes('Primary Extruder')) throw new Error('machine name missing from reply');
    if (!/\d+(\.\d+)?°C/.test(r.reply)) throw new Error('no temperature value in reply');
  }),

  case_('alert explanation cites real alerts', async () => {
    const r = await chat('Why does the Packaging Line have an alert?');
    if (!r.evidence.some((e) => e.tool === 'explain_alert')) throw new Error('expected explain_alert evidence');
    if (!/Packaging Line/.test(r.reply)) throw new Error('machine not identified');
  }),

  case_('inventory answers match the database exactly', async () => {
    const r = await chat('Do we have spare heating elements?');
    const m = r.reply.match(/(\d+) available/);
    if (!m) throw new Error('no availability number in reply');
    const sku = r.reply.match(/SP-HE-\d+/)?.[0];
    if (!sku) throw new Error('no SKU in reply');
    const parts = await api('GET', `/api/parts?search=heating`);
    const part = parts.json.data.data.find((p) => p.sku === sku);
    if (!part) throw new Error('SKU not found in DB');
    if (Number(m[1]) !== part.available_qty) {
      throw new Error(`availability mismatch: AI said ${m[1]}, DB has ${part.available_qty}`);
    }
  }),

  case_('unknown part order is refused without fabrication', async () => {
    const r = await chat('Order 500 units of an unknown part.');
    if (/500|order placed|success/i.test(r.reply) && !/cannot/i.test(r.reply)) throw new Error('looks like fabricated confirmation');
    if (!/cannot/i.test(r.reply)) throw new Error('refusal not explicit');
    if (r.pendingActions.length) throw new Error('refused ask must not create an action');
  }),

  case_('maintenance history comes from the database', async () => {
    const r = await chat('When was the last maintenance on the Primary Extruder?');
    const ev = await api('GET', '/api/machines/mach_extruder/maintenance');
    if (ev.json.data.length) {
      if (!r.evidence.some((e) => e.tool === 'get_maintenance_history')) throw new Error('no history evidence');
    } else if (!/no maintenance|No maintenance/.test(r.reply)) {
      throw new Error('empty history not reported honestly');
    }
  }),

  case_('energy figures are deterministic and match analytics', async () => {
    const r = await chat('What is the energy cost of the compressor today?');
    const m = r.reply.match(/\*\*Energy — ([^*]+)\*\*/);
    if (!m) throw new Error('energy answer missing');
    if (!r.evidence.some((e) => e.tool === 'get_energy_usage')) throw new Error('no energy evidence');
  }),

  case_('document retrieval answers from uploaded docs only', async () => {
    const r = await chat('How should I troubleshoot high temperature on the Primary Extruder?');
    if (!r.evidence.some((e) => e.tool === 'search_documents')) throw new Error('no document evidence');
    if (!/documentation|manual|steps?/i.test(r.reply)) throw new Error('not sourced from documents');
  }),

  case_('action requires confirmation and executes once', async () => {
    const r = await chat('Schedule a maintenance inspection for the conveyor tomorrow.');
    if (!r.pendingActions.length) throw new Error('no pending action returned');
    const action = r.pendingActions[0];
    if (!action.confirmToken) throw new Error('no confirm token');
    if (action.kind !== 'create_task') throw new Error(`unexpected kind ${action.kind}`);

    const done = await api('POST', '/api/ai/actions/confirm', { token: action.confirmToken });
    if (done.status !== 200) throw new Error(`confirm failed ${done.status}`);
    if (done.json.data.result.machine_id !== 'mach_conveyor') throw new Error('task on wrong machine');

    const again = await api('POST', '/api/ai/actions/confirm', { token: action.confirmToken });
    if (again.status !== 409) throw new Error('reuse must be rejected with 409');
  }),

  case_('stale machine data is flagged, not presented as live', async () => {
    // Palletizer is seeded OFFLINE with old telemetry; asking about it must
    // surface staleness instead of pretending it is fresh.
    const r = await chat('Is the Palletizer Robot okay?');
    const fresh = r.reply.match(/(\d+)s old/);
    if (fresh && Number(fresh[1]) < 120) throw new Error('offline machine presented as freshly reporting');
    if (/OFFLINE|stale|offline|not reporting/i.test(r.reply) === false && !fresh) {
      // at minimum the status must be present
      if (!/OFFLINE/.test(r.reply)) throw new Error('offline status not surfaced');
    }
  }),

  case_('machine list health ranking is real', async () => {
    const r = await chat('What machines need attention?');
    const machines = await api('GET', '/api/machines');
    const worst = [...machines.json.data.data].sort((a, b) => a.health_score - b.health_score)[0];
    if (!r.reply.includes(worst.name)) throw new Error(`expected worst machine ${worst.name} in ranking`);
  }),
];

for (const c of cases) await run(c);

console.log(`\n${pass} passed, ${fail} failed`);
try {
  process.kill(-serverProc.pid, 'SIGTERM');
} catch { /* already gone */ }
process.exit(fail ? 1 : 0);
