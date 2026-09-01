'use strict';

/**
 * Environment configuration. All secrets come from environment variables
 * (or a local .env file via --env-file, or docker env). Nothing sensitive
 * is ever hard-coded in the codebase.
 */
const fs = require('fs');
const path = require('path');

// Load .env manually (Node --env-file only loads when passed; keep it simple and explicit).
const ROOT = path.resolve(__dirname, '..', '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      let value = m[2].trim();
      // Strip inline comments, but keep # inside quoted values.
      if (value.startsWith('"') || value.startsWith("'")) {
        const q = value[0];
        const end = value.indexOf(q, 1);
        if (end > 0) value = value.slice(0, end + 1);
      } else {
        value = value.split('#')[0].trim();
      }
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[m[1]] = value;
    }
  }
}

/** Resolve a possibly-relative path against the project root. */
function rootPath(v) {
  return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function parseJson(v, dflt) {
  if (!v) return dflt;
  try {
    return JSON.parse(v);
  } catch {
    return dflt;
  }
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: num(process.env.PORT, 4000),
  host: process.env.HOST || '0.0.0.0',

  dbPath: process.env.DB_PATH ? rootPath(process.env.DB_PATH) : path.join(ROOT, 'data', 'smartplant.db'),
  demoMode: bool(process.env.DEMO_MODE, true),
  seedDemoData: bool(process.env.SEED_DEMO_DATA, true),

  jwtSecret: process.env.JWT_SECRET || 'insecure-dev-secret-change-me',
  jwtTtlHours: num(process.env.JWT_TTL_HOURS, 12),
  loginRateLimit: num(process.env.LOGIN_RATE_LIMIT, 10),
  loginRateWindowMin: num(process.env.LOGIN_RATE_WINDOW_MIN, 15),

  simulateTelemetry: bool(process.env.SIMULATE_TELEMETRY, true),
  simIntervalSec: num(process.env.SIM_INTERVAL_SEC, 30),
  telemetryStaleMin: num(process.env.TELEMETRY_STALE_MIN, 5),

  alertTempMaxC: num(process.env.ALERT_TEMP_MAX_C, 60),
  alertPowerMaxKw: num(process.env.ALERT_POWER_MAX_KW, 12),

  tariffUsdPerKwh: num(process.env.TARIFF_USD_PER_KWH, 0.12),

  aiMode: process.env.AI_MODE || 'auto', // auto | anthropic | openai | fallback
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  // Provider-specific extra body fields merged into every chat request
  // (e.g. NVIDIA NIM: {"chat_template_kwargs":{"thinking":false}}).
  openaiExtraBody: parseJson(process.env.OPENAI_EXTRA_BODY, {}),
  aiMaxToolIterations: num(process.env.AI_MAX_TOOL_ITERATIONS, 8),
  aiMaxTokens: num(process.env.AI_MAX_TOKENS, 2048),
  aiActionConfirmTtlMin: num(process.env.AI_ACTION_CONFIRM_TTL_MIN, 10),

  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),

  logLevel: process.env.LOG_LEVEL || 'info',

  /** Static file serving of the built frontend (production mode). */
  frontendDist: path.join(ROOT, 'frontend', 'dist'),

  /** Anthropic tool-use API — must not be overridden. */
  anthropicUrl: 'https://api.anthropic.com/v1/messages',
};

module.exports = config;
