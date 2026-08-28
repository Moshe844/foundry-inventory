'use strict';

const { inTransaction } = require('../db');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');

const CURRENCY = /^[A-Z]{3}$/;

function normaliseCurrency(value, fallback = 'USD') {
  const currency = String(value || fallback).trim().toUpperCase();
  if (!CURRENCY.test(currency)) throw new ValidationError('Currency must be a three-letter code such as USD, EUR or GBP.');
  return currency;
}

/** Money is persisted as integer minor units so 3 × 12.10 is exactly 36.30. */
function toMinor(value, label = 'Price') {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const clean = String(value).trim().replace(/[$£€¥,\s]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean)) throw new ValidationError(`${label} must be a positive amount with no more than two decimal places.`);
  const [whole, fraction = ''] = clean.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor < 0 || minor > 99999999999) {
    throw new ValidationError(`${label} is outside the supported range.`);
  }
  return minor;
}

function fromMajorNumber(value) {
  if (value === null || value === undefined || Number(value) < 0) return null;
  const minor = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(minor) || minor < 0) throw new ValidationError('Price is not a valid monetary amount.');
  return minor;
}

function formatMinor(amountMinor, currency = 'USD') {
  if (amountMinor === null || amountMinor === undefined) return 'Not set';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: normaliseCurrency(currency) })
      .format(Number(amountMinor) / 100);
  } catch {
    return `${currency} ${(Number(amountMinor) / 100).toFixed(2)}`;
  }
}

function requireSku(db, workspaceId, skuId) {
  const sku = db.prepare(`SELECT s.*, i.name AS item_name, i.unit_label
    FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.id = ? AND s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1`).get(skuId, workspaceId);
  if (!sku) throw new NotFoundError('That product or variant is not in this inventory.');
  sku.display_name = sku.variant_label ? `${sku.item_name} / ${sku.variant_label}` : sku.item_name;
  return sku;
}

function currentForSku(db, workspaceId, skuId) {
  const row = db.prepare(`SELECT sp.*, u.name AS actor_name
    FROM sku_prices sp LEFT JOIN users u ON u.id = sp.created_by_user_id
    WHERE sp.workspace_id = ? AND sp.sku_id = ?
    ORDER BY sp.created_at DESC, sp.rowid DESC LIMIT 1`).get(workspaceId, skuId);
  return row ? { ...row, isSet: row.amount_minor !== null, formatted: formatMinor(row.amount_minor, row.currency) }
    : { id: null, workspace_id: workspaceId, sku_id: skuId, amount_minor: null, currency: 'USD', isSet: false, formatted: 'Not set' };
}

function listForItem(db, workspaceId, itemId) {
  return db.prepare('SELECT id FROM skus WHERE workspace_id = ? AND item_id = ? AND is_active = 1 ORDER BY position')
    .all(workspaceId, itemId).map((row) => currentForSku(db, workspaceId, row.id));
}

function purchaseCostForSku(db, workspaceId, skuId) {
  const row = db.prepare(`SELECT si.last_unit_cost, si.last_cost_at, s.currency, s.name AS supplier_name
    FROM supplier_items si JOIN suppliers s ON s.id = si.supplier_id
    WHERE si.workspace_id = ? AND si.sku_id = ? AND si.is_active = 1 AND si.last_unit_cost IS NOT NULL
    ORDER BY si.is_preferred DESC, si.last_cost_at DESC, si.updated_at DESC LIMIT 1`).get(workspaceId, skuId);
  return row ? { ...row, amount_minor: fromMajorNumber(row.last_unit_cost), formatted: formatMinor(fromMajorNumber(row.last_unit_cost), row.currency) } : null;
}

function setPrice(db, ctx, input) {
  const sku = requireSku(db, ctx.workspaceId, input.skuId);
  const amountMinor = input.amountMinor !== undefined ? input.amountMinor : toMinor(input.amount, 'Selling price');
  if (amountMinor !== null && (!Number.isSafeInteger(Number(amountMinor)) || Number(amountMinor) < 0)) {
    throw new ValidationError('Selling price must be a valid non-negative amount.');
  }
  const currency = normaliseCurrency(input.currency);
  const current = currentForSku(db, ctx.workspaceId, sku.id);
  if (current.id && current.amount_minor === amountMinor && current.currency === currency) return { ...current, replayed: true };
  const id = newId('prc');
  const now = nowIso();
  return inTransaction(db, () => {
    db.prepare(`INSERT INTO sku_prices
      (id, workspace_id, sku_id, amount_minor, currency, source, source_detail, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, sku.id, amountMinor, currency, trimOrNull(input.source) || 'owner',
        JSON.stringify(input.sourceDetail || {}), ctx.actorId || null, now);

    // A draft has not been promised to a customer yet. Fill only missing draft
    // snapshots; confirmed orders remain historically exact.
    if (amountMinor !== null) {
      db.prepare(`UPDATE sales_order_lines SET unit_price_minor = ?, price_source_id = ?, updated_at = ?
        WHERE workspace_id = ? AND sku_id = ? AND unit_price_minor IS NULL
          AND sales_order_id IN (SELECT id FROM sales_orders WHERE workspace_id = ? AND status = 'DRAFT')`)
        .run(amountMinor, id, now, ctx.workspaceId, sku.id, ctx.workspaceId);
    }
    return currentForSku(db, ctx.workspaceId, sku.id);
  });
}

function historyForSku(db, workspaceId, skuId, limit = 50) {
  requireSku(db, workspaceId, skuId);
  return db.prepare(`SELECT sp.*, u.name AS actor_name FROM sku_prices sp
    LEFT JOIN users u ON u.id = sp.created_by_user_id
    WHERE sp.workspace_id = ? AND sp.sku_id = ? ORDER BY sp.created_at DESC, sp.rowid DESC LIMIT ?`)
    .all(workspaceId, skuId, limit).map((row) => ({ ...row, formatted: formatMinor(row.amount_minor, row.currency) }));
}

module.exports = {
  normaliseCurrency, toMinor, fromMajorNumber, formatMinor, requireSku,
  currentForSku, listForItem, purchaseCostForSku, setPrice, historyForSku,
};
