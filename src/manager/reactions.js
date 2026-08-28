'use strict';

/**
 * Turns committed domain events into one scoped manager turn.
 *
 * This layer decides no inventory policy. It supplies the trigger and affected
 * scope to the existing deterministic attention/planning/authority pipeline.
 * The in-process workspace guard prevents an automatic action from recursively
 * starting another manager while its parent turn is still verifying; the new
 * event remains durable and is drained immediately after the parent finishes.
 */

const events = require('./events');
const modes = require('../autopilot/modes');

const active = require('./guards').activeWorkspaces;

function ownerFor(db, workspaceId) {
  return db.prepare(
    "SELECT * FROM users WHERE workspace_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1"
  ).get(workspaceId);
}

function authorityFor(db, workspaceId) {
  const policyService = require('../autopilot/policy-service');
  const policies = policyService.list(db, workspaceId, { activeOnly: true })
    .filter((policy) => policy.approvedByUserId);
  for (const policy of policies) {
    const membership = db.prepare(
      `SELECT u.* FROM users u JOIN accounts a ON a.id = u.account_id
       WHERE u.id = ? AND u.workspace_id = ? AND a.password_hash != ''`
    ).get(policy.approvedByUserId, workspaceId);
    if (membership) return {
      ctx: { workspaceId, actorId: membership.id, accountId: membership.account_id },
      membership,
      policy,
    };
  }
  return null;
}

function scopeFor(event) {
  const payload = event.payload || {};
  const skuIds = [...new Set([
    ...(Array.isArray(payload.skuIds) ? payload.skuIds : []),
    ...(payload.skuId ? [payload.skuId] : []),
  ].filter(Boolean))];
  return skuIds.length ? { skuIds } : undefined;
}

function processClaimed(db, event, { now = Date.now() } = {}) {
  const attention = require('../attention/attention-engine');
  const managerLoop = require('./loop');
  const workspaceId = event.workspaceId;
  const scope = scopeFor(event);
  const state = modes.ensure(db, workspaceId);

  // Physical events can make earlier customer commitments newly coverable—or
  // invalidate a location allocation. Reconcile those promises before the
  // normal attention/replenishment pass reads available stock.
  const inventoryChanged = new Set([
    events.TYPES.INVENTORY_ISSUED, events.TYPES.INVENTORY_RECEIVED,
    events.TYPES.INVENTORY_TRANSFERRED, events.TYPES.INVENTORY_CORRECTED,
    events.TYPES.COUNT_CONFIRMED,
  ]);
  if (scope && inventoryChanged.has(event.type)) {
    const owner = ownerFor(db, workspaceId);
    require('../sales/sales-order-service').reconcileForSkus(db, {
      workspaceId, actorId: owner ? owner.id : null,
    }, scope.skuIds, { triggerEventId: event.id });
  }

  const refreshed = attention.evaluate(db, workspaceId, {
    trigger: event.type,
    scope,
    now,
  });

  // Pause stops consequential automation, not awareness. Observe mode follows
  // the same rule: current Needs You may change, inventory never does.
  if (state.paused || state.suspended || state.mode === modes.MODES.OBSERVE) {
    return {
      eventId: event.id,
      readOnly: true,
      because: state.paused ? 'paused' : state.suspended ? 'suspended' : 'ask-first observation',
      opened: refreshed.opened,
      resolved: refreshed.resolved,
    };
  }

  const authority = authorityFor(db, workspaceId);
  const membership = authority ? authority.membership : ownerFor(db, workspaceId);
  if (!membership) return { eventId: event.id, skipped: true, because: 'no inventory owner' };
  const ctx = authority
    ? authority.ctx
    : { workspaceId, actorId: membership.id, accountId: membership.account_id };

  const managed = managerLoop.run(db, ctx, membership, {
    trigger: event.type,
    triggerEventId: event.id,
    idempotencyKey: `event:${event.id}`,
    scope,
    now,
    planOnly: !authority,
    skipAttentionRefresh: true,
  });
  return {
    eventId: event.id,
    opened: refreshed.opened,
    resolved: refreshed.resolved,
    ...managed,
  };
}

function processEvent(db, eventId, options = {}) {
  const row = db.prepare('SELECT workspace_id FROM domain_events WHERE id = ?').get(eventId);
  if (!row) return null;
  if (active.has(row.workspace_id)) return { deferred: true, eventId };

  active.add(row.workspace_id);
  try {
    const event = events.claim(db, eventId);
    if (!event) return { deferred: true, eventId };
    if (event.status === events.STATUS.PROCESSED) return event.result;
    try {
      const result = processClaimed(db, event, options);
      events.finish(db, event.id, result);
      return result;
    } catch (error) {
      events.finish(db, event.id, {}, error);
      throw error;
    }
  } finally {
    active.delete(row.workspace_id);
  }
}

function drainWorkspace(db, workspaceId, { limit = 50, now = Date.now() } = {}) {
  if (active.has(workspaceId)) return [];
  const results = [];
  for (let count = 0; count < limit; count += 1) {
    const event = events.claimNext(db, workspaceId);
    if (!event) break;
    // claimNext has already claimed it; perform the turn here under the same
    // guard rather than trying to claim it again.
    active.add(workspaceId);
    try {
      try {
        const result = processClaimed(db, event, { now });
        events.finish(db, event.id, result);
        results.push(result);
      } catch (error) {
        events.finish(db, event.id, {}, error);
        results.push({ eventId: event.id, failed: true, error: error.message });
      }
    } finally {
      active.delete(workspaceId);
    }
  }
  return results;
}

function drain(db, { limit = 100, now = Date.now() } = {}) {
  const results = [];
  for (let count = 0; count < limit; count += 1) {
    const event = events.claimNext(db);
    if (!event) break;
    const workspaceId = event.workspaceId;
    if (active.has(workspaceId)) {
      db.prepare("UPDATE domain_events SET status = 'PENDING', started_at = NULL WHERE id = ?").run(event.id);
      continue;
    }
    active.add(workspaceId);
    try {
      try {
        const result = processClaimed(db, event, { now });
        events.finish(db, event.id, result);
        results.push(result);
      } catch (error) {
        events.finish(db, event.id, {}, error);
        results.push({ eventId: event.id, failed: true, error: error.message });
      }
    } finally {
      active.delete(workspaceId);
    }
  }
  return results;
}

function publishAndReact(db, workspaceId, type, payload = {}, options = {}) {
  const published = events.publish(db, workspaceId, type, payload, options);
  if (active.has(workspaceId)) return { ...published, reaction: { deferred: true } };
  const results = drainWorkspace(db, workspaceId, { now: options.now || Date.now() });
  const reaction = results.find((entry) => entry && entry.eventId === published.event.id) || null;
  return { ...published, reaction: reaction || published.event.result || null };
}

module.exports = { active, authorityFor, scopeFor, processEvent, drainWorkspace, drain, publishAndReact };
