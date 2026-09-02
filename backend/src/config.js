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
  // Self-registration for production-like (no-demo) mode: first account on an
  // empty database is always ADMIN; later accounts become WORKER. Disable
  // after onboarding (ALLOW_REGISTRATION=false).
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, true),
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
  // OpenAI-compatible endpoint. NVIDIA NIM is supported directly:
  //   NVIDIA_API_KEY / NVIDIA_BASE_URL / NVIDIA_MODEL are aliases, so the
  //   official `$NVIDIA_API_KEY` environment variable works out of the box.
  nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1',
  openaiApiKey: process.env.OPENAI_API_KEY || process.env.NVIDIA_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || process.env.NVIDIA_MODEL ||
    (process.env.NVIDIA_API_KEY || process.env.NVIDIA_BASE_URL
      ? 'deepseek-ai/deepseek-v4-pro-0813'
      : 'gpt-4o-mini'),
  // If only $NVIDIA_API_KEY is provided (the official SDK pattern), default to
  // the NIM endpoint; otherwise default to OpenAI's public endpoint.
  openaiBaseUrl: (
    process.env.OPENAI_BASE_URL ||
    process.env.NVIDIA_BASE_URL ||
    (process.env.NVIDIA_API_KEY ? 'https://integrate.api.nvidia.com/v1' : 'https://api.openai.com/v1')
  ).replace(/\/$/, ''),
  // Provider-specific extra body fields merged into every chat request
  // (e.g. NVIDIA NIM: {"chat_template_kwargs":{"thinking":false}}).
  // When a NIM endpoint is configured without an explicit override, disable
  // thinking automatically (required for reliable tool calling on NIM
  // DeepSeek models).
  openaiExtraBody: parseJson(
    process.env.OPENAI_EXTRA_BODY,
    String(process.env.OPENAI_BASE_URL || process.env.NVIDIA_BASE_URL || '').includes('nvidia.com') || process.env.NVIDIA_API_KEY
      ? { chat_template_kwargs: { thinking: false } }
      : {},
  ),
  // Sampling parameters (same knobs as the public SDK example).
  aiTemperature: num(process.env.AI_TEMPERATURE, 1),
  aiTopP: num(process.env.AI_TOP_P, 0.95),
  aiSeed: process.env.AI_SEED === undefined || process.env.AI_SEED === '' ? null : num(process.env.AI_SEED, null),
  aiMaxToolIterations: num(process.env.AI_MAX_TOOL_ITERATIONS, 8),
  aiMaxTokens: num(process.env.AI_MAX_TOKENS, 16384),
  aiActionConfirmTtlMin: num(process.env.AI_ACTION_CONFIRM_TTL_MIN, 10),

  corsOrigins: (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),

  logLevel: process.env.LOG_LEVEL || 'info',

  /** Static file serving of the built frontend (production mode). */
  frontendDist: path.join(ROOT, 'frontend', 'dist'),

  /** Anthropic tool-use API — must not be overridden. */
  anthropicUrl: 'https://api.anthropic.com/v1/messages',
};

module.exports = config;
