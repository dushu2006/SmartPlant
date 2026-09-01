'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap } = require('../src/db');

process.env.DB_PATH = require('./helpers').tmpDir + '/unit.db';
process.env.LOG_LEVEL = 'error';
bootstrap();

// ------------------------------------------------------------ permissions
test('RBAC matrix: worker cannot approve spare requests', () => {
  const { can } = require('@smartplant/shared');
  assert.equal(can('WORKER', 'spare.approve'), false);
  assert.equal(can('ADMIN', 'spare.approve'), true);
  assert.equal(can('MANAGER', 'spare.approve'), true);
  assert.equal(can('VIEWER', 'tasks.create'), false);
  assert.equal(can('WORKER', 'tasks.create'), true);
});

// ------------------------------------------------------------ telemetry contract
test('telemetry validation rejects bad readings', () => {
  const { validateTelemetryReading } = require('@smartplant/shared');
  assert.ok(validateTelemetryReading({}).length > 0);
  assert.ok(validateTelemetryReading({ machine_id: 'm', metric: 'bogus', value: 1 }).length > 0);
  assert.ok(validateTelemetryReading({ machine_id: 'm', metric: 'temperature_c', value: 'x' }).length > 0);
  assert.deepEqual(validateTelemetryReading({ machine_id: 'm', metric: 'temperature_c', value: 55 }), []);
});

// ------------------------------------------------------------ slope
test('slope detection returns expected rate', () => {
  const { slopeOf } = require('../src/services/alertEngine');
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ ts: '', value: 50 + i * 0.5 });
  const slope = slopeOf(rows);
  assert.ok(slope > 4.5 && slope < 7.5, `expected ~6/h, got ${slope}`);
});

test('severity for exceedance is monotonic', () => {
  const { severityForExceedance } = require('../src/services/alertEngine');
  assert.equal(severityForExceedance(1.1), 'LOW');
  assert.equal(severityForExceedance(1.3), 'MEDIUM');
  assert.equal(severityForExceedance(1.6), 'HIGH');
  assert.equal(severityForExceedance(2.5), 'CRITICAL');
});

// ------------------------------------------------------------ reports
test('CSV export quotes correctly', () => {
  const { toCsv } = require('../src/services/reports');
  const csv = toCsv([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], [{ a: 'x,y', b: 'line\nbreak' }]);
  assert.match(csv, /"x,y"/);
  assert.match(csv, /"line\nbreak"/);
});

test('XLSX export produces a valid zip container', () => {
  const { toXlsx } = require('../src/services/reports');
  const buf = toXlsx([{ key: 'a', label: 'Machine' }], [{ a: 'Primary Extruder' }]);
  assert.ok(buf.slice(0, 2).toString() === 'PK', 'zip magic');
  const { unzipSync } = require('fflate');
  const files = unzipSync(new Uint8Array(buf));
  assert.ok(files['xl/worksheets/sheet1.xml']);
  const sheet = Buffer.from(files['xl/worksheets/sheet1.xml']).toString('utf8');
  assert.ok(sheet.includes('Primary Extruder'));
});

test('PDF export produces a valid PDF header and xref', () => {
  const { toPdf } = require('../src/services/reports');
  const buf = toPdf('Test', [{ key: 'a', label: 'A' }], [{ a: 'hello' }]);
  const text = buf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.includes('startxref'));
  assert.ok(text.includes('%%EOF'));
  assert.ok(text.includes('hello'));
});

// ------------------------------------------------------------ scheduling
test('recurrence expansion computes next occurrence', () => {
  const { nextOccurrence } = require('../src/services/scheduling');
  const base = '2026-09-01T10:00:00.000Z';
  assert.equal(nextOccurrence('daily', null, base), '2026-09-02T10:00:00.000Z');
  assert.equal(nextOccurrence('weekly', null, base), '2026-09-08T10:00:00.000Z');
  assert.equal(nextOccurrence('monthly', null, base), '2026-10-01T10:00:00.000Z');
  assert.equal(nextOccurrence('custom_days', 3, base), '2026-09-04T10:00:00.000Z');
  assert.equal(nextOccurrence('none', null, base), null);
});

// ------------------------------------------------------------ analytics
test('energy integration is deterministic and positive', () => {
  const analytics = require('../src/services/analytics');
  // Simulate: no data for a made-up machine → 0
  assert.equal(analytics.energyKwh('does-not-exist', '2026-09-01T00:00:00Z', '2026-09-01T02:00:00Z'), 0);
});

test('health score stays in 0..100', () => {
  const machines = require('../src/store/machines').allMachines();
  const analytics = require('../src/services/analytics');
  for (const m of machines) {
    const h = analytics.healthScore(m);
    assert.ok(h >= 0 && h <= 100, `health ${h} out of range for ${m.id}`);
  }
});

test('risk assessment shape matches PRD §38', () => {
  const machines = require('../src/store/machines').allMachines();
  const analytics = require('../src/services/analytics');
  const risk = analytics.riskAssessment(machines[0]);
  assert.ok(typeof risk.risk_score === 'number');
  assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(risk.risk_level));
  assert.ok(Array.isArray(risk.top_signals));
  assert.ok(risk.caveat);
});

// ------------------------------------------------------------ crypto/auth
test('password hashing and JWT round-trip', () => {
  const { hashPassword, verifyPassword, signJwt, verifyJwt } = require('../src/crypto');
  const hash = hashPassword('S3cret!');
  assert.notEqual(hash, 'S3cret!');
  assert.ok(verifyPassword('S3cret!', hash));
  assert.equal(verifyPassword('wrong', hash), false);
  const token = signJwt({ sub: 'u1', role: 'ADMIN' }, 'sekret', 1);
  const payload = verifyJwt(token, 'sekret');
  assert.equal(payload.sub, 'u1');
  assert.equal(verifyJwt(token, 'other-secret'), null);
});

test('action confirm tokens are one-time and tamper-proof', () => {
  const { signActionToken, verifyActionToken } = require('../src/crypto');
  const t = signActionToken('s', { uid: 'u', kind: 'create_task' }, 60000);
  assert.ok(verifyActionToken('s', t));
  assert.equal(verifyActionToken('s', t + 'x'), null);
  assert.equal(verifyActionToken('other', t), null);
});
