'use strict';

/**
 * Counting what the import actually produced, from the inventory itself.
 *
 * The executor's counters say what it believes it did. This re-reads Mission 1
 * truth — items, balances, movements — and compares. Keeping the two apart is
 * the point: "the import reported 438 products" and "there are 438 products"
 * are different claims, and only the second one is worth showing someone.
 */

const { newId, nowIso } = require('../lib/util');
const planService = require('./plan-service');

function check(name, expected, observed, detail) {
  return { name, expected, observed, ok: expected === observed, detail: detail || null };
}

/**
 * @returns {{ verified, checks, observed, problems }}
 */
function verify(db, workspaceId, importId, executionId) {
  const rows = db
    .prepare(`SELECT * FROM import_rows WHERE import_id = ? AND status = 'IMPORTED'`)
    .all(importId)
    .map(planService.hydrateRow);

  const execution = db
    .prepare('SELECT * FROM import_executions WHERE id = ? AND workspace_id = ?')
    .get(executionId, workspaceId);

  const itemIds = new Set(rows.map((row) => row.itemId).filter(Boolean));
  const skuIds = new Set(rows.map((row) => row.skuId).filter(Boolean));
  const movementIds = rows.flatMap((row) => row.movementIds || []);
  const expectedUnits = rows.reduce((total, row) => total + (row.quantity || 0), 0);

  // Every movement this import claims to have made, read back from the ledger.
  const movements = movementIds.length
    ? db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(quantity_delta), 0) AS units FROM movements
            WHERE workspace_id = ? AND reference LIKE ?`
        )
        .get(workspaceId, `import:${importId}#%`)
    : { n: 0, units: 0 };

  const existingItems = itemIds.size
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM items WHERE workspace_id = ? AND is_active = 1
             AND id IN (${[...itemIds].map(() => '?').join(',')})`
        )
        .get(workspaceId, ...itemIds).n
    : 0;

  const checks = [
    check('Products exist', itemIds.size, existingItems),
    check('Movements recorded', movementIds.length, movements.n),
    check('Units received', expectedUnits, movements.units),
    check('Rows imported', rows.length, execution ? execution.rows_imported : rows.length),
  ];

  // Balances, summed from the inventory rather than from the import.
  const balances = skuIds.size
    ? db
        .prepare(
          `SELECT COALESCE(SUM(on_hand), 0) AS total FROM balances
            WHERE workspace_id = ? AND sku_id IN (${[...skuIds].map(() => '?').join(',')})`
        )
        .get(workspaceId, ...skuIds).total
    : 0;

  const problems = checks
    .filter((entry) => !entry.ok)
    .map((entry) => `${entry.name}: expected ${entry.expected}, found ${entry.observed}.`);

  const observed = {
    items: existingItems,
    skus: skuIds.size,
    rows: rows.length,
    units: movements.units,
    balanceTotal: balances,
    movements: movements.n,
  };

  const record = {
    id: newId('impv'),
    workspaceId,
    importId,
    executionId,
    verified: problems.length === 0,
    checks,
    observed,
    problems,
    createdAt: nowIso(),
  };

  db.prepare(
    `INSERT INTO import_verifications (
       id, workspace_id, import_id, execution_id, verified, checks, observed, problems, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    workspaceId,
    importId,
    executionId,
    record.verified ? 1 : 0,
    JSON.stringify(checks),
    JSON.stringify(observed),
    JSON.stringify(problems),
    record.createdAt
  );

  return record;
}

function latest(db, workspaceId, importId) {
  const row = db
    .prepare(
      `SELECT * FROM import_verifications WHERE workspace_id = ? AND import_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(workspaceId, importId);
  if (!row) return null;
  return {
    id: row.id,
    verified: Boolean(row.verified),
    checks: JSON.parse(row.checks),
    observed: JSON.parse(row.observed),
    problems: JSON.parse(row.problems),
    createdAt: row.created_at,
  };
}

module.exports = { verify, latest, check };
