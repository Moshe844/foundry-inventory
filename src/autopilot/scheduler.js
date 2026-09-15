'use strict';

/**
 * The thing that makes Foundry an employee rather than a button.
 *
 * Everything else in Mission 7 answers "what should happen?". This answers
 * "when?" — and until it existed the product promise quietly depended on
 * somebody remembering to press Check now.
 *
 * Four rules shape it:
 *
 * It decides nothing. Every tick calls the same `runner.run` a person's button
 * calls, so a scheduled action and a clicked one go through the identical
 * policy gate, the identical engine, and the identical verification. If this
 * file were deleted, Foundry would lose its timing and none of its judgement.
 *
 * It acts under somebody's authority, never its own. The actor for automatic
 * work is the person who approved the policy that allows it — they wrote the
 * permission down, so the movement is genuinely theirs. If no policy is
 * approved, no authority exists and the tick plans without executing.
 *
 * One workspace's bad day is its own. Every workspace is wrapped, so a broken
 * one is logged and skipped rather than stopping the sweep for everybody else.
 *
 * Paused means paused. A paused, suspended or watching workspace still gets its
 * attention re-evaluated — the calendar keeps moving and a customer who paused
 * Foundry still wants to know their lot expires — but no work is planned and
 * nothing is executed.
 */

const modes = require('./modes');
const runner = require('./runner');
const managerLoop = require('../manager/loop');
const policyService = require('./policy-service');
const reevaluate = require('../attention/reevaluate');
const { nowIso } = require('../lib/util');
const { inTransaction } = require('../db');
const managerEvents = require('../manager/events');
const patience = require('../ai/patience');
const reactions = require('../manager/reactions');
const os = require('os');

/**
 * Quarter-hourly. Inventory does not change by the second, and a customer who
 * receives a delivery expects Foundry to have noticed by the time they have made
 * a cup of tea — not instantly, and not tomorrow.
 */
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

const LEASE_ID = 'autopilot';
const HOLDER = `${process.pid}@${os.hostname()}`;

/** A lease from a process on this host is stale as soon as that process is gone. */
function holderIsAlive(holder) {
  const match = String(holder || '').match(/^(\d+)@(.+)$/);
  if (!match || match[2] !== os.hostname()) return true;
  const pid = Number(match[1]);
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== 'ESRCH';
  }
}

/**
 * Only one process may run the loop at a time.
 *
 * Two servers against one database would otherwise both plan and both execute.
 * The work item's idempotency key would stop the duplicate transfer, but racing
 * two executions to find that out is not a design — it is a bet.
 */
function acquireLease(db, leaseMs, { now = Date.now() } = {}) {
  const expiresAt = now + leaseMs;
  try {
    return inTransaction(db, () => {
      const held = db.prepare('SELECT * FROM autopilot_lease WHERE id = ?').get(LEASE_ID);
      if (held && held.expires_at > now && held.holder !== HOLDER && holderIsAlive(held.holder)) return false;

      db.prepare(
        `INSERT INTO autopilot_lease (id, holder, expires_at, acquired_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET holder = excluded.holder,
           expires_at = excluded.expires_at, acquired_at = excluded.acquired_at`
      ).run(LEASE_ID, HOLDER, expiresAt, nowIso());
      return true;
    });
  } catch (error) {
    // Losing the lease is a reason to skip a turn, never to fall over.
    console.error('[autopilot] could not take the lease: %s', error.message);
    return false;
  }
}

/**
 * Whose authority a scheduled action runs under.
 *
 * The person who approved the policy, because that approval is the permission.
 * Attributing an automatic transfer to whoever happened to log in last would
 * put a movement in somebody's name that they had nothing to do with.
 *
 * Returns null when nobody has authorised anything — which is not an error, it
 * is a workspace that has not asked Foundry to act.
 */
function authorityFor(db, workspaceId) {
  const policies = policyService
    .list(db, workspaceId, { activeOnly: true })
    .filter((policy) => policy.approvedByUserId);
  if (!policies.length) return null;

  for (const policy of policies) {
    // The approver may have left since. Their membership row survives — the
    // ledger has to keep saying who did what — but leaving unlinks it from a
    // real account, and an account nobody can sign in to is not a person who
    // can authorise anything. Foundry would otherwise go on acting in a
    // departed employee's name indefinitely.
    const membership = db
      .prepare(
        `SELECT u.* FROM users u JOIN accounts a ON a.id = u.account_id
          WHERE u.id = ? AND u.workspace_id = ? AND a.password_hash != ''`
      )
      .get(policy.approvedByUserId, workspaceId);
    if (membership) {
      return {
        ctx: { workspaceId, actorId: membership.id, accountId: membership.account_id },
        membership,
        policy,
      };
    }
  }
  return null;
}

/** Workspaces worth looking at: ones with stock to look at. */
function activeWorkspaces(db) {
  return db
    .prepare(
      `SELECT w.id FROM workspaces w
        WHERE EXISTS (SELECT 1 FROM skus s WHERE s.workspace_id = w.id AND s.is_active = 1)
          AND NOT EXISTS (
            SELECT 1 FROM migration_packages mp
             WHERE mp.workspace_id = w.id
               AND mp.status NOT IN ('CUTOVER_ACTIVE', 'CANCELLED')
          )
        ORDER BY w.id`
    )
    .all()
    .map((row) => row.id);
}

/**
 * One workspace, one turn.
 *
 * Returns what happened, in words the caller can log, including the reason it
 * did nothing. "Skipped" with no reason is how a scheduler becomes a mystery.
 */
function runWorkspace(db, workspaceId, { now = Date.now(), trigger = 'scheduled', intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const state = modes.ensure(db, workspaceId);
  const nextAt = new Date(now + intervalMs).toISOString();
  const bucket = new Date(Math.floor(now / intervalMs) * intervalMs).toISOString();
  const published = managerEvents.publish(db, workspaceId, managerEvents.TYPES.TIME_REEVALUATION_DUE, {
    dueAt: bucket,
  }, { source: 'clock', idempotencyKey: `${managerEvents.TYPES.TIME_REEVALUATION_DUE}:${bucket}` });
  const triggerEventId = published.event.id;

  /*
   * Look ahead before doing anything else.
   *
   * Deliberately above the paused and watching-only branches. Pausing Foundry
   * stops it acting, not thinking — an owner who pauses for a stock take still
   * wants to be told on Monday that something is about to run out, and a
   * system that goes blind the moment it is told to keep its hands still is one
   * people stop pausing. Every recommendation this writes still has to pass the
   * authority gate before it can become an action, and while paused that gate
   * refuses everything.
   *
   * Wrapped, and the wrapping is the point: a forecast is an opinion about the
   * future and must never be able to stop the loop that runs the business.
   */
  let planned = null;
  try {
    planned = require('../forecasting/planning-service').sweepAndRecord(db, workspaceId, { now });
  } catch {
    planned = null;
  }
  try {
    require('../forecasting/outcomes').scoreDue(db, workspaceId, { now });
    require('../forecasting/adaptive-brain').scoreDue(db, workspaceId, { now });
  } catch {
    // Marking old predictions is housekeeping. It never blocks a turn.
  }
  const complete = (result) => {
    const current = managerEvents.get(db, workspaceId, triggerEventId);
    if (current && current.status !== managerEvents.STATUS.PROCESSED) {
      managerEvents.finish(db, triggerEventId, result);
    }
    return result;
  };

  // Watching, paused or globally stopped: the calendar still moves, so findings
  // are re-evaluated. A domain-scoped stop continues through the manager because
  // each typed operation checks that exact scope at authorization time.
  const globallySuspended = state.suspended && !state.suspendedScope;
  if (state.paused || globallySuspended || state.mode === modes.MODES.OBSERVE) {
    const refreshed = reevaluate.refresh(db, workspaceId, trigger);
    modes.recordEvaluation(db, workspaceId, { nextAt });
    return complete({
      workspaceId,
      readOnly: true,
      predicted: planned ? planned.recorded.length : 0,
      because: state.paused
        ? 'paused'
        : globallySuspended
          ? 'stopped itself'
          : 'watching only',
      opened: refreshed.opened,
      resolved: refreshed.resolved,
    });
  }

  /*
   * Levels Foundry has actually been authorised to keep current.
   *
   * Below the paused and watching-only branches on purpose — those return
   * before reaching here, so a paused workspace predicts and reports but
   * changes nothing. Each one is re-judged at the moment of applying rather
   * than trusting the verdict stored when the sweep ran, because hours may
   * have passed and permission can be taken back in seconds.
   */
  const applyAuthority = authorityFor(db, workspaceId);
  if (applyAuthority) {
    try {
      require('../forecasting/apply').applyAuthorised(
        db, applyAuthority.ctx, applyAuthority.membership, { now }
      );
    } catch {
      // A level that could not be updated is not a reason to abandon the turn.
    }
  }

  const authority = authorityFor(db, workspaceId);
  if (!authority) {
    // Supervised with nothing approved: Foundry may still prepare work, but it
    // has nobody's permission to execute, so it plans under the owner and stops
    // there. Planning writes no movements, so no authority is being borrowed.
    const owner = db
      .prepare("SELECT * FROM users WHERE workspace_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1")
      .get(workspaceId);
    if (!owner) return complete({ workspaceId, skipped: true, because: 'no one to act for' });

    const ctx = { workspaceId, actorId: owner.id, accountId: owner.account_id };
    const planned = managerLoop.run(db, ctx, owner, {
      trigger, triggerEventId,
      // A replacement process must re-read current state even when it starts
      // inside the same quarter-hour bucket as the process it replaced. Work
      // item idempotency still prevents duplicate actions.
      idempotencyKey: trigger === 'startup'
        ? `startup:${HOLDER}:${now}`
        : `event:${triggerEventId}`,
      now, planOnly: true,
    });
    modes.recordEvaluation(db, workspaceId, { nextAt });
    return complete({
      workspaceId,
      plannedOnly: true,
      because: 'no approved policy',
      planned: planned.planned || 0,
    });
  }

  const result = managerLoop.run(db, authority.ctx, authority.membership, {
    trigger, triggerEventId,
    idempotencyKey: trigger === 'startup'
      ? `startup:${HOLDER}:${now}`
      : `event:${triggerEventId}`,
    now,
  });
  modes.recordEvaluation(db, workspaceId, { nextAt });
  return complete({ workspaceId, ...result, under: authority.policy.name });
}

/**
 * One turn of the loop across every workspace.
 *
 * Never throws. A scheduler that can throw is a scheduler that stops.
 */
function tick(db, { now = Date.now(), trigger = 'scheduled', intervalMs = DEFAULT_INTERVAL_MS, lease = true } = {}) {
  if (lease && !acquireLease(db, Math.max(30000, Math.floor(intervalMs * 0.9)), { now })) {
    return { skipped: true, because: 'another process holds the lease', results: [] };
  }

  const results = [];
  for (const workspaceId of activeWorkspaces(db)) {
    try {
      results.push(runWorkspace(db, workspaceId, { now, trigger, intervalMs }));
    } catch (error) {
      console.error('[autopilot] %s failed: %s', workspaceId, error.message);
      results.push({ workspaceId, failed: true, error: error.message });
    }
  }

  return {
    at: new Date(now).toISOString(),
    workspaces: results.length,
    executed: results.reduce((sum, r) => sum + (r.executed || 0), 0),
    planned: results.reduce((sum, r) => sum + (r.planned || 0), 0),
    failed: results.filter((r) => r.failed).length,
    results,
  };
}

/**
 * Starts the loop. Returns the function that stops it.
 *
 * `immediate` runs one turn at startup, so a server that has been down over
 * lunch catches up rather than waiting out a full interval first.
 */
function start(db, { intervalMs = DEFAULT_INTERVAL_MS, immediate = true } = {}) {
  let running = false;

  // A committed event whose process died mid-reaction is safe to reconsider:
  // the event key, work key, execution key and movement engine are all
  // idempotent. Recover it before accepting new timed work.
  managerEvents.recover(db);
  reactions.drain(db);

  const turn = (trigger) => {
    // A slow turn must not overlap the next one. Overlapping ticks would race
    // each other for the same work.
    if (running) return null;
    running = true;
    try {
      // Nobody is watching a scheduled turn, so it can afford to wait out a
      // refused connection for minutes rather than seconds.
      return patience.unattended(() => tick(db, { trigger, intervalMs }));
    } catch (error) {
      console.error('[autopilot] tick failed: %s', error.message);
      return null;
    } finally {
      running = false;
    }
  };

  if (immediate) turn('startup');
  const timer = setInterval(() => turn('scheduled'), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  const eventTimer = setInterval(() => {
    if (running) return;
    running = true;
    try {
      reactions.drain(db);
      managerLoop.processPending(db, authorityFor);
    }
    catch (error) { console.error('[manager] event turn failed: %s', error.message); }
    finally { running = false; }
  }, Math.min(intervalMs, 1000));
  if (typeof eventTimer.unref === 'function') eventTimer.unref();
  return () => {
    clearInterval(timer);
    clearInterval(eventTimer);
    // A graceful restart must not make the replacement server wait out the
    // old fifteen-minute lease before it can refresh visible business state.
    try {
      db.prepare('DELETE FROM autopilot_lease WHERE id = ? AND holder = ?').run(LEASE_ID, HOLDER);
    } catch {
      // Shutdown proceeds even if the database is already unavailable.
    }
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  authorityFor,
  activeWorkspaces,
  runWorkspace,
  tick,
  start,
};
