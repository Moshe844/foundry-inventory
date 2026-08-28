'use strict';

/**
 * Running an approved action.
 *
 * The order here is the whole safety argument, and it never varies:
 *
 *   authorize → claim an idempotency key → revalidate against current truth
 *   → execute through the Mission 1 engine → re-read the balances → record
 *
 * The engine is still the only code that changes a balance. Nothing in this
 * file writes to `balances`, `movements`, `lot_balances` or `serial_units`; it
 * calls `receive` / `issue` / `transfer` / `adjust` exactly as a person would.
 *
 * "It ran" and "it is correct" are deliberately separate claims. A successful
 * engine call that fails verification is reported as unverified, never as done.
 */

const { inTransaction } = require('../db');
const engine = require('../domain/inventory-engine');
const locationService = require('../domain/location-service');
const itemService = require('../domain/item-service');
const catalog = require('../imports/catalog-service');
const repo = require('../domain/repository');
const proposals = require('./proposal-service');
const permissions = require('./permissions');
const policy = require('./policy');
const verification = require('./verification');
const reevaluate = require('../attention/reevaluate');
const { ValidationError, NotFoundError, DomainError } = require('../domain/errors');
const { newId, nowIso } = require('../lib/util');

class StaleProposalError extends DomainError {
  constructor(message, details) {
    super(message, { code: 'proposal_stale', status: 409 });
    this.details = details || null;
  }
}

/**
 * The approval step. Separate from execution so approval is auditable alone.
 *
 * The staleness check runs and is *recorded* before anything can throw. Marking
 * a proposal invalid has to outlive the rejection — writing it inside the same
 * transaction as the throw would roll the record back with it, leaving a stale
 * proposal that still looks approvable.
 */
function approve(db, ctx, membership, proposalId) {
  const proposal = proposals.get(db, ctx.workspaceId, proposalId);
  if (!proposal) throw new NotFoundError('That action could not be found.');
  permissions.assertCanPerform(membership, proposal.actionType);

  if (proposal.status === 'APPROVED') return proposal;
  if (proposal.status !== 'AWAITING_APPROVAL') {
    throw new ValidationError('That action is no longer waiting for approval.');
  }

  const check = proposals.revalidate(db, ctx, proposal);
  if (!check.ok) {
    const problems = describe(check);
    inTransaction(db, () => {
      proposals.setStatus(db, ctx, proposalId, 'INVALIDATED', { problems });
      proposals.record(db, ctx, proposalId, 'INVALIDATED', { at: 'approval', problems });
    });
    throw new StaleProposalError(problems[0] || 'The inventory changed since this was proposed.', {
      current: check.current,
    });
  }

  return inTransaction(db, () => {
    proposals.setStatus(db, ctx, proposalId, 'APPROVED', { approvedBy: ctx.actorId });
    proposals.record(db, ctx, proposalId, 'APPROVED', {});
    return proposals.get(db, ctx.workspaceId, proposalId);
  });
}

function describe(check) {
  const problems = [...(check.problems || [])];
  if (check.changed && problems.length === 0) {
    problems.push('The stock changed since this was worked out. Foundry has recalculated it.');
  }
  return problems;
}

/**
 * Executes an approved proposal, exactly once.
 *
 * `idempotencyKey` is claimed inside the same transaction as the mutation, so a
 * double-click, a retried POST or a replayed request finds the claim already
 * taken and gets the first result back instead of moving stock twice.
 */
function execute(db, ctx, membership, proposalId, options = {}) {
  const idempotencyKey = options.idempotencyKey || `proposal:${proposalId}`;

  const existing = findExecution(db, ctx.workspaceId, idempotencyKey);
  if (existing) return replay(db, ctx.workspaceId, existing);

  const proposal = proposals.get(db, ctx.workspaceId, proposalId);
  if (!proposal) throw new NotFoundError('That action could not be found.');
  permissions.assertCanPerform(membership, proposal.actionType);
  if (proposal.status !== 'APPROVED') {
    throw new ValidationError('That action has not been approved.');
  }

  let claimed;
  try {
    claimed = runOnce(db, ctx, proposal, idempotencyKey);
  } catch (error) {
    if (isDuplicateKey(error)) {
      // Another request beat this one to it by microseconds.
      const winner = findExecution(db, ctx.workspaceId, idempotencyKey);
      if (winner) return replay(db, ctx.workspaceId, winner);
    }
    throw error;
  }

  // Attention re-evaluation happens after the movement has committed, never
  // inside it: interpretation must not be able to roll back inventory work.
  const affectedSkuIds = proposal.skuId ? [proposal.skuId] : (claimed.affectedSkuIds || []);
  if (claimed.status === 'SUCCEEDED' && affectedSkuIds.length) {
    reevaluate.afterMovement(db, ctx.workspaceId, affectedSkuIds, `action:${proposal.actionType}`);
  }
  return claimed;
}

function isDuplicateKey(error) {
  return Boolean(error && typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT'));
}

function runOnce(db, ctx, proposal, idempotencyKey) {
  return inTransaction(db, () => {
    const executionId = newId('axe');
    // Claimed first: if anything below fails, the row is rolled back with it,
    // so a failed attempt never blocks a legitimate retry.
    db.prepare(
      `INSERT INTO action_executions
         (id, workspace_id, idempotency_key, proposal_id, plan_id, executed_by_user_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'EXECUTING', ?)`
    ).run(executionId, ctx.workspaceId, idempotencyKey, proposal.proposalId, proposal.planId, ctx.actorId, nowIso());

    proposals.setStatus(db, ctx, proposal.proposalId, 'EXECUTING');
    proposals.record(db, ctx, proposal.proposalId, 'EXECUTING', { executionId });

    // Last check, with the write lock held: nothing can change underneath now.
    const check = proposals.revalidate(db, ctx, proposal, { ignoreExpiry: true });
    if (!check.ok) {
      throw new StaleProposalError(describe(check)[0] || 'The inventory changed before this could run.', {
        current: check.current,
      });
    }

    const before = proposals.currentState(db, ctx.workspaceId, proposal);
    const result = perform(db, ctx, proposal);
    const after = proposals.currentState(db, ctx.workspaceId, proposal);

    const verdict = verification.verify(db, ctx.workspaceId, proposal, { before, after, result });

    db.prepare(
      `INSERT INTO action_verifications
         (id, workspace_id, execution_id, proposal_id, verified, checks, observed_state, problems, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newId('avf'),
      ctx.workspaceId,
      executionId,
      proposal.proposalId,
      verdict.verified ? 1 : 0,
      JSON.stringify(verdict.checks),
      JSON.stringify(after),
      JSON.stringify(verdict.problems),
      nowIso()
    );

    db.prepare(
      `UPDATE action_executions
          SET status = 'SUCCEEDED', movement_group_ids = ?, movement_ids = ?, result = ?, finished_at = ?
        WHERE id = ?`
    ).run(
      JSON.stringify(result.groupIds || []),
      JSON.stringify(result.movementIds || []),
      JSON.stringify({ before, after, verified: verdict.verified }),
      nowIso(),
      executionId
    );

    proposals.setStatus(db, ctx, proposal.proposalId, 'SUCCEEDED', { completed: true });
    proposals.record(db, ctx, proposal.proposalId, verdict.verified ? 'SUCCEEDED' : 'SUCCEEDED_UNVERIFIED', {
      executionId,
      before,
      after,
      problems: verdict.problems,
    });

    return {
      executionId,
      status: 'SUCCEEDED',
      replayed: false,
      before,
      after,
      verified: verdict.verified,
      verification: verdict,
      movementIds: result.movementIds || [],
      affectedSkuIds: result.skuIds || [],
      proposal: proposals.get(db, ctx.workspaceId, proposal.proposalId),
    };
  });
}

/**
 * The only place an action reaches inventory, and it does so exclusively
 * through Mission 1's public operations.
 */
function perform(db, ctx, proposal) {
  const engineCtx = { workspaceId: ctx.workspaceId, actorId: ctx.actorId };
  const reference = `Foundry ${proposal.proposalId}`;

  if (proposal.actionType === 'receive') {
    return engine.receive(db, engineCtx, {
      skuId: proposal.skuId,
      locationId: proposal.destinationLocationId,
      quantity: proposal.quantity,
      lotId: proposal.lotId || undefined,
      // A batch named on the proposal that does not exist yet. The engine finds
      // or creates it exactly as the receiving form does; nothing new is
      // reachable from here that a person could not already do by hand.
      lotCode: proposal.lotId ? undefined : (proposal.settings && proposal.settings.newLotCode) || undefined,
      reference,
      notes: proposal.notes || undefined,
    });
  }

  if (proposal.actionType === 'issue') {
    return engine.issue(db, engineCtx, {
      skuId: proposal.skuId,
      locationId: proposal.sourceLocationId,
      quantity: proposal.serialUnitIds.length ? undefined : proposal.quantity,
      serialUnitIds: proposal.serialUnitIds.length ? proposal.serialUnitIds : undefined,
      lotId: proposal.lotId || undefined,
      reasonCode: proposal.reasonCode,
      reference,
      notes: proposal.notes || undefined,
    });
  }

  if (proposal.actionType === 'transfer') {
    return engine.transfer(db, engineCtx, {
      skuId: proposal.skuId,
      fromLocationId: proposal.sourceLocationId,
      toLocationId: proposal.destinationLocationId,
      quantity: proposal.serialUnitIds.length ? undefined : proposal.quantity,
      serialUnitIds: proposal.serialUnitIds.length ? proposal.serialUnitIds : undefined,
      lotId: proposal.lotId || undefined,
      reference,
      notes: proposal.notes || undefined,
    });
  }

  if (proposal.actionType === 'adjust') {
    return engine.adjust(db, engineCtx, {
      skuId: proposal.skuId,
      locationId: proposal.sourceLocationId,
      countedQty: proposal.adjustmentTarget,
      lotId: proposal.lotId || undefined,
      reasonCode: proposal.reasonCode,
      reference,
      notes: proposal.notes || undefined,
    });
  }

  if (proposal.actionType === 'create_item') {
    const created = itemService.createItem(db, engineCtx, catalog.toCreateInput(proposal.settings));
    const initial = proposal.settings && proposal.settings.initialStock;
    if (!initial) {
      return { movementIds: [], groupIds: [], itemId: created.itemId, skuIds: created.skuIds };
    }
    if (created.skuIds.length !== 1) {
      throw new ValidationError('Initial stock can only be received when the new product resolves to one exact variant.');
    }
    const received = engine.receive(db, engineCtx, {
      skuId: created.skuIds[0],
      locationId: initial.locationId,
      quantity: proposal.settings.trackingMode === 'serial' ? undefined : initial.quantity,
      serials: proposal.settings.trackingMode === 'serial' ? initial.serials : undefined,
      lotCode: proposal.settings.trackingMode === 'lot' ? initial.lotCode : undefined,
      reference,
      notes: `Initial stock recorded while adding ${proposal.settings.name}.`,
    });
    return {
      movementIds: received.movementIds || [],
      groupIds: received.groupId ? [received.groupId] : [],
      itemId: created.itemId,
      skuIds: created.skuIds,
    };
  }

  if (proposal.actionType === 'archive_item') {
    if (proposal.settings.archiveScope === 'item') {
      itemService.setItemActive(db, engineCtx, proposal.itemId, false);
    } else {
      itemService.setSkuActive(db, engineCtx, proposal.skuId, false);
    }
    return { movementIds: [], groupIds: [], skuIds: [proposal.skuId] };
  }

  if (proposal.actionType === 'add_location') {
    const location = locationService.createLocation(db, engineCtx, {
      name: proposal.settings.name,
      kind: proposal.settings.kind,
    });
    return { movementIds: [], groupIds: [], locationId: location.id };
  }

  if (proposal.actionType === 'rename_terminology') {
    applyTerminology(db, ctx.workspaceId, proposal.settings.key, proposal.settings.value);
    return { movementIds: [], groupIds: [] };
  }

  throw new ValidationError(`Foundry cannot carry out “${proposal.actionType}”.`);
}

/** Presentation vocabulary only; the domain never sees these words. */
function applyTerminology(db, workspaceId, key, value) {
  const row = db
    .prepare('SELECT terminology FROM workspace_configuration WHERE workspace_id = ?')
    .get(workspaceId);
  const terminology = row ? JSON.parse(row.terminology || '{}') : {};
  terminology[key] = value;
  if (row) {
    db.prepare('UPDATE workspace_configuration SET terminology = ?, updated_at = ? WHERE workspace_id = ?')
      .run(JSON.stringify(terminology), nowIso(), workspaceId);
  } else {
    db.prepare(
      `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
         operational_defaults, inventory_model, updated_at)
       VALUES (?, ?, 0, ?, '{}', '{}', ?)`
    ).run(workspaceId, nowIso(), JSON.stringify(terminology), nowIso());
  }
}

function findExecution(db, workspaceId, idempotencyKey) {
  return db
    .prepare('SELECT * FROM action_executions WHERE workspace_id = ? AND idempotency_key = ?')
    .get(workspaceId, idempotencyKey);
}

/** A repeat of an already-executed action returns the original outcome. */
function replay(db, workspaceId, row) {
  const stored = JSON.parse(row.result || '{}');
  const verdict = db
    .prepare('SELECT * FROM action_verifications WHERE execution_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(row.id);
  return {
    executionId: row.id,
    status: row.status,
    replayed: true,
    before: stored.before || {},
    after: stored.after || {},
    verified: Boolean(stored.verified),
    verification: verdict
      ? {
          verified: Boolean(verdict.verified),
          checks: JSON.parse(verdict.checks || '[]'),
          problems: JSON.parse(verdict.problems || '[]'),
        }
      : null,
    movementIds: JSON.parse(row.movement_ids || '[]'),
    proposal: row.proposal_id ? proposals.get(db, workspaceId, row.proposal_id) : null,
  };
}

function getExecution(db, workspaceId, executionId) {
  const row = db
    .prepare('SELECT * FROM action_executions WHERE id = ? AND workspace_id = ?')
    .get(executionId, workspaceId);
  return row ? replay(db, workspaceId, row) : null;
}

module.exports = {
  StaleProposalError,
  approve,
  execute,
  perform,
  findExecution,
  getExecution,
  replay,
};

// --- multi-line plans --------------------------------------------------------

const actionService = require('./action-service');

function approvePlan(db, ctx, membership, planId) {
  return inTransaction(db, () => {
    const plan = actionService.getPlan(db, ctx.workspaceId, planId);
    if (!plan) throw new NotFoundError('That plan could not be found.');
    for (const line of plan.lines) permissions.assertCanPerform(membership, line.actionType);
    if (plan.status === 'APPROVED') return actionService.getPlan(db, ctx.workspaceId, planId);
    if (plan.status !== 'AWAITING_APPROVAL') throw new ValidationError('That plan is no longer waiting for approval.');

    for (const line of plan.lines) {
      const check = proposals.revalidate(db, ctx, line);
      if (!check.ok) {
        actionService.setPlanStatus(db, ctx.workspaceId, planId, 'INVALIDATED');
        proposals.setStatus(db, ctx, line.proposalId, 'INVALIDATED', { problems: describe(check) });
        throw new StaleProposalError(describe(check)[0] || 'The inventory changed since this was proposed.', {
          current: check.current,
        });
      }
      proposals.setStatus(db, ctx, line.proposalId, 'APPROVED', { approvedBy: ctx.actorId });
      proposals.record(db, ctx, line.proposalId, 'APPROVED', { planId }, planId);
    }
    actionService.setPlanStatus(db, ctx.workspaceId, planId, 'APPROVED', { approvedBy: ctx.actorId });
    return actionService.getPlan(db, ctx.workspaceId, planId);
  });
}

/**
 * Runs every line of a plan inside one transaction.
 *
 * All-or-nothing is the default because a half-applied batch is the worst
 * outcome available: the inventory is left in a state nobody asked for and
 * nobody can name. If any line fails, the whole thing rolls back and the
 * inventory is exactly as it was.
 */
function executePlan(db, ctx, membership, planId, options = {}) {
  const idempotencyKey = options.idempotencyKey || `plan:${planId}`;
  const existing = findExecution(db, ctx.workspaceId, idempotencyKey);
  if (existing) return { ...replay(db, ctx.workspaceId, existing), planId };

  const plan = actionService.getPlan(db, ctx.workspaceId, planId);
  if (!plan) throw new NotFoundError('That plan could not be found.');
  if (plan.status !== 'APPROVED') throw new ValidationError('That plan has not been approved.');
  for (const line of plan.lines) permissions.assertCanPerform(membership, line.actionType);

  let outcome;
  try {
    outcome = inTransaction(db, () => {
      const executionId = newId('axe');
      db.prepare(
        `INSERT INTO action_executions
           (id, workspace_id, idempotency_key, proposal_id, plan_id, executed_by_user_id, status, started_at)
         VALUES (?, ?, ?, NULL, ?, ?, 'EXECUTING', ?)`
      ).run(executionId, ctx.workspaceId, idempotencyKey, planId, ctx.actorId, nowIso());

      actionService.setPlanStatus(db, ctx.workspaceId, planId, 'EXECUTING');

      const results = [];
      let allVerified = true;

      // What this plan has moved so far, so a later line is judged against the
      // position its own siblings left behind rather than against a snapshot
      // they have already made out of date.
      const appliedByPlan = { totals: new Map(), positions: new Map() };
      const addEffect = (map, key, delta) => {
        if (!key || !delta) return;
        map.set(key, (map.get(key) || 0) + delta);
      };

      for (const line of plan.lines) {
        const check = proposals.revalidate(db, ctx, line, { ignoreExpiry: true, appliedByPlan });
        if (!check.ok) {
          throw new StaleProposalError(
            describe(check)[0] || 'The inventory changed before this could run.',
            { current: check.current, line: line.lineNumber }
          );
        }
        const before = proposals.currentState(db, ctx.workspaceId, line);
        const result = perform(db, ctx, line);
        const after = proposals.currentState(db, ctx.workspaceId, line);
        const verdict = verification.verify(db, ctx.workspaceId, line, { before, after, result });
        if (!verdict.verified) allVerified = false;

        db.prepare(
          `INSERT INTO action_verifications
             (id, workspace_id, execution_id, proposal_id, verified, checks, observed_state, problems, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          newId('avf'), ctx.workspaceId, executionId, line.proposalId, verdict.verified ? 1 : 0,
          JSON.stringify(verdict.checks), JSON.stringify(after), JSON.stringify(verdict.problems), nowIso()
        );

        // Measured, not predicted: the effect recorded is the difference the
        // engine actually made.
        const keys = proposals.planKeys(line);
        addEffect(appliedByPlan.totals, keys.total, (after.total ?? 0) - (before.total ?? 0));
        addEffect(appliedByPlan.positions, keys.source, (after.sourceOnHand ?? 0) - (before.sourceOnHand ?? 0));
        addEffect(
          appliedByPlan.positions,
          keys.destination,
          (after.destinationOnHand ?? 0) - (before.destinationOnHand ?? 0)
        );

        proposals.setStatus(db, ctx, line.proposalId, 'SUCCEEDED', { completed: true });
        proposals.record(db, ctx, line.proposalId, 'SUCCEEDED', { executionId, before, after }, planId);
        results.push({ proposalId: line.proposalId, before, after, verified: verdict.verified, verification: verdict });
      }

      db.prepare(
        `UPDATE action_executions SET status = 'SUCCEEDED', result = ?, finished_at = ? WHERE id = ?`
      ).run(JSON.stringify({ lines: results, verified: allVerified }), nowIso(), executionId);
      actionService.setPlanStatus(db, ctx.workspaceId, planId, 'SUCCEEDED', { completed: true });

      return { executionId, planId, status: 'SUCCEEDED', replayed: false, verified: allVerified, lines: results };
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      const winner = findExecution(db, ctx.workspaceId, idempotencyKey);
      if (winner) return { ...replay(db, ctx.workspaceId, winner), planId };
    }
    // The transaction rolled back, so the plan never half-ran.
    actionService.setPlanStatus(db, ctx.workspaceId, planId, 'FAILED');
    throw error;
  }

  const skuIds = plan.lines.map((l) => l.skuId).filter(Boolean);
  if (skuIds.length) reevaluate.afterMovement(db, ctx.workspaceId, skuIds, 'action:plan');
  return outcome;
}

module.exports.approvePlan = approvePlan;
module.exports.executePlan = executePlan;
