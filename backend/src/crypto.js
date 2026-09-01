'use strict';

/**
 * Password hashing (scrypt, per-user salt) and stateless JWT (HMAC-SHA256).
 * Implemented with Node's crypto only — no third-party auth dependency.
 * Token revocation is handled via a per-user `token_version` stored in DB.
 */
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const JWT_ALG = 'HS256';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const candidate = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signJwt(payload, secret, ttlHours) {
  const header = { alg: JWT_ALG, typ: 'JWT' };
  const body = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlHours * 3600,
    jti: crypto.randomUUID(),
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function verifyJwt(token, secret) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    const sigBuf = Buffer.from(sig, 'base64url');
    const expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (body.exp && body.exp * 1000 < Date.now()) return null;
    return body;
  } catch {
    return null;
  }
}

/** HMAC one-time token used for AI action confirmation (PRD §47–48). */
function signActionToken(secret, payload, ttlMs) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  const sig = crypto.createHmac('sha256', secret).update(`ai-action.${body}`).digest('base64url');
  return `${body}.${sig}`;
}

function verifyActionToken(secret, token) {
  try {
    const [body, sig] = String(token).split('.');
    const expected = crypto.createHmac('sha256', secret).update(`ai-action.${body}`).digest('base64url');
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, signJwt, verifyJwt, signActionToken, verifyActionToken };
