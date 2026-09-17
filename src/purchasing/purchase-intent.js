'use strict';

/**
 * Turning "order 5 cases of Navy 8 from ABC Footwear" into a draft order.
 *
 * The model's part is the same as everywhere else in StockChief: it names things
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
const { inTransaction } = require('../db');

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
      clarification: {
        dimension: 'supplier',
        choices: contains.map((supplier) => ({ label: supplier.name, value: supplier.name })),
      },
    };
  }

  const close = resolver.closestMatch(query, all, (s) => s.name);
  if (close.ok) {
    return { ok: true, value: close.value, note: `You wrote “${query}” — StockChief took that as ${close.value.name}.` };
  }
  if (close.reason === 'ambiguous') {
    return {
      ok: false,
      reason: 'ambiguous',
      message: `“${query}” is close to ${close.candidates.map((s) => s.name).join(' and ')}. Which supplier?`,
      clarification: {
        dimension: 'supplier',
        choices: close.candidates.map((supplier) => ({ label: supplier.name, value: supplier.name })),
      },
    };
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
/*
 * One order from one sentence, however many products it names.
 *
 * Every line is resolved before anything is written — product, supplier,
 * pack size, quantity — and the first thing that cannot be resolved is the
 * question, with the line it belongs to named. Lines that resolve to
 * different suppliers are not one order: that is said, with the split, and
 * nothing is drafted. The draft records how many lines were asked for and
 * how many it carries, so a dropped line can never pass as a complete order.
 */
function buildMany(db, ctx, membership, lines, options = {}) {
  permissions.assertCan(membership, permissions.CREATE_PO, 'prepare purchase orders');
  if (!Array.isArray(lines) || !lines.length) return { ok: false, question: 'What would you like to order?' };
  if (lines.length === 1) return build(db, ctx, membership, lines[0], options);
  // All or nothing: a supplier link made for line 1 does not outlive a line 3
  // that could not be read.
  const stop = {};
  try {
    return inTransaction(db, () => {
      const out = buildManyInside(db, ctx, membership, lines, options);
      if (!out.ok) { stop.result = out; throw stop; }
      return out;
    });
  } catch (err) {
    if (err === stop) return stop.result;
    throw err;
  }
}

function buildManyInside(db, ctx, membership, lines, options) {
  const resolved = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const one = resolveLine(db, ctx, membership, line, { ...options, manyLines: true, selectedSkuId: options.selectedPurchaseLineIndex === index ? options.selectedSkuId : null });
    if (!one.ok) {
      const named = [line.quantity > 0 ? line.quantity : '', line.item, line.variant].filter(Boolean).join(' ');
      return { ...one, lineIndex: index,
        question: one.question ? `Line ${index + 1} of ${lines.length} (${named}): ${one.question}` : one.question,
        unsupported: one.unsupported ? `Line ${index + 1} of ${lines.length} (${named}): ${one.unsupported} Nothing was drafted.` : one.unsupported };
    }
    resolved.push(one);
  }
  const suppliers = [...new Map(resolved.map((r) => [r.supplier.id, r.supplier])).values()];
  if (suppliers.length > 1) {
    const split = suppliers.map((s) => `${resolved.filter((r) => r.supplier.id === s.id).map((r) => r.sku.item_name).join(', ')} from ${s.name}`).join('; ');
    return { ok: false, unsupported: `Those come from different suppliers — ${split} — and a purchase order goes to one supplier. Order them one supplier at a time, or write the order on the form. Nothing was drafted.` };
  }
  const supplier = suppliers[0];
  const assumptions = resolved.flatMap((r, i) => r.assumptions.map((a) => `Line ${i + 1}: ${a}`));
  const requested = Array.isArray(options.requestedLines) ? options.requestedLines : lines.map((l) => [l.quantity > 0 ? l.quantity : '', l.item, l.variant].filter(Boolean).join(' '));
  if (requested.length !== resolved.length) {
    return { ok: false, unsupported: `You asked for ${requested.length} lines and StockChief could only prepare ${resolved.length}, so it drafted nothing rather than an order with lines missing. Write each product on its own line, or use the order form.` };
  }
  assumptions.push(`${resolved.length} lines asked for, ${resolved.length} on the order: ${resolved.map((r) => `${r.purchaseUnits} ${r.supplierItem.purchase_unit}${r.purchaseUnits === 1 ? '' : 's'} of ${r.sku.item_name}${r.sku.variant_label ? ` / ${r.sku.variant_label}` : ''}`).join('; ')}.`);
  const order = poService.createOrder(db, ctx, membership, {
    supplierId: supplier.id,
    expectedDate: options.purchaseDetails?.expectedDate ?? resolved.find((r) => r.groundedDate)?.groundedDate ?? null,
    destinationLocationId: options.purchaseDetails?.destinationLocationId || null,
    notes: options.purchaseDetails?.notes ?? resolved.find((r) => r.groundedNotes)?.groundedNotes ?? null,
    source: 'instruction',
    sourceDetail: { instruction: options.instruction || null, assumptions, requestedLines: requested, preparedLines: resolved.length },
    lines: resolved.map((r) => ({ skuId: r.sku.id, quantityPurchaseUnits: r.purchaseUnits, unitCost: r.unitCost })),
  });
  return { ok: true, order, assumptions };
}

function build(db, ctx, membership, line, options = {}) {
  const one = resolveLine(db, ctx, membership, line, options);
  if (!one.ok) return one;
  const order = poService.createOrder(db, ctx, membership, {
    supplierId: one.supplier.id,
    expectedDate: options.purchaseDetails?.expectedDate ?? one.groundedDate,
    destinationLocationId: options.purchaseDetails?.destinationLocationId || null,
    notes: options.purchaseDetails?.notes ?? one.groundedNotes,
    source: 'instruction',
    sourceDetail: { instruction: options.instruction || null, assumptions: one.assumptions, requestedLines: [[line.quantity > 0 ? line.quantity : '', line.item, line.variant].filter(Boolean).join(' ')], preparedLines: 1 },
    lines: [{ skuId: one.sku.id, quantityPurchaseUnits: one.purchaseUnits, unitCost: one.unitCost }],
  });
  return { ok: true, order, assumptions: one.assumptions };
}

/** One line of an order, resolved but not written: product, supplier, pack size, quantity. */
function resolveLine(db, ctx, membership, line, options = {}) {
  permissions.assertCan(membership, permissions.CREATE_PO, 'prepare purchase orders');
  const source = String(options.instruction || '');
  const date = String(line.purchaseExpectedDate || '');
  const groundedDate = line.purchaseDateSource && source.includes(line.purchaseDateSource)
    && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date ? date : null;
  const groundedNotes = line.deliveryInstructions && source.includes(line.deliveryInstructions) ? line.deliveryInstructions : null;

  // A SKU selected from StockChief's own clarification buttons is already a
  // deterministic record choice. Do not feed that choice back through the
  // language resolver: the original wording may have been deliberately vague
  // ("shoes"), and grounding against it would discard the exact selection and
  // ask the owner to choose the variant a second time.
  const selectedSku = options.selectedSkuId
    ? db.prepare(
        `SELECT s.*, i.name AS item_name, i.tracking_mode, i.unit_label, i.has_variants
           FROM skus s JOIN items i ON i.id = s.item_id
          WHERE s.workspace_id = ? AND s.id = ? AND s.is_active = 1 AND i.is_active = 1`
      ).get(ctx.workspaceId, options.selectedSkuId)
    : null;
  if (options.selectedSkuId && !selectedSku) {
    throw new ValidationError('That product choice is no longer available. Please choose again.');
  }
  const sku = selectedSku
    ? { ok: true, value: selectedSku }
    : resolver.resolveSku(db, ctx.workspaceId, line.item, line.variant, {
        instruction: options.instruction,
      });
  if (!sku.ok) {
    // Purchasing may introduce a catalogue record. Missing identity is not
    // permission to substitute an existing SKU, nor evidence of stock on hand.
    if (sku.missingSkuCode) {
      const existing = db.prepare('SELECT id FROM skus WHERE workspace_id = ? AND code = ? COLLATE NOCASE')
        .get(ctx.workspaceId, sku.missingSkuCode);
      if (existing) return { ok: false, question: `SKU ${sku.missingSkuCode} already exists but is inactive. Review that record before ordering it; StockChief will not create a duplicate.` };
      return { ok: false,
        question: `SKU ${sku.missingSkuCode} is new. Review its product details here, then continue to your draft purchase order. Buying it does not put it in stock.`,
        newProduct: { code: sku.missingSkuCode, name: String(line.productName || line.item || '').trim(),
          unitLabel: String(line.unitLabel || '').trim(), supplier: String(line.supplier || '').trim(),
          quantity: line.quantity, unitCost: statedUnitCost(options.instruction), notes: groundedNotes || '', expectedDate: groundedDate,
          trackingMode: line.trackingSource && source.includes(line.trackingSource) ? line.trackingMode : '' } };
    }
    const rows = ['not_found', 'not_understood'].includes(sku.reason)
      ? db.prepare(
          `SELECT s.id, i.name AS item_name, s.variant_label, s.code
             FROM skus s JOIN items i ON i.id = s.item_id
            WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
            ORDER BY i.name, s.position LIMIT 13`
        ).all(ctx.workspaceId)
      : [];
    if (rows.length > 0 && rows.length <= 12) {
      const namedSupplier = String(line.supplier || '').trim();
      const genericSupplier = /^(?:our|my|the|a|a regular|regular|usual|default)\s+supplier$/i.test(namedSupplier);
      const supplierResult = namedSupplier && !genericSupplier
        ? resolveSupplier(db, ctx.workspaceId, namedSupplier)
        : null;
      const supplierCreationName = supplierResult
        && !supplierResult.ok
        && ['none_exist', 'not_found'].includes(supplierResult.reason)
        ? namedSupplier
        : null;
      const productChoices = rows.map((row) => ({
        value: `__purchase_sku__:${row.id}`,
        label: `${row.item_name}${row.variant_label ? ` — ${row.variant_label}` : ''}`,
        skuId: row.id,
        item: row.item_name,
        variant: row.variant_label || '',
      }));
      return {
        ok: false,
        question: supplierCreationName
          ? options.previewOnly
            ? `${supplierCreationName} is not in your suppliers yet. Choose the product below to add this supplier and prepare a draft for review. This does not approve or send the order.`
            : `${supplierCreationName} is not in your suppliers yet. Choose the product below to add this supplier and approve the purchase order in one step.`
          : `Which product should be on this purchase order? StockChief could not safely match “${line.item || line.variant}”.`,
        choices: productChoices.map(({ label, value }) => ({ label, value })),
        missingProduct: { choices: productChoices, supplierCreationName },
      };
    }
    return {
      ok: false,
      question: sku.message,
      clarification: sku.clarification || null,
      choices: sku.clarification ? sku.clarification.choices : null,
    };
  }

  const assumptions = [];
  if (sku.note) assumptions.push(sku.note);

  // Which supplier: the one they named, or — when they did not — the one
  // StockChief would choose anyway, said out loud.
  let supplier;
  if (line.supplier) {
    const found = resolveSupplier(db, ctx.workspaceId, line.supplier);
    if (!found.ok) {
      if (['none_exist', 'not_found'].includes(found.reason)) {
        if (/^(?:our|my|the|a|a regular|regular|usual|default)\s+supplier$/i.test(String(line.supplier).trim())) {
          return { ok: false, question: `Which supplier should provide ${sku.value.item_name}?` };
        }
        if (String(options.confirmedSupplierCreationName || '').trim().toLowerCase()
            !== String(line.supplier).trim().toLowerCase()) {
          return {
            ok: false,
            question: options.previewOnly
              ? `${line.supplier} is not in your suppliers yet. Add it so StockChief can prepare a draft purchase order for review?`
              : `${line.supplier} is not in your suppliers yet. Add it and approve this purchase order?`,
            choices: [{
              label: options.previewOnly ? `Add ${line.supplier} and prepare draft` : `Add ${line.supplier} and approve order`,
              value: '__create_purchase_supplier__',
            }],
            missingSupplier: { name: line.supplier, skuId: sku.value.id },
          };
        }
        supplier = supplierService.createSupplier(db, ctx, membership, { name: line.supplier });
        assumptions.push(`${supplier.name} was added after you confirmed it was a new supplier.`);
      } else {
        return {
          ok: false,
          question: found.message,
          clarification: found.clarification || null,
          choices: found.clarification ? found.clarification.choices : null,
        };
      }
    } else {
      supplier = found.value;
      if (found.note) assumptions.push(found.note);
    }
  } else {
    const options_ = supplierService.suppliersForSku(db, ctx.workspaceId, sku.value.id);
    if (options_.length === 0) {
      return {
        ok: false,
        unsupported: `No supplier is on file for ${sku.value.item_name}. Add one, then StockChief can order it.`,
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

  let supplierItem = db
    .prepare('SELECT * FROM supplier_items WHERE workspace_id = ? AND supplier_id = ? AND sku_id = ? AND is_active = 1')
    .get(ctx.workspaceId, supplier.id, sku.value.id);
  if (!supplierItem) {
    const statedPurchaseUnit = String(line.purchaseUnit || '').trim().toLowerCase();
    if (statedPurchaseUnit && !['unit', 'units', 'item', 'items', 'each'].includes(statedPurchaseUnit)) {
      return {
        ok: false,
        question: `How many inventory units are in one ${line.purchaseUnit} from ${supplier.name}?`,
      };
    }
    supplierService.linkItem(db, ctx, membership, {
      supplierId: supplier.id,
      skuId: sku.value.id,
      purchaseUnit: 'unit',
      unitsPerPurchaseUnit: 1,
      lastUnitCost: statedUnitCost(options.instruction),
    });
    supplierItem = db
      .prepare('SELECT * FROM supplier_items WHERE workspace_id = ? AND supplier_id = ? AND sku_id = ? AND is_active = 1')
      .get(ctx.workspaceId, supplier.id, sku.value.id);
    assumptions.push(`${supplier.name} was linked to ${sku.value.item_name} from your request; no supplier SKU or pack size was invented.`);
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
        clarification: { dimension: 'quantity', choices: [] },
      };
    }
    purchaseUnits = recommendation.quantityPurchaseUnits;
    assumptions.push(`${recommendation.explanation} StockChief sized this from that.`);
  }

  if (!Number.isFinite(purchaseUnits) || purchaseUnits <= 0) {
    return {
      ok: false,
      question: `How many ${supplierItem.purchase_unit}s would you like to order?`,
      clarification: { dimension: 'quantity', choices: [] },
    };
  }

  return { ok: true, sku: sku.value, supplier, supplierItem, purchaseUnits, assumptions, groundedDate, groundedNotes,
    // A cost stated on the line itself wins; a cost stated once in the sentence
    // belongs to a one-line order only, never to every line of a list.
    unitCost: options.purchaseDetails?.unitCost ?? (line.unitCostMinor >= 0 ? line.unitCostMinor / 100 : options.manyLines ? undefined : statedUnitCost(options.instruction)) };
}

/** A price is a business fact only when the owner wrote an explicit amount. */
function statedUnitCost(instruction) {
  const text = String(instruction || '');
  const match = /(?:USD\s*)?\$\s*(\d[\d,]*(?:\.\d{1,4})?)\s*(?:each|apiece|per\s+(?:unit|item|piece|shoe|pair))\b/i.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

/** Did they say "cases" (the supplier's unit) or a bare number of items? */
function looksLikePurchaseUnit(said, purchaseUnit) {
  const text = String(said || '').trim().toLowerCase();
  if (!text) return false;
  const unit = String(purchaseUnit || '').trim().toLowerCase();
  if (!unit || unit === 'unit') return false;
  return text === unit || text === `${unit}s` || unit.startsWith(text) || text.startsWith(unit);
}

module.exports = { build, buildMany, resolveLine, resolveSupplier, looksLikePurchaseUnit, statedUnitCost };
