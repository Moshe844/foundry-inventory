'use strict';

/**
 * The AI boundary.
 *
 * Everything above this line is Foundry's intelligence layer; everything below
 * is a vendor. A provider takes a prompt plus a JSON Schema and returns parsed,
 * schema-shaped data — nothing more. It cannot run SQL, call services, or reach
 * the inventory engine, because it is never handed anything that could.
 *
 * Mission 2 ships one production provider (Anthropic). The registry exists so
 * that stays a configuration choice rather than an architectural commitment.
 */

const { DomainError } = require('../domain/errors');

class ProviderError extends DomainError {
  constructor(message, options = {}) {
    super(message, { code: options.code || 'ai_provider_error', status: options.status || 502 });
    this.retryable = options.retryable === true;
    this.cause = options.cause || null;
  }
}

/** Raised when the model returns something that is not valid against the schema. */
class ProviderOutputError extends ProviderError {
  constructor(message, details) {
    super(message, { code: 'ai_invalid_output', status: 502 });
    this.details = details || null;
  }
}

const registry = new Map();

function registerProvider(name, factory) {
  registry.set(name, factory);
}

/**
 * @returns {{ name: string, model: string, complete(request): Promise<{data: object, usage: object}> }}
 */
function createProvider(name, options = {}) {
  const factory = registry.get(name);
  if (!factory) {
    throw new ProviderError(`No AI provider named "${name}" is registered.`, { code: 'ai_provider_unknown' });
  }
  return factory(options);
}

function availableProviders() {
  return [...registry.keys()];
}

/**
 * A provider configured for one kind of work.
 *
 * Call sites ask for the thinking they need — 'deep', 'standard', 'fast' — and
 * never for a model by name. Which model serves a tier is a deployment
 * decision, not something a service should hold an opinion about.
 */
function createProviderForTier(tierName, options = {}) {
  const config = require('../config');
  const tier = config.ai.tier(tierName);
  return createProvider(options.provider || config.ai.provider, { ...tier, ...options });
}

registerProvider('anthropic', (options) => require('./providers/anthropic').create(options));

module.exports = {
  registerProvider,
  createProvider,
  createProviderForTier,
  availableProviders,
  ProviderError,
  ProviderOutputError,
};
