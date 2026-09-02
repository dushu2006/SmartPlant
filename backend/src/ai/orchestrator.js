'use strict';

/**
 * AI orchestrator (PRD §28–33, §47–49, §71):
 *   User → LLM (or fallback) → AI Tools → Backend → DB
 * Action tools produce previews; nothing mutates until the user confirms a
 * signed one-time token. All conversations persist; all LLM usage is tracked.
 */
const crypto = require('crypto');
const config = require('../config');
const aiStore = require('../store/ai');
const { TOOLS, listToolSchemas, executeTool, executeAction } = require('./tools');
const { complete, resolveEngine, estimateTokens } = require('./llm');
const { runFallback } = require('./fallback');
const { signActionToken, verifyActionToken } = require('../crypto');
const { audit } = require('../services/audit');
const { notify } = require('../services/notifications');
const { errors } = require('../errors');
const logger = require('../logger');

const SYSTEM_PROMPT = `You are the SmartPlant AI Copilot — the intelligence layer of an industrial machine monitoring and maintenance platform.

GROUNDING POLICY (absolute rules):
1. Never fabricate telemetry, inventory, maintenance history, document content or costs. Every number MUST come from a tool result.
2. If a tool result says data is stale (data_freshness_seconds), say so, e.g. "the latest available reading is X seconds old". If a machine is offline, say you cannot confirm its current state.
3. Never claim unsupported certainty. If evidence is insufficient, say so and recommend what data would help.
4. Only use compatible spare parts listed by get_spare_inventory. Never invent part compatibility.
5. Respect the user's permissions — tools enforce them; if a tool returns UNAUTHORIZED_ACTION, tell the user they lack permission.
6. Action tools (create_task, create_assistance_request, acknowledge_alert) return PREVIEWS. Present the preview to the user and ask them to confirm; never claim the action was executed.
7. Answer in the user's language when practical. Be concise, use markdown, and cite evidence (tool names).
8. "What is the temperature of X?" → use get_machine_status, report the value, its timestamp/freshness and quality.
9. "When will X turn off / stop / shut down?" → use predict_machine: give the estimated time (local to the user when known or UTC), its basis and confidence; if the machine is not running, say so.
10. "Does X have any errors?" → use get_active_alerts + get_machine_status; list active alerts or state there are none.
11. "Will X go wrong / fail / break after some weeks?" → use predict_machine: give the failure outlook window, deterioration index and signals, ALWAYS with the honest caveat that it is an estimated risk, not a validated failure probability, and recommend next steps only from tool output.

You have access to these tools: ${TOOLS.filter((t) => !t.action).map((t) => t.name).join(', ')}.
Action tools (preview-only): ${TOOLS.filter((t) => t.action).map((t) => t.name).join(', ')}.`;

const usedConfirmTokens = new Set();

// ------------------------------------------------------------- chat loop
async function chat({ user, conversationId, message, mode }) {
  if (!message || !String(message).trim()) throw errors.validation('message is required');

  const engine = resolveEngine();
  let conversation = conversationId ? aiStore.findConversation(conversationId) : null;
  if (!conversation) {
    conversation = aiStore.createConversation({
      id: crypto.randomUUID(),
      userId: user.id,
      title: String(message).slice(0, 60),
    });
  } else if (conversation.user_id !== user.id) {
    throw errors.forbidden();
  }
  aiStore.touchConversation(conversation.id);
  aiStore.addMessage({ id: crypto.randomUUID(), conversationId: conversation.id, role: 'user', content: message });

  let result;
  if (engine && mode !== 'fallback') {
    try {
      result = await llmChat({ user, conversationId: conversation.id, message });
    } catch (err) {
      logger.warn('LLM chat failed — falling back to deterministic engine', { error: err.message });
      result = runFallback({ message, user });
      result.fallbackReason = 'llm_error';
    }
  } else {
    result = runFallback({ message, user });
  }

  const reply = result.reply;
  const pendingActions = (result.pendingActions || []).map((p) => ({
    ...p,
    confirmToken: signActionToken(config.jwtSecret, { uid: user.id, kind: p.kind, params: p.params }, config.aiActionConfirmTtlMin * 60000),
  }));

  aiStore.addMessage({
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    role: 'assistant',
    content: JSON.stringify({ reply, evidence: result.evidence || [], confidence: result.confidence || 'low', model: result.model || 'unknown', pendingActions: pendingActions.map((p) => ({ kind: p.kind, label: p.label })) }),
  });

  return {
    id: crypto.randomUUID(),
    conversation_id: conversation.id,
    reply,
    evidence: result.evidence || [],
    confidence: result.confidence || 'low',
    model: result.model || 'unknown',
    pendingActions,
    usage: result.usage || null,
  };
}

async function llmChat({ user, conversationId, message }) {
  const messages = [];
  const history = aiStore.listMessages(conversationId).slice(-20);
  const toolResults = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const m of history) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const parsed = safeParse(m.content);
      messages.push({ role: 'assistant', content: parsed?.reply || m.content });
    }
  }

  let rounds = 0;
  let finalContent = '';
  const pendingActions = [];

  while (rounds < config.aiMaxToolIterations) {
    rounds++;
    const res = await complete({
      system: SYSTEM_PROMPT,
      messages,
      tools: listToolSchemas(),
      maxTokens: config.aiMaxTokens,
    });
    if (!res) break;
    inputTokens += res.usage?.input || 0;
    outputTokens += res.usage?.output || 0;
    finalContent = res.content || finalContent;

    if (res.stop_reason === 'tool_use' && res.tool_calls?.length) {
      const toolBlocks = [];
      if (res.provider === 'anthropic') {
        messages.push({
          role: 'assistant',
          content: [
            ...(res.content ? [{ type: 'text', text: res.content }] : []),
            ...res.tool_calls.map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })),
          ],
        });
      } else {
        messages.push({
          role: 'assistant',
          content: res.content || '',
          tool_calls: res.tool_calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })),
        });
      }

      for (const tc of res.tool_calls) {
        const result = executeTool(tc.name, tc.arguments, user);
        toolResults.push({ tool: tc.name, summary: result.summary, content: result.content });
        if (result.preview) pendingActions.push(result.preview);
        if (res.provider === 'anthropic') {
          toolBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content: result.content });
        } else {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content });
        }
      }
      if (res.provider === 'anthropic') {
        messages.push({ role: 'user', content: toolBlocks });
      }
      continue;
    }

    finalContent = res.content || finalContent;
    break;
  }

  const model = `llm:${require('./llm').resolveEngine()}`;
  return {
    reply: finalContent || 'I could not complete that request. Please try again.',
    evidence: toolResults.map((t) => ({ tool: t.tool, summary: t.summary })),
    confidence: toolResults.length ? 'medium' : 'low',
    model,
    pendingActions,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ------------------------------------------------------------- confirm
function confirmAction({ token, user }) {
  const payload = verifyActionToken(config.jwtSecret, token);
  if (!payload) throw errors.badRequest('Invalid or expired confirmation token.');
  if (payload.uid !== user.id) throw errors.forbidden('This confirmation belongs to another user.');
  if (usedConfirmTokens.has(token)) throw errors.conflict('This confirmation has already been used.');
  usedConfirmTokens.add(token);

  let result;
  try {
    result = executeAction(payload.kind, payload.params, user);
  } catch (err) {
    usedConfirmTokens.delete(token); // allow retry on failure
    throw err;
  }

  audit({
    actorId: user.id,
    action: 'AI.ACTION_EXECUTE',
    entityType: 'ai_action',
    entityId: payload.kind,
    after: { kind: payload.kind, params: payload.params, result_id: result?.id || null },
    metadata: { via_ai: true },
  });
  notify({
    recipients: [user.id],
    type: 'SYSTEM',
    title: `AI action executed: ${payload.kind}`,
    body: JSON.stringify(payload.params).slice(0, 160),
    entityType: 'ai_action',
    entityId: payload.kind,
    dedupeKey: `ai-action:${token.slice(0, 16)}`,
  });
  return { kind: payload.kind, params: payload.params, result };
}

// ------------------------------------------------------------- insights
/**
 * Background insight generation (PRD §49–50): scan machines with active
 * alerts or elevated risk; store AIInsight rows with evidence + confidence +
 * model version + expiry. Idempotent per machine per day.
 */
function generateInsights() {
  const machines = require('../store/machines').allMachines();
  const { analyzeMachine } = require('./insights');
  const dayKey = new Date().toISOString().slice(0, 10);
  let created = 0;

  for (const machine of machines) {
    const active = require('../store/alerts').listActive({ machineId: machine.id, pageSize: 5 }).data;
    const existing = aiStore.listInsights({ machineId: machine.id, pageSize: 100 }).data;
    const alreadyToday = existing.some((i) => i.created_at.slice(0, 10) === dayKey);
    if (alreadyToday) continue;

    if (active.length >= 1) {
      const analysis = analyzeMachine(machine);
      const severity = analysis.severity;
      if (severity === 'INFO') continue;
      const insight = aiStore.createInsight({
        id: crypto.randomUUID(),
        machine_id: machine.id,
        category: active.some((a) => a.type.startsWith('ANOMALY')) ? 'ANOMALY' : 'RISK',
        severity,
        description: `${analysis.findings.slice(0, 3).join(' ')} ${analysis.next_steps[0]}`,
        evidence_refs: analysis.evidence.map((e) => e.ref === 'alert' ? e.alert_id : e.ref),
        confidence: analysis.confidence,
        model_version: analysis.model_version,
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      });
      audit({
        actorId: 'system',
        action: 'AI.INSIGHT_GENERATE',
        entityType: 'ai_insight',
        entityId: insight.id,
        after: { machine_id: machine.id, severity, confidence: insight.confidence },
      });
      if (severity === 'CRITICAL' || severity === 'HIGH') {
        notify({
          type: 'AI_HIGH_RISK',
          title: `AI insight: ${machine.name} — ${severity}`,
          body: insight.description.slice(0, 160),
          entityType: 'ai_insight',
          entityId: insight.id,
          dedupeKey: `ai-insight:${machine.id}:${dayKey}`,
        });
      }
      created++;
    }
  }
  if (created) logger.info('AI insights generated', { count: created });
  return created;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = { chat, confirmAction, generateInsights };
