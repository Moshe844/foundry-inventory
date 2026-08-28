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

const plural = (value, singular, pluralForm = `${singular}s`) =>
  `${value} ${Number(value) === 1 ? singular : pluralForm}`;

function evidenceGap(entry) {
  const floor = signalEngine.EVIDENCE_FLOOR;
  const measured = entry.measured;
  const missing = {
    outboundEvents: Math.max(0, floor.minOutboundEvents - measured.issueEventsInWindow),
    outboundQuantity: Math.max(0, floor.minOutboundQuantity - measured.issuedInWindow),
    observedDays: Math.max(0, Math.ceil((floor.minObservedDays - measured.observedDays) * 10) / 10),
  };
  const parts = [];
  if (missing.observedDays) parts.push(`${plural(missing.observedDays, 'more observed day')}`);
  if (missing.outboundEvents) parts.push(`${plural(missing.outboundEvents, 'more outbound observation')}`);
  if (missing.outboundQuantity) parts.push(`${plural(missing.outboundQuantity, 'more unit')} leaving`);
  return {
    missing,
    summary: parts.length ? `${entry.displayName} still needs ${parts.join(', ')}.` : null,
  };
}

function assess(db, workspaceId, { now = Date.now() } = {}) {
  const inventorySignals = signalEngine.skuSignals(db, workspaceId, { now })
    .filter((entry) => entry.isActive);

  // Never seen anything leave, and seen some but not enough, are two different
  // facts about the same inventory. Collapsing them into "no usage evidence"
  // meant that recording a real sale changed nothing anybody could see: Foundry
  // went on saying it did not know what you sell, and went on asking to be told.
  const withOutbound = inventorySignals.filter((entry) => entry.measured.issueEventsInWindow > 0);
  const withoutOutbound = inventorySignals.filter((entry) => entry.measured.issueEventsInWindow === 0);
  const ready = inventorySignals.filter((entry) => entry.estimated.hasUsageEvidence);
  const usageReady = ready.length;

  // The threshold for acting on demand is not lowered by any of this. A single
  // sale moves Foundry from knowing nothing to learning; it does not make it
  // ready to reorder on.
  const demandStage = inventorySignals.length === 0
    ? 'no-products'
    : usageReady > 0
      ? 'ready'
      : withOutbound.length > 0
        ? 'learning'
        : 'none';

  const position = (entry) => {
    const gap = evidenceGap(entry);
    return {
      skuId: entry.skuId,
      displayName: entry.displayName,
      issued: entry.measured.issuedInWindow,
      outboundEvents: entry.measured.issueEventsInWindow,
      observedDays: entry.measured.observedDays,
      ready: entry.estimated.hasUsageEvidence,
      missing: gap.missing,
      missingSummary: gap.summary,
    };
  };
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
  if (demandStage === 'none') {
    notes.push('It has not seen anything leave yet, so it cannot say when you will run out.');
  }
  if (demandStage === 'learning') {
    notes.push(
      `It has seen ${withOutbound.length} of ${inventorySignals.length} ` +
      `${inventorySignals.length === 1 ? 'stock position' : 'stock positions'} selling, but not for long enough ` +
      'to say when you will run out.'
    );
  }

  const floor = signalEngine.EVIDENCE_FLOOR;
  const evidenceRequirement =
    `For each stock position, Foundry needs at least ${plural(floor.minObservedDays, 'observed day')}, ` +
    `${plural(floor.minOutboundEvents, 'outbound observation')}, and ` +
    `${plural(floor.minOutboundQuantity, 'unit')} recorded leaving.`;
  const evidenceGaps = inventorySignals
    .filter((entry) => !entry.estimated.hasUsageEvidence)
    .map(position)
    .filter((entry) => entry.missingSummary);
  if (locationCount < 2) {
    notes.push('You have one location, so there is nowhere for Foundry to move stock to.');
  }
  if (!supplierCount) {
    notes.push('No supplier is set up, so Foundry cannot draft an order even when something is low.');
  }

  return {
    canAssessDemand: usageReady > 0,
    demandStage,
    usageReady,
    observingCount: withOutbound.length,
    // Which stock positions Foundry has actually watched move, and which it has not.
    positionsWithOutbound: withOutbound.map(position),
    positionsWithoutOutbound: withoutOutbound.map(position),
    skuCount: inventorySignals.length,
    connectedSources,
    locationCount,
    supplierCount,
    evidenceRequirement,
    evidenceGaps,
    notes,
  };
}

/** Only gaps that require a human decision belong in Needs you. */
function decisions(db, workspaceId, options = {}) {
  const state = options.readiness || assess(db, workspaceId, options);
  const result = [];

  // Only when there is nothing at all to learn from. Once a real sale exists,
  // asking to be told about sales is asking for something already provided —
  // and it sat in Needs you as the one thing standing between the customer and
  // a working system.
  if (state.demandStage === 'none' && state.connectedSources === 0) {
    result.push({
      kind: 'operating_input',
      id: 'outbound-source',
      title: 'Tell Foundry when you sell something',
      because:
        `Foundry knows the quantities in your ${state.skuCount} stock position${state.skuCount === 1 ? '' : 's'}, ` +
        'but not how fast they go. Until it sees stock leaving, it cannot tell you what is running low ' +
        'or what to reorder — and it will not guess. Record a sale, or a delivery going out, and it starts learning.',
      // Why Foundry cannot get this for itself. It lived as copy in the Needs
      // you view, which meant it vanished the moment that page was rebuilt —
      // and it is the sentence that stops "record a sale" reading as busywork.
      why:
        'Foundry cannot silently observe another system or invent demand, and it will not raise a ' +
        'low-stock alert it cannot stand behind. Record sales, usage, or stock leaving and it can ' +
        'begin learning immediately.',
      recommendation: 'Record the next real sale or usage when it happens. Do not create activity just to teach Foundry.',
      missing: 'One outbound movement — a sale, or stock going out — so Foundry can measure demand.',
      action: 'Record a sale',
      link: '/#tell-foundry',
      priority: 95,
    });
  }

  return result;
}

module.exports = { assess, decisions };
