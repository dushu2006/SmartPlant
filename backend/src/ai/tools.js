'use strict';

/**
 * AI tool system (PRD §31–33). The LLM never touches the database directly:
 *   LLM → AI Tool → Backend API → Database
 * Every tool enforces the caller's permissions. Action tools NEVER execute
 * during chat — they return a preview that must be confirmed separately
 * (PRD §47–48), and confirmation re-checks permissions.
 */
const machinesStore = require('../store/machines');
const telemetryStore = require('../store/telemetry');
const alertsStore = require('../store/alerts');
const opsStore = require('../store/ops');
const inventoryStore = require('../store/inventory');
const aiStore = require('../store/ai');
const analytics = require('../services/analytics');
const { can } = require('@smartplant/shared');

// ------------------------------------------------------------- helpers
function resolveMachine(identifier) {
  if (!identifier) return null;
  const byId = machinesStore.findById(identifier);
  if (byId) return byId;
  const id2 = `mach_${String(identifier).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  const bySlug = machinesStore.findById(id2);
  if (bySlug) return bySlug;
  const all = machinesStore.allMachines();
  const needle = String(identifier).toLowerCase();
  return all.find((m) => m.name.toLowerCase().includes(needle) || needle.includes(m.name.toLowerCase())) || null;
}

function machineListSummary() {
  return machinesStore.allMachines().map((m) => {
    const latest = telemetryStore.latestForMachine(m.id);
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      status: m.status,
      temperature_c: latest.temperature_c?.value ?? null,
      power_kw: latest.power_kw?.value ?? null,
      data_freshness_seconds: freshnessOf(latest),
      health_score: analytics.healthScore(m),
    };
  });
}

function freshnessOf(latest) {
  const r = latest.temperature_c || latest.power_kw;
  if (!r) return null;
  return Math.max(0, Math.round((Date.now() - new Date(r.ts).getTime()) / 1000));
}

function fmt(iso) {
  return iso ? new Date(iso).toISOString() : null;
}

// ------------------------------------------------------------- registry
const TOOLS = [
  {
    name: 'list_machines',
    description: 'List all machines with current status, latest temperature/power, data freshness in seconds and health score.',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', description: 'Filter by status: RUNNING, IDLE, OFF, OFFLINE, MAINTENANCE, FAULT' } },
    },
    permission: 'machines.view',
    handler: (ctx, args) => {
      let list = machineListSummary();
      if (args.status) list = list.filter((m) => m.status === String(args.status).toUpperCase());
      return { content: JSON.stringify(list), summary: `listed ${list.length} machines` };
    },
  },
  {
    name: 'get_machine_status',
    description: 'Get the full current status of one machine: status, temperature, power, load, freshness, active alerts, health score, risk indicators, last maintenance.',
    parameters: {
      type: 'object',
      properties: { machine_id: { type: 'string', description: 'Machine id or name (e.g. "Primary Extruder")' } },
      required: ['machine_id'],
    },
    permission: 'machines.view',
    handler: (ctx, args) => {
      const m = resolveMachine(args.machine_id);
      if (!m) return { content: JSON.stringify({ error: 'Machine not found', hint: machineListSummary().map((x) => x.name) }), summary: 'machine not found' };
      const ov = analytics.machineOverview(m);
      return { content: JSON.stringify(ov), summary: `status of ${m.name}` };
    },
  },
  {
    name: 'get_machine_history',
    description: 'Get aggregated telemetry history for a machine (default: last 24h, 30-minute buckets).',
    parameters: {
      type: 'object',
      properties: {
        machine_id: { type: 'string' },
        metric: { type: 'string', enum: ['temperature_c', 'power_kw', 'load_pct', 'vibration_mm_s'] },
        hours: { type: 'number', description: 'How many hours back (1-168)' },
      },
      required: ['machine_id'],
    },
    permission: 'telemetry.view',
    handler: (ctx, args) => {
      const m = resolveMachine(args.machine_id);
      if (!m) return { content: JSON.stringify({ error: 'Machine not found' }), summary: 'machine not found' };
      const hours = Math.min(168, Math.max(1, Number(args.hours) || 24));
      const from = new Date(Date.now() - hours * 3600000).toISOString();
      const metrics = args.metric ? [args.metric] : ['temperature_c', 'power_kw'];
      const out = { machine: m.name, hours, series: {} };
      for (const metric of metrics) {
        const res = telemetryStore.query({ machineId: m.id, metric, from, agg: 'avg', bucketMinutes: 30 });
        out.series[metric] = res.data.map((r) => ({ ts: r.bucket_ts, value: Math.round(r.value * 100) / 100, samples: r.samples }));
        if (out.series[metric].length) {
          out.series[metric].push({ ts: 'now', value: telemetryStore.latestForMachine(m.id)[metric]?.value ?? null, samples: 1 });
        }
      }
      return { content: JSON.stringify(out), summary: `history of ${m.name} (${hours}h)` };
    },
  },
  {
    name: 'get_active_alerts',
    description: 'List active alerts, optionally for one machine.',
    parameters: {
      type: 'object',
      properties: { machine_id: { type: 'string' } },
    },
    permission: 'alerts.view',
    handler: (ctx, args) => {
      const m = args.machine_id ? resolveMachine(args.machine_id) : null;
      if (args.machine_id && !m) return { content: JSON.stringify({ error: 'Machine not found' }), summary: 'machine not found' };
      const res = alertsStore.listActive({ machineId: m ? m.id : null, pageSize: 50 });
      return { content: JSON.stringify(res.data.map((a) => ({ id: a.id, machine_id: a.machine_id, type: a.type, severity: a.severity, status: a.status, message: a.message, created_at: a.created_at }))), summary: `${res.data.length} active alerts` };
    },
  },
  {
    name: 'get_maintenance_history',
    description: 'Get maintenance events for a machine (past repairs, inspections, outcomes).',
    parameters: {
      type: 'object',
      properties: { machine_id: { type: 'string' }, limit: { type: 'number' } },
      required: ['machine_id'],
    },
    permission: 'maintenance.view',
    handler: (ctx, args) => {
      const m = resolveMachine(args.machine_id);
      if (!m) return { content: JSON.stringify({ error: 'Machine not found' }), summary: 'machine not found' };
      const rows = opsStore.listMaintenanceEvents({ machineId: m.id, limit: Math.min(50, Number(args.limit) || 10) });
      return { content: JSON.stringify(rows.map((r) => ({ id: r.id, type: r.type, diagnosis: r.diagnosis, action: r.action, outcome: r.outcome, completed_at: r.completed_at, notes: r.notes }))), summary: `${rows.length} maintenance events for ${m.name}` };
    },
  },
  {
    name: 'get_open_requests',
    description: 'List open maintenance/spare-part requests, optionally for one machine.',
    parameters: {
      type: 'object',
      properties: { machine_id: { type: 'string' }, kind: { type: 'string', enum: ['maintenance', 'spare'] } },
    },
    permission: 'maintenance.view',
    handler: (ctx, args) => {
      const m = args.machine_id ? resolveMachine(args.machine_id) : null;
      const open = ['OPEN', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'VERIFICATION', 'PENDING', 'APPROVED'];
      const out = [];
      if (!args.kind || args.kind === 'maintenance') {
        const res = opsStore.listMaintenanceRequests({ machineId: m ? m.id : null, pageSize: 100 });
        out.push(...res.data.filter((r) => open.includes(r.status)).map((r) => ({ kind: 'maintenance', id: r.id, machine: r.machine_name || r.machine_id, issue: r.issue, priority: r.priority, status: r.status })));
      }
      if (!args.kind || args.kind === 'spare') {
        const res = inventoryStore.listSpareRequests({ machineId: m ? m.id : null, pageSize: 100 });
        out.push(...res.data.filter((r) => ['PENDING', 'APPROVED'].includes(r.status)).map((r) => ({ kind: 'spare', id: r.id, machine: r.machine_name || r.machine_id, part: r.part_name, quantity: r.quantity, status: r.status })));
      }
      return { content: JSON.stringify(out), summary: `${out.length} open requests` };
    },
  },
  {
    name: 'get_spare_inventory',
    description: 'Get spare-part inventory. Supply machine_id to get only parts compatible with that machine. Includes stock, reserved, available, reorder level.',
    parameters: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Part name or SKU' }, machine_id: { type: 'string' } },
    },
    permission: 'inventory.view',
    handler: (ctx, args) => {
      let parts;
      if (args.machine_id) {
        const m = resolveMachine(args.machine_id);
        if (!m) return { content: JSON.stringify({ error: 'Machine not found' }), summary: 'machine not found' };
        parts = inventoryStore.listPartsForMachine(m.id);
      } else {
        parts = inventoryStore.listParts({ search: args.search, pageSize: 200 }).data;
      }
      const out = parts
        .filter((p) => !args.search || p.name.toLowerCase().includes(String(args.search).toLowerCase()) || p.sku.toLowerCase().includes(String(args.search).toLowerCase()))
        .map((p) => ({ id: p.id, sku: p.sku, name: p.name, stock_qty: p.stock_qty, reserved_qty: p.reserved_qty, available_qty: p.available_qty, reorder_level: p.reorder_level, supplier: p.supplier, low: p.available_qty <= p.reorder_level }));
      return { content: JSON.stringify(out), summary: `${out.length} parts` };
    },
  },
  {
    name: 'get_machine_documents',
    description: 'Get documents associated with a machine (manuals, SOPs, safety, troubleshooting).',
    parameters: {
      type: 'object',
      properties: { machine_id: { type: 'string' } },
      required: ['machine_id'],
    },
    permission: 'documents.view',
    handler: (ctx, args) => {
      const m = resolveMachine(args.machine_id);
      if (!m) return { content: JSON.stringify({ error: 'Machine not found' }), summary: 'machine not found' };
      const res = aiStore.listDocuments({ machineId: m.id, pageSize: 50 });
      return { content: JSON.stringify(res.data.map((d) => ({ id: d.id, type: d.type, title: d.title }))), summary: `${res.data.length} documents for ${m.name}` };
    },
  },
  {
    name: 'search_documents',
    description: 'Search machine documentation (manuals, SOPs, troubleshooting guides) and return the most relevant passages.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What you want to find' }, machine_id: { type: 'string' } },
      required: ['query'],
    },
    permission: 'documents.view',
    handler: (ctx, args) => {
      const m = args.machine_id ? resolveMachine(args.machine_id) : null;
      const hits = aiStore.searchDocuments({ machineId: m ? m.id : null, query: args.query, limit: 4 });
      return { content: JSON.stringify(hits), summary: `${hits.length} document passages` };
    },
  },
  {
    name: 'get_scheduled_tasks',
    description: 'List scheduled tasks (maintenance inspections etc.), optionally filtered by machine or status.',
    parameters: {
      type: 'object',
      properties: { machine_id: { type: 'string' }, status: { type: 'string' } },
    },
    permission: 'tasks.view',
    handler: (ctx, args) => {
      const m = args.machine_id ? resolveMachine(args.machine_id) : null;
      const res = opsStore.listTasks({ machineId: m ? m.id : null, status: args.status, pageSize: 100 });
      return { content: JSON.stringify(res.data.map((t) => ({ id: t.id, machine: t.machine_name || t.machine_id, title: t.title, due_at: t.due_at, recurrence: t.recurrence, priority: t.priority, status: t.status }))), summary: `${res.data.length} tasks` };
    },
  },
  {
    name: 'get_energy_usage',
    description: 'Get deterministic energy consumption and cost for a machine (today kWh, cost USD, monthly estimate).',
    parameters: {
      type: 'object',
      properties: { machine_id: { type: 'string' } },
      required: ['machine_id'],
    },
    permission: 'dashboard.view',
    handler: (ctx, args) => {
      const m = resolveMachine(args.machine_id);
      if (!m) return { content: JSON.stringify({ error: 'Machine not found' }), summary: 'machine not found' };
      return {
        content: JSON.stringify({
          machine: m.name,
          energy_today_kwh: Math.round(analytics.energyTodayKwh(m.id) * 100) / 100,
          cost_today_usd: Math.round(analytics.costTodayUsd(m.id) * 100) / 100,
          monthly_estimate_usd: Math.round(analytics.monthlyEstimateUsd(m.id) * 100) / 100,
          operating_hours_today: Math.round(analytics.operatingHoursToday(m.id) * 100) / 100,
        }),
        summary: `energy of ${m.name}`,
      };
    },
  },
  {
    name: 'analyze_machine',
    description: 'Run the deterministic machine analysis (health, risk indicators, active alerts, trend signals, recommended next steps).',
    parameters: {
      type: 'object',
      properties: { machine_id: { type: 'string' } },
      required: ['machine_id'],
    },
    permission: 'ai.chat',
    handler: (ctx, args) => {
      const m = resolveMachine(args.machine_id);
      if (!m) return { content: JSON.stringify({ error: 'Machine not found' }), summary: 'machine not found' };
      const { analyzeMachine } = require('./insights');
      const analysis = analyzeMachine(m);
      return { content: JSON.stringify(analysis), summary: `analysis of ${m.name}` };
    },
  },
  {
    name: 'explain_alert',
    description: 'Explain why an alert fired using telemetry, baseline and documents.',
    parameters: {
      type: 'object',
      properties: { alert_id: { type: 'string' } },
      required: ['alert_id'],
    },
    permission: 'alerts.view',
    handler: (ctx, args) => {
      const alert = alertsStore.findById(args.alert_id);
      if (!alert) return { content: JSON.stringify({ error: 'Alert not found' }), summary: 'alert not found' };
      const { explainAlert } = require('./insights');
      return { content: JSON.stringify(explainAlert(alert)), summary: `explanation of alert ${args.alert_id}` };
    },
  },
  {
    name: 'predict_maintenance',
    description: 'Predictive maintenance: risk indicators, health score, top signals and a recommended horizon. NOT a validated failure probability.',
    parameters: {
      type: 'object',
      properties: { machine_id: { type: 'string' } },
      required: ['machine_id'],
    },
    permission: 'ai.chat',
    handler: (ctx, args) => {
      const m = resolveMachine(args.machine_id);
      if (!m) return { content: JSON.stringify({ error: 'Machine not found' }), summary: 'machine not found' };
      const risk = analytics.riskAssessment(m);
      const analysis = require('./insights').analyzeMachine(m);
      return { content: JSON.stringify({ ...risk, recommended_horizon: risk.risk_level === 'HIGH' ? 'inspect within 7 days' : risk.risk_level === 'MEDIUM' ? 'inspect within 30 days' : 'routine schedule', next_steps: analysis.next_steps }), summary: `risk for ${m.name}` };
    },
  },
  {
    name: 'predict_machine',
    description: 'Forecast for one machine: estimated shutdown time (when it will turn off/stop) with its basis and confidence, plus a failure outlook over the coming weeks (how likely it goes wrong soon) from health, alerts, history and trend. Honest estimate — not a validated failure probability.',
    parameters: {
      type: 'object',
      properties: { machine_id: { type: 'string', description: 'Machine id or name' } },
      required: ['machine_id'],
    },
    permission: 'ai.chat',
    handler: (ctx, args) => {
      const m = resolveMachine(args.machine_id);
      if (!m) return { content: JSON.stringify({ error: 'Machine not found', hint: machineListSummary().map((x) => x.name) }), summary: 'machine not found' };
      const forecast = analytics.machineForecast(m);
      const latest = telemetryStore.latestForMachine(m.id);
      return {
        content: JSON.stringify({
          ...forecast,
          current: {
            temperature_c: latest.temperature_c?.value ?? null,
            power_kw: latest.power_kw?.value ?? null,
            data_freshness_seconds: freshnessOf(latest),
          },
        }),
        summary: `forecast for ${m.name}`,
      };
    },
  },
  {
    name: 'triage_ticket',
    description: 'Structure a free-text issue into machine, category, priority, symptoms and possible subsystems. Final priority always subject to business rules and human oversight.',
    parameters: {
      type: 'object',
      properties: { issue: { type: 'string' }, machine_id: { type: 'string' } },
      required: ['issue'],
    },
    permission: 'ai.chat',
    handler: (ctx, args) => {
      const m = args.machine_id ? resolveMachine(args.machine_id) : null;
      const { triageTicket } = require('./insights');
      const triage = triageTicket(args.issue, m);
      return { content: JSON.stringify(triage), summary: 'ticketed triage' };
    },
  },

  // ------------------------------------------------------- ACTION TOOLS
  // These NEVER mutate during chat. They return a preview + confirm token.
  {
    name: 'generate_machines_from_description',
    description: 'AI-designed plant layout: builds machine configurations (name, type, image, schedule, thresholds) from a natural-language description of equipment. Returns a preview; the user confirms before machines are created.',
    parameters: {
      type: 'object',
      properties: { description: { type: 'string', description: 'e.g. "3 extruders, 1 milling machine and a packaging line"' } },
      required: ['description'],
    },
    permission: 'machines.manage',
    action: true,
    handler: (ctx, args) => {
      const machinesService = require('../services/machines');
      const specs = machinesService.parseMachineDescription(args.description);
      if (!specs.length) {
        return { content: JSON.stringify({ error: 'Could not identify any machinery in that description. Describe equipment like "2 extruders and 1 conveyor".' }), summary: 'no machines parsed' };
      }
      return {
        preview: {
          kind: 'generate_machines_from_description',
          label: `Create ${specs.length} machine(s): ${specs.map((s) => s.name).join(', ')}`,
          params: { description: args.description, machines: specs },
        },
        content: JSON.stringify({ preview: 'generate_machines_from_description', count: specs.length, machines: specs.map((s) => ({ name: s.name, type: s.type, image: s.image, status: s.status, schedule: s.schedule })) }),
        summary: `parsed ${specs.length} machine(s) from description`,
      };
    },
  },
  {
    name: 'create_task',
    description: 'Schedule a maintenance task. Returns a preview that the user must confirm before it is created.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        machine_id: { type: 'string' },
        due_at: { type: 'string', description: 'ISO date-time' },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
        description: { type: 'string' },
      },
      required: ['title', 'machine_id', 'due_at'],
    },
    permission: 'tasks.create',
    action: true,
    handler: (ctx, args) => {
      const m = resolveMachine(args.machine_id);
      if (!m) return { content: JSON.stringify({ error: 'Machine not found' }), summary: 'machine not found' };
      const due = new Date(args.due_at);
      if (Number.isNaN(due.getTime())) return { content: JSON.stringify({ error: 'due_at must be a valid ISO date' }), summary: 'invalid due_at' };
      return {
        preview: {
          kind: 'create_task',
          label: `Schedule task "${args.title}" on ${m.name}`,
          params: { title: args.title, machine_id: m.id, due_at: due.toISOString(), priority: args.priority || 'MEDIUM', description: args.description || null },
        },
        content: JSON.stringify({ preview: 'create_task', machine: m.name, title: args.title, due_at: due.toISOString() }),
        summary: 'task preview created — awaiting confirmation',
      };
    },
  },
  {
    name: 'create_assistance_request',
    description: 'Create a maintenance/assistance request. Returns a preview that the user must confirm before it is created.',
    parameters: {
      type: 'object',
      properties: {
        machine_id: { type: 'string' },
        issue: { type: 'string' },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
      },
      required: ['machine_id', 'issue'],
    },
    permission: 'maintenance.create',
    action: true,
    handler: (ctx, args) => {
      const m = resolveMachine(args.machine_id);
      if (!m) return { content: JSON.stringify({ error: 'Machine not found' }), summary: 'machine not found' };
      const triage = require('./insights').triageTicket(args.issue, m);
      return {
        preview: {
          kind: 'create_assistance_request',
          label: `Create maintenance request on ${m.name}`,
          params: { machine_id: m.id, issue: args.issue, priority: args.priority || triage.priority },
        },
        content: JSON.stringify({ preview: 'create_assistance_request', machine: m.name, issue: args.issue, triage }),
        summary: 'assistance request preview created — awaiting confirmation',
      };
    },
  },
  {
    name: 'acknowledge_alert',
    description: 'Acknowledge an active alert. Returns a preview that the user must confirm.',
    parameters: {
      type: 'object',
      properties: { alert_id: { type: 'string' } },
      required: ['alert_id'],
    },
    permission: 'alerts.ack',
    action: true,
    handler: (ctx, args) => {
      const alert = alertsStore.findById(args.alert_id);
      if (!alert) return { content: JSON.stringify({ error: 'Alert not found' }), summary: 'alert not found' };
      if (!['DETECTED', 'ACTIVE', 'ACKNOWLEDGED'].includes(alert.status)) {
        return { content: JSON.stringify({ error: `Alert is already ${alert.status}` }), summary: 'alert not actionable' };
      }
      return {
        preview: {
          kind: 'acknowledge_alert',
          label: `Acknowledge alert: ${alert.type} (${alert.severity})`,
          params: { alert_id: alert.id },
        },
        content: JSON.stringify({ preview: 'acknowledge_alert', alert_id: alert.id }),
        summary: 'acknowledge preview created — awaiting confirmation',
      };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function listToolSchemas() {
  return TOOLS.filter((t) => !t.action).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/** Execute a tool call with permission enforcement. */
function executeTool(toolName, args, user, opts = {}) {
  const tool = TOOL_MAP.get(toolName);
  if (!tool) return { content: JSON.stringify({ error: `Unknown tool: ${toolName}` }), summary: 'unknown tool' };
  if (tool.permission && !can(user.role, tool.permission)) {
    return { content: JSON.stringify({ error: 'UNAUTHORIZED_ACTION', message: `You do not have permission to use ${toolName}.` }), summary: 'permission denied' };
  }
  return tool.handler({ user }, args || {});
}

/** Execute a confirmed action (after user confirmation). */
function executeAction(kind, params, user) {
  const tool = TOOLS.find((t) => t.action && t.preview && t.preview.kind === kind) || TOOLS.find((t) => t.action && t.name === kind);
  if (!tool) throw Object.assign(new Error(`Unknown action kind: ${kind}`), { status: 404, code: 'NOT_FOUND' });
  if (tool.permission && !can(user.role, tool.permission)) {
    throw Object.assign(new Error('You do not have permission to perform this action.'), { status: 403, code: 'UNAUTHORIZED_ACTION' });
  }

  switch (kind) {
    case 'generate_machines_from_description': {
      const machinesService = require('../services/machines');
      const specs = params.machines || machinesService.parseMachineDescription(params.description);
      return specs.map((s) => machinesService.createMachine(s, user.id));
    }
    case 'create_task': {
      const scheduling = require('../services/scheduling');
      return scheduling.createTask({
        machineId: params.machine_id,
        title: params.title,
        dueAt: params.due_at,
        priority: params.priority,
        description: params.description ?? null,
        createdBy: user.id,
      });
    }
    case 'create_assistance_request': {
      const maintenance = require('../services/maintenance');
      return maintenance.createRequest({
        machineId: params.machine_id,
        issue: params.issue,
        priority: params.priority,
        requesterId: user.id,
      });
    }
    case 'acknowledge_alert': {
      const alertsService = require('../services/alerts');
      return alertsService.acknowledgeAlert(params.alert_id, user.id);
    }
    default:
      throw Object.assign(new Error(`No executor for action ${kind}`), { status: 500, code: 'INTERNAL_ERROR' });
  }
}

module.exports = {
  TOOLS,
  TOOL_MAP,
  listToolSchemas,
  executeTool,
  executeAction,
  resolveMachine,
  machineListSummary,
};
