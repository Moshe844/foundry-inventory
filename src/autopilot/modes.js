'use strict';

/**
 * How much authority Foundry has in one inventory, and how to take it away.
 *
 * Three modes, and the difference between them is exactly what Foundry may do
 * without being asked:
 *
 *   OBSERVE           watch, detect, explain, recommend. Nothing is mutated.
 *   SUPERVISED        plan and prepare the work, execute what a person approves.
 *   POLICY_AUTOMATED  additionally execute what an approved policy allows —
 *                     and only that.
 *
 * Two separate ways to stop, because they are different situations. A *pause*
 * is a person deciding to stop; a *suspension* is Foundry stopping itself after
 * something it could not verify. Conflating them would mean a customer
 * resuming their own pause and silently clearing a safety stop they never saw.
 */

const { nowIso, trimOrNull } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const permissions = require('../actions/permissions');

const MODES = {
  OBSERVE: 'OBSERVE',
  SUPERVISED: 'SUPERVISED',
  POLICY_AUTOMATED: 'POLICY_AUTOMATED',
};

const MODE_LABEL = {
  OBSERVE: 'Watching',
  SUPERVISED: 'Supervised',
  POLICY_AUTOMATED: 'Autopilot',
};

const MODE_BLURB = {
  OBSERVE: 'Foundry watches and explains. It changes nothing.',
  SUPERVISED: 'Foundry plans and prepares the work, and carries out what you approve.',
  POLICY_AUTOMATED: 'Foundry also carries out routine work your policies allow, and tells you what it did.',
};

/** Sensible starting limits. Deliberately conservative. */
const DEFAULT_LIMITS = {
  maxActionsPerDay: 20,
  maxUnitsPerAction: 50,
  maxValuePerAction: null,
  maxValuePerDay: null,
  // maxRetries is stored by the schema but deliberately not a setting: Foundry
  // does not retry a failed automatic action at all. A verification failure
  // suspends the scope for a person to look at, which is a stronger guarantee
  // than any retry count, and offering the dial would imply otherwise.
  cooldownHours: 24,
  maxActionsPerItemPerWeek: 2,
};

function hydrate(row) {
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    mode: row.mode,
    modeLabel: MODE_LABEL[row.mode],
    modeBlurb: MODE_BLURB[row.mode],
    paused: Boolean(row.paused),
    pausedAt: row.paused_at,
    pausedReason: row.paused_reason,
    suspended: Boolean(row.suspended),
    suspendedAt: row.suspended_at,
    suspendedScope: row.suspended_scope,
    suspendedReason: row.suspended_reason,
    lastEvaluatedAt: row.last_evaluated_at,
    nextEvaluationAt: row.next_evaluation_at,
    // The one question the rest of the system asks.
    canAct: row.mode !== MODES.OBSERVE && !row.paused && !row.suspended,
    canAutomate: row.mode === MODES.POLICY_AUTOMATED && !row.paused && !row.suspended,
  };
}

function hydrateLimits(row) {
  if (!row) return { ...DEFAULT_LIMITS };
  return {
    maxActionsPerDay: row.max_actions_per_day,
    maxUnitsPerAction: row.max_units_per_action,
    maxValuePerAction: row.max_value_per_action,
    maxValuePerDay: row.max_value_per_day,
    cooldownHours: row.cooldown_hours,
    maxActionsPerItemPerWeek: row.max_actions_per_item_per_week,
  };
}

/** The autopilot state, started at the default if this workspace has none. */
function ensure(db, workspaceId) {
  const existing = db.prepare('SELECT * FROM workspace_autopilot WHERE workspace_id = ?').get(workspaceId);
  if (existing) return hydrate(existing);

  const now = nowIso();
  db.prepare(
    `INSERT INTO workspace_autopilot (workspace_id, mode, created_at, updated_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) DO NOTHING`
  ).run(workspaceId, MODES.SUPERVISED, now, now);
  db.prepare(
    'INSERT INTO autopilot_limits (workspace_id, updated_at) VALUES (?, ?) ON CONFLICT(workspace_id) DO NOTHING'
  ).run(workspaceId, now);

  return hydrate(db.prepare('SELECT * FROM workspace_autopilot WHERE workspace_id = ?').get(workspaceId));
}

function get(db, workspaceId) {
  return ensure(db, workspaceId);
}

function limits(db, workspaceId) {
  ensure(db, workspaceId);
  return hydrateLimits(
    db.prepare('SELECT * FROM autopilot_limits WHERE workspace_id = ?').get(workspaceId)
  );
}

function setLimits(db, ctx, membership, changes) {
  permissions.assertCan(membership, permissions.ADMIN, 'change what Foundry may do');
  ensure(db, ctx.workspaceId);
  const current = limits(db, ctx.workspaceId);

  const number = (value, fallback, { min = 0, max = 100000 } = {}) => {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new ValidationError(`That limit must be a number between ${min} and ${max}.`);
    }
    return Math.trunc(n);
  };

  db.prepare(
    `UPDATE autopilot_limits
        SET max_actions_per_day = ?, max_units_per_action = ?, max_value_per_action = ?,
            max_value_per_day = ?, cooldown_hours = ?,
            max_actions_per_item_per_week = ?, updated_at = ?
      WHERE workspace_id = ?`
  ).run(
    number(changes.maxActionsPerDay, current.maxActionsPerDay, { min: 0, max: 1000 }),
    number(changes.maxUnitsPerAction, current.maxUnitsPerAction, { min: 1, max: 100000 }),
    changes.maxValuePerAction === undefined ? current.maxValuePerAction : Number(changes.maxValuePerAction) || null,
    changes.maxValuePerDay === undefined ? current.maxValuePerDay : Number(changes.maxValuePerDay) || null,
    number(changes.cooldownHours, current.cooldownHours, { min: 0, max: 24 * 30 }),
    number(changes.maxActionsPerItemPerWeek, current.maxActionsPerItemPerWeek, { min: 0, max: 100 }),
    nowIso(),
    ctx.workspaceId
  );
  return limits(db, ctx.workspaceId);
}

/**
 * Changes how much authority Foundry has.
 *
 * Moving up to POLICY_AUTOMATED is an ADMIN decision. Moving *down* is
 * deliberately available to anyone who can operate the inventory: taking
 * authority away from an automaton should never be the harder path.
 */
function setMode(db, ctx, membership, mode) {
  if (!Object.values(MODES).includes(mode)) throw new ValidationError('That is not an autopilot mode.');
  const current = ensure(db, ctx.workspaceId);

  const rank = { OBSERVE: 0, SUPERVISED: 1, POLICY_AUTOMATED: 2 };
  if (rank[mode] > rank[current.mode]) {
    permissions.assertCan(membership, permissions.ADMIN, 'give Foundry more authority');
  } else {
    permissions.assertCan(membership, permissions.OPERATE, 'change what Foundry does');
  }

  db.prepare('UPDATE workspace_autopilot SET mode = ?, updated_at = ? WHERE workspace_id = ?')
    .run(mode, nowIso(), ctx.workspaceId);
  return get(db, ctx.workspaceId);
}

/** A person stopping Foundry. */
function pause(db, ctx, membership, reason) {
  permissions.assertCan(membership, permissions.OPERATE, 'pause Foundry');
  ensure(db, ctx.workspaceId);
  const now = nowIso();
  db.prepare(
    `UPDATE workspace_autopilot
        SET paused = 1, paused_at = ?, paused_by_user_id = ?, paused_reason = ?, updated_at = ?
      WHERE workspace_id = ?`
  ).run(now, ctx.actorId, trimOrNull(reason), now, ctx.workspaceId);
  return get(db, ctx.workspaceId);
}

function resume(db, ctx, membership) {
  permissions.assertCan(membership, permissions.OPERATE, 'resume Foundry');
  const state = ensure(db, ctx.workspaceId);
  // Resuming clears a person's pause. A safety suspension is a separate thing
  // and needs its own deliberate clearing, so it is not swept away here.
  if (state.suspended) {
    permissions.assertCan(membership, permissions.ADMIN, 'clear a safety suspension');
  }
  db.prepare(
    `UPDATE workspace_autopilot
        SET paused = 0, paused_at = NULL, paused_by_user_id = NULL, paused_reason = NULL, updated_at = ?
      WHERE workspace_id = ?`
  ).run(nowIso(), ctx.workspaceId);
  return get(db, ctx.workspaceId);
}

/**
 * Foundry stopping itself.
 *
 * Called when something could not be verified, an invariant failed, or the same
 * work keeps coming back. The failure mode of an autonomous system is not one
 * bad action — it is the same bad action repeated — so the response is to stop
 * and say so, never to try again and hope.
 */
function suspend(db, workspaceId, { scope = null, reason }) {
  ensure(db, workspaceId);
  const now = nowIso();
  db.prepare(
    `UPDATE workspace_autopilot
        SET suspended = 1, suspended_at = ?, suspended_scope = ?, suspended_reason = ?, updated_at = ?
      WHERE workspace_id = ?`
  ).run(now, scope, String(reason || 'Something could not be verified.'), now, workspaceId);

  db.prepare(
    `INSERT INTO notifications (id, workspace_id, kind, severity, title, body, created_at)
     VALUES (?, ?, 'paused', 'critical', ?, ?, ?)`
  ).run(
    require('../lib/util').newId('ntf'),
    workspaceId,
    scope ? `Foundry paused automatic ${scope}s` : 'Foundry paused itself',
    String(reason || ''),
    now
  );
  return get(db, workspaceId);
}

function clearSuspension(db, ctx, membership) {
  permissions.assertCan(membership, permissions.ADMIN, 'clear a safety suspension');
  db.prepare(
    `UPDATE workspace_autopilot
        SET suspended = 0, suspended_at = NULL, suspended_scope = NULL, suspended_reason = NULL, updated_at = ?
      WHERE workspace_id = ?`
  ).run(nowIso(), ctx.workspaceId);
  return get(db, ctx.workspaceId);
}

function recordEvaluation(db, workspaceId, { nextAt = null } = {}) {
  ensure(db, workspaceId);
  db.prepare(
    'UPDATE workspace_autopilot SET last_evaluated_at = ?, next_evaluation_at = ?, updated_at = ? WHERE workspace_id = ?'
  ).run(nowIso(), nextAt, nowIso(), workspaceId);
}

/**
 * Whether autonomous execution may happen at all right now, and why not.
 *
 * One place, so no caller has to remember the combination of mode, pause and
 * suspension — forgetting one of them is how an automaton keeps running after
 * being told to stop.
 */
function executionState(db, workspaceId, { scope = null } = {}) {
  const state = get(db, workspaceId);
  if (state.paused) {
    return { allowed: false, because: state.pausedReason || 'Foundry is paused.', state };
  }
  if (state.suspended && (!state.suspendedScope || state.suspendedScope === scope)) {
    return { allowed: false, because: state.suspendedReason, suspended: true, state };
  }
  if (state.mode === MODES.OBSERVE) {
    return { allowed: false, because: 'Foundry is only watching this inventory.', state };
  }
  return { allowed: true, automatic: state.mode === MODES.POLICY_AUTOMATED, state };
}

module.exports = {
  MODES,
  MODE_LABEL,
  MODE_BLURB,
  DEFAULT_LIMITS,
  hydrate,
  ensure,
  get,
  limits,
  setLimits,
  setMode,
  pause,
  resume,
  suspend,
  clearSuspension,
  recordEvaluation,
  executionState,
};
