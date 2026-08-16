'use strict';

/**
 * The connector boundary.
 *
 * Foundry should eventually be able to sit on top of a system a business
 * already runs — reading its inventory, watching it, recommending work, and
 * carrying out only the actions that system actually supports. This file is
 * that architecture.
 *
 * It ships with no vendor connectors, and that is deliberate. A logo on a
 * settings page that does nothing is worse than an empty list: it makes a
 * customer believe their inventory is connected when nothing is reading it. A
 * connector gets registered here when there are real credentials and real test
 * access against a real account, and not before.
 *
 * What a connector may do is discovered from the connector, never assumed.
 * Mission 4 asks before it proposes: a read-only system gets a recommendation
 * and a clear statement that the work has to be done over there.
 */

const { ValidationError, NotFoundError } = require('../../domain/errors');

/**
 * The vocabulary every connector speaks.
 *
 * Reads are separated from writes because the interesting case is a system that
 * will tell Foundry everything and let it change nothing — which is most of
 * them, and which Foundry has to handle honestly rather than treat as broken.
 */
const CAPABILITIES = {
  READ_CATALOG: 'read_catalog',
  READ_LOCATIONS: 'read_locations',
  READ_BALANCES: 'read_balances',
  READ_VARIANTS: 'read_variants',
  READ_SERIALS: 'read_serials',
  READ_LOTS: 'read_lots',
  READ_SUPPLIERS: 'read_suppliers',
  READ_PURCHASE_ORDERS: 'read_purchase_orders',
  READ_MOVEMENTS: 'read_movements',
  WRITE_RECEIVE: 'write_receive',
  WRITE_ISSUE: 'write_issue',
  WRITE_TRANSFER: 'write_transfer',
  WRITE_ADJUST: 'write_adjust',
  WRITE_PURCHASE_ORDER: 'write_purchase_order',
};

const ALL_CAPABILITIES = Object.values(CAPABILITIES);
const READ_CAPABILITIES = ALL_CAPABILITIES.filter((c) => c.startsWith('read_'));
const WRITE_CAPABILITIES = ALL_CAPABILITIES.filter((c) => c.startsWith('write_'));

/** Which capability each Mission 4 action would need from a connected system. */
const ACTION_CAPABILITY = {
  receive: CAPABILITIES.WRITE_RECEIVE,
  issue: CAPABILITIES.WRITE_ISSUE,
  transfer: CAPABILITIES.WRITE_TRANSFER,
  adjust: CAPABILITIES.WRITE_ADJUST,
  purchase: CAPABILITIES.WRITE_PURCHASE_ORDER,
};

const registry = new Map();

/**
 * Registers a connector implementation.
 *
 * @param {object} definition
 *   key           unique, stable identifier
 *   displayName   what a customer would call it
 *   capabilities  what it can actually do — checked against the vocabulary
 *   create(config) returns the live connector
 */
function register(definition) {
  if (!definition || !definition.key) throw new ValidationError('A connector needs a key.');
  const unknown = (definition.capabilities || []).filter((c) => !ALL_CAPABILITIES.includes(c));
  if (unknown.length) {
    throw new ValidationError(`Unknown connector capabilities: ${unknown.join(', ')}.`);
  }
  if (typeof definition.create !== 'function') {
    throw new ValidationError('A connector needs a create() that returns something that can actually talk to it.');
  }
  registry.set(definition.key, definition);
  return definition;
}

/** Every connector Foundry genuinely has. Empty until one really exists. */
function available() {
  return [...registry.values()].map((definition) => ({
    key: definition.key,
    displayName: definition.displayName,
    capabilities: definition.capabilities || [],
    readOnly: !(definition.capabilities || []).some((c) => WRITE_CAPABILITIES.includes(c)),
  }));
}

function get(key) {
  const definition = registry.get(key);
  if (!definition) {
    throw new NotFoundError(
      `Foundry has no connector for that system yet. Export your inventory to CSV or Excel and Foundry will take it from there.`
    );
  }
  return definition;
}

function has(key) {
  return registry.has(key);
}

/**
 * What a connected system will let Foundry do, read from the connector rather
 * than from anything a customer or a model asserted.
 */
function capabilitiesFor(db, workspaceId) {
  const row = db
    .prepare(
      "SELECT connector_key, capabilities FROM workspace_connectors WHERE workspace_id = ? AND status = 'connected' LIMIT 1"
    )
    .get(workspaceId);
  if (!row) return { connected: false, key: null, capabilities: [] };

  let capabilities = [];
  try {
    capabilities = JSON.parse(row.capabilities) || [];
  } catch {
    capabilities = [];
  }
  return {
    connected: true,
    key: row.connector_key,
    capabilities: capabilities.filter((c) => ALL_CAPABILITIES.includes(c)),
    readOnly: !capabilities.some((c) => WRITE_CAPABILITIES.includes(c)),
  };
}

/**
 * Whether Foundry may carry out an action itself, and what to say when it may not.
 *
 * The refusal wording matters as much as the refusal. "This connected system is
 * read-only — complete the transfer in your existing system" tells someone what
 * to do next. Silence, or a success message for something that never happened,
 * is how trust in an inventory system dies.
 */
function canPerform(db, workspaceId, actionType) {
  const paths = require('../paths');
  if (paths.isFoundryNative(db, workspaceId)) {
    return { allowed: true, through: 'foundry' };
  }

  const state = capabilitiesFor(db, workspaceId);
  if (!state.connected) {
    return {
      allowed: false,
      through: 'external',
      because: 'This inventory is owned by an external system, but nothing is connected to it right now.',
    };
  }

  const needed = ACTION_CAPABILITY[actionType];
  if (!needed) {
    return { allowed: false, through: 'external', because: 'That is not something a connected system can be asked to do.' };
  }
  if (!state.capabilities.includes(needed)) {
    return {
      allowed: false,
      through: 'external',
      readOnly: state.readOnly,
      because: state.readOnly
        ? 'This connected system is read-only. Foundry can tell you what to do, but the work has to be done in your existing system.'
        : `This connected system does not let Foundry ${actionType} on its own. Do it in your existing system and Foundry will see the result.`,
    };
  }
  return { allowed: true, through: 'connector', connectorKey: state.key };
}

/** For tests: forget everything registered. */
function reset() {
  registry.clear();
}

module.exports = {
  CAPABILITIES,
  ALL_CAPABILITIES,
  READ_CAPABILITIES,
  WRITE_CAPABILITIES,
  ACTION_CAPABILITY,
  register,
  available,
  get,
  has,
  capabilitiesFor,
  canPerform,
  reset,
};
