'use strict';

class DomainError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code || 'domain_error';
    this.status = options.status || 400;
    this.details = options.details || null;
  }
}

/** Input the user can fix: missing field, bad number, unknown option. */
class ValidationError extends DomainError {
  constructor(message, details) {
    super(message, { code: 'validation_error', status: 400, details });
  }
}

/** Record does not exist, or does not belong to this workspace. */
class NotFoundError extends DomainError {
  constructor(message = 'That record could not be found.') {
    super(message, { code: 'not_found', status: 404 });
  }
}

/** An inventory invariant would be violated. */
class InvariantError extends DomainError {
  constructor(message, code = 'invariant_violation', details) {
    super(message, { code, status: 409, details });
  }
}

class InsufficientStockError extends InvariantError {
  constructor(message, details) {
    super(message, 'insufficient_stock', details);
  }
}

class AuthorizationError extends DomainError {
  constructor(message = 'You do not have permission to do that.') {
    super(message, { code: 'forbidden', status: 403 });
  }
}

class AuthenticationError extends DomainError {
  constructor(message = 'Please sign in to continue.') {
    super(message, { code: 'unauthenticated', status: 401 });
  }
}

module.exports = {
  DomainError,
  ValidationError,
  NotFoundError,
  InvariantError,
  InsufficientStockError,
  AuthorizationError,
  AuthenticationError,
};
