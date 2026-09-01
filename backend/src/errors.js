'use strict';

/**
 * Structured application errors → { error: { code, message, details? } }
 * per the PRD API principles (§25).
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const errors = {
  badRequest: (msg, details) => new AppError(400, 'BAD_REQUEST', msg, details),
  unauthorized: (msg = 'Authentication required.') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'You do not have permission to perform this action.') =>
    new AppError(403, 'UNAUTHORIZED_ACTION', msg),
  notFound: (msg = 'Resource not found.') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (msg) => new AppError(409, 'CONFLICT', msg),
  rateLimited: (msg = 'Too many requests. Try again later.') => new AppError(429, 'RATE_LIMITED', msg),
  validation: (msg, details) => new AppError(422, 'VALIDATION_ERROR', msg, details),
  internal: (msg = 'Internal server error.') => new AppError(500, 'INTERNAL_ERROR', msg),
};

module.exports = { AppError, errors };
