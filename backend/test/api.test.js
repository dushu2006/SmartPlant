'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const { startServer, stopServer, login, api, demoUsers } = helpers;

test.before(async () => {
  await startServer();
});

test.after(async () => {
  await stopServer();
});

// ------------------------------------------------------------ auth
test('login succeeds for every demo role and rejects bad credentials', async () => {
  for (const [role, [email, password]] of Object.entries(demoUsers)) {
    const res = await api('POST', '/api/auth/login', { body: { email, password } });
    assert.equal(res.status, 200, `${role} login`);
    assert.ok(res.json.data.token.length > 100);
  }
  const bad = await api('POST', '/api/auth/login', { body: { email: demoUsers.admin[0], password: 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'UNAUTHORIZED');
});

test('login rate limiting kicks in after repeated failures', async () => {
  for (let i = 0; i < 11; i++) {
    await api('POST', '/api/auth/login', { body: { email: 'rate@test.local', password: 'wrong' } });
  }
  const res = await api('POST', '/api/auth/login', { body: { email: 'rate@test.local', password: 'wrong' } });
  assert.equal(res.status, 429);
});

test('auth/me returns the user and demo mode', async () => {
  const { token } = await login(...demoUsers.worker);
  const res = await api('GET', '/api/auth/me', { token });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.user.email, demoUsers.worker[0]);
  assert.equal(res.json.data.demo_mode, true);
  assert.equal(res.json.data.user.password_hash, undefined);
});

// ------------------------------------------------------------ RBAC
test('workers cannot access admin endpoints (backend-enforced)', async () => {
  const { token } = await login(...demoUsers.worker);
  for (const path of ['/api/admin/audit', '/api/admin/users', '/api/admin/health']) {
    const res = await api('GET', path, { token });
    assert.equal(res.status, 403, path);
    assert.equal(res.json.error.code, 'UNAUTHORIZED_ACTION');
  }
});

test('viewers cannot create tasks', async () => {
  const { token } = await login(...demoUsers.viewer);
  const res = await api('POST', '/api/tasks', { token, body: { title: 'nope', due_at: new Date().toISOString() } });
  assert.equal(res.status, 403);
});

// ------------------------------------------------------------ dashboard
test('dashboard returns KPIs with backend data', async () => {
  const { token } = await login(...demoUsers.admin);
  const res = await api('GET', '/api/dashboard', { token });
  assert.equal(res.status, 200);
  const k = res.json.data.kpis;
  assert.ok(k.total_machines >= 16);
  assert.ok(k.active_machines >= 1);
  assert.ok(k.energy_today_kwh > 0);
  assert.ok(Array.isArray(res.json.data.machines));
  assert.ok(Array.isArray(res.json.data.energy_series));
});

// ------------------------------------------------------------ machines
test('machine list + overview + telemetry', async () => {
  const { token } = await login(...demoUsers.admin);
  const list = await api('GET', '/api/machines', { token });
  assert.equal(list.status, 200);
  assert.equal(list.json.data.data.length, 16);

  const ov = await api('GET', '/api/machines/mach_extruder', { token });
  assert.equal(ov.status, 200);
  assert.ok(ov.json.data.health_score >= 0);
  assert.ok(ov.json.data.current.temperature_c.value > 0);
  assert.ok(typeof ov.json.data.operating_hours_today === 'number');

  const tel = await api('GET', '/api/machines/mach_extruder/telemetry?metric=power_kw&agg=avg&bucketMinutes=60', { token });
  assert.equal(tel.status, 200);
  assert.ok(tel.json.data.data.length >= 24);

  const missing = await api('GET', '/api/machines/nope', { token });
  assert.equal(missing.status, 404);
});

// ------------------------------------------------------------ telemetry ingest
test('telemetry ingestion validates, dedupes and triggers alerts', async () => {
  const { token } = await login(...demoUsers.admin);
  const reading = { machine_id: 'mach_extruder', metric: 'temperature_c', value: 99, quality: 'good', source: 'device', sequence: 777001 };
  const r1 = await api('POST', '/api/telemetry/ingest', { token, body: { readings: [reading] } });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.data.inserted, 1);

  // A 99°C reading must create or refresh a TEMPERATURE_HIGH alert on the machine.
  const alerts = await api('GET', '/api/alerts?status=ACTIVE&machine_id=mach_extruder', { token });
  const hot = alerts.json.data.data.find((a) => a.type === 'TEMPERATURE_HIGH');
  assert.ok(hot, 'high temperature should trigger a TEMPERATURE_HIGH alert');

  // duplicate (same machine+metric+sequence) → dedupe
  const r2 = await api('POST', '/api/telemetry/ingest', { token, body: { readings: [reading] } });
  assert.equal(r2.json.data.duplicates, 1);

  // invalid reading → rejected
  const r3 = await api('POST', '/api/telemetry/ingest', { token, body: { readings: [{ machine_id: 'mach_extruder', metric: 'nope', value: 1 }] } });
  assert.equal(r3.json.data.rejected.length, 1);

  // unknown machine → rejected
  const r4 = await api('POST', '/api/telemetry/ingest', { token, body: { readings: [{ machine_id: 'no-such-machine', metric: 'temperature_c', value: 1 }] } });
  assert.equal(r4.json.data.rejected.length, 1);

  // clean up: resolve the 99°C alert
  if (hot) {
    const resolved = await api('POST', `/api/alerts/${hot.id}/resolve`, { token });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json.data.status, 'RESOLVED');
  }
});

// ------------------------------------------------------------ alert lifecycle
test('alert acknowledge → resolve transitions are audited', async () => {
  const { token } = await login(...demoUsers.technician);
  const alerts = await api('GET', '/api/alerts?status=ACTIVE', { token });
  const alert = alerts.json.data.data[0];
  assert.ok(alert);

  const ack = await api('POST', `/api/alerts/${alert.id}/acknowledge`, { token });
  assert.equal(ack.status, 200);
  assert.equal(ack.json.data.status, 'ACKNOWLEDGED');

  const resolve = await api('POST', `/api/alerts/${alert.id}/resolve`, { token });
  assert.equal(resolve.json.data.status, 'RESOLVED');

  // invalid transition
  const again = await api('POST', `/api/alerts/${alert.id}/acknowledge`, { token });
  assert.equal(again.status, 409);

  // audit trail exists
  const admin = await login(...demoUsers.admin);
  const audit = await api('GET', `/api/admin/audit?entity_id=${alert.id}`, { token: admin.token });
  assert.ok(audit.json.data.data.some((e) => e.action === 'ALERT.ACK'));
  assert.ok(audit.json.data.data.some((e) => e.action === 'ALERT.RESOLVE'));
});

// ------------------------------------------------------------ maintenance workflow
test('maintenance request workflow: create → assign → start → complete', async () => {
  const worker = await login(...demoUsers.worker);
  const supervisor = await login(...demoUsers.supervisor);
  const technician = await login(...demoUsers.technician);

  const created = await api('POST', '/api/maintenance-requests', {
    token: worker.token,
    body: { machine_id: 'mach_mixer', issue: 'Unusual noise during agitation', priority: 'HIGH' },
  });
  assert.equal(created.status, 201);
  const id = created.json.data.id;

  // worker cannot assign
  const denied = await api('POST', `/api/maintenance-requests/${id}/assign`, { token: worker.token, body: { technician_id: 'usr_technician' } });
  assert.equal(denied.status, 403);

  // supervisor triages (OPEN → TRIAGED), then assigns (TRIAGED → ASSIGNED)
  const triaged = await api('POST', `/api/maintenance-requests/${id}/triage`, { token: supervisor.token });
  assert.equal(triaged.status, 200);
  assert.equal(triaged.json.data.status, 'TRIAGED');

  const assigned = await api('POST', `/api/maintenance-requests/${id}/assign`, { token: supervisor.token, body: { technician_id: 'usr_technician' } });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.json.data.status, 'ASSIGNED');
  assert.equal(assigned.json.data.technician_id, 'usr_technician');

  const started = await api('POST', `/api/maintenance-requests/${id}/start`, { token: technician.token });
  assert.equal(started.json.data.status, 'IN_PROGRESS');

  const completed = await api('POST', `/api/maintenance-requests/${id}/complete`, {
    token: technician.token,
    body: { type: 'CORRECTIVE', diagnosis: 'Worn agitator blade', action: 'Replaced blade set', outcome: 'SUCCESS', notes: 'Verified' },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.json.data.request.status, 'RESOLVED');
  assert.equal(completed.json.data.event.type, 'CORRECTIVE');
  assert.equal(completed.json.data.event.outcome, 'SUCCESS');

  // maintenance history visible
  const history = await api('GET', '/api/machines/mach_mixer/maintenance', { token: worker.token });
  assert.ok(history.json.data.some((e) => e.id === completed.json.data.event.id));
});

// ------------------------------------------------------------ spare workflow
test('spare request workflow: request → approve (reserve) → deliver → use', async () => {
  const worker = await login(...demoUsers.worker);
  const manager = await login(...demoUsers.manager);

  const before = await api('GET', '/api/parts?search=heating', { token: worker.token });
  const part = before.json.data.data.find((p) => p.sku === 'SP-HE-102');
  const availableBefore = part.available_qty;

  const created = await api('POST', '/api/spare-requests', {
    token: worker.token,
    body: { machine_id: 'mach_extruder', part_id: part.id, quantity: 1 },
  });
  assert.equal(created.status, 201);

  // worker cannot approve
  const denied = await api('POST', `/api/spare-requests/${created.json.data.id}/approve`, { token: worker.token });
  assert.equal(denied.status, 403);

  const approved = await api('POST', `/api/spare-requests/${created.json.data.id}/approve`, { token: manager.token });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.data.request.status, 'APPROVED');
  assert.equal(approved.json.data.part.available_qty, availableBefore - 1, 'reserved qty reduces available');

  // cannot approve twice
  const again = await api('POST', `/api/spare-requests/${created.json.data.id}/approve`, { token: manager.token });
  assert.equal(again.status, 409);

  const delivered = await api('POST', `/api/spare-requests/${created.json.data.id}/deliver`, { token: manager.token });
  assert.equal(delivered.json.data.status, 'DELIVERED');

  const after = await api('GET', '/api/parts?search=heating', { token: worker.token });
  const partAfter = after.json.data.data.find((p) => p.sku === 'SP-HE-102');
  assert.equal(partAfter.available_qty, availableBefore - 1, 'delivery consumes reserved stock');

  const used = await api('POST', `/api/spare-requests/${created.json.data.id}/use`, { token: manager.token });
  assert.equal(used.json.data.status, 'USED');
});

test('approving more than available stock is rejected', async () => {
  const worker = await login(...demoUsers.worker);
  const manager = await login(...demoUsers.manager);
  const parts = await api('GET', '/api/parts?search=pump', { token: worker.token });
  const impeller = parts.json.data.data.find((p) => p.sku === 'SP-PI-802');
  assert.ok(impeller.available_qty < 5, 'impeller has limited stock');

  const created = await api('POST', '/api/spare-requests', {
    token: worker.token,
    body: { part_id: impeller.id, quantity: impeller.available_qty + 10 },
  });
  assert.equal(created.status, 201);

  const approved = await api('POST', `/api/spare-requests/${created.json.data.id}/approve`, { token: manager.token });
  assert.equal(approved.status, 409);
  assert.match(approved.json.error.message, /Insufficient available stock/);
});

// ------------------------------------------------------------ tasks
test('task create with recurrence and completion expansion', async () => {
  const worker = await login(...demoUsers.worker);
  const technician = await login(...demoUsers.technician);

  const created = await api('POST', '/api/tasks', {
    token: worker.token,
    body: {
      machine_id: 'mach_conveyor',
      title: 'Daily belt inspection',
      due_at: new Date(Date.now() + 3600000).toISOString(),
      priority: 'MEDIUM',
      recurrence: 'daily',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.recurrence, 'daily');
  const id = created.json.data.id;

  const completed = await api('POST', `/api/tasks/${id}/complete`, { token: technician.token });
  assert.equal(completed.status, 200);
  assert.ok(completed.json.data.nextOccurrence, 'recurring task expands');
  assert.equal(completed.json.data.nextOccurrence.recurrence, 'daily');
  assert.ok(new Date(completed.json.data.nextOccurrence.due_at) > new Date(created.json.data.due_at));
});

// ------------------------------------------------------------ documents
test('document upload, search and delete', async () => {
  const technician = await login(...demoUsers.technician);
  const created = await api('POST', '/api/documents', {
    token: technician.token,
    body: { machine_id: 'mach_extruder', type: 'SOP', title: 'Test SOP', content: 'Always check the cooling flow before startup.', filename: 'sop.txt' },
  });
  assert.equal(created.status, 201);
  const docId = created.json.data.id;

  const list = await api('GET', '/api/documents?machine_id=mach_extruder', { token: technician.token });
  assert.ok(list.json.data.data.some((d) => d.id === docId));

  const del = await api('DELETE', `/api/documents/${docId}`, { token: technician.token });
  assert.equal(del.status, 200);
});

// ------------------------------------------------------------ notifications
test('notifications are created and can be marked read', async () => {
  const worker = await login(...demoUsers.worker);
  const res = await api('GET', '/api/notifications', { token: worker.token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.data.data));
  const n = res.json.data.data[0];
  if (n) {
    const read = await api('POST', `/api/notifications/${n.id}/read`, { token: worker.token });
    assert.equal(read.json.data.ok, true);
  }
});

// ------------------------------------------------------------ reports
test('all report kinds export in csv/xlsx/pdf', async () => {
  const admin = await login(...demoUsers.admin);
  for (const kind of ['machines', 'energy', 'maintenance', 'alerts', 'inventory', 'requests', 'insights']) {
    for (const format of ['csv', 'xlsx', 'pdf']) {
      const res = await api('GET', `/api/reports/${kind}?format=${format}`, { token: admin.token });
      assert.equal(res.status, 200, `${kind}.${format}`);
      if (format === 'pdf') assert.ok(res.json.startsWith('%PDF'));
      if (format === 'xlsx') assert.equal(res.json.slice(0, 2).toString(), 'PK');
      if (format === 'csv') assert.ok(res.json.includes('\n'));
    }
  }
});

// ------------------------------------------------------------ AI
test('AI chat is grounded and refuses fabrication', async () => {
  const worker = await login(...demoUsers.worker);

  // status question uses the tool and contains a real number
  const status = await api('POST', '/api/ai/chat', { token: worker.token, body: { message: 'Is the Primary Extruder okay?' } });
  assert.equal(status.status, 200);
  assert.ok(status.json.data.evidence.some((e) => e.tool === 'get_machine_status'));
  assert.match(status.json.data.reply, /Primary Extruder/);

  // unknown part order → refusal, no fabrication
  const order = await api('POST', '/api/ai/chat', { token: worker.token, body: { message: 'Order 500 units of an unknown part.' } });
  assert.match(order.json.data.reply, /cannot place orders/i);

  // inventory answer must match the database
  const inv = await api('POST', '/api/ai/chat', { token: worker.token, body: { message: 'Do we have spare heating elements?' } });
  assert.match(inv.json.data.reply, /SP-HE-102/);
  const dbPart = require('../src/store/inventory').findBySku('SP-HE-102');
  const m = inv.json.data.reply.match(/(\d+) available/);
  assert.ok(m, 'reply contains availability');
  assert.equal(Number(m[1]), dbPart.available_qty, 'AI availability matches DB');
});

test('AI action flow: preview → confirm → single-use audit trail', async () => {
  const worker = await login(...demoUsers.worker);
  const chat = await api('POST', '/api/ai/chat', { token: worker.token, body: { message: 'Schedule a maintenance inspection for the conveyor tomorrow.' } });
  assert.equal(chat.status, 200);
  const action = chat.json.data.pendingActions[0];
  assert.ok(action, 'pending action returned');
  assert.ok(action.confirmToken, 'confirm token present');
  assert.match(action.label, /Conveyor Belt Sys C5/);

  const confirmed = await api('POST', '/api/ai/actions/confirm', { token: worker.token, body: { token: action.confirmToken } });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.data.kind, 'create_task');
  assert.equal(confirmed.json.data.result.machine_id, 'mach_conveyor');

  // single-use
  const again = await api('POST', '/api/ai/actions/confirm', { token: worker.token, body: { token: action.confirmToken } });
  assert.equal(again.status, 409);

  // audited
  const admin = await login(...demoUsers.admin);
  const audit = await api('GET', '/api/admin/audit?action=AI.ACTION_EXECUTE', { token: admin.token });
  assert.ok(audit.json.data.data.length >= 1);
});

test('AI respects permissions (viewer gets no action preview)', async () => {
  const viewer = await login(...demoUsers.viewer);
  const chat = await api('POST', '/api/ai/chat', { token: viewer.token, body: { message: 'Schedule a maintenance inspection for the conveyor tomorrow.' } });
  // viewer cannot create tasks → the tool returns permission denied, no preview
  assert.equal(chat.json.data.pendingActions.length, 0);
});

// ------------------------------------------------------------ admin
test('admin can manage users and audit', async () => {
  const admin = await login(...demoUsers.admin);
  const users = await api('GET', '/api/admin/users', { token: admin.token });
  assert.equal(users.status, 200);
  assert.ok(users.json.data.data.length >= 6);

  const created = await api('POST', '/api/admin/users', {
    token: admin.token,
    body: { email: 'newuser@smartplant.local', display_name: 'New User', role: 'TECHNICIAN', password: 'Password123!' },
  });
  assert.equal(created.status, 201);

  const updated = await api('PATCH', `/api/admin/users/${created.json.data.id}`, { token: admin.token, body: { role: 'WORKER' } });
  assert.equal(updated.json.data.role, 'WORKER');

  const health = await api('GET', '/api/admin/health', { token: admin.token });
  assert.equal(health.status, 200);
  assert.ok(health.json.data.counts.machines >= 16);
});
