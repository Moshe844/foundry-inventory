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

  const notes = [];
  if (!connectedSources) notes.push('No live sales or warehouse system is connected, so physical changes must be reported or uploaded.');
  if (!usageReady && inventorySignals.length) notes.push('Foundry does not yet have enough outbound history to calculate trustworthy stockout timing.');
  if (locationCount < 2) notes.push('There is only one active location, so warehouse balancing is not possible.');
  if (!supplierCount) notes.push('No supplier is configured, so Foundry cannot prepare replenishment orders.');

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
      title: 'Foundry cannot see stock leaving the business',
      because:
        `Foundry knows the current quantities for ${state.skuCount} stock position${state.skuCount === 1 ? '' : 's'}, ` +
        'but it has no live sales or warehouse feed and no usable outbound history. Until that input exists, ' +
        'it cannot truthfully decide what is low, forecast a stockout, or calculate replenishment.',
      action: 'See what is missing',
      link: '/needs-you#operating-inputs',
      priority: 95,
    });
  }

  return result;
}

module.exports = { assess, decisions };
