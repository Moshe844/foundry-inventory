'use strict';

/**
 * What evidence the manager can actually observe without a person supplying it.
 *
 * These are not inventory alerts. They are operating-input gaps: conditions
 * where Foundry cannot perform the manager job because an external fact never
 * reaches the ledger. Mission 8 explicitly treats insufficient evidence as a
 * human exception; hiding it in helper text makes an idle loop look broken.
 */

const signalEngine = require('../signals/signal-engine');

function assess(db, workspaceId, { now = Date.now() } = {}) {
  const inventorySignals = signalEngine.skuSignals(db, workspaceId, { now })
    .filter((entry) => entry.isActive);
  const usageReady = inventorySignals.filter((entry) => entry.estimated.hasUsageEvidence).length;
  const locationCount = db
    .prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ? AND is_active = 1')
    .get(workspaceId).n;
  const supplierCount = db
    .prepare('SELECT COUNT(*) AS n FROM suppliers WHERE workspace_id = ?')
    .get(workspaceId).n;
  const connectedSources = db
    .prepare(
      "SELECT COUNT(*) AS n FROM workspace_connectors WHERE workspace_id = ? AND status = 'connected' AND last_synced_at IS NOT NULL"
    )
    .get(workspaceId).n;

  // Each of these is read by somebody who may never have run an inventory
  // system. They say what Foundry cannot do and what would change it, in the
  // words a shopkeeper would use — not "outbound history", "standing authority"
  // or "replenishment orders".
  const notes = [];
  if (!connectedSources) {
    notes.push('Nothing is feeding Foundry automatically yet, so tell it when stock comes in or goes out.');
  }
  if (!usageReady && inventorySignals.length) {
    notes.push('It has not seen enough selling yet to say when you will run out.');
  }
  if (locationCount < 2) {
    notes.push('You have one location, so there is nowhere for Foundry to move stock to.');
  }
  if (!supplierCount) {
    notes.push('No supplier is set up, so Foundry cannot draft an order even when something is low.');
  }

  return {
    canAssessDemand: usageReady > 0,
    usageReady,
    skuCount: inventorySignals.length,
    connectedSources,
    locationCount,
    supplierCount,
    notes,
  };
}

/** Only gaps that require a human decision belong in Needs you. */
function decisions(db, workspaceId, options = {}) {
  const state = options.readiness || assess(db, workspaceId, options);
  const result = [];

  if (state.skuCount > 0 && state.usageReady === 0 && state.connectedSources === 0) {
    result.push({
      kind: 'operating_input',
      id: 'outbound-source',
      title: 'Tell Foundry when you sell something',
      because:
        `Foundry knows how many of your ${state.skuCount} product${state.skuCount === 1 ? '' : 's'} you have, ` +
        'but not how fast they go. Until it sees stock leaving, it cannot tell you what is running low ' +
        'or what to reorder — and it will not guess. Record a sale, or a delivery going out, and it starts learning.',
      action: 'Record a sale',
      link: '/#tell-foundry',
      priority: 95,
    });
  }

  return result;
}

module.exports = { assess, decisions };
