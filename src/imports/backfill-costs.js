'use strict';

/**
 * Stock that came in from a file carrying its cost, and was stored worth zero.
 *
 * Imports used to discard the supplier's cost column — "StockChief does not track
 * supplier cost" — so a spreadsheet invoice created 250 pairs of shoes valued
 * at nothing at all. The books showed inventory with no value, and the first
 * sale of any of it would have stopped on "StockChief has no recorded cost for
 * this product".
 *
 * The import path now attaches the cost as it creates the stock. This is for
 * the stock that came in before it did — because a fix that only works on the
 * next upload leaves every business that already uploaded holding inventory
 * the books cannot value, and asks them to notice it themselves.
 *
 * Nothing here is invented. The figure is the one the supplier wrote in the
 * file, still stored on the row it was read from, applied through the same
 * costing engine a purchase receipt uses. A row whose cost is already recorded
 * is left exactly alone, so running this twice changes nothing.
 */

const fields = require('./fields');

/** The column holding a unit cost, from the plan's mapping or its headings. */
function costColumn(plan) {
  try {
    const mapped = JSON.parse(plan.field_mappings || '{}');
    if (mapped.unitCost !== undefined) return Number(mapped.unitCost);
  } catch { /* fall through to the headings */ }

  /*
   * A plan stored before StockChief had a unit-cost field at all. Its headings
   * are still on the plan, and they are recognised the same way a fresh upload
   * would recognise them — the same rules, so the same answer.
   */
  let columns;
  try { columns = JSON.parse(plan.source_columns || '[]'); } catch { return -1; }
  let best = { index: -1, score: 0 };
  for (const column of columns) {
    const match = (fields.bestFieldScores(column.name) || [])
      .find((candidate) => candidate.field === 'unitCost');
    if (match && match.score > best.score) best = { index: Number(column.index), score: match.score };
  }
  return best.index;
}

/**
 * Give already-imported stock the value its own file recorded.
 *
 * Returns what it changed, so a caller can say so rather than working
 * silently. Safe to call on every database, including ones with no imports.
 */
function backfillImportCosts(db) {
  const costing = require('../accounting/costing');
  const prices = require('../pricing/price-service');

  let valuedRows = 0;
  let valuedMinor = 0;
  let posted = 0;

  const plans = db.prepare(`SELECT id, workspace_id, field_mappings, source_columns
    FROM import_plans WHERE status = 'SUCCEEDED'`).all();

  for (const plan of plans) {
    const index = costColumn(plan);
    if (index < 0) continue;
    const before = valuedMinor;

    const rows = db.prepare(`SELECT id, raw, movement_ids FROM import_rows
      WHERE import_id = ? AND status = 'IMPORTED'`).all(plan.id);

    for (const row of rows) {
      let movementIds;
      let raw;
      try {
        movementIds = JSON.parse(row.movement_ids || '[]');
        raw = JSON.parse(row.raw || '[]');
      } catch { continue; }
      if (!movementIds.length) continue;

      // Already valued — by the import itself, or by an earlier pass.
      const costed = db.prepare(`SELECT 1 FROM accounting_inventory_cost_movements
        WHERE workspace_id = ? AND inventory_movement_id IN (${movementIds.map(() => '?').join(',')})`)
        .get(plan.workspace_id, ...movementIds);
      if (costed) continue;

      let unitCostMinor;
      try { unitCostMinor = prices.toMinor(raw[index], 'Unit cost'); } catch { continue; }
      if (unitCostMinor === null || unitCostMinor === undefined) continue;

      try {
        const applied = costing.receive(db, { workspaceId: plan.workspace_id }, {
          movementIds,
          unitCostMinor,
          sourceType: 'import',
          sourceRecordId: row.id,
        });
        valuedRows += 1;
        valuedMinor += Number(applied.totalCostMinor || 0);
      } catch {
        /*
         * One row that cannot be valued is not a reason to leave the rest
         * worth nothing. It stays as it was — uncosted and visible — rather
         * than stopping a repair that is correct for every other row.
         */
      }
    }

    /*
     * And tell the books, so the valuation and the ledger agree.
     *
     * Deliberately not "post what this pass just valued": stock can already
     * carry a cost and still be missing from the ledger, which is exactly the
     * state a half-finished repair leaves behind. What is posted is the gap
     * between what this import's stock is worth and what has been posted for
     * it so far, so the two figures meet however they came apart.
     */
    const costedForPlan = db.prepare(`SELECT COALESCE(SUM(icm.cost_delta_minor), 0) AS total
      FROM accounting_inventory_cost_movements icm
      JOIN import_rows r ON r.id = icm.cost_source_record_id
      WHERE icm.workspace_id = ? AND icm.cost_source_type = 'import' AND r.import_id = ?`)
      .get(plan.workspace_id, plan.id).total;

    const postedForPlan = db.prepare(`SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0) AS total
      FROM accounting_journal_lines jl
      JOIN accounting_journal_entries je ON je.id = jl.entry_id
      JOIN accounting_accounts aa ON aa.id = jl.account_id
      WHERE jl.workspace_id = ? AND je.status = 'POSTED' AND je.source_type = 'import'
        AND je.source_record_id = ? AND aa.system_key = 'INVENTORY_ASSET'`)
      .get(plan.workspace_id, plan.id).total;

    const owed = Number(costedForPlan) - Number(postedForPlan);
    if (owed > 0) {
      try {
        const entry = require('./inventory-value').post(db, plan.workspace_id, {
          totalCostMinor: owed,
          // Keyed on the figure, so the same gap is never posted twice and a
          // later, larger one still can be.
          sourceKey: `import-inventory-value:repair:${plan.id}:${costedForPlan}`,
          sourceRecordId: plan.id,
          description: 'Inventory brought in from a file, valued afterwards',
        });
        if (entry && !entry.replayed) posted += 1;
      } catch {
        // The stock is valued either way; the ledger entry can be posted later.
      }
    }
  }

  /*
   * And the freight and fees those same files carried, which were dropped
   * with the cost. Recorded rather than posted, so the owner still decides
   * what they are.
   */
  let charges = 0;
  for (const plan of plans) {
    try { charges += require('./document-money').recordForPlan(db, plan.id).charges; }
    catch { /* one file's paperwork is not a reason to stop repairing the rest */ }
  }

  return { rows: valuedRows, totalCostMinor: valuedMinor, entriesPosted: posted, charges };
}

module.exports = { backfillImportCosts, costColumn };
