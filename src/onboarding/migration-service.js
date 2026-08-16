'use strict';

/**
 * Taking the inventory over: the plan, the migration, and the reconciliation.
 *
 * The shape is the one every consequential thing in Foundry uses — propose,
 * show, approve, execute, verify — with one addition that matters more here
 * than anywhere else.
 *
 * A migration is not finished when the import commands complete. It is finished
 * when the totals agree. Source totals are captured *before* anything is
 * created, Foundry's totals are counted afterwards from Mission 1 truth, and
 * the two are compared. A migration whose numbers disagree is reported as
 * MISMATCHED with the discrepancies listed, never as verified. A business that
 * is told its migration succeeded and finds out three months later that its
 * opening stock was wrong has been failed in the worst way this product can
 * fail somebody.
 *
 * Nothing here writes inventory directly. Products come from the Mission 5
 * import engine and every opening unit arrives as a real Mission 1 receive.
 */

const crypto = require('crypto');
const { inTransaction } = require('../db');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const locationService = require('../domain/location-service');
const repo = require('../domain/repository');
const planApplier = require('../foundry/plan-applier');
const importPlans = require('../imports/plan-service');
const importExecutor = require('../imports/executor');
const reevaluate = require('../attention/reevaluate');
const sourceService = require('./source-service');
const consolidation = require('./consolidation-service');
const paths = require('./paths');

const OPENING_REASON = 'Migrated opening inventory';

const json = (value, fallback) => {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
};

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function integrityHash(plan) {
  return crypto
    .createHash('sha256')
    .update(
      stableStringify({
        sourceHashes: plan.sourceHashes,
        locations: plan.proposedLocations,
        locationMappings: plan.locationMappings,
        expected: plan.expectedTotals,
      })
    )
    .digest('hex');
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function hydratePlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sourceIds: json(row.source_ids, []),
    sourceHashes: json(row.source_hashes, []),
    proposedConfiguration: json(row.proposed_configuration, {}),
    configurationSource: row.configuration_source,
    proposedLocations: json(row.proposed_locations, []),
    locationMappings: json(row.location_mappings, {}),
    proposedRecords: json(row.proposed_records, {}),
    overlaps: json(row.overlaps, []),
    excludedData: json(row.excluded_data, []),
    expectedTotals: json(row.expected_totals, {}),
    confidence: row.confidence,
    status: row.status,
    planVersion: row.plan_version,
    integrityHash: row.integrity_hash,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

function hydrateConflict(row) {
  if (!row) return null;
  return {
    id: row.id,
    planId: row.plan_id,
    kind: row.kind,
    severity: row.severity,
    subject: row.subject,
    detail: json(row.detail, {}),
    evidence: json(row.evidence, []),
    options: json(row.options, []),
    recommendedOption: row.recommended_option,
    recommendationReason: row.recommendation_reason,
    decision: row.decision,
    decidedAt: row.decided_at,
    isSettled: Boolean(row.decision) || row.severity === 'resolved_automatically',
  };
}

/**
 * Analyses the sources and stores what Foundry proposes to do with them.
 */
function buildPlan(db, ctx, membership, options = {}) {
  permissions.assertCan(membership, permissions.OPERATE, 'bring data in');
  const sources = sourceService.list(db, ctx.workspaceId);
  if (sources.length === 0) throw new ValidationError('Give Foundry at least one file to work from.');

  const analysis = consolidation.analyse(db, ctx.workspaceId, sources);
  const now = nowIso();
  const id = newId('cplan');

  const draft = {
    sourceIds: sources.map((source) => source.id),
    sourceHashes: sources.map((source) => source.contentHash),
    proposedLocations: analysis.locations.map((group) => group.canonical),
    locationMappings: analysis.locationMappings,
    expectedTotals: analysis.expectedTotals,
  };

  const blocking = analysis.conflicts.filter((conflict) => conflict.severity === 'blocking').length;
  const reviewable = analysis.conflicts.filter((conflict) => conflict.severity === 'review').length;

  inTransaction(db, () => {
    db.prepare(
      `INSERT INTO consolidation_plans (
         id, workspace_id, created_by_user_id, source_ids, source_hashes,
         proposed_configuration, configuration_source, proposed_locations, location_mappings,
         proposed_records, overlaps, excluded_data, expected_totals, confidence, status,
         integrity_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      ctx.workspaceId,
      ctx.actorId,
      JSON.stringify(draft.sourceIds),
      JSON.stringify(draft.sourceHashes),
      JSON.stringify(options.configuration || {}),
      options.configurationSource || 'inferred',
      JSON.stringify(draft.proposedLocations),
      JSON.stringify(draft.locationMappings),
      JSON.stringify({ products: analysis.products.length, rows: analysis.totalRows }),
      JSON.stringify(analysis.products.filter((product) => product.sourceCount > 1)),
      JSON.stringify(analysis.excluded),
      JSON.stringify(draft.expectedTotals),
      blocking ? 'low' : reviewable ? 'medium' : 'high',
      blocking || reviewable ? 'AWAITING_DECISIONS' : 'READY',
      integrityHash({ ...draft }),
      now,
      now
    );

    const insert = db.prepare(
      `INSERT INTO consolidation_conflicts (
         id, workspace_id, plan_id, kind, severity, subject, detail, evidence, options,
         recommended_option, recommendation_reason, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const conflict of analysis.conflicts) {
      insert.run(
        newId('cflt'), ctx.workspaceId, id, conflict.kind, conflict.severity, conflict.subject,
        JSON.stringify(conflict.detail || {}), JSON.stringify(conflict.evidence || []),
        JSON.stringify(conflict.options || []), conflict.recommendedOption || null,
        conflict.recommendationReason || null, now
      );
    }
  });

  paths.setStatus(db, ctx.workspaceId, 'reviewing');
  return getPlan(db, ctx.workspaceId, id);
}

function getPlan(db, workspaceId, planId) {
  const row = db
    .prepare('SELECT * FROM consolidation_plans WHERE id = ? AND workspace_id = ?')
    .get(planId, workspaceId);
  if (!row) throw new NotFoundError('That migration plan is not in this inventory.');
  return hydratePlan(row);
}

function latestPlan(db, workspaceId) {
  return hydratePlan(
    db
      .prepare('SELECT * FROM consolidation_plans WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(workspaceId)
  );
}

function conflictsFor(db, workspaceId, planId, { onlyOpen = false } = {}) {
  const clause = onlyOpen ? " AND decision IS NULL AND severity <> 'resolved_automatically'" : '';
  return db
    .prepare(
      `SELECT * FROM consolidation_conflicts
        WHERE workspace_id = ? AND plan_id = ?${clause}
        ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, created_at, rowid`
    )
    .all(workspaceId, planId)
    .map(hydrateConflict);
}

/** Records how a person settled one conflict. */
function decide(db, ctx, membership, conflictId, decision) {
  permissions.assertCan(membership, permissions.OPERATE, 'bring data in');
  const row = db
    .prepare('SELECT * FROM consolidation_conflicts WHERE id = ? AND workspace_id = ?')
    .get(conflictId, ctx.workspaceId);
  if (!row) throw new NotFoundError('That decision is not part of this migration.');

  const options = json(row.options, []);
  const chosen = String(decision || '').trim();
  if (!options.some((option) => option.id === chosen)) {
    throw new ValidationError('That is not one of the options.');
  }

  db.prepare(
    'UPDATE consolidation_conflicts SET decision = ?, decided_by_user_id = ?, decided_at = ? WHERE id = ?'
  ).run(chosen, ctx.actorId, nowIso(), conflictId);

  // The plan becomes runnable exactly when nothing is left undecided.
  const open = conflictsFor(db, ctx.workspaceId, row.plan_id, { onlyOpen: true });
  db.prepare('UPDATE consolidation_plans SET status = ?, updated_at = ? WHERE id = ?')
    .run(open.length ? 'AWAITING_DECISIONS' : 'READY', nowIso(), row.plan_id);

  return hydrateConflict(
    db.prepare('SELECT * FROM consolidation_conflicts WHERE id = ?').get(conflictId)
  );
}

/** Accepts every conflict Foundry recommended an answer for, in one go. */
function acceptRecommendations(db, ctx, membership, planId) {
  permissions.assertCan(membership, permissions.OPERATE, 'bring data in');
  const conflicts = conflictsFor(db, ctx.workspaceId, planId, { onlyOpen: true });
  let accepted = 0;
  for (const conflict of conflicts) {
    if (!conflict.recommendedOption) continue;   // no recommendation is not an answer
    decide(db, ctx, membership, conflict.id, conflict.recommendedOption);
    accepted += 1;
  }
  return { accepted, remaining: conflictsFor(db, ctx.workspaceId, planId, { onlyOpen: true }).length };
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/**
 * Carries the migration out.
 *
 * Configuration, then locations, then the catalog and opening stock through the
 * Mission 5 import engine, then reconciliation. Claimed under an idempotency
 * key first, so a retried request returns the first migration rather than
 * building the customer's inventory twice.
 */
async function migrate(db, ctx, membership, planId, options = {}) {
  permissions.assertCan(membership, permissions.OPERATE, 'bring data in');
  const plan = getPlan(db, ctx.workspaceId, planId);

  const idempotencyKey = options.idempotencyKey || `migration:${planId}:${plan.integrityHash}`;
  const seen = db
    .prepare('SELECT * FROM migration_runs WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, idempotencyKey);
  if (seen) return { replayed: true, run: hydrateRun(db, ctx.workspaceId, seen.id) };

  const open = conflictsFor(db, ctx.workspaceId, planId, { onlyOpen: true });
  const blocking = open.filter((conflict) => conflict.severity === 'blocking');
  if (blocking.length) {
    throw new ValidationError(
      `${blocking.length} thing(s) still need a decision before Foundry can take this inventory over.`
    );
  }

  const runId = newId('mrun');
  const now = nowIso();
  db.prepare(
    `INSERT INTO migration_runs (
       id, workspace_id, plan_id, idempotency_key, run_by_user_id, status, stage, started_at
     ) VALUES (?, ?, ?, ?, ?, 'RUNNING', 'configuring', ?)`
  ).run(runId, ctx.workspaceId, planId, idempotencyKey, ctx.actorId, now);

  db.prepare("UPDATE consolidation_plans SET status = 'MIGRATING', updated_at = ? WHERE id = ?").run(now, planId);
  paths.setStatus(db, ctx.workspaceId, 'migrating');

  try {
    // 1. Locations, using the canonical spelling for every variant found.
    const created = ensureLocations(db, ctx, plan);
    stage(db, runId, 'importing catalog and stock');

    // 2. The catalog and opening balances, through Mission 5.
    const decisions = decisionsFor(db, ctx.workspaceId, planId);
    const imports = [];
    for (const sourceId of plan.sourceIds) {
      const source = sourceService.get(db, ctx.workspaceId, sourceId);
      if (source.excluded) continue;
      // Sequential on purpose: two imports creating the same product at once
      // would race to create it twice.
      imports.push(await runImport(db, ctx, membership, source, plan, decisions));
    }

    stage(db, runId, 'reconciling');
    db.prepare("UPDATE migration_runs SET status = 'RECONCILING', import_ids = ? WHERE id = ?")
      .run(JSON.stringify(imports.map((entry) => entry.importId)), runId);

    // 3. The part that decides whether this worked.
    const reconciliation = reconcile(db, ctx.workspaceId, runId, plan, imports);

    const result = {
      locationsCreated: created.length,
      imports: imports.map((entry) => ({
        source: entry.sourceName,
        importId: entry.importId,
        itemsCreated: entry.result.itemsCreated,
        skusCreated: entry.result.skusCreated,
        unitsEstablished: entry.result.unitsEstablished,
        rowsImported: entry.result.rowsImported,
        rowsSkipped: entry.result.rowsSkipped,
        rowsFailed: entry.result.rowsFailed,
      })),
      conflictsReviewed: conflictsFor(db, ctx.workspaceId, planId).filter((c) => c.decision).length,
    };

    db.prepare(
      `UPDATE migration_runs SET status = ?, stage = 'finished', result = ?, finished_at = ? WHERE id = ?`
    ).run(reconciliation.verified ? 'VERIFIED' : 'MISMATCHED', JSON.stringify(result), nowIso(), runId);
    db.prepare("UPDATE consolidation_plans SET status = 'COMPLETED', updated_at = ? WHERE id = ?")
      .run(nowIso(), planId);
    paths.setStatus(db, ctx.workspaceId, 'ready');

    // 4. Look at the inventory Foundry now holds. Conservatively — there is no
    // trading history yet, so most of Mission 3 has nothing honest to say.
    try {
      reevaluate.refresh(db, ctx.workspaceId, 'migration');
    } catch {
      /* a failed sweep must not fail a migration that worked */
    }

    return { replayed: false, run: hydrateRun(db, ctx.workspaceId, runId) };
  } catch (error) {
    db.prepare("UPDATE migration_runs SET status = 'FAILED', error_message = ?, finished_at = ? WHERE id = ?")
      .run(error.message, nowIso(), runId);
    db.prepare("UPDATE consolidation_plans SET status = 'READY', updated_at = ? WHERE id = ?")
      .run(nowIso(), planId);
    throw error;
  }
}

function stage(db, runId, name) {
  db.prepare('UPDATE migration_runs SET stage = ? WHERE id = ?').run(name, runId);
}

/** The locations the files describe, created once, under one spelling each. */
function ensureLocations(db, ctx, plan) {
  const created = [];
  const existing = repo.listLocations(db, ctx.workspaceId).map((location) => location.name.toLowerCase());
  for (const name of plan.proposedLocations) {
    if (existing.includes(String(name).toLowerCase())) continue;
    const location = locationService.createLocation(db, ctx, { name, kind: 'warehouse' });
    created.push(location);
    existing.push(String(name).toLowerCase());
  }
  return created;
}

/** Decisions keyed for lookup while importing. */
function decisionsFor(db, workspaceId, planId) {
  const map = new Map();
  for (const conflict of conflictsFor(db, workspaceId, planId)) {
    if (conflict.decision) map.set(conflict.id, conflict);
  }
  return map;
}

/**
 * Runs one source through the Mission 5 import engine.
 *
 * This is the whole reason onboarding does not have its own importer. What
 * migration adds is the context Mission 5 could not know on its own: which
 * spelling of a location is canonical, and which conflicts a person settled.
 * Everything after that — reading, validating, previewing, creating products,
 * establishing opening stock as real receives, verifying — is Mission 5 doing
 * exactly what it already does.
 */
async function runImport(db, ctx, membership, source, plan, decisions) {
  const { buffer, filename } = sourceService.contentOf(db, ctx.workspaceId, source.id);

  // The canonical location for every spelling the files used.
  const locationMappings = {};
  for (const [variant, canonical] of Object.entries(plan.locationMappings)) {
    const location = db
      .prepare('SELECT id FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
      .get(ctx.workspaceId, canonical);
    if (location) locationMappings[variant] = location.id;
  }

  // The profile already recognised these columns deterministically, and the
  // review screen showed them. Handing them to the import engine keeps the
  // migration reproducible and skips asking a model the same question again.
  const sheetProfile = source.profile.sheets[source.profile.primarySheetIndex] || source.profile.sheets[0];
  const { plan: imported } = await importPlans.analyse(db, ctx, membership, {
    buffer,
    filename,
    mappings: sheetProfile ? sheetProfile.mappings : undefined,
    detectedType: sheetProfile ? sheetProfile.detectedType : undefined,
  });

  // Re-read with the migration's location decisions applied, so a row that said
  // "Brooklyn Whse" lands in Brooklyn Warehouse rather than failing.
  if (Object.keys(locationMappings).length) {
    importPlans.revalidate(db, ctx, membership, imported.id, { locationMappings });
  }

  importPlans.approve(db, ctx, membership, imported.id);
  const run = importExecutor.execute(db, ctx, membership, imported.id, {
    // Keyed to this migration so a retried migration replays rather than
    // importing the same file a second time.
    idempotencyKey: `migration:${plan.id}:${source.id}`,
  });

  return {
    importId: imported.id,
    sourceName: source.name,
    sourceHash: source.contentHash,
    result: run.result || {},
    replayed: run.replayed === true,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Compares what the sources said with what Foundry now holds.
 *
 * Counted independently on both sides. A check that cannot be made honestly is
 * reported as unmeasured rather than quietly passing.
 */
function reconcile(db, workspaceId, runId, plan, imports) {
  const expected = plan.expectedTotals || {};

  const observed = {
    products: db
      .prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ? AND is_active = 1')
      .get(workspaceId).n,
    variants: db
      .prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ? AND is_active = 1')
      .get(workspaceId).n,
    locations: db
      .prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ? AND is_active = 1')
      .get(workspaceId).n,
    units: db
      .prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?')
      .get(workspaceId).n,
    serials: db.prepare('SELECT COUNT(*) AS n FROM serial_units WHERE workspace_id = ?').get(workspaceId).n,
    lots: db.prepare('SELECT COUNT(*) AS n FROM lots WHERE workspace_id = ?').get(workspaceId).n,
    suppliers: db.prepare('SELECT COUNT(*) AS n FROM suppliers WHERE workspace_id = ?').get(workspaceId).n,
  };

  const rowsSkipped = imports.reduce((sum, entry) => sum + ((entry.result && entry.result.rowsSkipped) || 0), 0);
  const rowsFailed = imports.reduce((sum, entry) => sum + ((entry.result && entry.result.rowsFailed) || 0), 0);

  const checks = [
    check('Products', expected.products, observed.products),
    check('Locations', expected.locations, observed.locations),
    check('Units on hand', expected.units, observed.units),
  ];

  const discrepancies = checks
    .filter((entry) => entry.measured && !entry.ok)
    .map((entry) => `${entry.name}: the files say ${entry.expected}, Foundry holds ${entry.observed}.`);

  // Rows that never made it in are a discrepancy even when the arithmetic
  // happens to line up — they are records the customer handed over and does
  // not have.
  if (rowsSkipped || rowsFailed) {
    discrepancies.push(
      `${rowsSkipped + rowsFailed} row(s) from the files were not imported and are listed separately.`
    );
  }

  const verified = discrepancies.length === 0;
  const id = newId('mrec');
  db.prepare(
    `INSERT INTO migration_reconciliations (
       id, workspace_id, migration_run_id, verified, checks, expected, observed, discrepancies, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, workspaceId, runId, verified ? 1 : 0,
    JSON.stringify(checks), JSON.stringify(expected), JSON.stringify(observed),
    JSON.stringify(discrepancies), nowIso()
  );

  return { id, verified, checks, expected, observed, discrepancies, rowsSkipped, rowsFailed };
}

function check(name, expected, observed) {
  const measured = expected !== undefined && expected !== null;
  return {
    name,
    expected: measured ? expected : null,
    observed,
    measured,
    ok: measured ? expected === observed : false,
  };
}

function hydrateRun(db, workspaceId, runId) {
  const row = db
    .prepare('SELECT * FROM migration_runs WHERE id = ? AND workspace_id = ?')
    .get(runId, workspaceId);
  if (!row) throw new NotFoundError('That migration is not in this inventory.');

  const reconciliation = db
    .prepare(
      'SELECT * FROM migration_reconciliations WHERE migration_run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
    )
    .get(runId);

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    planId: row.plan_id,
    status: row.status,
    stage: row.stage,
    importIds: json(row.import_ids, []),
    result: json(row.result, {}),
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    verified: row.status === 'VERIFIED',
    reconciliation: reconciliation
      ? {
          verified: Boolean(reconciliation.verified),
          checks: json(reconciliation.checks, []),
          expected: json(reconciliation.expected, {}),
          observed: json(reconciliation.observed, {}),
          discrepancies: json(reconciliation.discrepancies, []),
        }
      : null,
  };
}

function latestRun(db, workspaceId) {
  const row = db
    .prepare('SELECT id FROM migration_runs WHERE workspace_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
    .get(workspaceId);
  return row ? hydrateRun(db, workspaceId, row.id) : null;
}

module.exports = {
  OPENING_REASON,
  stableStringify,
  integrityHash,
  hydratePlan,
  hydrateConflict,
  buildPlan,
  getPlan,
  latestPlan,
  conflictsFor,
  decide,
  acceptRecommendations,
  migrate,
  ensureLocations,
  reconcile,
  check,
  hydrateRun,
  latestRun,
};
