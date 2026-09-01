'use strict';

/**
 * LLM provider adapters — Anthropic Messages API and OpenAI-compatible
 * chat completions (works with OpenAI, Ollama, LM Studio, vLLM, ...).
 * If no key is configured the orchestrator falls back to the deterministic
 * engine. Every call is recorded in ai_usage (PRD §71).
 */
const config = require('../config');
const aiStore = require('../store/ai');
const logger = require('../logger');

const COST_PER_1M = {
  'claude-sonnet-4-5': { in: 3.0, out: 15.0 },
  'claude-3-5-haiku-latest': { in: 0.8, out: 4.0 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10.0 },
};

function costFor(model, inputTokens, outputTokens) {
  const c = COST_PER_1M[model];
  if (!c) return 0;
  return (inputTokens / 1e6) * c.in + (outputTokens / 1e6) * c.out;
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function resolveEngine() {
  if (config.aiMode === 'anthropic') return config.anthropicApiKey ? 'anthropic' : null;
  if (config.aiMode === 'openai') return config.openaiApiKey ? 'openai' : null;
  if (config.aiMode === 'fallback') return null;
  if (config.anthropicApiKey) return 'anthropic';
  if (config.openaiApiKey) return 'openai';
  return null;
}

function record(provider, model, inputTokens, outputTokens, latencyMs, toolCalls, ok) {
  try {
    aiStore.recordUsage({
      provider,
      model,
      inputTokens,
      outputTokens,
      costUsd: costFor(model, inputTokens, outputTokens),
      latencyMs,
      toolCalls,
      ok,
    });
  } catch (err) {
    logger.warn('usage record failed', { error: err.message });
  }
}

/**
 * One LLM round trip with tool definitions. Returns:
 * { content, tool_calls: [{id, name, arguments}], stop_reason, usage }
 */
async function complete({ system, messages, tools, maxTokens }) {
  const provider = resolveEngine();
  if (!provider) return null;
  const started = Date.now();
  try {
    if (provider === 'anthropic') {
      const res = await fetch(config.anthropicUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.anthropicModel,
          max_tokens: maxTokens || config.aiMaxTokens,
          system,
          messages,
          tools: (tools || []).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        const err = new Error(`Anthropic API error ${res.status}: ${body.error?.message || res.statusText}`);
        err.status = res.status;
        throw err;
      }
      const toolCalls = (body.content || [])
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, arguments: b.input }));
      const text = (body.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const usage = { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 };
      record('anthropic', config.anthropicModel, usage.input, usage.output, Date.now() - started, toolCalls.length, true);
      return { content: text, tool_calls: toolCalls, stop_reason: body.stop_reason || (toolCalls.length ? 'tool_use' : 'end_turn'), usage, provider: 'anthropic', model: config.anthropicModel };
    }

    if (provider === 'openai') {
      const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: config.openaiModel,
          messages,
          tools: (tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: 'auto',
          max_tokens: config.aiMaxTokens,
          ...config.openaiExtraBody,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        const err = new Error(`OpenAI API error ${res.status}: ${body.error?.message || res.statusText}`);
        err.status = res.status;
        throw err;
      }
      const msg = body.choices?.[0]?.message || {};
      const toolCalls = (msg.tool_calls || []).map((tc) => {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          args = {};
        }
        return { id: tc.id, name: tc.function.name, arguments: args };
      });
      const usage = { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0 };
      record('openai', config.openaiModel, usage.input, usage.output, Date.now() - started, toolCalls.length, true);
      return { content: msg.content || '', tool_calls: toolCalls, stop_reason: toolCalls.length ? 'tool_use' : 'end_turn', usage, provider: 'openai', model: config.openaiModel };
    }
  } catch (err) {
    logger.error('LLM call failed', { provider, error: err.message });
    record(provider, provider === 'anthropic' ? config.anthropicModel : config.openaiModel, 0, 0, Date.now() - started, 0, false);
    throw err;
  }
  return null;
}

module.exports = { complete, resolveEngine, estimateTokens, costFor };
