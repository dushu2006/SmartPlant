-- ============================================================================
-- SmartPlant schema — SQLite (node:sqlite).
-- The repository layer isolates SQL so PostgreSQL can be swapped in for
-- production (see docs/ARCHITECTURE.md). Timestamps are ISO-8601 UTC strings.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('ADMIN','MANAGER','SUPERVISOR','TECHNICIAN','WORKER','VIEWER')),
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  locale         TEXT NOT NULL DEFAULT 'en',
  token_version  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_login_at  TEXT
);

CREATE TABLE IF NOT EXISTS plants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  location    TEXT,
  timezone    TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id                 TEXT PRIMARY KEY,
  plant_id           TEXT REFERENCES plants(id),
  external_device_id TEXT,
  name               TEXT NOT NULL,
  type               TEXT,
  status             TEXT NOT NULL DEFAULT 'OFFLINE'
                     CHECK (status IN ('RUNNING','IDLE','OFF','OFFLINE','MAINTENANCE','FAULT')),
  configuration      TEXT NOT NULL DEFAULT '{}',
  thresholds         TEXT NOT NULL DEFAULT '{}',
  schedule           TEXT NOT NULL DEFAULT '{}',
  metadata           TEXT NOT NULL DEFAULT '{}',
  image              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_readings (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  ts          TEXT NOT NULL,                 -- event timestamp (device time, normalized)
  metric      TEXT NOT NULL,
  value       REAL NOT NULL,
  unit        TEXT,
  quality     TEXT NOT NULL DEFAULT 'good' CHECK (quality IN ('good','suspect','bad','missing')),
  source      TEXT NOT NULL DEFAULT 'device' CHECK (source IN ('device','simulator','imported')),
  sequence    INTEGER,
  received_at TEXT NOT NULL,                 -- ingestion timestamp (server time)
  dedupe_key  TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_telemetry_machine_ts ON telemetry_readings(machine_id, ts);
CREATE INDEX IF NOT EXISTS idx_telemetry_machine_metric_ts ON telemetry_readings(machine_id, metric, ts);

-- Materialized latest reading per machine+metric (fast dashboard queries).
CREATE TABLE IF NOT EXISTS telemetry_latest (
  machine_id  TEXT NOT NULL,
  metric      TEXT NOT NULL,
  ts          TEXT NOT NULL,
  value       REAL NOT NULL,
  unit        TEXT,
  quality     TEXT NOT NULL,
  source      TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (machine_id, metric)
);

CREATE TABLE IF NOT EXISTS alerts (
  id              TEXT PRIMARY KEY,
  machine_id      TEXT REFERENCES machines(id),
  type            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('DETECTED','ACTIVE','ACKNOWLEDGED','RESOLVED','DISMISSED')),
  message         TEXT NOT NULL,
  evidence        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  resolved_at     TEXT,
  resolved_by     TEXT,
  dismissed_at    TEXT,
  dismissed_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_machine ON alerts(machine_id);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, created_at);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT REFERENCES machines(id),
  task_type   TEXT,
  title       TEXT NOT NULL,
  description TEXT,
  due_at      TEXT NOT NULL,
  recurrence  TEXT NOT NULL DEFAULT 'none',   -- none|daily|weekly|monthly|custom_days
  recurrence_interval INTEGER,                -- days for custom_days
  priority    TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','COMPLETED','CANCELLED')),
  assigned_to TEXT REFERENCES users(id),
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON scheduled_tasks(status, due_at);

CREATE TABLE IF NOT EXISTS maintenance_requests (
  id           TEXT PRIMARY KEY,
  machine_id   TEXT REFERENCES machines(id),
  requester_id TEXT REFERENCES users(id),
  issue        TEXT NOT NULL,
  priority     TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status       TEXT NOT NULL DEFAULT 'OPEN'
               CHECK (status IN ('OPEN','TRIAGED','ASSIGNED','IN_PROGRESS','VERIFICATION','RESOLVED','CANCELLED')),
  technician_id TEXT REFERENCES users(id),
  ai_triage    TEXT,                           -- JSON from AI ticket triage (§43)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintreq_status ON maintenance_requests(status, created_at);

CREATE TABLE IF NOT EXISTS maintenance_events (
  id            TEXT PRIMARY KEY,
  machine_id    TEXT REFERENCES machines(id),
  request_id    TEXT REFERENCES maintenance_requests(id),
  type          TEXT CHECK (type IN ('PREVENTIVE','CORRECTIVE','INSPECTION','PREDICTIVE','CALIBRATION','REPAIR','REPLACEMENT')),
  diagnosis     TEXT,
  action        TEXT,
  technician_id TEXT REFERENCES users(id),
  started_at    TEXT,
  completed_at  TEXT,
  outcome       TEXT CHECK (outcome IN ('SUCCESS','PARTIAL','FAILED','DEFERRED')),
  notes         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintevent_machine ON maintenance_events(machine_id, completed_at);

CREATE TABLE IF NOT EXISTS spare_parts (
  id             TEXT PRIMARY KEY,
  sku            TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT,
  image_url      TEXT,
  stock_qty      INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  reserved_qty   INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  reorder_level  INTEGER NOT NULL DEFAULT 0,
  supplier       TEXT,
  lead_time_days INTEGER,
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISCONTINUED')),
  metadata       TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Machine ↔ part compatibility (PRD §42: AI must never invent compatibility).
CREATE TABLE IF NOT EXISTS machine_parts (
  machine_id TEXT NOT NULL REFERENCES machines(id),
  part_id    TEXT NOT NULL REFERENCES spare_parts(id),
  PRIMARY KEY (machine_id, part_id)
);

CREATE TABLE IF NOT EXISTS spare_requests (
  id           TEXT PRIMARY KEY,
  machine_id   TEXT REFERENCES machines(id),
  part_id      TEXT REFERENCES spare_parts(id),
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  requester_id TEXT REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING','APPROVED','REJECTED','DELIVERED','USED','CANCELLED')),
  approver_id  TEXT REFERENCES users(id),
  eta          TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sparereq_status ON spare_requests(status, created_at);

CREATE TABLE IF NOT EXISTS machine_documents (
  id             TEXT PRIMARY KEY,
  machine_id     TEXT REFERENCES machines(id),
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  storage_url    TEXT,
  extracted_text TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  uploaded_by    TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_machine ON machine_documents(machine_id);

CREATE TABLE IF NOT EXISTS ai_insights (
  id             TEXT PRIMARY KEY,
  machine_id     TEXT REFERENCES machines(id),
  category       TEXT NOT NULL,
  severity       TEXT NOT NULL CHECK (severity IN ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  description    TEXT NOT NULL,
  evidence_refs  TEXT NOT NULL DEFAULT '[]',
  confidence     REAL NOT NULL DEFAULT 0.5,
  model_version  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT,
  feedback       TEXT CHECK (feedback IN ('useful','not_useful','correct','incorrect','accepted','rejected','partial')),
  feedback_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_insights_machine ON ai_insights(machine_id, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  before      TEXT,
  after       TEXT,
  ts          TEXT NOT NULL,
  metadata    TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  entity_type TEXT,
  entity_id   TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL,
  dedupe_key  TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id),
  title      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content         TEXT,
  tool_calls      TEXT,
  created_at      TEXT NOT NULL
);

-- LLM usage / cost tracking (PRD §71).
CREATE TABLE IF NOT EXISTS ai_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  latency_ms    INTEGER,
  tool_calls    INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');
