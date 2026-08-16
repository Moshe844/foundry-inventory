'use strict';

/**
 * How this business likes its inventory run.
 *
 * The whole design is in one sentence: Foundry never learns a preference, it is
 * only ever told one. Every row here comes from something a person did on
 * purpose — typed an instruction, approved a policy, filled in configuration —
 * and every row records which of those it was, in their own words.
 *
 * The alternative is the obvious one, and it is the reason this file is so
 * strict: a system that quietly infers "they always approve these, so I will
 * stop asking" has changed what it is allowed to do without anyone agreeing to
 * it. That is indistinguishable from a bug until the day it matters. So there
 * is no inference here, no counting of past approvals, and no model.
 *
 * A preference tunes work Foundry was already allowed to do. It can never widen
 * authority — only a policy does that, and only when approved.
 */

const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const permissions = require('../actions/permissions');

/**
 * The preferences that mean something.
 *
 * A key not on this list is refused rather than stored. A store that accepts
 * anything becomes a place where settings go to be silently ignored, and a
 * customer who set one would reasonably believe it was doing something.
 */
const KEYS = {
  TARGET_DAYS_OF_STOCK: {
    key: 'target_days_of_stock',
    label: 'Days of stock to aim for',
    kind: 'number',
    min: 1,
    max: 365,
    describe: (v) => `Keep about ${v} days of stock on hand.`,
  },
  RISK_DAYS: {
    key: 'risk_days',
    label: 'Treat as running out below',
    kind: 'number',
    min: 1,
    max: 180,
    describe: (v) => `Treat anything under ${v} days of cover as running out.`,
  },
  SOURCE_SAFETY_DAYS: {
    key: 'source_safety_days',
    label: 'Days a location keeps for itself',
    kind: 'number',
    min: 1,
    max: 365,
    describe: (v) => `A location giving stock away keeps ${v} days for itself.`,
  },
  PREFER_TRANSFER_BEFORE_PURCHASING: {
    key: 'prefer_transfer_before_purchasing',
    label: 'Move stock before buying more',
    kind: 'boolean',
    describe: (v) => (v ? 'Move stock between locations before buying more.' : 'Buy without trying to move stock first.'),
  },
  NEVER_AUTOMATE_SERIALIZED: {
    key: 'never_automate_serialized',
    label: 'Never move serialised items automatically',
    kind: 'boolean',
    describe: (v) => (v ? 'Never move serialised items automatically.' : 'Serialised items may be moved automatically.'),
  },
};

const BY_KEY = new Map(Object.values(KEYS).map((def) => [def.key, def]));

const SOURCES = ['instruction', 'policy', 'configuration'];

function parse(def, raw) {
  if (def.kind === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw).trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(text)) return true;
    if (['false', 'no', 'off', '0'].includes(text)) return false;
    throw new ValidationError(`“${def.label}” is a yes or no.`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < def.min || n > def.max) {
    throw new ValidationError(`“${def.label}” must be between ${def.min} and ${def.max}.`);
  }
  return Math.trunc(n);
}

/**
 * Records a preference.
 *
 * `statedAs` is what the person actually said, kept verbatim so the settings
 * page can show their words back rather than Foundry's paraphrase of them.
 */
function set(db, ctx, membership, { key, value, source, statedAs = null }) {
  permissions.assertCan(membership, permissions.OPERATE, 'change how this inventory is run');
  const def = BY_KEY.get(key);
  if (!def) throw new ValidationError('Foundry does not have a setting for that.');
  if (!SOURCES.includes(source)) {
    // Every preference has to be traceable to a deliberate act. An unattributed
    // one is exactly the silent learning this module exists to prevent.
    throw new ValidationError('A preference has to come from something someone did.');
  }

  const parsed = parse(def, value);
  const now = nowIso();
  const existing = db
    .prepare('SELECT id FROM operational_preferences WHERE workspace_id = ? AND key = ?')
    .get(ctx.workspaceId, key);

  if (existing) {
    db.prepare(
      `UPDATE operational_preferences
          SET value = ?, stated_as = ?, source = ?, set_by_user_id = ?, updated_at = ?
        WHERE id = ?`
    ).run(JSON.stringify(parsed), trimOrNull(statedAs), source, ctx.actorId, now, existing.id);
  } else {
    db.prepare(
      `INSERT INTO operational_preferences
         (id, workspace_id, key, value, stated_as, source, set_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newId('pref'), ctx.workspaceId, key, JSON.stringify(parsed), trimOrNull(statedAs), source, ctx.actorId, now, now);
  }
  return { key, value: parsed, source, statedAs: trimOrNull(statedAs) };
}

function clear(db, ctx, membership, key) {
  permissions.assertCan(membership, permissions.OPERATE, 'change how this inventory is run');
  db.prepare('DELETE FROM operational_preferences WHERE workspace_id = ? AND key = ?').run(ctx.workspaceId, key);
}

/** Everything set for this workspace, as `{ key: value }`. Unset keys are absent. */
function all(db, workspaceId) {
  const out = {};
  for (const row of db
    .prepare('SELECT key, value FROM operational_preferences WHERE workspace_id = ?')
    .all(workspaceId)) {
    if (!BY_KEY.has(row.key)) continue;      // a key retired since it was stored
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      /* unreadable value: behave as if it were never set */
    }
  }
  return out;
}

/** For the settings page: what is set, in the customer's own words. */
function list(db, workspaceId) {
  return db
    .prepare(
      `SELECT p.*, u.name AS set_by_name FROM operational_preferences p
         LEFT JOIN users u ON u.id = p.set_by_user_id
        WHERE p.workspace_id = ? ORDER BY p.key`
    )
    .all(workspaceId)
    .filter((row) => BY_KEY.has(row.key))
    .map((row) => {
      const def = BY_KEY.get(row.key);
      let value = null;
      try {
        value = JSON.parse(row.value);
      } catch {
        value = null;
      }
      return {
        key: row.key,
        label: def.label,
        value,
        description: def.describe(value),
        statedAs: row.stated_as,
        source: row.source,
        setByName: row.set_by_name,
        updatedAt: row.updated_at,
      };
    });
}

/**
 * The balance-transfer numbers, with any stated preference applied on top.
 *
 * Bounds are re-checked here rather than trusted from storage: a value written
 * before a key's limits changed must not become a way round them.
 */
function balanceSettings(db, workspaceId, defaults) {
  const prefs = all(db, workspaceId);
  const clamp = (def, value, fallback) =>
    Number.isFinite(value) && value >= def.min && value <= def.max ? value : fallback;

  return {
    ...defaults,
    riskDays: clamp(KEYS.RISK_DAYS, prefs[KEYS.RISK_DAYS.key], defaults.riskDays),
    sourceSafetyDays: clamp(
      KEYS.SOURCE_SAFETY_DAYS,
      prefs[KEYS.SOURCE_SAFETY_DAYS.key],
      defaults.sourceSafetyDays
    ),
    targetDays: clamp(
      KEYS.TARGET_DAYS_OF_STOCK,
      prefs[KEYS.TARGET_DAYS_OF_STOCK.key],
      defaults.targetDays
    ),
    neverAutomateSerialized: prefs[KEYS.NEVER_AUTOMATE_SERIALIZED.key] === true,
  };
}

module.exports = { KEYS, SOURCES, set, clear, all, list, balanceSettings };
