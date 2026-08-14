'use strict';

/**
 * The path from a sentence to something a person can approve.
 *
 *   instruction → intent (model) → resolution (deterministic) → proposal
 *
 * Nothing here executes. The result is always one of three honest outcomes: a
 * proposal to look at, a question, or "Foundry cannot do that" — and the third
 * is a real answer, not a failure. Refusing to invent a purchase order is the
 * behaviour that keeps the rest trustworthy.
 */

const { inTransaction } = require('../db');
const intentService = require('./intent-service');
const proposals = require('./proposal-service');
const presenter = require('./presenter');
const purchaseIntent = require('../purchasing/purchase-intent');
const policy = require('./policy');
const permissions = require('./permissions');
const attention = require('../attention/attention-engine');
const planApplier = require('../foundry/plan-applier');
const repo = require('../domain/repository');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');

/** Everything the model needs to read an instruction in this workspace's terms. */
function instructionContext(db, workspaceId) {
  const configuration = planApplier.getConfiguration(db, workspaceId);
  const terminology = (configuration && configuration.terminology) || {};
  const pending = proposals.listOpen(db, workspaceId, { limit: 3 });
  return {
    locationNames: repo.listLocations(db, workspaceId).map((l) => l.name),
    stockNoun: terminology.item || null,
    pendingAction: pending.length === 1 ? presenter.oneLine(db, workspaceId, pending[0]) : null,
    pendingCount: pending.length,
  };
}

/** Phrases that mean "the thing you already proposed", not a new instruction. */
const AGREEMENT = /^\s*(yes|yep|yeah|ok(ay)?|sure|go ahead|do it|do that|please do|carry on|confirm(ed)?|approve( it)?|make it so|do what you recommended|do your recommendation)\s*[.!]?\s*$/i;

/**
 * Reads an instruction and returns what should happen next.
 *
 * @returns {{ kind: 'proposal'|'plan'|'question'|'unsupported'|'existing', ... }}
 */
async function interpret(db, ctx, membership, instruction, options = {}) {
  const text = String(instruction || '').trim();
  if (!text) return { kind: 'question', question: 'What would you like Foundry to do?' };

  // "Do it" refers to something already on the table. Resolving that here, in
  // code, means the model is never the thing deciding which action was meant.
  if (AGREEMENT.test(text)) {
    const open = proposals.listOpen(db, ctx.workspaceId, { limit: 5 })
      .filter((p) => p.status === 'AWAITING_APPROVAL');
    if (open.length === 1) {
      return { kind: 'existing', proposal: open[0], instruction: text };
    }
    if (open.length === 0) {
      return {
        kind: 'question',
        question: 'There is nothing waiting for approval. What would you like Foundry to do?',
      };
    }
    return {
      kind: 'question',
      question: 'Which one would you like Foundry to carry out?',
      choices: open.map((p) => ({ proposalId: p.proposalId, summary: presenter.oneLine(db, ctx.workspaceId, p) })),
    };
  }

  const intent = await intentService.readInstruction(text, {
    provider: options.provider,
    context: options.context || instructionContext(db, ctx.workspaceId),
  });

  if (intent.unsupportedReason && intent.lines.length === 0) {
    return { kind: 'unsupported', message: intent.unsupportedReason };
  }
  if (intent.clarifyingQuestion && intent.lines.length === 0) {
    return { kind: 'question', question: intent.clarifyingQuestion };
  }

  const usable = intent.lines.filter((line) => !['clarify', 'unsupported'].includes(line.actionType));
  const blocked = intent.lines.find((line) => ['clarify', 'unsupported'].includes(line.actionType));
  if (usable.length === 0) {
    if (blocked && blocked.actionType === 'unsupported') {
      return { kind: 'unsupported', message: intent.unsupportedReason || 'Foundry cannot do that yet.' };
    }
    return {
      kind: 'question',
      question: intent.clarifyingQuestion || 'Could you say a little more about what you want Foundry to do?',
    };
  }

  // Permission is checked before anything is written, so a person without it
  // is told plainly rather than shown a proposal they can never approve.
  for (const line of usable) permissions.assertCanPerform(membership, line.actionType);

  // Purchasing is a different kind of thing from moving stock, and it has its
  // own object with its own approval. It leaves this pipeline here rather than
  // being forced into an action proposal that would mean something else.
  const purchase = usable.find((line) => line.actionType === 'purchase');
  if (purchase) {
    const result = purchaseIntent.build(db, ctx, membership, purchase, { instruction: text });
    if (!result.ok) {
      return result.unsupported
        ? { kind: 'unsupported', message: result.unsupported }
        : { kind: 'question', question: result.question };
    }
    return { kind: 'purchase_order', order: result.order, assumptions: result.assumptions };
  }

  const shipment = usable.find((line) => line.actionType === 'receive_shipment');
  if (shipment) {
    return { kind: 'receive_shipment', supplier: shipment.supplier || '', instruction: text };
  }

  return inTransaction(db, () => {
    const built = [];
    for (const line of usable) {
      const result = proposals.build(db, ctx, line);
      if (!result.ok) {
        if (result.unsupported) return { kind: 'unsupported', message: result.unsupported };
        return { kind: 'question', question: result.question, needsReason: Boolean(result.needsReason) };
      }
      built.push(result.proposal);
    }

    if (built.length === 1) {
      const stored = proposals.persist(db, ctx, built[0], {
        sourceType: options.sourceType || 'USER_REQUEST',
        sourceAttentionId: options.sourceAttentionId || null,
        instruction: text,
      });
      return { kind: 'proposal', proposal: stored };
    }

    const plan = createPlan(db, ctx, built, { instruction: text });
    return { kind: 'plan', plan };
  });
}

/** Several lines approved and executed as one, all or nothing by default. */
function createPlan(db, ctx, built, meta = {}) {
  const planId = newId('apl');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + policy.PROPOSAL_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO action_plans
       (id, workspace_id, requested_by_user_id, original_instruction, summary,
        atomicity_policy, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'ALL_OR_NOTHING', 'AWAITING_APPROVAL', ?, ?)`
  ).run(planId, ctx.workspaceId, ctx.actorId, meta.instruction || null, meta.summary || '', now, expiresAt);

  const lines = built.map((proposal, index) =>
    proposals.persist(db, ctx, proposal, {
      planId,
      lineNumber: index + 1,
      sourceType: meta.sourceType || 'USER_REQUEST',
      instruction: meta.instruction || null,
    })
  );

  return getPlan(db, ctx.workspaceId, planId, lines);
}

function getPlan(db, workspaceId, planId, preloaded = null) {
  const row = db.prepare('SELECT * FROM action_plans WHERE id = ? AND workspace_id = ?').get(planId, workspaceId);
  if (!row) return null;
  const lines =
    preloaded ||
    db
      .prepare('SELECT * FROM action_proposals WHERE plan_id = ? AND workspace_id = ? ORDER BY line_number')
      .all(planId, workspaceId)
      .map(proposals.hydrate);

  return {
    planId: row.id,
    workspaceId: row.workspace_id,
    requestedByUserId: row.requested_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    originalInstruction: row.original_instruction,
    atomicityPolicy: row.atomicity_policy,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
    lines,
    // A plan is as risky as its riskiest line.
    safetyLevel: lines.some((l) => l.safetyLevel === 'HIGH') ? 'HIGH' : 'MUTATION',
    warnings: lines.flatMap((l) => l.warnings),
  };
}

function setPlanStatus(db, workspaceId, planId, status, extra = {}) {
  const sets = ['status = @status'];
  const params = { id: planId, workspaceId, status };
  if (extra.approvedBy) {
    sets.push('approved_by_user_id = @approvedBy', 'approved_at = @now');
    params.approvedBy = extra.approvedBy;
    params.now = nowIso();
  }
  if (extra.completed) {
    sets.push('completed_at = @completedAt');
    params.completedAt = nowIso();
  }
  db.prepare(`UPDATE action_plans SET ${sets.join(', ')} WHERE id = @id AND workspace_id = @workspaceId`).run(params);
}

/**
 * Turns a Mission 3 finding into something reviewable.
 *
 * Only where an operation Foundry actually has can address the condition. A
 * stockout needs replenishment, which does not exist yet, so it gets no action
 * — inventing one would be worse than offering none.
 */
function proposeFromAttention(db, ctx, membership, attentionId) {
  const item = attention.getAttention(db, ctx.workspaceId, attentionId);
  if (!item) throw new NotFoundError('That item could not be found.');

  if (item.category !== 'location_imbalance' && !item.relatedCategories.includes('location_imbalance')) {
    return { kind: 'unsupported', message: actionabilityMessage(item) };
  }

  const metrics = item.metrics || {};
  const quantity = Number(metrics.suggestedTransferQuantity);
  if (!Number.isFinite(quantity) || quantity < 1) {
    return { kind: 'unsupported', message: 'There is no move that would clearly improve this.' };
  }

  permissions.assertCanPerform(membership, 'transfer');

  const from = db.prepare('SELECT name FROM locations WHERE id = ? AND workspace_id = ?')
    .get(metrics.quietLocationId, ctx.workspaceId);
  const to = db.prepare('SELECT name FROM locations WHERE id = ? AND workspace_id = ?')
    .get(metrics.busyLocationId, ctx.workspaceId);
  if (!from || !to) return { kind: 'unsupported', message: 'The locations involved have changed.' };

  return inTransaction(db, () => {
    const built = proposals.build(db, ctx, {
      actionType: 'transfer',
      item: '',
      variant: '',
      lotCode: '',
      serials: [],
      sourceLocation: from.name,
      destinationLocation: to.name,
      quantity,
      // Resolution is by id here: the finding already knows exactly which SKU.
      resolvedSkuId: item.skuId,
    });
    if (!built.ok) return { kind: 'question', question: built.question || built.unsupported };

    const stored = proposals.persist(db, ctx, built.proposal, {
      sourceType: 'ATTENTION_ITEM',
      sourceAttentionId: attentionId,
      instruction: item.recommendation,
    });
    return { kind: 'proposal', proposal: stored };
  });
}

function actionabilityMessage(item) {
  const messages = {
    stockout_risk: 'Replenishment ordering is not supported yet, so Foundry cannot act on this. Review the stock and order it yourself.',
    low_stock: 'Replenishment ordering is not supported yet, so Foundry cannot act on this.',
    expiring_inventory: 'Foundry can move this lot somewhere it will be used, but deciding what to do with it is yours. Ask Foundry to transfer it if that helps.',
    unusual_adjustment: 'This is something to check with the person who recorded it. There is no inventory action to take.',
    stale_inventory: 'Foundry can move this stock if you tell it where. There is no action it should take on its own.',
    serialized_inactivity: 'Foundry can move these units if you tell it where they should be.',
    data_integrity: 'This needs investigating rather than an inventory movement.',
  };
  return messages[item.category] || 'There is no inventory action Foundry can take for this.';
}

/**
 * A change of mind supersedes rather than edits: what was approved has to stay
 * exactly what was approved, so a new quantity is a new proposal.
 */
function reviseQuantity(db, ctx, membership, proposalId, quantity) {
  const existing = proposals.get(db, ctx.workspaceId, proposalId);
  if (!existing) throw new NotFoundError('That action could not be found.');
  permissions.assertCanPerform(membership, existing.actionType);
  if (!['AWAITING_APPROVAL', 'APPROVED', 'INVALIDATED'].includes(existing.status)) {
    throw new ValidationError('That action can no longer be changed.');
  }
  const wanted = Math.trunc(Number(quantity));
  if (!Number.isFinite(wanted) || wanted < 1) throw new ValidationError('Enter how many, as a whole number.');

  return inTransaction(db, () => {
    const intent = intentFromProposal(db, ctx.workspaceId, existing, { quantity: wanted });
    const built = proposals.build(db, ctx, intent);
    if (!built.ok) {
      throw new ValidationError(built.question || built.unsupported || 'That change is not possible.');
    }
    built.proposal.proposalVersion = existing.proposalVersion + 1;
    built.proposal.integrityHash = proposals.computeIntegrityHash(built.proposal);

    proposals.setStatus(db, ctx, proposalId, 'SUPERSEDED');
    proposals.record(db, ctx, proposalId, 'SUPERSEDED', { newQuantity: wanted });

    return proposals.persist(db, ctx, built.proposal, {
      sourceType: existing.sourceType,
      sourceAttentionId: existing.sourceAttentionId,
      sourceProposalId: proposalId,
      planId: existing.planId,
      lineNumber: existing.lineNumber,
      instruction: existing.originalInstruction,
    });
  });
}

/** Rebuilds the intent behind a stored proposal, so it can be recalculated. */
function intentFromProposal(db, workspaceId, proposal, overrides = {}) {
  const location = (id) => {
    if (!id) return '';
    const row = db.prepare('SELECT name FROM locations WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    return row ? row.name : '';
  };
  const lot = proposal.lotId
    ? db.prepare('SELECT code FROM lots WHERE id = ? AND workspace_id = ?').get(proposal.lotId, workspaceId)
    : null;
  const serials = proposal.serialUnitIds.map((id) => {
    const row = db.prepare('SELECT serial FROM serial_units WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    return row ? row.serial : null;
  }).filter(Boolean);

  return {
    actionType: proposal.actionType,
    item: '',
    variant: '',
    lotCode: lot ? lot.code : '',
    serials,
    sourceLocation: location(proposal.sourceLocationId),
    destinationLocation: location(proposal.destinationLocationId),
    quantity: overrides.quantity ?? proposal.quantity,
    adjustmentTarget: overrides.adjustmentTarget ?? proposal.adjustmentTarget,
    reasonCode: proposal.reasonCode || '',
    resolvedSkuId: proposal.skuId,
    settings: proposal.settings,
    assumptions: [],
  };
}

/**
 * Undo is a new, validated movement in the opposite direction — never a
 * deletion. The ledger is append-only, so "putting it back" is itself work that
 * has to be checked against what the inventory looks like now.
 */
function proposeCompensation(db, ctx, membership, proposalId) {
  const original = proposals.get(db, ctx.workspaceId, proposalId);
  if (!original) throw new NotFoundError('That action could not be found.');
  if (original.status !== 'SUCCEEDED') throw new ValidationError('That action did not run, so there is nothing to undo.');

  if (original.actionType !== 'transfer') {
    return {
      kind: 'unsupported',
      message:
        original.actionType === 'adjust'
          ? 'A correction is undone by recording another correction, with its own reason.'
          : 'Foundry can only reverse a transfer automatically. Anything else needs a new action.',
    };
  }

  permissions.assertCanPerform(membership, 'transfer');

  return inTransaction(db, () => {
    const intent = intentFromProposal(db, ctx.workspaceId, original);
    // The same move, the other way round.
    const reversed = {
      ...intent,
      sourceLocation: intent.destinationLocation,
      destinationLocation: intent.sourceLocation,
    };
    const built = proposals.build(db, ctx, reversed);
    if (!built.ok) {
      return { kind: 'question', question: built.question || built.unsupported };
    }
    const stored = proposals.persist(db, ctx, built.proposal, {
      sourceType: 'COMPENSATION',
      sourceProposalId: proposalId,
      instruction: `Reverse ${original.proposalId}`,
    });
    return { kind: 'proposal', proposal: stored };
  });
}

module.exports = {
  AGREEMENT,
  interpret,
  instructionContext,
  createPlan,
  getPlan,
  setPlanStatus,
  proposeFromAttention,
  actionabilityMessage,
  reviseQuantity,
  proposeCompensation,
  intentFromProposal,
};
