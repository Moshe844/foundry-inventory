'use strict';

/**
 * What the person sees before they approve.
 *
 * Every number here comes from the proposal's own stored state, which was read
 * from Mission 1 truth when it was built and re-read at approval. Nothing on
 * this screen is written by a model, so the preview cannot say one thing while
 * the action does another.
 */

const policy = require('./policy');

const ACTION_LABEL = {
  receive: 'receive',
  issue: 'issue',
  transfer: 'transfer',
  adjust: 'correct the count for',
  create_item: 'add',
  add_location: 'add a location',
  rename_terminology: 'change some wording',
};

const ACTION_TITLE = {
  receive: 'Foundry is ready to receive',
  issue: 'Foundry is ready to issue',
  transfer: 'Foundry is ready to transfer',
  adjust: 'Foundry is ready to correct a count',
  create_item: 'Foundry is ready to add a product',
  add_location: 'Foundry is ready to add a location',
  rename_terminology: 'Foundry is ready to change some wording',
};

const REASON_LABEL = {
  sold: 'Sold or delivered',
  used: 'Used internally',
  damaged: 'Damaged',
  lost: 'Lost',
  returned_to_supplier: 'Returned to supplier',
  other: 'Other',
  physical_count: 'Physical count',
  found: 'Found',
  shrinkage: 'Shrinkage',
  correction: 'Correction',
};

/** The product, lot or units this action is about, named as a person would. */
function subjectOf(db, workspaceId, proposal) {
  if (proposal.serialUnitIds.length) {
    const units = proposal.serialUnitIds
      .map((id) =>
        db
          .prepare(
            `SELECT su.serial, i.name AS item_name FROM serial_units su
               JOIN skus s ON s.id = su.sku_id JOIN items i ON i.id = s.item_id
              WHERE su.id = ? AND su.workspace_id = ?`
          )
          .get(id, workspaceId)
      )
      .filter(Boolean);
    if (units.length === 0) return { name: 'unknown unit', detail: null };
    return {
      name: units[0].item_name,
      detail: units.map((u) => u.serial).join(', '),
      unitCount: units.length,
    };
  }

  if (!proposal.skuId) {
    if (proposal.actionType === 'add_location') {
      return { name: proposal.settings.name, detail: 'new location' };
    }
    if (proposal.actionType === 'rename_terminology') {
      return { name: proposal.settings.value, detail: `what Foundry calls a ${proposal.settings.key}` };
    }
    if (proposal.actionType === 'create_item') {
      const axes = proposal.settings.axes || [];
      return {
        name: proposal.settings.name,
        detail: proposal.settings.code || null,
        axes,
        variantCount: (proposal.expectedAfterState && proposal.expectedAfterState.variants) || 1,
        trackingMode: proposal.settings.trackingMode,
      };
    }
    return { name: 'inventory', detail: null };
  }

  const sku = db
    .prepare(
      `SELECT s.code, s.variant_label, i.name AS item_name, i.unit_label
         FROM skus s JOIN items i ON i.id = s.item_id
        WHERE s.id = ? AND s.workspace_id = ?`
    )
    .get(proposal.skuId, workspaceId);
  if (!sku) return { name: 'unknown product', detail: null };

  const lot = proposal.lotId
    ? db.prepare('SELECT code FROM lots WHERE id = ? AND workspace_id = ?').get(proposal.lotId, workspaceId)
    : null;

  return {
    name: sku.item_name,
    detail: [sku.variant_label, lot ? `Lot ${lot.code}` : null].filter(Boolean).join(' · ') || null,
    unitLabel: sku.unit_label,
    code: sku.code,
    lotCode: lot ? lot.code : null,
  };
}

/** One sentence, for lists and for telling the model what is already pending. */
function oneLine(db, workspaceId, proposal) {
  const subject = subjectOf(db, workspaceId, proposal);
  const name = [subject.name, subject.detail].filter(Boolean).join(' / ');
  const before = proposal.expectedBeforeState || {};

  switch (proposal.actionType) {
    case 'receive':
      return `Receive ${proposal.quantity} ${name} into ${before.destinationLocationName || 'a location'}`;
    case 'issue':
      return `Issue ${proposal.quantity} ${name} from ${before.sourceLocationName || 'a location'}`;
    case 'transfer':
      return `Transfer ${proposal.quantity} ${name} from ${before.sourceLocationName || 'somewhere'} to ${before.destinationLocationName || 'somewhere'}`;
    case 'adjust':
      return `Correct ${name} at ${before.sourceLocationName || 'a location'} to ${proposal.adjustmentTarget}`;
    case 'create_item': {
      const count = (proposal.expectedAfterState && proposal.expectedAfterState.variants) || 1;
      return count > 1
        ? `Add ${proposal.settings.name} with ${count} variants`
        : `Add the product ${proposal.settings.name}`;
    }
    case 'add_location':
      return `Add the location “${proposal.settings.name}”`;
    case 'rename_terminology':
      return `Call a ${proposal.settings.key} a “${proposal.settings.value}”`;
    default:
      return proposal.actionType;
  }
}

/**
 * The full preview: what, where, from what to what, and why.
 * `current` is the freshly re-read state when it differs from what was stored.
 */
function present(db, workspaceId, proposal, options = {}) {
  const subject = subjectOf(db, workspaceId, proposal);
  const before = options.current || proposal.expectedBeforeState || {};
  const after = proposal.expectedAfterState || {};
  const rows = [];

  if (proposal.sourceLocationId) {
    rows.push({
      label: before.sourceLocationName || 'Source',
      before: before.sourceOnHand ?? 0,
      after:
        proposal.actionType === 'adjust'
          ? proposal.adjustmentTarget
          : (before.sourceOnHand ?? 0) - (proposal.quantity || 0),
      direction: 'out',
    });
  }
  if (proposal.destinationLocationId) {
    rows.push({
      label: before.destinationLocationName || 'Destination',
      before: before.destinationOnHand ?? 0,
      after: (before.destinationOnHand ?? 0) + (proposal.quantity || 0),
      direction: 'in',
    });
  }

  const total = {
    before: before.total ?? 0,
    after:
      proposal.actionType === 'transfer'
        ? before.total ?? 0
        : proposal.actionType === 'receive'
          ? (before.total ?? 0) + (proposal.quantity || 0)
          : proposal.actionType === 'issue'
            ? (before.total ?? 0) - (proposal.quantity || 0)
            : (before.total ?? 0) + (proposal.adjustmentTarget - (before.sourceOnHand ?? 0)),
  };

  return {
    ...proposal,
    title: ACTION_TITLE[proposal.actionType] || 'Foundry is ready',
    verb: ACTION_LABEL[proposal.actionType] || proposal.actionType,
    subject,
    subjectName: [subject.name, subject.detail].filter(Boolean).join(' / '),
    rows,
    total,
    totalChanges: total.before !== total.after,
    reasonLabel: proposal.reasonCode ? REASON_LABEL[proposal.reasonCode] || proposal.reasonCode : null,
    isMutation: policy.MUTATION_ACTIONS.includes(proposal.actionType),
    needsWarningConfirm: proposal.approvalRequirement === policy.APPROVAL.CONFIRM_WITH_WARNING,
    oneLine: oneLine(db, workspaceId, proposal),
    // Quantity may only be revised on the operations where it is meaningful.
    canReviseQuantity: ['receive', 'issue', 'transfer'].includes(proposal.actionType) && !proposal.serialUnitIds.length,
  };
}

/** What actually changed, once it has run and been verified. */
function outcome(db, workspaceId, proposal, execution) {
  const subject = subjectOf(db, workspaceId, proposal);
  const name = [subject.name, subject.detail].filter(Boolean).join(' / ');
  const before = execution.before || {};
  const after = execution.after || {};
  const lines = [];

  if (before.sourceLocationName !== undefined || proposal.sourceLocationId) {
    lines.push({
      label: before.sourceLocationName || 'Source',
      from: before.sourceOnHand ?? 0,
      to: after.sourceOnHand ?? 0,
    });
  }
  if (proposal.destinationLocationId) {
    lines.push({
      label: before.destinationLocationName || 'Destination',
      from: before.destinationOnHand ?? 0,
      to: after.destinationOnHand ?? 0,
    });
  }

  return {
    name,
    lines,
    total: { from: before.total ?? 0, to: after.total ?? 0 },
    verified: execution.verified,
    problems: (execution.verification && execution.verification.problems) || [],
    checks: (execution.verification && execution.verification.checks) || [],
  };
}

module.exports = {
  ACTION_LABEL,
  ACTION_TITLE,
  REASON_LABEL,
  subjectOf,
  oneLine,
  present,
  outcome,
};
