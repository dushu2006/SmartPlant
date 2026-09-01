'use strict';

/**
 * Deterministic fallback AI engine. Used when no LLM provider key is
 * configured (AI_MODE=fallback or auto-without-keys). It classifies intent,
 * executes the SAME permission-checked tools as the LLM path, and renders
 * answers with real numbers, data freshness, evidence and confidence.
 * It never fabricates values and refuses unsupported asks (PRD §34, §67).
 */
const { executeTool, resolveMachine, machineListSummary } = require('./tools');
const alertsStore = require('../store/alerts');
const opsStore = require('../store/ops');
const analytics = require('../services/analytics');

const MODEL_VERSION = 'fallback-deterministic-v1';

function toolCall(toolName, args, user) {
  const result = executeTool(toolName, args, user);
  return { ...result, tool: toolName };
}

function fmt1(v) {
  return v === null || v === undefined ? '—' : Math.round(v * 10) / 10;
}

function freshnessNote(seconds) {
  if (seconds === null || seconds === undefined) return '';
  if (seconds < 60) return ` (latest reading ${seconds}s old)`;
  return ` (latest reading ${Math.round(seconds / 60)} min old)`;
}

function detectMachine(text) {
  const summary = machineListSummary();
  const lower = text.toLowerCase();
  // 1) exact name / id mention
  const exact = summary.find((m) => lower.includes(m.name.toLowerCase()) || lower.includes(m.id.toLowerCase()));
  if (exact) return exact;
  // 2) token match: any word ≥4 chars from the machine name appears in the text
  const tokens = lower.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 4);
  const candidates = [];
  for (const m of summary) {
    const nameTokens = m.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 4);
    const hits = nameTokens.filter((t) => tokens.includes(t)).length;
    if (hits > 0) candidates.push({ m, hits });
  }
  candidates.sort((a, b) => b.hits - a.hits);
  return candidates.length ? candidates[0].m : null;
}

/**
 * Run the deterministic engine. Returns the same envelope as the LLM path:
 * { reply, evidence, confidence, model, pendingActions }.
 */
function runFallback({ message, user }) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  const evidence = [];
  const pendingActions = [];
  const toolResults = [];

  // ------------------------------------------------------------ actions
  // Create task (schedule … tomorrow, etc.)
  if (/(schedule|create|add|plan).*(task|inspection|maintenance|check)/.test(lower) || /(task|inspection).*(schedule|create|tomorrow)/.test(lower)) {
    const machine = detectMachine(lower) || machineListSummary()[0];
    let due = new Date(Date.now() + 24 * 3600000);
    due.setUTCMinutes(0, 0, 0);
    const title = text.match(/(?:task|inspection|maintenance|check)[^.,;]*/i)?.[0]?.trim() || 'Maintenance inspection';
    const res = toolCall('create_task', { title, machine_id: machine.id, due_at: due.toISOString(), priority: 'MEDIUM', description: message }, user);
    if (res.preview) {
      pendingActions.push(res.preview);
      toolResults.push(res);
      evidence.push({ tool: 'create_task', summary: res.summary });
    }
    const machineName = machine.name;
    return {
      reply: `I can schedule a maintenance task for **${machineName}** tomorrow at ${due.toISOString().slice(11, 16)} UTC.\n\nMachine: ${machineName}\nTask: ${title}\nTime: ${due.toISOString()}\n\nConfirm the action below to create it.`,
      evidence,
      confidence: 'high',
      model: MODEL_VERSION,
      pendingActions,
    };
  }

  // Create assistance request
  if (/(assistance|maintenance request|technician|help).*(extruder|machine|mixer|robot|conveyor|molder|mill|press|compressor|welding|lathe|cooling|packaging|palletizer|laser|test bench)/.test(lower) && /(create|request|need|call|open)/.test(lower)) {
    const machine = detectMachine(lower);
    if (machine) {
      const issue = text.length > 20 ? text : `${machine.name}: maintenance assistance requested.`;
      const res = toolCall('create_assistance_request', { machine_id: machine.id, issue }, user);
      if (res.preview) {
        pendingActions.push(res.preview);
        toolResults.push(res);
        evidence.push({ tool: 'create_assistance_request', summary: res.summary });
      }
      return {
        reply: `I can create a maintenance request for **${machine.name}** with the issue you described.\n\nConfirm the action below to submit it.`,
        evidence,
        confidence: 'high',
        model: MODEL_VERSION,
        pendingActions,
      };
    }
  }

  // Acknowledge alert
  const ackMatch = lower.match(/acknowledge (?:alert )?([a-z0-9-]+)/);
  if (ackMatch) {
    const res = toolCall('acknowledge_alert', { alert_id: ackMatch[1] }, user);
    if (res.preview) {
      pendingActions.push(res.preview);
      evidence.push({ tool: 'acknowledge_alert', summary: res.summary });
      return {
        reply: `I can acknowledge this alert for you.\n\nConfirm the action below to acknowledge it.`,
        evidence,
        confidence: 'high',
        model: MODEL_VERSION,
        pendingActions,
      };
    }
  }

  // ------------------------------------------------------------ questions
  // Alert explanation — must come before generic status/temperature checks.
  if (/(why|alert|explain|what happened|issue)/.test(lower) && /(alert|temperature|high|overheat|warning|fault)/.test(lower)) {
    const machine = detectMachine(lower);
    const active = machine
      ? alertsStore.listActive({ machineId: machine.id, pageSize: 5 }).data
      : alertsStore.listActive({ pageSize: 5 }).data;
    if (active.length) {
      const a = active[0];
      const res = toolCall('explain_alert', { alert_id: a.id }, user);
      toolResults.push(res);
      const explanation = safeParse(res.content);
      evidence.push({ tool: 'explain_alert', summary: res.summary, alert_id: a.id });
      const lines = [`**${a.type.replace(/_/g, ' ')} alert on ${machine ? machine.name : a.machine_id} (${a.severity})**`, ''];
      lines.push(a.message, '');
      for (const p of (explanation?.explanation || [])) lines.push(`- ${p}`);
      return {
        reply: lines.join('\n'),
        evidence,
        confidence: explanation?.confidence >= 0.6 ? 'high' : 'medium',
        model: MODEL_VERSION,
        pendingActions,
      };
    }
  }

  // Maintenance history
  if (/(maintenance|last maintenance|service|repaired|serviced)/.test(lower) && /(when|history|last|ever|recent)/.test(lower)) {
    const machine = detectMachine(lower) || machineListSummary()[0];
    const res = toolCall('get_maintenance_history', { machine_id: machine.id, limit: 5 }, user);
    toolResults.push(res);
    const events = safeParse(res.content) || [];
    evidence.push({ tool: 'get_maintenance_history', summary: res.summary });
    if (!events.length) {
      return { reply: `No maintenance events are recorded for **${machine.name}**.`, evidence, confidence: 'high', model: MODEL_VERSION, pendingActions };
    }
    const lines = [`**Maintenance history — ${machine.name}**`, ''];
    for (const e of events) {
      lines.push(`- **${e.type}** (${e.outcome}) — ${(e.completed_at || '').slice(0, 10)}${e.notes ? `: ${e.notes}` : ''}`);
    }
    return { reply: lines.join('\n'), evidence, confidence: 'high', model: MODEL_VERSION, pendingActions };
  }

  // Order / procurement requests — refuse unless a known catalog part is named.
  if (/(order|buy|purchase|procure)/.test(lower)) {
    const term = extractPartTerm(lower);
    if (!term || /(unknown|something|whatever|new part)/.test(lower)) {
      return {
        reply: `I cannot place orders or invent part information. I only report parts that exist in the SmartPlant catalog. Tell me the part name or SKU (e.g. "heating element") and I will check availability, price of approval, and stock.`,
        evidence,
        confidence: 'high',
        model: MODEL_VERSION,
        pendingActions,
      };
    }
  }

  // Inventory / spare parts
  if (/(spare|part|inventory|stock|have|available|reorder)/.test(lower)) {
    const machine = detectMachine(lower);
    const term = extractPartTerm(lower);
    const res = machine
      ? toolCall('get_spare_inventory', { machine_id: machine.id }, user)
      : toolCall('get_spare_inventory', { search: term }, user);
    toolResults.push(res);
    let parts = safeParse(res.content) || [];
    // When both a machine and a part term are present, narrow to the term.
    if (machine && term && Array.isArray(parts)) {
      const needle = term.toLowerCase();
      parts = parts.filter((p) => p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle));
    }
    evidence.push({ tool: 'get_spare_inventory', summary: res.summary });
    if (parts.error) {
      return { reply: `I could not find that machine. Known machines: ${machineListSummary().map((m) => m.name).join(', ')}.`, evidence, confidence: 'high', model: MODEL_VERSION, pendingActions };
    }
    if (!parts.length) {
      return { reply: `No matching spare parts found in the catalog. I will not invent part information.`, evidence, confidence: 'high', model: MODEL_VERSION, pendingActions };
    }
    const lines = [`**Spare parts${machine ? ` compatible with ${machine.name}` : ''}**`, ''];
    for (const p of parts.slice(0, 10)) {
      const flag = p.low ? ' ⚠️ reorder recommended' : '';
      lines.push(`- **${p.name}** (${p.sku}): ${p.available_qty} available (stock ${p.stock_qty}, reserved ${p.reserved_qty})${flag}`);
    }
    return { reply: lines.join('\n'), evidence, confidence: 'high', model: MODEL_VERSION, pendingActions };
  }

  // Documents / "how should I troubleshoot" — before generic status checks.
  if (/(how should i|according to|manual|document|troubleshoot|sop|procedure|guide)/.test(lower)) {
    const machine = detectMachine(lower);
    const res = toolCall('search_documents', { query: text, machine_id: machine?.id }, user);
    toolResults.push(res);
    const hits = safeParse(res.content) || [];
    evidence.push({ tool: 'search_documents', summary: res.summary });
    if (!hits.length) {
      return { reply: `No documents matched "${message}". Available documents can be viewed in the Documents page.`, evidence, confidence: 'medium', model: MODEL_VERSION, pendingActions };
    }
    const lines = [`**From the documentation:**`, ''];
    for (const h of hits.slice(0, 3)) {
      lines.push(`- **${h.title}**: ${h.snippet}`);
    }
    return { reply: lines.join('\n'), evidence, confidence: 'high', model: MODEL_VERSION, pendingActions };
  }

  // Energy / cost — before generic status checks ("energy cost of X").
  if (/(energy|cost|kwh|electricity|power usage)/.test(lower)) {
    const machine = detectMachine(lower);
    const res = toolCall('get_energy_usage', { machine_id: machine?.id || machineListSummary()[0].id }, user);
    toolResults.push(res);
    const data = safeParse(res.content) || {};
    evidence.push({ tool: 'get_energy_usage', summary: res.summary });
    return {
      reply: `**Energy — ${data.machine}**\n\n- Energy today: **${data.energy_today_kwh} kWh**\n- Cost today: **$${data.cost_today_usd}**\n- Monthly estimate: **$${data.monthly_estimate_usd}**\n- Operating hours today: ${data.operating_hours_today}`,
      evidence,
      confidence: 'high',
      model: MODEL_VERSION,
      pendingActions,
    };
  }

  // Machine status / "is X okay?"
  const statusQ = /(status|okay|ok\?|running|fine|current|temperature|power|how is|is the)/.test(lower);
  const hasMachineWord = machineListSummary().some((m) => lower.includes(m.name.toLowerCase())) || /machine|extruder|mixer|robot|conveyor|molder|mill|press|compressor|welding|lathe|cooling|packaging|palletizer|laser|bench/.test(lower);
  if (statusQ && hasMachineWord) {
    const machine = detectMachine(lower);
    if (machine) {
      const res = toolCall('get_machine_status', { machine_id: machine.id }, user);
      toolResults.push(res);
      const ov = safeParse(res.content);
      const rows = [];
      if (ov?.current) {
        rows.push(`- **Status:** ${ov.machine.status}`);
        if (ov.current.temperature_c) rows.push(`- **Temperature:** ${ov.current.temperature_c.value}°C${freshnessNote(ov.current.data_freshness_seconds)}`);
        if (ov.current.power_kw) rows.push(`- **Power:** ${ov.current.power_kw.value} kW`);
        if (ov.current.load_pct) rows.push(`- **Load:** ${ov.current.load_pct.value}%`);
        rows.push(`- **Health score:** ${ov.health_score}/100`);
        rows.push(`- **Risk:** ${ov.risk.risk_level} (${fmt1(ov.risk.risk_score)})`);
      }
      const active = ov?.active_alerts || [];
      if (active.length) {
        rows.push(`- **Active alerts (${active.length}):** ${active.map((a) => `${a.type} (${a.severity})`).join(', ')}`);
      } else {
        rows.push('- **Active alerts:** none');
      }
      if (ov?.last_maintenance) {
        rows.push(`- **Last maintenance:** ${ov.last_maintenance.type} — ${ov.last_maintenance.outcome} on ${(ov.last_maintenance.completed_at || '').slice(0, 10)}`);
      }
      evidence.push({ tool: 'get_machine_status', summary: res.summary });
      return {
        reply: `**${ov?.machine?.name || machine.name}**\n\n${rows.join('\n')}`,
        evidence,
        confidence: active.length ? 'high' : 'medium',
        model: MODEL_VERSION,
        pendingActions,
      };
    }
  }

  // Risk / attention / predictive
  if (/(attention|risk|predict|health|healthy|due for|maintenance needed|all machines)/.test(lower)) {
    const res = toolCall('list_machines', {}, user);
    toolResults.push(res);
    const machines = safeParse(res.content) || [];
    evidence.push({ tool: 'list_machines', summary: res.summary });
    const ranked = [...machines].sort((a, b) => a.health_score - b.health_score).slice(0, 5);
    const lines = ['**Machines needing attention (by health score):**', ''];
    for (const m of ranked) {
      lines.push(`- **${m.name}** — health ${m.health_score}/100, ${m.status}${m.temperature_c !== null ? `, temp ${m.temperature_c}°C` : ''}${freshnessNote(m.data_freshness_seconds)}`);
    }
    return { reply: lines.join('\n'), evidence, confidence: 'medium', model: MODEL_VERSION, pendingActions };
  }

  // Fallback: honest refusal with capabilities
  return {
    reply:
      `I can answer operational questions about SmartPlant data. For example:\n\n` +
      `- *"Is the Primary Extruder okay?"*\n` +
      `- *"Why is the temperature high?"*\n` +
      `- *"What machines need attention?"*\n` +
      `- *"When was the last maintenance on the Chemical Mixer?"*\n` +
      `- *"Do we have spare heating elements for the extruder?"*\n` +
      `- *"How should I troubleshoot high temperature?"*\n` +
      `- *"Schedule a maintenance inspection tomorrow"*\n\n` +
      `I only answer from the SmartPlant database — I will not invent machine values or inventory.`,
    evidence,
    confidence: 'low',
    model: MODEL_VERSION,
    pendingActions,
  };
}

function extractPartTerm(lower) {
  const words = lower.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/);
  const skip = new Set([
    'spare', 'part', 'parts', 'do', 'we', 'have', 'the', 'how', 'many', 'available',
    'what', 'is', 'are', 'in', 'stock', 'for', 'a', 'an', 'inventory', 'catalog',
    'reorder', 'need', 'get', 'compatible', 'machine', 'order', 'buy', 'purchase',
    'procure', 'units', 'please', 'can', 'you', 'me', 'with', 'any', 'there',
  ]);
  return words.find((w) => w.length > 3 && !skip.has(w)) || null;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = { runFallback, MODEL_VERSION };
