'use strict';

const { db, paged, nowIso } = require('./util');

// ================================================================= documents
function findDocument(id) {
  return db().prepare('SELECT * FROM machine_documents WHERE id = ?').get(id);
}

function listDocuments({ machineId, type, search, page = 1, pageSize = 100 }) {
  const where = [];
  const params = [];
  if (machineId) {
    where.push('machine_id = ?');
    params.push(machineId);
  }
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (search) {
    where.push('(title LIKE ? OR extracted_text LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db().prepare(`SELECT COUNT(*) AS n FROM machine_documents ${w}`).get(...params).n;
  const rows = db()
    .prepare(
      `SELECT d.*, m.name AS machine_name, u.display_name AS uploader_name
       FROM machine_documents d
       LEFT JOIN machines m ON m.id = d.machine_id
       LEFT JOIN users u ON u.id = d.uploaded_by
       ${w} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return paged(rows, total, page, pageSize);
}

function createDocument(doc) {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO machine_documents
         (id, machine_id, type, title, storage_url, extracted_text, version, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(doc.id, doc.machine_id, doc.type, doc.title, doc.storage_url ?? null, doc.extracted_text ?? null, doc.version ?? 1, doc.uploaded_by ?? null, ts);
  return findDocument(doc.id);
}

function deleteDocument(id) {
  return db().prepare('DELETE FROM machine_documents WHERE id = ?').run(id).changes;
}

/**
 * Deterministic keyword retrieval over document text (RAG-lite). In a full
 * production deployment this is replaced by embeddings + a vector database
 * (PRD §44); the interface stays the same.
 */
function searchDocuments({ machineId, query, limit = 5 }) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return [];
  const where = [];
  const params = [];
  if (machineId) {
    where.push('machine_id = ?');
    params.push(machineId);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const docs = db()
    .prepare(`SELECT * FROM machine_documents ${w}`)
    .all(...params);
  const scored = [];
  for (const doc of docs) {
    const hay = `${doc.title} ${doc.extracted_text || ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const idx = hay.indexOf(t);
      if (idx !== -1) score += 1 + (idx === 0 ? 0.5 : 0);
    }
    if (score > 0) {
      const snippet = snippetFrom(doc.extracted_text || '', terms, 260);
      scored.push({ id: doc.id, machine_id: doc.machine_id, type: doc.type, title: doc.title, score, snippet });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function snippetFrom(text, terms, maxLen) {
  let best = -1;
  for (const t of terms) {
    const idx = text.toLowerCase().indexOf(t);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  if (best === -1) return text.slice(0, maxLen);
  const start = Math.max(0, best - 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + maxLen)}${start + maxLen < text.length ? '…' : ''}`;
}

// ================================================================ ai insights
function findInsight(id) {
  const row = db().prepare('SELECT * FROM ai_insights WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, evidence_refs: JSON.parse(row.evidence_refs || '[]') };
}

function createInsight(insight) {
  const ts = nowIso();
  db()
    .prepare(
      `INSERT INTO ai_insights
         (id, machine_id, category, severity, description, evidence_refs, confidence, model_version, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      insight.id,
      insight.machine_id,
      insight.category,
      insight.severity,
      insight.description,
      JSON.stringify(insight.evidence_refs || []),
      insight.confidence ?? 0.5,
      insight.model_version,
      ts,
      insight.expires_at ?? null,
    );
  return findInsight(insight.id);
}

function listInsights({ machineId, category, severity, page = 1, pageSize = 50 }) {
  const where = [];
  const params = [];
  if (machineId) {
    where.push('machine_id = ?');
    params.push(machineId);
  }
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (severity) {
    where.push('severity = ?');
    params.push(severity);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db().prepare(`SELECT COUNT(*) AS n FROM ai_insights ${w}`).get(...params).n;
  const rows = db()
    .prepare(
      `SELECT i.*, m.name AS machine_name FROM ai_insights i
       LEFT JOIN machines m ON m.id = i.machine_id
       ${w} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize)
    .map((r) => ({ ...r, evidence_refs: JSON.parse(r.evidence_refs || '[]') }));
  return paged(rows, total, page, pageSize);
}

function feedbackInsight(id, feedback) {
  db().prepare('UPDATE ai_insights SET feedback = ?, feedback_at = ? WHERE id = ?').run(feedback, nowIso(), id);
  return findInsight(id);
}

function activeInsightCount() {
  return db().prepare('SELECT COUNT(*) AS n FROM ai_insights WHERE feedback IS NULL').get().n;
}

// =============================================================== conversations
function findConversation(id) {
  return db().prepare('SELECT * FROM ai_conversations WHERE id = ?').get(id);
}

function listConversations(userId) {
  return db()
    .prepare('SELECT * FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50')
    .all(userId);
}

function createConversation({ id, userId, title }) {
  const ts = nowIso();
  db()
    .prepare('INSERT INTO ai_conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, title ?? 'New conversation', ts, ts);
  return findConversation(id);
}

function touchConversation(id) {
  db().prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(nowIso(), id);
}

function addMessage({ id, conversationId, role, content, toolCalls }) {
  db()
    .prepare(
      `INSERT INTO ai_messages (id, conversation_id, role, content, tool_calls, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, conversationId, role, content ?? null, toolCalls ? JSON.stringify(toolCalls) : null, nowIso());
}

function listMessages(conversationId) {
  return db()
    .prepare('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId);
}

function deleteConversation(id) {
  db().prepare('DELETE FROM ai_messages WHERE conversation_id = ?').run(id);
  return db().prepare('DELETE FROM ai_conversations WHERE id = ?').run(id).changes;
}

// ==================================================================== usage
function recordUsage({ provider, model, inputTokens, outputTokens, costUsd, latencyMs, toolCalls, ok = true }) {
  db()
    .prepare(
      `INSERT INTO ai_usage (ts, provider, model, input_tokens, output_tokens, cost_usd, latency_ms, tool_calls, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(nowIso(), provider, model, inputTokens, outputTokens, costUsd, latencyMs ?? null, toolCalls ?? 0, ok ? 1 : 0);
}

function usageSummary(sinceIso) {
  const since = sinceIso || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COALESCE(SUM(cost_usd),0) AS cost_usd,
              COALESCE(AVG(latency_ms),0) AS avg_latency_ms,
              COALESCE(SUM(tool_calls),0) AS tool_calls,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) AS failures
       FROM ai_usage WHERE ts >= ?`,
    )
    .get(since);
  return row;
}

function usageByModel(sinceIso) {
  const since = sinceIso || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  return db()
    .prepare('SELECT provider, model, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd FROM ai_usage WHERE ts >= ? GROUP BY provider, model')
    .all(since);
}

module.exports = {
  findDocument,
  listDocuments,
  createDocument,
  deleteDocument,
  searchDocuments,
  findInsight,
  createInsight,
  listInsights,
  feedbackInsight,
  activeInsightCount,
  findConversation,
  listConversations,
  createConversation,
  touchConversation,
  addMessage,
  listMessages,
  deleteConversation,
  recordUsage,
  usageSummary,
  usageByModel,
};
