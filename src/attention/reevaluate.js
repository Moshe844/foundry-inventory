'use strict';

/**
 * When attention is recalculated.
 *
 * Two triggers: something moved, or time passed. Both call the same engine.
 *
 * The hooks live here and are called from the route layer *after* the Mission 1
 * operation has committed — deliberately not from inside the inventory engine.
 * Interpretation must never be able to fail, slow, or roll back a receive; if
 * this throws, the stock movement has already happened and stands.
 */

const os = require('node:os');

const { inTransaction } = require('../db');
const attention = require('./attention-engine');
const { nowIso } = require('../lib/util');
const managerTriggers = require('../manager/triggers');
const managerEvents = require('../manager/events');
const reactions = require('../manager/reactions');
const patience = require('../ai/patience');

const DEFAULT_SWEEP_MS = 60 * 60 * 1000; // hourly: expiry and idleness move by the day
const LEASE_ID = 'sweep';
const HOLDER = `${os.hostname()}:${process.pid}`;

/**
 * Claims the right to run the timed sweep.
 *
 * Detection is idempotent, so a double sweep would not corrupt anything — but
 * it would double the work and race two processes onto the same rows for no
 * benefit. A short lease in the database makes "once per interval, across
 * however many servers" true rather than merely likely.
 */
function acquireSweepLease(db, leaseMs) {
  const now = Date.now();
  const expiresAt = now + leaseMs;
  try {
    return inTransaction(db, () => {
      const held = db.prepare('SELECT * FROM attention_sweep_lease WHERE id = ?').get(LEASE_ID);
      if (held && held.expires_at > now && held.holder !== HOLDER) return false;

      db.prepare(
        `INSERT INTO attention_sweep_lease (id, holder, expires_at, acquired_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET holder = excluded.holder,
           expires_at = excluded.expires_at, acquired_at = excluded.acquired_at`
      ).run(LEASE_ID, HOLDER, expiresAt, nowIso());
      return true;
    });
  } catch (error) {
    // A contended lease is not a reason to fall over; it is a reason to skip.
    console.error('[attention] could not take the sweep lease: %s', error.message);
    return false;
  }
}

/** Narrow re-evaluation after an operation. Never throws into the caller. */
function afterMovement(db, workspaceId, skuIds, trigger = 'movement', options = {}) {
  const scope = Array.isArray(skuIds) && skuIds.length ? { skuIds: [...new Set(skuIds)] } : undefined;
  try {
    // Keep the Mission 8 trigger row as compatibility/audit history, but mark
    // it complete: Mission 9's durable domain event owns the reaction now.
    const legacy = managerTriggers.enqueue(db, workspaceId, trigger, scope || {}, {
      idempotencyKey: managerTriggers.keyFor(trigger, scope || {}),
    });
    if (legacy.created) managerTriggers.finish(db, legacy.trigger.id);

    const raw = String(trigger || '').replace(/^connector:/, '').replace(/^action:/, '');
    const type = raw === 'issue' ? managerEvents.TYPES.INVENTORY_ISSUED
      : raw === 'receive' ? managerEvents.TYPES.INVENTORY_RECEIVED
        : raw === 'transfer' || raw === 'plan' ? managerEvents.TYPES.INVENTORY_TRANSFERRED
          : raw === 'adjust' ? managerEvents.TYPES.INVENTORY_CORRECTED
            : `inventory.${raw || 'changed'}`;
    const latest = options.sourceRecordId || (scope && db.prepare(
      `SELECT id FROM movements WHERE workspace_id = ? AND sku_id IN (${scope.skuIds.map(() => '?').join(',')})
       ORDER BY rowid DESC LIMIT 1`
    ).get(workspaceId, ...scope.skuIds)?.id);
    const reacted = reactions.publishAndReact(db, workspaceId, type, scope || {}, {
      source: trigger.startsWith('connector:') ? 'connector'
        : trigger.startsWith('action:') ? 'tell_foundry' : 'inventory',
      // A committed movement has its own idempotency at the engine layer. At
      // this boundary callers do not all expose the movement id, so a narrow
      // event key includes the original trigger and current ledger watermark.
      sourceRecordType: latest ? 'movement' : null,
      sourceRecordId: latest || null,
      idempotencyKey: options.idempotencyKey || (latest
        ? `${type}:movement:${latest}`
        : managerTriggers.keyFor(type, { trigger, ...(scope || {}) })),
    });
    return reacted.reaction;
  } catch (error) {
    // The operation succeeded; the briefing is stale until the next sweep.
    console.error('[attention] re-evaluation failed after %s: %s', trigger, error.message);
    return null;
  }
}

/** Full re-evaluation for one workspace. */
function refresh(db, workspaceId, trigger = 'manual') {
  return attention.evaluate(db, workspaceId, { trigger });
}

/**
 * Time-based sweep across every workspace. Conditions that depend on the
 * calendar — an expiry date approaching, stock going idle — become true without
 * anything moving, so they need a clock as well as a hook.
 */
function sweepAll(db, trigger = 'scheduled') {
  const workspaces = db.prepare('SELECT id FROM workspaces').all();
  const results = [];
  for (const workspace of workspaces) {
    try {
      results.push({ workspaceId: workspace.id, ...attention.evaluate(db, workspace.id, { trigger }) });
    } catch (error) {
      console.error('[attention] sweep failed for %s: %s', workspace.id, error.message);
    }
  }
  return results;
}

/**
 * Starts the periodic sweep. Returns a stop function.
 *
 * The lease is held for slightly less than the interval, so a process that dies
 * mid-sweep does not block the next one for long.
 */
function startScheduler(db, { intervalMs = DEFAULT_SWEEP_MS, immediate = true } = {}) {
  const leaseMs = Math.max(30000, Math.floor(intervalMs * 0.9));
  const tick = (trigger) => {
    if (!acquireSweepLease(db, leaseMs)) return null;
    // A sweep runs on the clock, not because anybody asked, so it can wait out
    // a refused connection far longer than a web request could.
    return patience.unattended(() => sweepAll(db, trigger));
  };

  if (immediate) tick('startup');
  const timer = setInterval(() => tick('scheduled'), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  DEFAULT_SWEEP_MS,
  HOLDER,
  afterMovement,
  refresh,
  sweepAll,
  acquireSweepLease,
  startScheduler,
};
