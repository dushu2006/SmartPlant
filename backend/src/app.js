'use strict';

/**
 * SmartPlant HTTP API (PRD §24–25). All endpoints:
 * validate input → authenticate → authorize → operate → structured errors.
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
const logger = require('./logger');
const { errors, AppError } = require('./errors');
const auth = require('./auth');
const { can } = require('@smartplant/shared');

const machinesStore = require('./store/machines');
const telemetryStore = require('./store/telemetry');
const alertsStore = require('./store/alerts');
const opsStore = require('./store/ops');
const inventoryStore = require('./store/inventory');
const aiStore = require('./store/ai');
const auditStore = require('./store/audit');
const usersStore = require('./store/users');

const analytics = require('./services/analytics');
const telemetryService = require('./services/telemetry');
const alertsService = require('./services/alerts');
const maintenanceService = require('./services/maintenance');
const schedulingService = require('./services/scheduling');
const inventoryService = require('./services/inventory');
const reportsService = require('./services/reports');
const notificationsService = require('./services/notifications');
const { audit } = require('./services/audit');

let alertEngine = null;
function setAlertEngine(engine) {
  alertEngine = engine;
}

// ------------------------------------------------------------------ utils
function pageParams(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
  return { page, pageSize };
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// In-memory idempotency (PRD §25). Production: Redis with TTL.
const idempotencyStore = new Map();
function idempotent(fn) {
  return (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key) return fn(req, res, next);
    const full = `${req.user?.id || 'anon'}:${key}`;
    const hit = idempotencyStore.get(full);
    if (hit && hit.expires > Date.now()) return res.status(hit.status).json(hit.body);
    const origJson = res.json.bind(res);
    res.json = (body) => {
      idempotencyStore.set(full, { status: res.statusCode, body, expires: Date.now() + 3600000 });
      return origJson(body);
    };
    return fn(req, res, next);
  };
}

// ------------------------------------------------------------ rate limiting
const ipHits = new Map();
function generalRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = ipHits.get(ip) || { count: 0, resetAt: now + 60000 };
  if (entry.resetAt < now) {
    entry.count = 0;
    entry.resetAt = now + 60000;
  }
  entry.count++;
  ipHits.set(ip, entry);
  if (entry.count > 600) return next(errors.rateLimited());
  next();
}

const aiHits = new Map();
function aiRateLimit(req, res, next) {
  const userId = req.user?.id || 'anon';
  const now = Date.now();
  const entry = aiHits.get(userId) || { count: 0, resetAt: now + 60000 };
  if (entry.resetAt < now) {
    entry.count = 0;
    entry.resetAt = now + 60000;
  }
  entry.count++;
  aiHits.set(userId, entry);
  if (entry.count > 30) return next(errors.rateLimited('AI rate limit reached. Try again in a minute.'));
  next();
}

// ------------------------------------------------------------------ app
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  // request id + structured logging
  app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('x-request-id', req.id);
    const started = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api') || req.path.startsWith('/health')) {
        logger.debug('http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started, requestId: req.id, user: req.user?.id });
      }
    });
    next();
  });

  // security headers (production hardening documented in docs/SECURITY.md)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // CORS
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key,X-Request-Id');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(generalRateLimit);

  // ------------------------------------------------------------ health
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      uptime_s: Math.round(process.uptime()),
      mode: config.demoMode ? 'demo' : 'production',
      telemetry_source: config.simulateTelemetry ? 'simulator' : 'device',
      db: path.basename(config.dbPath),
      ai_engine: require('./ai/llm').resolveEngine() || 'fallback-deterministic',
    });
  });

  // ------------------------------------------------------------ auth
  app.post('/api/auth/login', (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      const result = auth.login({ email, password, ip: req.ip, userAgent: req.headers['user-agent'] });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/auth/me', auth.requireAuth, (req, res) => {
    res.json({ data: { user: req.user, demo_mode: config.demoMode } });
  });

  app.post('/api/auth/refresh', auth.requireAuth, (req, res) => {
    res.json({ data: auth.refreshToken(req.user) });
  });

  app.post('/api/auth/logout', auth.requireAuth, (req, res) => {
    auth.logout(req.user.id);
    res.json({ data: { ok: true } });
  });

  app.post('/api/auth/change-password', auth.requireAuth, (req, res, next) => {
    try {
      const { current_password, new_password } = req.body || {};
      const token = auth.changePassword(req.user.id, current_password, new_password);
      res.json({ data: { token } });
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------ dashboard
  app.get('/api/dashboard', auth.requireAuth, auth.requirePermission('dashboard.view'), wrap(async (req, res) => {
    const machines = machinesStore.allMachines();
    const latestAll = telemetryStore.latestForAll();
    const now = Date.now();

    let totalPower = 0;
    let activeMachines = 0;
    let staleMachines = 0;
    const rows = machines.map((m) => {
      const l = latestAll[m.id] || {};
      const temp = l.temperature_c ? { value: l.temperature_c.value, ts: l.temperature_c.ts, source: l.temperature_c.source, quality: l.temperature_c.quality } : null;
      const power = l.power_kw ? { value: l.power_kw.value, ts: l.power_kw.ts, source: l.power_kw.source, quality: l.power_kw.quality } : null;
      const freshness = temp || power ? Math.round((now - new Date((temp || power).ts).getTime()) / 1000) : null;
      if (m.status === 'RUNNING') {
        activeMachines++;
        if (power) totalPower += power.value;
      }
      if (m.status === 'RUNNING' && freshness !== null && freshness > config.telemetryStaleMin * 60) staleMachines++;
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        status: m.status,
        image: m.image,
        temperature_c: temp,
        power_kw: power,
        data_freshness_seconds: freshness,
        health_score: analytics.healthScore(m),
      };
    });

    const energyToday = analytics.fleetEnergyTodayKwh();
    const activeAlerts = alertsStore.listActive({ pageSize: 10 }).data;
    const upcoming = opsStore.upcomingTasks(8);
    const totalMachines = machines.length;

    res.json({
      data: {
        kpis: {
          current_load_kw: Math.round(totalPower * 100) / 100,
          active_machines: activeMachines,
          total_machines: totalMachines,
          stale_machines: staleMachines,
          energy_today_kwh: Math.round(energyToday * 100) / 100,
          cost_today_usd: Math.round(energyToday * config.tariffUsdPerKwh * 100) / 100,
          monthly_estimate_usd: Math.round(
            machines.reduce((acc, m) => acc + analytics.monthlyEstimateUsd(m.id), 0) * 100,
          ) / 100,
          active_alerts: activeAlerts.length,
          critical_alerts: activeAlerts.filter((a) => a.severity === 'CRITICAL').length,
          unread_notifications: auditStore.countUnread(req.user.id),
          mode: config.demoMode ? 'demo' : 'production',
        },
        machines: rows,
        active_alerts: activeAlerts.map((a) => ({ ...a, machine_name: machinesStore.findById(a.machine_id)?.name })),
        upcoming_tasks: upcoming.map((t) => ({ ...t, machine_name: t.machine_name })),
        energy_series: energySeries(24),
        temperature_series: temperatureSeries(24),
      },
    });
  }));

  function energySeries(hours) {
    const machines = machinesStore.allMachines();
    const from = new Date(Date.now() - hours * 3600000).toISOString();
    const buckets = new Map();
    for (const m of machines) {
      const rows = telemetryStore.readingsBetween(m.id, 'power_kw', from, new Date().toISOString());
      for (let i = 1; i < rows.length; i++) {
        const dtH = (new Date(rows[i].ts) - new Date(rows[i - 1].ts)) / 3600000;
        if (dtH <= 0 || dtH > 2) continue;
        const energy = ((rows[i - 1].value + rows[i].value) / 2) * dtH;
        const bucket = Math.floor(new Date(rows[i].ts).getTime() / 1800000) * 1800000;
        const key = new Date(bucket).toISOString();
        buckets.set(key, (buckets.get(key) || 0) + energy);
      }
    }
    return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ts, value]) => ({ ts, value: Math.round(value * 100) / 100 }));
  }

  function temperatureSeries(hours) {
    const machines = machinesStore.allMachines();
    const from = new Date(Date.now() - hours * 3600000).toISOString();
    const buckets = new Map();
    for (const m of machines) {
      const rows = telemetryStore.readingsBetween(m.id, 'temperature_c', from, new Date().toISOString());
      for (const r of rows) {
        const bucket = Math.floor(new Date(r.ts).getTime() / 1800000) * 1800000;
        const key = new Date(bucket).toISOString();
        const entry = buckets.get(key) || { sum: 0, n: 0 };
        entry.sum += r.value;
        entry.n++;
        buckets.set(key, entry);
      }
    }
    return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ts, e]) => ({ ts, value: Math.round((e.sum / e.n) * 10) / 10 }));
  }

  // ------------------------------------------------------------ machines
  app.get('/api/machines', auth.requireAuth, auth.requirePermission('machines.view'), wrap(async (req, res) => {
    const { page, pageSize } = pageParams(req);
    const result = machinesStore.list({ status: req.query.status, plantId: req.query.plant_id, search: req.query.search, page, pageSize });
    const latestAll = telemetryStore.latestForAll();
    const now = Date.now();
    result.data = result.data.map((m) => {
      const l = latestAll[m.id] || {};
      const freshness = l.temperature_c || l.power_kw ? Math.round((now - new Date((l.temperature_c || l.power_kw).ts).getTime()) / 1000) : null;
      return {
        ...m,
        latest: {
          temperature_c: l.temperature_c ? { value: l.temperature_c.value, ts: l.temperature_c.ts, source: l.temperature_c.source } : null,
          power_kw: l.power_kw ? { value: l.power_kw.value, ts: l.power_kw.ts, source: l.power_kw.source } : null,
          load_pct: l.load_pct ? { value: l.load_pct.value, ts: l.load_pct.ts } : null,
          data_freshness_seconds: freshness,
        },
        health_score: analytics.healthScore(m),
        active_alerts: alertsStore.listActive({ machineId: m.id, pageSize: 10 }).data.length,
      };
    });
    res.json({ data: result });
  }));

  app.get('/api/machines/:id', auth.requireAuth, auth.requirePermission('machines.view'), wrap(async (req, res) => {
    const machine = machinesStore.findById(req.params.id);
    if (!machine) throw errors.notFound('Machine not found.');
    res.json({ data: analytics.machineOverview(machine) });
  }));

  app.get('/api/machines/:id/telemetry', auth.requireAuth, auth.requirePermission('telemetry.view'), wrap(async (req, res) => {
    const machine = machinesStore.findById(req.params.id);
    if (!machine) throw errors.notFound('Machine not found.');
    const { agg = 'raw', bucketMinutes = 30, from, to, limit } = req.query;
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const fromIso = from || new Date(Date.now() - hours * 3600000).toISOString();
    const result = telemetryStore.query({
      machineId: machine.id,
      metric: req.query.metric,
      from: fromIso,
      to: to || new Date().toISOString(),
      agg,
      bucketMinutes: parseInt(bucketMinutes, 10) || 30,
      limit: parseInt(limit, 10) || 5000,
    });
    res.json({ data: result });
  }));

  app.get('/api/machines/:id/alerts', auth.requireAuth, auth.requirePermission('alerts.view'), wrap(async (req, res) => {
    const machine = machinesStore.findById(req.params.id);
    if (!machine) throw errors.notFound('Machine not found.');
    const { page, pageSize } = pageParams(req);
    const result = alertsStore.list({ machineId: machine.id, page, pageSize });
    res.json({ data: result });
  }));

  app.get('/api/machines/:id/maintenance', auth.requireAuth, auth.requirePermission('maintenance.view'), wrap(async (req, res) => {
    const machine = machinesStore.findById(req.params.id);
    if (!machine) throw errors.notFound('Machine not found.');
    res.json({ data: opsStore.listMaintenanceEvents({ machineId: machine.id, limit: 100 }) });
  }));

  // ------------------------------------------------------------ telemetry
  app.get('/api/telemetry/latest', auth.requireAuth, auth.requirePermission('telemetry.view'), wrap(async (req, res) => {
    if (req.query.machine_id) {
      res.json({ data: telemetryStore.latestForMachine(req.query.machine_id) });
    } else {
      res.json({ data: telemetryStore.latestForAll() });
    }
  }));

  /**
   * Device/edge ingestion endpoint. In a real deployment this is called by
   * the IoT gateway with device credentials (mTLS or device token); here it
   * requires telemetry.ingest permission. Idempotency via dedupe keys.
   */
  app.post('/api/telemetry/ingest', auth.requireAuth, auth.requirePermission('telemetry.ingest'), idempotent(wrap(async (req, res) => {
    const result = telemetryService.ingest(req.body?.readings || req.body, {});
    res.json({ data: result });
  })));

  // ------------------------------------------------------------ alerts
  app.get('/api/alerts', auth.requireAuth, auth.requirePermission('alerts.view'), wrap(async (req, res) => {
    const { page, pageSize } = pageParams(req);
    const statuses = req.query.status ? String(req.query.status).split(',') : undefined;
    const result = alertsStore.list({
      machineId: req.query.machine_id,
      severity: req.query.severity,
      type: req.query.type,
      statuses,
      from: req.query.from,
      to: req.query.to,
      page,
      pageSize,
    });
    result.data = result.data.map((a) => ({ ...a, machine_name: machinesStore.findById(a.machine_id)?.name || null }));
    res.json({ data: result });
  }));

  app.post('/api/alerts/:id/acknowledge', auth.requireAuth, auth.requirePermission('alerts.ack'), idempotent(wrap(async (req, res) => {
    res.json({ data: alertsService.acknowledgeAlert(req.params.id, req.user.id) });
  })));

  app.post('/api/alerts/:id/resolve', auth.requireAuth, auth.requirePermission('alerts.resolve'), idempotent(wrap(async (req, res) => {
    res.json({ data: alertsService.resolveAlert(req.params.id, req.user.id) });
  })));

  app.post('/api/alerts/:id/dismiss', auth.requireAuth, auth.requirePermission('alerts.dismiss'), idempotent(wrap(async (req, res) => {
    res.json({ data: alertsService.dismissAlert(req.params.id, req.user.id) });
  })));

  // ------------------------------------------------------------ tasks
  app.get('/api/tasks', auth.requireAuth, auth.requirePermission('tasks.view'), wrap(async (req, res) => {
    const { page, pageSize } = pageParams(req);
    const result = opsStore.listTasks({
      machineId: req.query.machine_id,
      status: req.query.status,
      assignedTo: req.query.assigned_to,
      priority: req.query.priority,
      dueBefore: req.query.due_before,
      dueAfter: req.query.due_after,
      page,
      pageSize,
    });
    res.json({ data: result });
  }));

  app.post('/api/tasks', auth.requireAuth, auth.requirePermission('tasks.create'), idempotent(wrap(async (req, res) => {
    const task = schedulingService.createTask({
      machineId: req.body.machine_id,
      taskType: req.body.task_type,
      title: req.body.title,
      description: req.body.description,
      dueAt: req.body.due_at,
      recurrence: req.body.recurrence,
      recurrenceInterval: req.body.recurrence_interval,
      priority: req.body.priority,
      assignedTo: req.body.assigned_to,
      createdBy: req.user.id,
    });
    res.status(201).json({ data: task });
  })));

  app.post('/api/tasks/:id/assign', auth.requireAuth, auth.requirePermission('tasks.assign'), idempotent(wrap(async (req, res) => {
    res.json({ data: schedulingService.assignTask(req.params.id, req.body.assigned_to, req.user.id) });
  })));

  app.post('/api/tasks/:id/complete', auth.requireAuth, auth.requirePermission('tasks.complete'), idempotent(wrap(async (req, res) => {
    res.json({ data: schedulingService.completeTask(req.params.id, req.user.id) });
  })));

  app.post('/api/tasks/:id/cancel', auth.requireAuth, auth.requirePermission('tasks.complete'), idempotent(wrap(async (req, res) => {
    res.json({ data: schedulingService.cancelTask(req.params.id, req.user.id) });
  })));

  // ------------------------------------------------------------ maintenance
  app.get('/api/maintenance-requests', auth.requireAuth, auth.requirePermission('maintenance.view'), wrap(async (req, res) => {
    const { page, pageSize } = pageParams(req);
    const result = opsStore.listMaintenanceRequests({
      machineId: req.query.machine_id,
      status: req.query.status,
      priority: req.query.priority,
      assignedTo: req.query.assigned_to,
      page,
      pageSize,
    });
    res.json({ data: result });
  }));

  app.post('/api/maintenance-requests', auth.requireAuth, auth.requirePermission('maintenance.create'), idempotent(wrap(async (req, res) => {
    const req_ = maintenanceService.createRequest({
      machineId: req.body.machine_id,
      issue: req.body.issue,
      priority: req.body.priority,
      requesterId: req.user.id,
    });
    res.status(201).json({ data: req_ });
  })));

  app.post('/api/maintenance-requests/:id/triage', auth.requireAuth, auth.requirePermission('maintenance.triage'), idempotent(wrap(async (req, res) => {
    res.json({ data: maintenanceService.triageRequest(req.params.id, req.body.ai_triage, req.user.id) });
  })));

  app.post('/api/maintenance-requests/:id/assign', auth.requireAuth, auth.requirePermission('maintenance.assign'), idempotent(wrap(async (req, res) => {
    res.json({ data: maintenanceService.assignTechnician(req.params.id, req.body.technician_id, req.user.id) });
  })));

  app.post('/api/maintenance-requests/:id/start', auth.requireAuth, auth.requirePermission('maintenance.complete'), idempotent(wrap(async (req, res) => {
    res.json({ data: maintenanceService.startWork(req.params.id, req.user.id) });
  })));

  app.post('/api/maintenance-requests/:id/verify', auth.requireAuth, auth.requirePermission('maintenance.complete'), idempotent(wrap(async (req, res) => {
    res.json({ data: maintenanceService.submitVerification(req.params.id, req.user.id) });
  })));

  app.post('/api/maintenance-requests/:id/complete', auth.requireAuth, auth.requirePermission('maintenance.complete'), idempotent(wrap(async (req, res) => {
    res.json({ data: maintenanceService.completeRequest(req.params.id, { ...req.body, actorId: req.user.id }) });
  })));

  app.post('/api/maintenance-requests/:id/cancel', auth.requireAuth, auth.requirePermission('maintenance.complete'), idempotent(wrap(async (req, res) => {
    res.json({ data: maintenanceService.cancelRequest(req.params.id, req.user.id) });
  })));

  app.get('/api/maintenance-events', auth.requireAuth, auth.requirePermission('maintenance.view'), wrap(async (req, res) => {
    res.json({ data: opsStore.listMaintenanceEvents({ machineId: req.query.machine_id, limit: 200 }) });
  }));

  // ------------------------------------------------------------ inventory
  app.get('/api/parts', auth.requireAuth, auth.requirePermission('inventory.view'), wrap(async (req, res) => {
    const { page, pageSize } = pageParams(req);
    const result = inventoryStore.listParts({ search: req.query.search, lowStock: req.query.low_stock === 'true', page, pageSize });
    res.json({ data: result });
  }));

  app.post('/api/parts', auth.requireAuth, auth.requirePermission('inventory.manage'), idempotent(wrap(async (req, res) => {
    const part = inventoryService.createPart(req.body, req.user.id);
    res.status(201).json({ data: part });
  })));

  app.post('/api/parts/:id/restock', auth.requireAuth, auth.requirePermission('inventory.manage'), idempotent(wrap(async (req, res) => {
    res.json({ data: inventoryService.restockPart(req.params.id, req.body.quantity, req.user.id) });
  })));

  app.get('/api/machines/:id/parts', auth.requireAuth, auth.requirePermission('inventory.view'), wrap(async (req, res) => {
    const machine = machinesStore.findById(req.params.id);
    if (!machine) throw errors.notFound('Machine not found.');
    res.json({ data: inventoryStore.listPartsForMachine(machine.id) });
  }));

  app.get('/api/spare-requests', auth.requireAuth, auth.requirePermission('inventory.view'), wrap(async (req, res) => {
    const { page, pageSize } = pageParams(req);
    const result = inventoryStore.listSpareRequests({
      status: req.query.status,
      machineId: req.query.machine_id,
      requesterId: req.user.role === 'ADMIN' || req.user.role === 'MANAGER' ? req.query.requester_id : req.user.id,
      page,
      pageSize,
    });
    res.json({ data: result });
  }));

  app.post('/api/spare-requests', auth.requireAuth, auth.requirePermission('spare.request'), idempotent(wrap(async (req, res) => {
    const request = inventoryService.createSpareRequest({
      machineId: req.body.machine_id,
      partId: req.body.part_id,
      quantity: req.body.quantity,
      eta: req.body.eta,
      requesterId: req.user.id,
    });
    res.status(201).json({ data: request });
  })));

  app.post('/api/spare-requests/:id/approve', auth.requireAuth, auth.requirePermission('spare.approve'), idempotent(wrap(async (req, res) => {
    res.json({ data: inventoryService.approveSpareRequest(req.params.id, req.user.id) });
  })));

  app.post('/api/spare-requests/:id/reject', auth.requireAuth, auth.requirePermission('spare.approve'), idempotent(wrap(async (req, res) => {
    res.json({ data: inventoryService.rejectSpareRequest(req.params.id, req.user.id) });
  })));

  app.post('/api/spare-requests/:id/deliver', auth.requireAuth, auth.requirePermission('inventory.manage'), idempotent(wrap(async (req, res) => {
    res.json({ data: inventoryService.deliverSpareRequest(req.params.id, req.user.id) });
  })));

  app.post('/api/spare-requests/:id/use', auth.requireAuth, auth.requirePermission('inventory.manage'), idempotent(wrap(async (req, res) => {
    res.json({ data: inventoryService.markUsedSpareRequest(req.params.id, req.user.id) });
  })));

  app.post('/api/spare-requests/:id/cancel', auth.requireAuth, auth.requirePermission('spare.request'), idempotent(wrap(async (req, res) => {
    res.json({ data: inventoryService.cancelSpareRequest(req.params.id, req.user.id) });
  })));

  // ------------------------------------------------------------ documents
  app.get('/api/documents', auth.requireAuth, auth.requirePermission('documents.view'), wrap(async (req, res) => {
    const { page, pageSize } = pageParams(req);
    const result = aiStore.listDocuments({ machineId: req.query.machine_id, type: req.query.type, search: req.query.search, page, pageSize });
    res.json({ data: result });
  }));

  app.post('/api/documents', auth.requireAuth, auth.requirePermission('documents.upload'), idempotent(wrap(async (req, res) => {
    const { machine_id, type, title, content, filename } = req.body || {};
    if (!machine_id) throw errors.validation('machine_id is required');
    if (!machinesStore.findById(machine_id)) throw errors.notFound('Machine not found.');
    if (!title || !title.trim()) throw errors.validation('title is required');
    if (!content) throw errors.validation('content is required');

    const size = Buffer.byteLength(String(content), 'utf8');
    if (size > 2 * 1024 * 1024) throw errors.badRequest('Document content exceeds the 2 MB limit.');

    // Validate upload (PRD §59): text extraction for .txt/.md/.csv; others stored as-is with a note.
    const ext = filename ? path.extname(filename).toLowerCase() : '.txt';
    const textExts = ['.txt', '.md', '.csv', '.log'];
    const doc = aiStore.createDocument({
      id: crypto.randomUUID(),
      machine_id,
      type: type || 'OTHER',
      title: title.trim(),
      storage_url: filename ? `uploads/${crypto.randomUUID()}${ext}` : null,
      extracted_text: textExts.includes(ext) ? String(content).slice(0, 200000) : null,
      uploaded_by: req.user.id,
    });
    audit({ actorId: req.user.id, action: 'DOCUMENT.UPLOAD', entityType: 'machine_document', entityId: doc.id, after: { machine_id, title: doc.title, type: doc.type } });
    res.status(201).json({ data: doc });
  })));

  app.delete('/api/documents/:id', auth.requireAuth, auth.requirePermission('documents.upload'), wrap(async (req, res) => {
    const doc = aiStore.findDocument(req.params.id);
    if (!doc) throw errors.notFound('Document not found.');
    aiStore.deleteDocument(doc.id);
    audit({ actorId: req.user.id, action: 'DOCUMENT.DELETE', entityType: 'machine_document', entityId: doc.id, before: { title: doc.title } });
    res.json({ data: { ok: true } });
  }));

  // ------------------------------------------------------------ notifications
  app.get('/api/notifications', auth.requireAuth, wrap(async (req, res) => {
    const { page, pageSize } = pageParams(req);
    const result = auditStore.listNotifications({ userId: req.user.id, unreadOnly: req.query.unread === 'true', page, pageSize });
    res.json({ data: result });
  }));

  app.post('/api/notifications/:id/read', auth.requireAuth, wrap(async (req, res) => {
    res.json({ data: { ok: auditStore.markRead(req.params.id, req.user.id) > 0 } });
  }));

  app.post('/api/notifications/read-all', auth.requireAuth, wrap(async (req, res) => {
    res.json({ data: { ok: true, updated: auditStore.markAllRead(req.user.id) } });
  }));

  // ------------------------------------------------------------ AI
  app.post('/api/ai/chat', auth.requireAuth, auth.requirePermission('ai.chat'), aiRateLimit, idempotent(wrap(async (req, res) => {
    const { conversation_id, message, mode } = req.body || {};
    const result = await require('./ai/orchestrator').chat({ user: req.user, conversationId: conversation_id, message, mode });
    res.json({ data: result });
  })));

  app.get('/api/ai/conversations', auth.requireAuth, auth.requirePermission('ai.chat'), wrap(async (req, res) => {
    res.json({ data: aiStore.listConversations(req.user.id) });
  }));

  app.get('/api/ai/conversations/:id/messages', auth.requireAuth, auth.requirePermission('ai.chat'), wrap(async (req, res) => {
    const conv = aiStore.findConversation(req.params.id);
    if (!conv) throw errors.notFound('Conversation not found.');
    if (conv.user_id !== req.user.id && req.user.role !== 'ADMIN') throw errors.forbidden();
    res.json({ data: aiStore.listMessages(conv.id) });
  }));

  app.delete('/api/ai/conversations/:id', auth.requireAuth, auth.requirePermission('ai.chat'), wrap(async (req, res) => {
    const conv = aiStore.findConversation(req.params.id);
    if (!conv) throw errors.notFound('Conversation not found.');
    if (conv.user_id !== req.user.id && req.user.role !== 'ADMIN') throw errors.forbidden();
    aiStore.deleteConversation(conv.id);
    audit({ actorId: req.user.id, action: 'AI.CHAT', entityType: 'ai_conversation', entityId: conv.id, metadata: { deleted: true } });
    res.json({ data: { ok: true } });
  }));

  app.post('/api/ai/actions/confirm', auth.requireAuth, auth.requirePermission('ai.chat'), idempotent(wrap(async (req, res) => {
    const { token } = req.body || {};
    if (!token) throw errors.validation('token is required');
    const result = await require('./ai/orchestrator').confirmAction({ token, user: req.user });
    res.json({ data: result });
  })));

  app.get('/api/ai/insights', auth.requireAuth, auth.requirePermission('ai.insights.view'), wrap(async (req, res) => {
    const { page, pageSize } = pageParams(req);
    const result = aiStore.listInsights({ machineId: req.query.machine_id, category: req.query.category, severity: req.query.severity, page, pageSize });
    res.json({ data: result });
  }));

  app.post('/api/ai/insights/:id/feedback', auth.requireAuth, auth.requirePermission('ai.insights.view'), wrap(async (req, res) => {
    const insight = aiStore.findInsight(req.params.id);
    if (!insight) throw errors.notFound('Insight not found.');
    const { feedback } = req.body || {};
    const valid = ['useful', 'not_useful', 'correct', 'incorrect', 'accepted', 'rejected', 'partial'];
    if (!valid.includes(feedback)) throw errors.validation(`feedback must be one of: ${valid.join(', ')}`);
    const updated = aiStore.feedbackInsight(insight.id, feedback);
    audit({ actorId: req.user.id, action: 'AI.INSIGHT_FEEDBACK', entityType: 'ai_insight', entityId: insight.id, after: { feedback } });
    res.json({ data: updated });
  }));

  app.get('/api/admin/ai/usage', auth.requireAuth, auth.requirePermission('ai.usage.view'), wrap(async (req, res) => {
    const since = req.query.since || new Date(Date.now() - 30 * 86400000).toISOString();
    res.json({ data: { summary: aiStore.usageSummary(since), byModel: aiStore.usageByModel(since) } });
  }));

  // ------------------------------------------------------------ reports
  app.get('/api/reports/:kind', auth.requireAuth, auth.requirePermission('reports.export'), wrap(async (req, res) => {
    const format = req.query.format || 'csv';
    const { buffer, mime, filename } = reportsService.exportReport(req.params.kind, format, req.user.id);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  }));

  // ------------------------------------------------------------ admin
  app.get('/api/admin/users', auth.requireAuth, auth.requirePermission('users.view'), wrap(async (req, res) => {
    const { page, pageSize } = pageParams(req);
    const result = usersStore.list({ search: req.query.search, role: req.query.role, status: req.query.status, page, pageSize });
    res.json({ data: { data: result.rows, meta: { total: result.total, page, pageSize } } });
  }));

  app.post('/api/admin/users', auth.requireAuth, auth.requirePermission('users.manage'), idempotent(wrap(async (req, res) => {
    const { email, display_name, role, password } = req.body || {};
    if (!email || !display_name || !role || !password) throw errors.validation('email, display_name, role and password are required');
    if (!['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'].includes(role)) throw errors.validation('invalid role');
    if (String(password).length < 8) throw errors.validation('password must be at least 8 characters');
    if (usersStore.findByEmail(email)) throw errors.conflict('A user with this email already exists.');
    const { hashPassword } = require('./crypto');
    const user = usersStore.create({
      id: crypto.randomUUID(),
      email: String(email).toLowerCase(),
      passwordHash: hashPassword(password),
      displayName: display_name,
      role,
    });
    audit({ actorId: req.user.id, action: 'USER.CREATE', entityType: 'user', entityId: user.id, after: { email: user.email, role: user.role } });
    res.status(201).json({ data: user });
  })));

  app.patch('/api/admin/users/:id', auth.requireAuth, auth.requirePermission('users.manage'), wrap(async (req, res) => {
    const user = usersStore.findById(req.params.id);
    if (!user) throw errors.notFound('User not found.');
    const before = { role: user.role, status: user.status, display_name: user.display_name };
    const fields = {};
    if (req.body.display_name !== undefined) fields.displayName = req.body.display_name;
    if (req.body.role !== undefined) {
      if (!['ADMIN', 'MANAGER', 'SUPERVISOR', 'TECHNICIAN', 'WORKER', 'VIEWER'].includes(req.body.role)) throw errors.validation('invalid role');
      if (req.user.id === user.id && req.body.role !== user.role) throw errors.conflict('You cannot change your own role.');
      fields.role = req.body.role;
    }
    if (req.body.status !== undefined) {
      if (!['ACTIVE', 'INACTIVE'].includes(req.body.status)) throw errors.validation('invalid status');
      if (req.user.id === user.id && req.body.status !== 'ACTIVE') throw errors.conflict('You cannot deactivate yourself.');
      fields.status = req.body.status;
    }
    const updated = usersStore.update(user.id, fields);
    if (fields.role && fields.role !== before.role) {
      audit({ actorId: req.user.id, action: 'USER.ROLE_CHANGE', entityType: 'user', entityId: user.id, before, after: { role: updated.role } });
      usersStore.bumpTokenVersion(user.id);
    } else {
      audit({ actorId: req.user.id, action: before.status !== updated.status ? (updated.status === 'INACTIVE' ? 'USER.DEACTIVATE' : 'USER.ACTIVATE') : 'USER.UPDATE', entityType: 'user', entityId: user.id, before, after: { role: updated.role, status: updated.status } });
    }
    res.json({ data: updated });
  }));

  app.post('/api/admin/users/:id/reset-password', auth.requireAuth, auth.requirePermission('users.manage'), idempotent(wrap(async (req, res) => {
    const user = usersStore.findById(req.params.id);
    if (!user) throw errors.notFound('User not found.');
    const { hashPassword } = require('./crypto');
    const tempPassword = crypto.randomBytes(6).toString('base64url');
    usersStore.update(user.id, { passwordHash: hashPassword(tempPassword) });
    usersStore.bumpTokenVersion(user.id);
    audit({ actorId: req.user.id, action: 'USER.UPDATE', entityType: 'user', entityId: user.id, metadata: { reset_password: true } });
    res.json({ data: { temporary_password: tempPassword } });
  })));

  app.get('/api/admin/audit', auth.requireAuth, auth.requirePermission('audit.view'), wrap(async (req, res) => {
    const { page, pageSize } = pageParams(req);
    const result = auditStore.listAudit({
      actorId: req.query.actor_id,
      action: req.query.action,
      entityType: req.query.entity_type,
      entityId: req.query.entity_id,
      from: req.query.from,
      to: req.query.to,
      page,
      pageSize,
    });
    res.json({ data: result });
  }));

  app.get('/api/admin/health', auth.requireAuth, auth.requirePermission('system.health'), wrap(async (req, res) => {
    const db = require('./db').getDb();
    const row = db.prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()").get();
    res.json({
      data: {
        uptime_s: Math.round(process.uptime()),
        mode: config.demoMode ? 'demo' : 'production',
        ai_engine: require('./ai/llm').resolveEngine() || 'fallback-deterministic',
        counts: {
          users: usersStore.count(),
          machines: machinesStore.allMachines().length,
          telemetry_readings: telemetryStore.countReadings(),
          telemetry_by_source: telemetryStore.countBySource(),
          active_alerts: alertsStore.countActive(),
          audit_events: auditStore.countAudit(),
          ai_insights: aiStore.activeInsightCount(),
        },
        db_bytes: row?.bytes || 0,
        recent_logs: logger.ring().slice(-50),
      },
    });
  }));

  // ------------------------------------------------------------ me
  app.get('/api/me', auth.requireAuth, (req, res) => {
    res.json({ data: { user: req.user, permissions: Object.entries(require('@smartplant/shared').PERMISSIONS).filter(([, roles]) => roles.includes(req.user.role)).map(([p]) => p) } });
  });

  app.patch('/api/me', auth.requireAuth, wrap(async (req, res) => {
    const fields = {};
    if (req.body.display_name !== undefined) fields.displayName = req.body.display_name;
    if (req.body.locale !== undefined) fields.locale = req.body.locale;
    const updated = usersStore.update(req.user.id, fields);
    res.json({ data: updated });
  }));

  // ------------------------------------------------------------ static frontend
  const dist = config.frontendDist;
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: config.isProd ? '1h' : 0 }));
    app.get(/^(?!\/api|\/health).*/, (_req, res) => {
      res.sendFile(path.join(dist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.json({ service: 'SmartPlant API', docs: '/api-docs', note: 'Frontend not built. Run: npm run build' });
    });
  }

  // ------------------------------------------------------------ error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error('request failed', { path: req.path, code: err.code, error: err.message });
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    logger.error('unhandled error', { path: req.path, error: err.message, stack: err.stack });
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } });
  });

  return app;
}

module.exports = { createApp, setAlertEngine };
