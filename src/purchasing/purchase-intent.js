'use strict';

/**
 * Turning "order 5 cases of Navy 8 from ABC Footwear" into a draft order.
 *
 * The model's part is the same as everywhere else in Foundry: it names things
 * in the person's words. It does not choose a supplier record, a SKU, a pack
 * size or a price — those are resolved here against this workspace's own data,
 * and an ambiguous name becomes a question rather than a guess.
 *
 * What comes out is a DRAFT purchase order. Nothing has been committed to and
 * no supplier has been contacted; the person reviews it and approves, exactly
 * as they would a stock movement in Mission 4.
 */

const resolver = require('../actions/resolver');
const permissions = require('../actions/permissions');
const supplierService = require('./supplier-service');
const poService = require('./po-service');
const replenishment = require('./replenishment');
const { ValidationError } = require('../domain/errors');

/** Finds the supplier a person named, tolerating spelling as elsewhere. */
function resolveSupplier(db, workspaceId, text) {
  const query = String(text || '').trim();
  if (!query) return { ok: false, reason: 'not_named' };

  const all = supplierService.listSuppliers(db, workspaceId, { includeInactive: true });
  if (all.length === 0) {
    return { ok: false, reason: 'none_exist', message: 'There are no suppliers in this inventory yet.' };
  }

  const exact = all.find((s) => s.name.toLowerCase() === query.toLowerCase());
  if (exact) return { ok: true, value: exact };

  const contains = all.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()));
  if (contains.length === 1) return { ok: true, value: contains[0] };
  if (contains.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `“${query}” could be ${contains.map((s) => s.name).join(' or ')}. Which supplier?`,
    };
  }

  const close = resolver.closestMatch(query, all, (s) => s.name);
  if (close.ok) {
    return { ok: true, value: close.value, note: `You wrote “${query}” — Foundry took that as ${close.value.name}.` };
  }
  return {
    ok: false,
    reason: 'not_found',
    message: `There is no supplier called “${query}”. You have ${all.map((s) => s.name).join(', ')}.`,
  };
}

/**
 * Builds a draft order from one instruction.
 *
 * @returns {{ok: true, order}|{ok: false, question}|{ok: false, unsupported}}
 */
function build(db, ctx, membership, line, options = {}) {
  permissions.assertCan(membership, permissions.CREATE_PO, 'prepare purchase orders');

  const sku = resolver.resolveSku(db, ctx.workspaceId, line.item, line.variant);
  if (!sku.ok) return { ok: false, question: sku.message };

  const assumptions = [];
  if (sku.note) assumptions.push(sku.note);

  // Which supplier: the one they named, or — when they did not — the one
  // Foundry would choose anyway, said out loud.
  let supplier;
  if (line.supplier) {
    const found = resolveSupplier(db, ctx.workspaceId, line.supplier);
    if (!found.ok) {
      return found.reason === 'none_exist'
        ? { ok: false, unsupported: `${found.message} Add one before ordering.` }
        : { ok: false, question: found.message };
    }
    supplier = found.value;
    if (found.note) assumptions.push(found.note);
  } else {
    const options_ = supplierService.suppliersForSku(db, ctx.workspaceId, sku.value.id);
    if (options_.length === 0) {
      return {
        ok: false,
        unsupported: `No supplier is on file for ${sku.value.item_name}. Add one, then Foundry can order it.`,
      };
    }
    const signals = require('../signals/signal-engine').skuSignals(db, ctx.workspaceId, {
      skuIds: [sku.value.id],
    })[0];
    const chosen = replenishment.chooseSupplier(options_, {
      daysOfStockRemaining: signals ? signals.estimated.daysOfStockRemaining : null,
    });
    supplier = supplierService.getSupplier(db, ctx.workspaceId, chosen.supplierItem.supplierId);
    assumptions.push(`${chosen.because}.`);
  }

  const supplierItem = db
    .prepare('SELECT * FROM supplier_items WHERE workspace_id = ? AND supplier_id = ? AND sku_id = ? AND is_active = 1')
    .get(ctx.workspaceId, supplier.id, sku.value.id);
  if (!supplierItem) {
    return {
      ok: false,
      unsupported:
        `${supplier.name} is not on file as a supplier for ${sku.value.item_name}. ` +
        'Link the product to them first, so Foundry knows the pack size and price.',
    };
  }

  // How much. A quantity in the supplier's own units ("5 cases") is taken as
  // given; a quantity in inventory units is converted up to whole packs.
  const saidPacks = looksLikePurchaseUnit(line.purchaseUnit, supplierItem.purchase_unit);
  const quantity = Number(line.quantity);
  let purchaseUnits;

  if (Number.isFinite(quantity) && quantity > 0) {
    if (saidPacks) {
      purchaseUnits = Math.trunc(quantity);
    } else {
      const converted = supplierService.toPurchaseUnits(
        quantity,
        supplierService.hydrateSupplierItem({ ...supplierItem, supplier_name: supplier.name })
      );
      purchaseUnits = converted.purchaseUnits;
      if (converted.units !== quantity) {
        assumptions.push(
          `${quantity} rounds up to ${converted.purchaseUnits} ${supplierItem.purchase_unit}(s) — ${converted.units} units.`
        );
      }
    }
  } else {
    // No number given: use what the replenishment engine would recommend, which
    // is a real calculation the person can inspect rather than a default.
    const recommendation = replenishment.evaluateOne(db, ctx.workspaceId, sku.value.id);
    if (!recommendation || !recommendation.recommend) {
      return {
        ok: false,
        question:
          recommendation && recommendation.reason === 'covered_by_incoming'
            ? `${recommendation.explanation} How many would you like to order anyway?`
            : 'How many would you like to order?',
      };
    }
    purchaseUnits = recommendation.quantityPurchaseUnits;
    assumptions.push(`${recommendation.explanation} Foundry sized this from that.`);
  }

  if (!Number.isFinite(purchaseUnits) || purchaseUnits <= 0) {
    return { ok: false, question: `How many ${supplierItem.purchase_unit}s would you like to order?` };
  }

  const order = poService.createOrder(db, ctx, membership, {
    supplierId: supplier.id,
    source: 'instruction',
    sourceDetail: { instruction: options.instruction || null, assumptions },
    lines: [{ skuId: sku.value.id, quantityPurchaseUnits: purchaseUnits }],
  });

  return { ok: true, order, assumptions };
}

/** Did they say "cases" (the supplier's unit) or a bare number of items? */
function looksLikePurchaseUnit(said, purchaseUnit) {
  const text = String(said || '').trim().toLowerCase();
  if (!text) return false;
  const unit = String(purchaseUnit || '').trim().toLowerCase();
  if (!unit || unit === 'unit') return false;
  return text === unit || text === `${unit}s` || unit.startsWith(text) || text.startsWith(unit);
}

module.exports = { build, resolveSupplier, looksLikePurchaseUnit };
