'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const { newId, nowIso } = require('../lib/util');
const ledger = require('./ledger');

function signature(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hydrate(db, workspaceId, id) {
  const row = db.prepare(`SELECT * FROM accounting_opening_balance_sets
    WHERE id = ? AND workspace_id = ?`).get(id, workspaceId);
  if (!row) return null;
  return { ...row,
    lines: db.prepare(`SELECT l.*, a.code AS account_code, a.name AS account_name,
      a.system_key FROM accounting_opening_balance_lines l JOIN accounting_accounts a ON a.id = l.account_id
      WHERE l.opening_set_id = ? ORDER BY a.code`).all(id),
    inventory: db.prepare(`SELECT o.*, s.code, s.variant_label, i.name AS item_name,
      l.name AS location_name FROM accounting_inventory_openings o
      JOIN skus s ON s.id = o.sku_id JOIN items i ON i.id = s.item_id
      JOIN locations l ON l.id = o.location_id WHERE o.opening_set_id = ?
      ORDER BY i.name, s.code, l.name`).all(id),
  };
}

function prepare(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'prepare opening balances');
  const startDate = ledger.dateOnly(input.startDate, 'Accounting start date');
  const currency = ledger.currencyCode(input.currency || 'USD');
  const costingMethod = String(input.costingMethod || 'WEIGHTED_AVERAGE').toUpperCase();
  if (costingMethod !== 'WEIGHTED_AVERAGE') {
    throw new ValidationError('Moving weighted average is the supported inventory costing method.');
  }
  ledger.ensureDefaultChart(db, ctx.workspaceId);
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  const rawInventory = Array.isArray(input.inventory) ? input.inventory : [];
  const lines = rawLines.map((line, index) => {
    const account = line.accountId
      ? db.prepare('SELECT * FROM accounting_accounts WHERE id = ? AND workspace_id = ? AND active = 1')
        .get(line.accountId, ctx.workspaceId)
      : ledger.accountBySystemKey(db, ctx.workspaceId, line.accountKey);
    if (!account) throw new ValidationError(`Opening line ${index + 1} uses an unavailable account.`);
    const debit = Number(line.debitMinor || 0); const credit = Number(line.creditMinor || 0);
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || (debit > 0) === (credit > 0)) {
      throw new ValidationError(`Opening line ${index + 1} needs one positive debit or credit.`);
    }
    return { accountId: account.id, debitMinor: debit, creditMinor: credit, memo: line.memo || null };
  });
  const inventory = rawInventory.map((row, index) => {
    const balance = db.prepare(`SELECT b.on_hand FROM balances b JOIN skus s ON s.id = b.sku_id
      WHERE b.workspace_id = ? AND b.sku_id = ? AND b.location_id = ?`)
      .get(ctx.workspaceId, row.skuId, row.locationId);
    if (!balance) throw new ValidationError(`Opening inventory line ${index + 1} is not a current stock position.`);
    const quantity = Number(row.quantityUnits);
    const cost = Number(row.totalCostMinor);
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity !== Number(balance.on_hand)) {
      throw new ValidationError(`Opening inventory line ${index + 1} quantity must equal current physical on-hand (${balance.on_hand}).`);
    }
    if (!Number.isSafeInteger(cost) || cost < 0 || (quantity === 0 && cost !== 0)) {
      throw new ValidationError(`Opening inventory line ${index + 1} needs a valid total cost.`);
    }
    return { skuId: row.skuId, locationId: row.locationId, quantityUnits: quantity, totalCostMinor: cost };
  });
  const inventoryCost = inventory.reduce((sum, row) => sum + row.totalCostMinor, 0);
  const inventoryAccount = ledger.accountBySystemKey(db, ctx.workspaceId, 'INVENTORY_ASSET');
  const explicitInventory = lines.filter((line) => line.accountId === inventoryAccount.id)
    .reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0);
  if (inventoryCost !== explicitInventory) {
    throw new ValidationError(`Opening inventory detail totals ${inventoryCost} minor units but the Inventory asset opening line is ${explicitInventory}.`);
  }
  const debits = lines.reduce((sum, line) => sum + line.debitMinor, 0);
  const credits = lines.reduce((sum, line) => sum + line.creditMinor, 0);
  if (!lines.length || debits !== credits) throw new ValidationError('Opening balances must be a complete balanced entry.');
  const payload = { startDate, currency, costingMethod, lines, inventory };
  const hash = signature(payload); const id = newId('opening'); const now = nowIso();
  return inTransaction(db, () => {
    db.prepare(`INSERT INTO accounting_opening_balance_sets
      (id, workspace_id, accounting_start_date, currency, costing_method, status,
       integrity_hash, source_description, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, startDate, currency, costingMethod, hash,
        input.sourceDescription || null, ctx.actorId, now);
    const insertLine = db.prepare(`INSERT INTO accounting_opening_balance_lines
      (id, workspace_id, opening_set_id, account_id, debit_minor, credit_minor, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    lines.forEach((line) => insertLine.run(newId('openingline'), ctx.workspaceId, id,
      line.accountId, line.debitMinor, line.creditMinor, line.memo));
    const insertInventory = db.prepare(`INSERT INTO accounting_inventory_openings
      (id, workspace_id, opening_set_id, sku_id, location_id, quantity_units, total_cost_minor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    inventory.forEach((row) => insertInventory.run(newId('openinginv'), ctx.workspaceId, id,
      row.skuId, row.locationId, row.quantityUnits, row.totalCostMinor, now));
    return hydrate(db, ctx.workspaceId, id);
  });
}

function approve(db, ctx, membership, id, expectedHash) {
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'approve opening balances');
  const opening = hydrate(db, ctx.workspaceId, id);
  if (!opening) throw new NotFoundError('That opening-balance review could not be found.');
  if (opening.status === 'POSTED') return { opening, replayed: true };
  if (opening.status !== 'DRAFT') throw new ValidationError('That opening-balance review is no longer available.');
  if (!expectedHash || expectedHash !== opening.integrity_hash) {
    throw new ValidationError('Opening balances changed since review. Review the complete balance again.');
  }
  return inTransaction(db, () => {
    ledger.configure(db, ctx, membership, { startDate: opening.accounting_start_date,
      currency: opening.currency, costingMethod: opening.costing_method });
    const posted = ledger.post(db, ctx, {
      postingDate: opening.accounting_start_date, description: 'Approved opening balances',
      sourceType: 'opening_balance', sourceRecordType: 'opening_balance_set', sourceRecordId: opening.id,
      sourceKey: `opening-balances:${opening.id}`, createdByType: 'USER', approvedByUserId: ctx.actorId,
      metadata: { sourceDescription: opening.source_description || null },
      lines: opening.lines.map((line) => ({ accountId: line.account_id,
        debitMinor: Number(line.debit_minor), creditMinor: Number(line.credit_minor), memo: line.memo })),
    });
    const now = nowIso();
    for (const row of opening.inventory) {
      db.prepare(`INSERT INTO accounting_inventory_cost_balances
        (workspace_id, sku_id, location_id, quantity_units, total_cost_minor, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, sku_id, location_id) DO UPDATE SET
          quantity_units = excluded.quantity_units, total_cost_minor = excluded.total_cost_minor,
          updated_at = excluded.updated_at`)
        .run(ctx.workspaceId, row.sku_id, row.location_id, row.quantity_units, row.total_cost_minor, now);
    }
    db.prepare(`UPDATE accounting_opening_balance_sets SET status = 'POSTED', journal_entry_id = ?,
      approved_by_user_id = ?, posted_at = ? WHERE id = ? AND workspace_id = ? AND status = 'DRAFT'`)
      .run(posted.entry.id, ctx.actorId, now, id, ctx.workspaceId);
    return { opening: hydrate(db, ctx.workspaceId, id), replayed: false };
  });
}

module.exports = { signature, hydrate, prepare, approve };
