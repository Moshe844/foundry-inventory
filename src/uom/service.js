'use strict';

// Exact unit-of-measure definitions.  Ratios use integers so that, for
// example, 24 packs of 12 always becomes exactly 288 each — no floating point
// drift can leak into a stock movement or a bill.

const { inTransaction } = require('../db');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, requireText } = require('../lib/util');
const permissions = require('../actions/permissions');

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ValidationError(`${field} must be a positive whole number.`);
  }
  return number;
}

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function ratio(numerator, denominator) {
  const n = positiveInteger(numerator, 'Conversion numerator');
  const d = positiveInteger(denominator, 'Conversion denominator');
  const common = gcd(n, d);
  return { numerator: n / common, denominator: d / common };
}

function family(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM uom_families WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new NotFoundError('That unit family could not be found.');
  return row;
}

function unit(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM units_of_measure WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new NotFoundError('That unit of measure could not be found.');
  return row;
}

function createFamily(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_SUPPLIERS, 'define unit families');
  const name = requireText(input.name, 'Unit family name', { max: 80 });
  const now = nowIso(); const id = newId('uomfam');
  try {
    db.prepare('INSERT INTO uom_families (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(id, ctx.workspaceId, name, now);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ValidationError('That unit family already exists.');
    throw error;
  }
  return family(db, ctx.workspaceId, id);
}

function defineUnit(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_SUPPLIERS, 'define units of measure');
  const f = family(db, ctx.workspaceId, input.familyId);
  const name = requireText(input.name, 'Unit name', { max: 80 });
  const symbol = requireText(input.symbol || name, 'Unit symbol', { max: 24 });
  const r = ratio(input.baseNumerator ?? 1, input.baseDenominator ?? 1);
  const now = nowIso(); const id = newId('uom');
  try {
    db.prepare(`INSERT INTO units_of_measure
      (id, workspace_id, family_id, name, symbol, base_numerator, base_denominator, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, f.id, name, symbol, r.numerator, r.denominator, now);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ValidationError('That unit name or symbol already exists in this family.');
    throw error;
  }
  return unit(db, ctx.workspaceId, id);
}

function setSkuProfile(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_SUPPLIERS, 'set product units of measure');
  const sku = db.prepare('SELECT id FROM skus WHERE id = ? AND workspace_id = ?').get(input.skuId, ctx.workspaceId);
  if (!sku) throw new NotFoundError('That product variant could not be found.');
  const stocking = unit(db, ctx.workspaceId, input.stockingUomId);
  const selling = unit(db, ctx.workspaceId, input.sellingUomId || input.stockingUomId);
  if (stocking.family_id !== selling.family_id) throw new ValidationError('Stocking and selling units must belong to the same unit family.');
  const grams = input.unitWeightGrams === null || input.unitWeightGrams === undefined || input.unitWeightGrams === ''
    ? null : positiveInteger(input.unitWeightGrams, 'Unit weight in grams');
  const now = nowIso();
  db.prepare(`INSERT INTO sku_uom_profiles
    (sku_id, workspace_id, family_id, stocking_uom_id, selling_uom_id, unit_weight_grams, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sku_id) DO UPDATE SET family_id = excluded.family_id, stocking_uom_id = excluded.stocking_uom_id,
      selling_uom_id = excluded.selling_uom_id, unit_weight_grams = excluded.unit_weight_grams,
      source = excluded.source, updated_at = excluded.updated_at`)
    .run(sku.id, ctx.workspaceId, stocking.family_id, stocking.id, selling.id, grams,
      input.source || 'owner', now, now);
  return profile(db, ctx.workspaceId, sku.id);
}

function profile(db, workspaceId, skuId) {
  return db.prepare(`SELECT p.*, f.name AS family_name, stock.name AS stocking_uom_name,
      stock.symbol AS stocking_uom_symbol, sell.name AS selling_uom_name, sell.symbol AS selling_uom_symbol
    FROM sku_uom_profiles p JOIN uom_families f ON f.id = p.family_id
    JOIN units_of_measure stock ON stock.id = p.stocking_uom_id
    JOIN units_of_measure sell ON sell.id = p.selling_uom_id
    WHERE p.workspace_id = ? AND p.sku_id = ?`).get(workspaceId, skuId) || null;
}

function setSupplierMapping(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_SUPPLIERS, 'set supplier purchasing units');
  const supplierItem = db.prepare('SELECT * FROM supplier_items WHERE id = ? AND workspace_id = ?')
    .get(input.supplierItemId, ctx.workspaceId);
  if (!supplierItem) throw new NotFoundError('That supplier product could not be found.');
  const purchase = unit(db, ctx.workspaceId, input.purchaseUomId);
  const stocking = unit(db, ctx.workspaceId, input.stockingUomId);
  if (purchase.family_id !== stocking.family_id) throw new ValidationError('Supplier and stocking units must be compatible.');
  const r = ratio(input.stockingNumerator, input.stockingDenominator || 1);
  const now = nowIso(); const id = newId('suom');
  db.prepare(`INSERT INTO supplier_item_uom_mappings
    (id, workspace_id, supplier_item_id, purchase_uom_id, stocking_uom_id, stocking_numerator,
     stocking_denominator, source, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(supplier_item_id, purchase_uom_id) DO UPDATE SET stocking_uom_id = excluded.stocking_uom_id,
      stocking_numerator = excluded.stocking_numerator, stocking_denominator = excluded.stocking_denominator,
      source = excluded.source, active = 1, updated_at = excluded.updated_at`)
    .run(id, ctx.workspaceId, supplierItem.id, purchase.id, stocking.id, r.numerator, r.denominator,
      input.source || 'owner', now, now);
  return db.prepare(`SELECT * FROM supplier_item_uom_mappings
    WHERE supplier_item_id = ? AND purchase_uom_id = ?`).get(supplierItem.id, purchase.id);
}

function convert(db, workspaceId, input) {
  const from = unit(db, workspaceId, input.fromUomId);
  const to = unit(db, workspaceId, input.toUomId);
  if (from.family_id !== to.family_id) throw new ValidationError('Those units are not compatible.');
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) throw new ValidationError('Quantity must be a non-negative number.');
  const numerator = quantity * Number(from.base_numerator) * Number(to.base_denominator);
  const denominator = Number(from.base_denominator) * Number(to.base_numerator);
  const converted = numerator / denominator;
  if (!Number.isFinite(converted)) throw new ValidationError('That conversion is outside the supported range.');
  if (input.requireWhole && !Number.isInteger(converted)) {
    throw new ValidationError(`${quantity} ${from.symbol} cannot be represented as a whole number of ${to.symbol}.`);
  }
  return { quantity, fromUom: from, toUom: to, quantityConverted: converted };
}

module.exports = { createFamily, defineUnit, setSkuProfile, profile, setSupplierMapping, convert, ratio };
