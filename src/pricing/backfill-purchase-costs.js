'use strict';

const crypto = require('node:crypto');

/**
 * A short-lived UI bug sent explicit “price I pay suppliers” instructions to
 * Accounting opening balances. The owner's words and the per-unit arithmetic
 * are still exact evidence. Recover that fact once as current purchase cost;
 * never infer it from an ordinary opening valuation.
 */
function backfillPurchaseCosts(db) {
  const rows = db.prepare(`SELECT obs.id AS opening_id, obs.workspace_id, obs.currency,
      obs.source_description, obs.created_by_user_id, obs.posted_at, obs.created_at,
      aio.sku_id, aio.quantity_units, aio.total_cost_minor
    FROM accounting_opening_balance_sets obs
    JOIN accounting_inventory_openings aio ON aio.opening_set_id = obs.id
    WHERE obs.status = 'POSTED' AND obs.source_description IS NOT NULL
      AND (LOWER(obs.source_description) LIKE '%price i pay supplier%'
        OR LOWER(obs.source_description) LIKE '%purchase cost%')
    ORDER BY obs.created_at, aio.sku_id`).all();
  const grouped = new Map();
  for (const row of rows) {
    if (!(row.quantity_units > 0) || row.total_cost_minor % row.quantity_units !== 0) continue;
    const key = `${row.opening_id}:${row.sku_id}`;
    const unit = row.total_cost_minor / row.quantity_units;
    const existing = grouped.get(key);
    if (existing && existing.amountMinor !== unit) {
      existing.conflicted = true;
      continue;
    }
    grouped.set(key, { ...row, amountMinor: unit, conflicted: existing && existing.conflicted });
  }
  const insert = db.prepare(`INSERT INTO sku_purchase_costs
    (id, workspace_id, sku_id, amount_minor, currency, supplier_item_id, source,
     source_detail, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, 'migrated_owner_instruction', ?, ?, ?)`);
  return db.transaction(() => {
    let created = 0;
    for (const row of grouped.values()) {
      if (row.conflicted) continue;
      const already = db.prepare('SELECT 1 FROM sku_purchase_costs WHERE workspace_id = ? AND sku_id = ? LIMIT 1')
        .get(row.workspace_id, row.sku_id);
      if (already) continue;
      const id = `pcost_mig_${crypto.createHash('sha256').update(`${row.opening_id}:${row.sku_id}`).digest('hex').slice(0, 20)}`;
      insert.run(id, row.workspace_id, row.sku_id, row.amountMinor, row.currency,
        JSON.stringify({ openingSetId: row.opening_id, statedAs: row.source_description }),
        row.created_by_user_id, row.posted_at || row.created_at);
      created += 1;
    }
    return created;
  })();
}

module.exports = { backfillPurchaseCosts };
