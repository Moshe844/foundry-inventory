'use strict';

/**
 * Running an approved import.
 *
 * The two things that matter here are that it cannot happen twice and that it
 * can stop half-way without lying about where it got to.
 *
 * Not twice: one execution row per import, claimed under a unique key before
 * anything is written, so a double-click or a retried request returns the first
 * run's result instead of creating two thousand products again. Underneath
 * that, each row records what it became, so even a resumed run skips what has
 * already happened.
 *
 * Not lying: progress counters are written as work completes and read back from
 * the table, never held in memory and reported optimistically. Opening stock is
 * established with real Mission 1 receives — there is no path here that writes a
 * balance directly — so every imported unit has a movement explaining itself.
 */

const { inTransaction } = require('../db');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const itemService = require('../domain/item-service');
const engine = require('../domain/inventory-engine');
const entitlements = require('../entitlements/service');
const planService = require('./plan-service');

const BATCH_SIZE = 50;
const IMPORT_NOTE = 'Initial inventory import';

/** Rows that still have work left in them. */
const PENDING = ['VALID', 'NEEDS_REVIEW'];

const json = (value, fallback) => {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
};

/**
 * Groups rows into the products they describe.
 *
 * A variant file gives one row per size, all of which are one product with
 * several versions — creating an item per row would produce eleven "Kids
 * Sweater" products instead of one with eleven sizes.
 */
function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const parsed = row.parsed || {};
    const key = (parsed.code || parsed.name || '').trim().toLowerCase();
    if (!key) continue;
    // Rows sharing a code are the same product; rows sharing only a name are
    // too, unless they carry different codes, which makes them different SKUs.
    const groupKey = parsed.existingItemId ? `item:${parsed.existingItemId}` : `new:${key}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        key: groupKey,
        existingItemId: parsed.existingItemId || null,
        name: parsed.name || parsed.code,
        code: parsed.code || null,
        description: parsed.description || null,
        unitLabel: parsed.unitLabel || null,
        rows: [],
      });
    }
    const group = groups.get(groupKey);
    group.rows.push(row);
    if (!group.name && parsed.name) group.name = parsed.name;
    if (!group.code && parsed.code) group.code = parsed.code;
    if (!group.description && parsed.description) group.description = parsed.description;
    if (!group.unitLabel && parsed.unitLabel) group.unitLabel = parsed.unitLabel;
  }
  return [...groups.values()];
}

/** The axes a group's rows describe, in the order the file presents them. */
function axesFor(group) {
  const axes = new Map();
  for (const row of group.rows) {
    for (const variant of row.parsed.variants || []) {
      if (!axes.has(variant.axis)) axes.set(variant.axis, []);
      const values = axes.get(variant.axis);
      if (!values.includes(variant.value)) values.push(variant.value);
    }
  }
  return [...axes.entries()].map(([name, values]) => ({ name, values }));
}

/**
 * How a product from this file is counted.
 *
 * Normally the workspace's own answer from Mission 2, which is why an import
 * never interrogates anyone about tracking. But a file carrying a lot code or a
 * serial number per row is direct evidence about these particular products, and
 * creating them as plain quantity items would silently discard that column.
 */
function trackingModeFor(plan) {
  if (plan.detectedType === 'serials') return 'serial';
  if (plan.detectedType === 'lots') return 'lot';
  return (plan.trackingModel && plan.trackingModel.trackingMode) || 'quantity';
}

/** How many SKUs a plan will create, for the entitlement check up front. */
function plannedSkuCount(groups) {
  return groups.reduce((total, group) => {
    if (group.existingItemId) return total;
    const axes = axesFor(group);
    return total + (axes.length ? axes.reduce((n, axis) => n * axis.values.length, 1) : 1);
  }, 0);
}

/** Finds the SKU a row means within an item, by its variant values. */
function findSku(db, workspaceId, itemId, variants) {
  const skus = db
    .prepare('SELECT * FROM skus WHERE workspace_id = ? AND item_id = ? AND is_active = 1 ORDER BY position')
    .all(workspaceId, itemId);
  if (!variants || variants.length === 0) {
    return skus.find((sku) => sku.is_default) || (skus.length === 1 ? skus[0] : null);
  }

  const wanted = variants.map((variant) => String(variant.value).toLowerCase()).sort();
  for (const sku of skus) {
    const values = db
      .prepare(
        `SELECT v.value FROM sku_option_values v WHERE v.sku_id = ?`
      )
      .all(sku.id)
      .map((row) => String(row.value).toLowerCase())
      .sort();
    if (values.length === wanted.length && values.every((value, index) => value === wanted[index])) {
      return sku;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Execution records
// ---------------------------------------------------------------------------

/**
 * Claims the right to run this import, or hands back the run that already has it.
 *
 * The unique index on (workspace_id, idempotency_key) is the actual guarantee;
 * the select afterwards is how a duplicate request finds the first attempt.
 */
function claim(db, ctx, importId, idempotencyKey) {
  const existing = db
    .prepare('SELECT * FROM import_executions WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, idempotencyKey);
  if (existing) return { claimed: false, execution: existing };

  const id = newId('impx');
  try {
    db.prepare(
      `INSERT INTO import_executions (
         id, workspace_id, import_id, idempotency_key, executed_by_user_id, status, stage, started_at
       ) VALUES (?, ?, ?, ?, ?, 'EXECUTING', 'starting', ?)`
    ).run(id, ctx.workspaceId, importId, idempotencyKey, ctx.actorId, nowIso());
  } catch (error) {
    if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
      const raced = db
        .prepare('SELECT * FROM import_executions WHERE workspace_id = ? AND idempotency_key = ?')
        .get(ctx.workspaceId, idempotencyKey);
      if (raced) return { claimed: false, execution: raced };
    }
    throw error;
  }
  return {
    claimed: true,
    execution: db.prepare('SELECT * FROM import_executions WHERE id = ?').get(id),
  };
}

function bump(db, executionId, counters) {
  const sets = Object.keys(counters).map((key) => `${key} = ${key} + ?`);
  if (!sets.length) return;
  db.prepare(`UPDATE import_executions SET ${sets.join(', ')} WHERE id = ?`).run(
    ...Object.values(counters),
    executionId
  );
}

function stage(db, executionId, name) {
  db.prepare('UPDATE import_executions SET stage = ? WHERE id = ?').run(name, executionId);
}

function isCancelled(db, executionId) {
  const row = db.prepare('SELECT cancel_requested FROM import_executions WHERE id = ?').get(executionId);
  return Boolean(row && row.cancel_requested);
}

function requestCancel(db, ctx, membership, executionId) {
  permissions.assertCan(membership, permissions.OPERATE, 'import data');
  const changed = db
    .prepare(
      `UPDATE import_executions SET cancel_requested = 1
        WHERE id = ? AND workspace_id = ? AND status = 'EXECUTING'`
    )
    .run(executionId, ctx.workspaceId);
  return changed.changes > 0;
}

/** Progress, read from what has actually been written. */
function progress(db, workspaceId, executionId) {
  const execution = db
    .prepare('SELECT * FROM import_executions WHERE id = ? AND workspace_id = ?')
    .get(executionId, workspaceId);
  if (!execution) throw new NotFoundError('That import run is not in this inventory.');

  const counts = planService.countsFor(db, execution.import_id);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const done = (counts.IMPORTED || 0) + (counts.FAILED || 0) + (counts.SKIPPED || 0) + (counts.INVALID || 0) +
    (counts.EXCLUDED || 0);
  return {
    executionId: execution.id,
    importId: execution.import_id,
    status: execution.status,
    stage: execution.stage,
    itemsCreated: execution.items_created,
    skusCreated: execution.skus_created,
    lotsCreated: execution.lots_created,
    serialsCreated: execution.serials_created,
    rowsImported: execution.rows_imported,
    rowsFailed: execution.rows_failed,
    unitsEstablished: execution.units_established,
    cancelRequested: Boolean(execution.cancel_requested),
    counts,
    total,
    done,
    percent: total ? Math.round((done / total) * 100) : 100,
    startedAt: execution.started_at,
    finishedAt: execution.finished_at,
    result: json(execution.result, {}),
    errorMessage: execution.error_message,
  };
}

// ---------------------------------------------------------------------------
// Doing the work
// ---------------------------------------------------------------------------

/**
 * Creates one product and establishes its opening stock.
 *
 * Each row is its own transaction. A batch-wide transaction would mean one bad
 * row on line 4,000 discarding 3,999 good ones, and an import that must be
 * perfect to be worth anything is not much use on real customer data.
 */
function importGroup(db, ctx, plan, group, executionId) {
  const results = [];
  const axes = axesFor(group);
  let itemId = group.existingItemId;
  let created = null;

  if (!itemId) {
    created = inTransaction(db, () =>
      itemService.createItem(db, ctx, {
        name: group.name,
        baseCode: group.code,
        description: group.description,
        unitLabel: group.unitLabel || 'unit',
        trackingMode: trackingModeFor(plan),
        hasVariants: axes.length > 0,
        options: axes.map((axis) => ({ name: axis.name, values: axis.values.join(', ') })),
      })
    );
    itemId = created.itemId;
    bump(db, executionId, { items_created: 1, skus_created: created.skuIds.length });
  }

  const item = db.prepare('SELECT * FROM items WHERE id = ? AND workspace_id = ?').get(itemId, ctx.workspaceId);

  for (const row of group.rows) {
    const parsed = row.parsed || {};
    try {
      const sku = findSku(db, ctx.workspaceId, itemId, parsed.variants);
      if (!sku) {
        throw new ValidationError(
          parsed.variants && parsed.variants.length
            ? `${item.name} has no ${parsed.variants.map((v) => v.value).join(' / ')} version. Add it first.`
            : `Foundry could not tell which version of ${item.name} this row means.`
        );
      }

      const quantity = parsed.quantity || 0;
      let movement = null;

      if (quantity > 0 || (item.tracking_mode === 'serial' && parsed.serial)) {
        if (!parsed.locationId) throw new ValidationError('No location for this stock.');
        const reference = `import:${plan.id}#${row.rowNumber}`;

        if (item.tracking_mode === 'serial') {
          // One row is one physical unit. A serial file with "3" in its
          // quantity column is describing one unit three times over, and
          // inventing two more serial numbers is exactly what must not happen.
          movement = engine.receive(db, ctx, {
            skuId: sku.id,
            locationId: parsed.locationId,
            serials: [parsed.serial],
            notes: IMPORT_NOTE,
            reference,
          });
          bump(db, executionId, { serials_created: movement.quantity, units_established: movement.quantity });
        } else if (item.tracking_mode === 'lot') {
          const before = db
            .prepare('SELECT COUNT(*) AS n FROM lots WHERE workspace_id = ? AND sku_id = ?')
            .get(ctx.workspaceId, sku.id).n;
          movement = engine.receive(db, ctx, {
            skuId: sku.id,
            locationId: parsed.locationId,
            quantity,
            lotCode: parsed.lotCode,
            expiresAt: parsed.expiresAt || null,
            lotReceivedAt: parsed.receivedAt || null,
            notes: IMPORT_NOTE,
            reference,
          });
          const after = db
            .prepare('SELECT COUNT(*) AS n FROM lots WHERE workspace_id = ? AND sku_id = ?')
            .get(ctx.workspaceId, sku.id).n;
          bump(db, executionId, { lots_created: Math.max(0, after - before), units_established: quantity });
        } else {
          movement = engine.receive(db, ctx, {
            skuId: sku.id,
            locationId: parsed.locationId,
            quantity,
            notes: IMPORT_NOTE,
            reference,
          });
          bump(db, executionId, { units_established: quantity });
        }
      }

      db.prepare(
        `UPDATE import_rows
            SET status = 'IMPORTED', item_id = ?, sku_id = ?, lot_id = ?, location_id = ?,
                movement_ids = ?, quantity = ?, imported_at = ?
          WHERE id = ?`
      ).run(
        itemId,
        sku.id,
        movement && movement.lotId ? movement.lotId : null,
        parsed.locationId || null,
        JSON.stringify(movement ? movement.movementIds : []),
        movement ? movement.quantity : 0,
        nowIso(),
        row.id
      );
      bump(db, executionId, { rows_imported: 1 });
      results.push({ rowId: row.id, ok: true });
    } catch (error) {
      const problems = [
        ...(row.problems || []),
        { code: 'failed', message: error.message || 'That row could not be imported.' },
      ];
      db.prepare('UPDATE import_rows SET status = ?, problems = ? WHERE id = ?').run(
        'FAILED',
        JSON.stringify(problems),
        row.id
      );
      bump(db, executionId, { rows_failed: 1 });
      results.push({ rowId: row.id, ok: false, error: error.message });
    }
  }

  return { itemId, createdItem: Boolean(created), results };
}

/**
 * Executes an approved import.
 *
 * @param {string} idempotencyKey the same key retried returns the first result.
 */
function execute(db, ctx, membership, importId, options = {}) {
  permissions.assertCan(membership, permissions.OPERATE, 'import data');
  const plan = planService.get(db, ctx.workspaceId, importId);
  // Keyed on the integrity hash rather than the version number: the hash covers
  // exactly what will be created, so two requests to run the same approved plan
  // share a key, and a plan whose mapping was corrected does not.
  const idempotencyKey = options.idempotencyKey || `import:${importId}:${plan.integrityHash}`;

  // The replay check comes before every other guard on purpose. A resubmitted
  // form arrives after the import has already succeeded, and answering it with
  // "that has already run" reads as an error for something that worked. The
  // honest answer to "do this" when it is already done is the result.
  const seen = db
    .prepare('SELECT * FROM import_executions WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, idempotencyKey);
  if (seen) return { replayed: true, ...progress(db, ctx.workspaceId, seen.id) };

  if (plan.approvalStatus !== 'APPROVED') {
    throw new ValidationError('That import has not been approved yet.');
  }
  if (plan.status === 'SUCCEEDED') throw new ValidationError('That import has already run.');
  if (plan.status === 'CANCELLED') throw new ValidationError('That import was cancelled.');

  const { claimed, execution } = claim(db, ctx, importId, idempotencyKey);
  if (!claimed) {
    // Lost a race with a concurrent request. Their result is the answer.
    return { replayed: true, ...progress(db, ctx.workspaceId, execution.id) };
  }

  db.prepare("UPDATE import_plans SET status = 'EXECUTING' WHERE id = ?").run(importId);

  const pending = db
    .prepare(
      `SELECT * FROM import_rows WHERE import_id = ? AND status IN (${PENDING.map(() => '?').join(',')})
        ORDER BY row_number`
    )
    .all(importId, ...PENDING)
    .map(planService.hydrateRow);

  const groups = groupRows(pending);

  // The plan's item allowance is checked before anything is created, so a large
  // file stops with an explanation instead of half-importing into a limit.
  try {
    entitlements.assertWithin(db, ctx, 'skus', { adding: plannedSkuCount(groups) });
  } catch (error) {
    db.prepare(
      `UPDATE import_executions SET status = 'FAILED', error_message = ?, finished_at = ? WHERE id = ?`
    ).run(error.message, nowIso(), execution.id);
    db.prepare("UPDATE import_plans SET status = 'READY' WHERE id = ?").run(importId);
    throw error;
  }

  stage(db, execution.id, 'creating products');
  let cancelled = false;

  for (let index = 0; index < groups.length; index += 1) {
    // Cancellation is honoured between products, never mid-product: stopping
    // after an item exists but before its stock arrives would leave a record
    // nobody asked for.
    if (index % 5 === 0 && isCancelled(db, execution.id)) {
      cancelled = true;
      break;
    }
    importGroup(db, ctx, plan, groups[index], execution.id);
    if ((index + 1) % BATCH_SIZE === 0) {
      stage(db, execution.id, `${index + 1} of ${groups.length} products`);
    }
  }

  if (cancelled) {
    db.prepare(
      `UPDATE import_rows SET status = 'SKIPPED' WHERE import_id = ? AND status IN ('VALID', 'NEEDS_REVIEW')`
    ).run(importId);
  }

  const counters = db.prepare('SELECT * FROM import_executions WHERE id = ?').get(execution.id);
  const status = cancelled
    ? 'CANCELLED'
    : counters.rows_failed === 0
      ? 'SUCCEEDED'
      : counters.rows_imported === 0
        ? 'FAILED'
        : 'PARTIAL';

  const result = {
    itemsCreated: counters.items_created,
    skusCreated: counters.skus_created,
    lotsCreated: counters.lots_created,
    serialsCreated: counters.serials_created,
    rowsImported: counters.rows_imported,
    rowsFailed: counters.rows_failed,
    rowsSkipped: planService.countsFor(db, importId).INVALID || 0,
    unitsEstablished: counters.units_established,
  };

  db.prepare(
    `UPDATE import_executions SET status = ?, stage = 'finished', result = ?, finished_at = ? WHERE id = ?`
  ).run(status, JSON.stringify(result), nowIso(), execution.id);
  db.prepare('UPDATE import_plans SET status = ?, completed_at = ? WHERE id = ?').run(
    status === 'SUCCEEDED' ? 'SUCCEEDED' : status === 'CANCELLED' ? 'CANCELLED' : status === 'FAILED' ? 'FAILED' : 'PARTIAL',
    nowIso(),
    importId
  );

  return { replayed: false, ...progress(db, ctx.workspaceId, execution.id) };
}

/**
 * Runs whatever is left of an import that stopped part-way.
 *
 * Rows already marked IMPORTED are not in the pending set, so resuming cannot
 * double-count them. A fresh idempotency key is correct here: this is a new
 * attempt at the remainder, not a replay of the first one.
 */
function resume(db, ctx, membership, importId) {
  const plan = planService.get(db, ctx.workspaceId, importId);
  if (!['PARTIAL', 'FAILED', 'CANCELLED'].includes(plan.status)) {
    throw new ValidationError('That import is not waiting to be resumed.');
  }
  const attempts = db
    .prepare('SELECT COUNT(*) AS n FROM import_executions WHERE import_id = ?')
    .get(importId).n;

  db.prepare("UPDATE import_plans SET status = 'READY', approval_status = 'APPROVED' WHERE id = ?").run(importId);
  db.prepare(
    `UPDATE import_rows SET status = 'VALID' WHERE import_id = ? AND status = 'SKIPPED'`
  ).run(importId);

  return execute(db, ctx, membership, importId, {
    idempotencyKey: `import:${importId}:${plan.integrityHash}:resume:${attempts}`,
  });
}

function executionsFor(db, workspaceId, importId) {
  return db
    .prepare(
      'SELECT * FROM import_executions WHERE workspace_id = ? AND import_id = ? ORDER BY started_at, rowid'
    )
    .all(workspaceId, importId);
}

function latestExecution(db, workspaceId, importId) {
  const rows = executionsFor(db, workspaceId, importId);
  return rows.length ? rows[rows.length - 1] : null;
}

module.exports = {
  BATCH_SIZE,
  IMPORT_NOTE,
  PENDING,
  groupRows,
  axesFor,
  trackingModeFor,
  plannedSkuCount,
  findSku,
  claim,
  progress,
  requestCancel,
  isCancelled,
  execute,
  resume,
  executionsFor,
  latestExecution,
};
