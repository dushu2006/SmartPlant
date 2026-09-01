'use strict';

/**
 * Authentication & authorization (PRD §4, §59).
 *  - Authentication: email+password → JWT (HS256, exp, per-user token version
 *    for revocation on logout/password change). Login rate-limited.
 *  - Authorization: requirePermission middleware enforcing the shared RBAC
 *    matrix. The frontend may hide UI; the backend always rejects.
 */
const crypto = require('crypto');
const config = require('./config');
const { verifyPassword, signJwt, verifyJwt } = require('./crypto');
const usersStore = require('./store/users');
const { audit } = require('./services/audit');
const { errors } = require('./errors');
const { can } = require('@smartplant/shared');

// ------------------------------------------------------------ rate limiting
const loginAttempts = new Map(); // key: ip|email -> { count, resetAt }

function checkLoginRate(ip, email) {
  const key = `${ip}|${String(email).toLowerCase()}`;
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + config.loginRateWindowMin * 60000 });
    return true;
  }
  entry.count++;
  if (entry.count > config.loginRateLimit) {
    throw errors.rateLimited('Too many login attempts. Try again later.');
  }
  return true;
}

function clearLoginRate(ip, email) {
  loginAttempts.delete(`${ip}|${String(email).toLowerCase()}`);
}

// ------------------------------------------------------------ login
function login({ email, password, ip, userAgent }) {
  if (!email || !password) throw errors.badRequest('email and password are required.');
  checkLoginRate(ip, email);
  const user = usersStore.findByEmail(email);
  const ok = user && verifyPassword(password, user.password_hash);
  if (!ok) {
    audit({ actorId: user?.id, action: 'AUTH.LOGIN', entityType: 'user', entityId: user?.id, metadata: { ip, userAgent, ok: false } });
    throw errors.unauthorized('Invalid email or password.');
  }
  if (user.status !== 'ACTIVE') {
    throw errors.forbidden('This account is inactive. Contact an administrator.');
  }
  clearLoginRate(ip, email);
  usersStore.touchLastLogin(user.id);
  const token = signJwt(
    { sub: user.id, role: user.role, name: user.display_name, ver: user.token_version },
    config.jwtSecret,
    config.jwtTtlHours,
  );
  audit({ actorId: user.id, action: 'AUTH.LOGIN', entityType: 'user', entityId: user.id, metadata: { ip, userAgent, ok: true } });
  return { token, user: usersStore.toPublic(user) };
}

// ------------------------------------------------------------ middleware
function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(errors.unauthorized());
  const payload = verifyJwt(token, config.jwtSecret);
  if (!payload) return next(errors.unauthorized('Invalid or expired session.'));
  const user = usersStore.findWithHash(payload.sub); // full row incl. token_version
  if (!user || user.status !== 'ACTIVE') return next(errors.unauthorized('Account unavailable.'));
  if (user.token_version !== payload.ver) return next(errors.unauthorized('Session revoked. Please log in again.'));
  const { password_hash, ...safe } = user;
  req.user = { ...safe, token };
  next();
}

function requirePermission(permission) {
  return (req, _res, next) => {
    if (!req.user) return next(errors.unauthorized());
    if (!can(req.user.role, permission)) {
      return next(errors.forbidden());
    }
    next();
  };
}

function issueToken(user) {
  return signJwt({ sub: user.id, role: user.role, name: user.display_name, ver: user.token_version }, config.jwtSecret, config.jwtTtlHours);
}

function refreshToken(user) {
  return { token: issueToken(user), user: usersStore.toPublic(user) };
}

function logout(userId) {
  usersStore.bumpTokenVersion(userId); // revoke all existing tokens
  audit({ actorId: userId, action: 'AUTH.LOGOUT', entityType: 'user', entityId: userId });
}

function changePassword(userId, currentPassword, newPassword) {
  const user = usersStore.findWithHash(userId);
  if (!verifyPassword(currentPassword, user.password_hash)) {
    throw errors.forbidden('Current password is incorrect.');
  }
  if (String(newPassword).length < 8) throw errors.validation('New password must be at least 8 characters.');
  const { hashPassword } = require('./crypto');
  usersStore.update(userId, { passwordHash: hashPassword(newPassword) });
  usersStore.bumpTokenVersion(userId);
  audit({ actorId: userId, action: 'AUTH.PASSWORD_CHANGE', entityType: 'user', entityId: userId });
  return issueToken(usersStore.findById(userId));
}

module.exports = { login, requireAuth, requirePermission, refreshToken, logout, changePassword, issueToken };
