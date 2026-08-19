'use strict';

/**
 * How a business is getting its inventory into Foundry.
 *
 * The old first run asked everyone to describe their business, which is the
 * right question for exactly one kind of customer: the one starting from
 * nothing. Someone with 1,842 variants in a spreadsheet does not want to
 * describe them — they want to hand the file over. Asking them to type out what
 * the file already says is asking them to do Foundry's job.
 *
 * So the first decision is which of those situations they are in, and the rest
 * of onboarding adapts. Nobody is asked to convert their data into a template.
 */

const { inTransaction } = require('../db');
const { nowIso, trimOrNull } = require('../lib/util');
const { ValidationError } = require('../domain/errors');

const PATHS = [
  {
    id: 'fresh',
    label: 'Starting fresh',
    blurb: 'I need Foundry to set everything up.',
    detail: 'Upload your first invoice or inventory sheet, or describe the business. Foundry shows one exact setup preview.',
    icon: 'foundry',
  },
  {
    id: 'spreadsheet',
    label: 'Excel / spreadsheets',
    blurb: 'My inventory already lives in spreadsheets.',
    detail: 'Hand over the file. Foundry reads it and sets itself up from what it finds.',
    icon: 'import',
  },
  {
    id: 'software',
    label: 'Existing inventory system',
    blurb: 'My inventory currently lives in another inventory or ERP system.',
    detail: 'Move to Foundry, or keep that system as the source of truth and let Foundry manage the operation.',
    icon: 'inventory',
  },
  {
    id: 'messy',
    label: "It's a mess",
    blurb: 'My inventory is spread across different files or systems.',
    detail: 'Give Foundry everything you have. It works out what agrees and what does not.',
    icon: 'alert',
  },
];

const PATH_IDS = PATHS.map((path) => path.id);

/** Where each path sends someone once chosen. */
const NEXT_STEP = {
  fresh: '/foundry/describe',
  spreadsheet: '/onboarding/files',
  software: '/onboarding/system',
  messy: '/onboarding/files?mode=messy',
  undecided: '/onboarding',
};

/**
 * Which system owns inventory truth for a workspace.
 *
 * This is never allowed to be ambiguous. Either Foundry's ledger is the record
 * and Mission 1 is authoritative, or an external system is and Foundry reads
 * from it. What must never exist is a Foundry balance that disagrees with the
 * system a business actually runs on while both claim to be right.
 */
const SOURCE_OF_TRUTH = {
  FOUNDRY_NATIVE: 'FOUNDRY_NATIVE',
  EXTERNAL_CONNECTED: 'EXTERNAL_CONNECTED',
};

function hydrate(row) {
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    path: row.path,
    pathChosenBy: row.path_chosen_by,
    pathReason: row.path_reason,
    describedAs: row.described_as,
    status: row.status,
    externalSystem: row.external_system,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    isComplete: row.status === 'ready',
    step: NEXT_STEP[row.path] || '/onboarding',
  };
}

function get(db, workspaceId) {
  return hydrate(
    db.prepare('SELECT * FROM workspace_onboarding WHERE workspace_id = ?').get(workspaceId)
  );
}

/** The onboarding state, started if this workspace has never had one. */
function ensure(db, workspaceId) {
  const existing = get(db, workspaceId);
  if (existing) return existing;
  const now = nowIso();
  db.prepare(
    `INSERT INTO workspace_onboarding (workspace_id, path, status, started_at, updated_at)
     VALUES (?, 'undecided', 'choosing', ?, ?)
     ON CONFLICT(workspace_id) DO NOTHING`
  ).run(workspaceId, now, now);
  return get(db, workspaceId);
}

/** Records the chosen path. */
function choose(db, workspaceId, path, options = {}) {
  if (!PATH_IDS.includes(path)) throw new ValidationError('That is not one of the onboarding paths.');
  ensure(db, workspaceId);
  const now = nowIso();

  db.prepare(
    `UPDATE workspace_onboarding
        SET path = ?, path_chosen_by = ?, path_reason = ?, described_as = COALESCE(?, described_as),
            status = ?, updated_at = ?
      WHERE workspace_id = ?`
  ).run(
    path,
    options.chosenBy === 'foundry' ? 'foundry' : 'customer',
    trimOrNull(options.reason),
    trimOrNull(options.describedAs),
    path === 'fresh' ? 'understanding' : 'collecting',
    now,
    workspaceId
  );
  return get(db, workspaceId);
}

function setStatus(db, workspaceId, status) {
  // A workspace can reach a migration without ever having pressed a path
  // button — an API caller, or a test. Recording progress against a row that
  // does not exist would silently lose the whole onboarding state.
  ensure(db, workspaceId);
  const now = nowIso();
  db.prepare(
    `UPDATE workspace_onboarding
        SET status = ?, completed_at = CASE WHEN ? = 'ready' THEN ? ELSE completed_at END, updated_at = ?
      WHERE workspace_id = ?`
  ).run(status, status, now, now, workspaceId);
  return get(db, workspaceId);
}

/**
 * A starting-fresh inventory has crossed the setup boundary once Foundry has
 * real ledger evidence. Continuing to ask how to add quantities after a
 * successful receipt or opening adjustment is stale workflow state, not a
 * meaningful customer decision.
 */
function reconcileWithInventoryTruth(db, workspaceId) {
  const state = get(db, workspaceId);
  if (!state || state.isComplete || state.path !== 'fresh') return state;
  const hasTruth = db
    .prepare('SELECT 1 FROM movements WHERE workspace_id = ? LIMIT 1')
    .get(workspaceId);
  return hasTruth ? setStatus(db, workspaceId, 'ready') : state;
}

function setExternalSystem(db, workspaceId, systemName) {
  db.prepare('UPDATE workspace_onboarding SET external_system = ?, updated_at = ? WHERE workspace_id = ?')
    .run(trimOrNull(systemName), nowIso(), workspaceId);
  return get(db, workspaceId);
}

// ---------------------------------------------------------------------------
// Source of truth
// ---------------------------------------------------------------------------

function sourceOfTruth(db, workspaceId) {
  const row = db.prepare('SELECT source_of_truth_mode FROM workspaces WHERE id = ?').get(workspaceId);
  return (row && row.source_of_truth_mode) || SOURCE_OF_TRUTH.FOUNDRY_NATIVE;
}

/**
 * Changes which system owns inventory truth.
 *
 * Going external is refused unless a connector is actually connected. A
 * workspace that claimed an external system owned its inventory while nothing
 * could read that system would have no source of truth at all — worse than
 * either mode honestly.
 */
function setSourceOfTruth(db, workspaceId, mode) {
  if (!Object.values(SOURCE_OF_TRUTH).includes(mode)) {
    throw new ValidationError('That is not a source-of-truth mode.');
  }
  if (mode === SOURCE_OF_TRUTH.EXTERNAL_CONNECTED) {
    const connected = db
      .prepare("SELECT 1 FROM workspace_connectors WHERE workspace_id = ? AND status = 'connected' LIMIT 1")
      .get(workspaceId);
    if (!connected) {
      throw new ValidationError(
        'An inventory can only be owned by an external system once a connector to it is actually connected.'
      );
    }
  }
  db.prepare('UPDATE workspaces SET source_of_truth_mode = ? WHERE id = ?').run(mode, workspaceId);
  return sourceOfTruth(db, workspaceId);
}

/** True when Mission 1's ledger is the record for this workspace. */
function isFoundryNative(db, workspaceId) {
  return sourceOfTruth(db, workspaceId) === SOURCE_OF_TRUTH.FOUNDRY_NATIVE;
}

// ---------------------------------------------------------------------------
// Choosing a path from a description
// ---------------------------------------------------------------------------

/**
 * Words that place someone on a path without needing a model.
 *
 * Used as a first pass for "not sure — here's what's going on". It is only ever
 * a *recommendation* shown with its reason, and the customer can pick something
 * else, so a wrong guess costs a click rather than a migration.
 */
const SIGNALS = [
  { path: 'messy', pattern: /\b(mess|messy|scattered|all over|several files|multiple files|different files|everywhere|no idea where)\b/i,
    reason: 'you mentioned your inventory is spread across more than one place' },
  { path: 'software', pattern: /\b(erp|netsuite|quickbooks|sap|shopify|square|lightspeed|fishbowl|cin7|unleashed|zoho|odoo|dear|katana|system|software|platform)\b/i,
    reason: 'you mentioned another system you are using today' },
  { path: 'spreadsheet', pattern: /\b(excel|spreadsheet|spread sheet|xlsx|csv|google sheets?|sheets?|workbook)\b/i,
    reason: 'you mentioned spreadsheets' },
  { path: 'fresh', pattern: /\b(nothing|from scratch|starting|new business|just started|not tracking|on paper|in my head|no system)\b/i,
    reason: 'you mentioned you are not tracking inventory anywhere yet' },
];

/**
 * Recommends a path from a free description.
 *
 * Deterministic first, and the model is only asked when the words settle
 * nothing. Either way the answer is a recommendation with a reason attached.
 */
function recommendFromDescription(description) {
  const text = String(description || '').trim();
  if (!text) return null;

  // Most specific first: "spreadsheets all over the place" is a mess, not a
  // spreadsheet migration, and the mess pattern is checked before the others.
  for (const signal of SIGNALS) {
    if (signal.pattern.test(text)) {
      return { path: signal.path, reason: signal.reason, decidedBy: 'rules' };
    }
  }
  return null;
}

module.exports = {
  PATHS,
  PATH_IDS,
  NEXT_STEP,
  SOURCE_OF_TRUTH,
  SIGNALS,
  hydrate,
  get,
  ensure,
  choose,
  setStatus,
  reconcileWithInventoryTruth,
  setExternalSystem,
  sourceOfTruth,
  setSourceOfTruth,
  isFoundryNative,
  recommendFromDescription,
};
