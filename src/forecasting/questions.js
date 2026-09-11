'use strict';

/**
 * The planning questions, answered.
 *
 * "What am I likely to run out of?" "Should I order anything this week?" "Are
 * my reorder settings still any good?" These arrive through Tell Foundry as
 * ordinary English and are routed here by the same deterministic planner that
 * handles every other question — no model decides what the answer is, only
 * which question was asked.
 *
 * Every answer is built from the same modules the recommendations are built
 * from. That is not a tidiness preference: an assistant that answers "what
 * should I order" differently from the order it recommended on the purchasing
 * page has two brains, and the owner has no way to know which one is talking.
 * So there is one brain, and this is a different set of words for it.
 *
 * Each executor returns `{ rows, columns, answer, handoff? }`, matching every
 * other query executor, so the chat surface needs to know nothing about
 * forecasting to render one.
 */

const money = (minor, currency = 'USD') =>
  `${currency === 'USD' ? '$' : `${currency} `}${(Number(minor || 0) / 100).toFixed(2)}`;

function planning() { return require('./planning-service'); }

/** Finds the product somebody named, without guessing between two of them. */
function findSku(db, workspaceId, query) {
  const like = `%${String(query).trim()}%`;
  return db.prepare(`SELECT s.id, s.variant_label, i.name AS item_name
    FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.workspace_id = ? AND s.is_active = 1
      AND (i.name LIKE ? OR s.code LIKE ? OR s.variant_label LIKE ?)
    ORDER BY LENGTH(i.name) LIMIT 1`).get(workspaceId, like, like, like) || null;
}

const EXECUTORS = {
  /** What demand is Foundry expecting over the requested future period? */
  demand_forecast(db, workspaceId, plan = {}) {
    const horizonDays = Math.max(1, Math.min(Number(plan.windowDays || 30), 365));
    const skuIds = db.prepare(`SELECT s.id FROM skus s
      WHERE s.workspace_id = ? AND s.is_active = 1
      ORDER BY s.created_at LIMIT 400`).all(workspaceId).map((row) => row.id);
    const rows = [];
    for (const skuId of skuIds) {
      let view;
      try { view = planning().forSku(db, workspaceId, skuId, { horizonDays }); } catch { view = null; }
      if (!view) continue;
      rows.push({
        product: view.sku.displayName,
        expectedUnits: view.forecast.dailyRate === null
          ? view.forecast.committedUnits || 0
          : Math.round(view.forecast.dailyRate * horizonDays),
        days: horizonDays,
        dailyRate: view.forecast.dailyRate === null ? '—' : view.forecast.dailyRate,
        confidence: view.forecast.confidence,
        evidence: view.forecast.confidenceReasons.join('; '),
      });
    }
    rows.sort((a, b) => b.expectedUnits - a.expectedUnits);
    const measurable = rows.filter((row) => row.dailyRate !== '—');
    return {
      rows: rows.slice(0, 25),
      columns: ['product', 'expectedUnits', 'days', 'dailyRate', 'confidence', 'evidence'],
      handoff: { href: '/planning', label: 'Open Planning and forecasts' },
      answer: !rows.length
        ? 'There are no active products to forecast yet.'
        : !measurable.length
          ? `Foundry checked ${rows.length} product${rows.length === 1 ? '' : 's'}, but none has enough recorded demand history for a sales-rate forecast. Known customer commitments are shown instead.`
          : `Foundry can estimate demand for ${measurable.length} product${measurable.length === 1 ? '' : 's'} over the next ${horizonDays} days. ${measurable[0].product} is highest at about ${measurable[0].expectedUnits} units, with ${measurable[0].confidence} confidence.`,
    };
  },
  /**
   * What is out of stock right now, and what is about to be.
   *
   * Added because a question about stock reached the model, and the model
   * routed it to connection diagnostics — so somebody asking why their shelves
   * looked empty was told "No matching connection is configured." Twice. The
   * deterministic layer exists precisely so that the obvious questions never
   * depend on a guess, and this was an obvious question with no rule behind it.
   */
  out_of_stock(db, workspaceId) {
    const empty = db.prepare(`SELECT i.name AS item_name, s.variant_label, s.id AS sku_id,
        l.name AS location_name
      FROM balances b
      JOIN skus s ON s.id = b.sku_id
      JOIN items i ON i.id = s.item_id
      JOIN locations l ON l.id = b.location_id
      WHERE b.workspace_id = ? AND b.on_hand <= 0 AND s.is_active = 1 AND l.is_active = 1
      ORDER BY i.name, s.position`).all(workspaceId);

    const held = db.prepare(`SELECT COALESCE(SUM(b.on_hand), 0) AS units,
        COUNT(DISTINCT b.sku_id) AS positions
      FROM balances b JOIN skus s ON s.id = b.sku_id
      WHERE b.workspace_id = ? AND s.is_active = 1`).get(workspaceId);

    const incoming = require("../purchasing/position").onOrderBySku(db, workspaceId);

    const rows = empty.map((row) => {
      const onOrder = incoming.get(row.sku_id);
      return {
        product: row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name,
        location: row.location_name,
        onTheWay: onOrder && onOrder.onOrder ? `${onOrder.onOrder} due${onOrder.nextExpectedDate ? ' ' + onOrder.nextExpectedDate : ''}` : 'nothing ordered',
      };
    });

    /*
     * The "nothing is empty" answer matters as much as the list. Somebody asks
     * this because a screen looked wrong to them, and the useful reply is the
     * count they can check rather than a bare denial.
     */
    return {
      rows,
      columns: ['product', 'location', 'onTheWay'],
      answer: rows.length
        ? `${rows.length} product/location position${rows.length === 1 ? ' is' : 's are'} at zero. `
          + `Everything else adds up to ${held.units} units across ${held.positions} products.`
        : `Nothing is out of stock. Foundry counts ${held.units} units across ${held.positions} `
          + 'products right now. If a screen is showing empty, it is either filtered, or it is a '
          + 'different inventory to the one this question was asked in.',
    };
  },
  /** What am I likely to run out of? */
  likely_stockouts(db, workspaceId) {
    const result = planning().sweep(db, workspaceId, { limit: 10 });
    const rows = result.shortages.map((row) => ({
      product: row.displayName,
      runsOut: row.stockoutDate,
      inDays: row.daysUntilStockout,
      alreadyCovered: row.coveredByIncoming ? 'yes, an order is on its way' : 'no',
      confidence: row.confidence,
    }));
    const exposed = result.shortages.filter((row) => !row.coveredByIncoming);
    return {
      rows,
      columns: ['product', 'runsOut', 'inDays', 'alreadyCovered', 'confidence'],
      handoff: exposed.length ? { href: '/needs-you', label: 'Open Needs you' } : null,
      answer: !rows.length
        ? 'Nothing Foundry can measure a sales rate for is heading for zero inside the period it can see.'
        : exposed.length
          ? `${exposed[0].displayName} is the nearest problem. ${exposed[0].explanation}`
          : `${rows[0].product} runs low around ${rows[0].runsOut}, and an order already placed covers it.`,
    };
  },

  /** What should I order this week? */
  what_to_order(db, workspaceId) {
    // Purchasing's actionable reorder calculation is the source of truth for
    // this question. The forward-looking planner remains responsible for
    // forecasts and risk, but must not quote a different buy quantity from the
    // one the Purchasing page will actually prepare.
    const result = require('../purchasing/replenishment').evaluateWorkspace(db, workspaceId);
    const rows = result.recommendations.slice(0, 10).map((row) => ({
      product: row.displayName,
      quantity: row.quantityUnits,
      supplier: row.supplier ? row.supplier.supplierName : '',
      orderBy: 'now',
      cost: row.estimatedCost === null || row.estimatedCost === undefined
        ? '—' : money(Math.round(row.estimatedCost * 100), row.supplier && row.supplier.currency),
    }));
    const blocked = result.blocked.filter((row) => row.reason === 'no_supplier');
    return {
      rows,
      columns: ['product', 'quantity', 'supplier', 'orderBy', 'cost'],
      handoff: rows.length ? { href: '/purchasing', label: 'Open Purchasing' } : null,
      // "Nothing" is a real answer here and gets a real explanation, because an
      // assistant that only ever speaks up to spend money is not advising you.
      answer: rows.length
        ? `${rows.length} line${rows.length === 1 ? '' : 's'} need ordering. ${result.recommendations[0].explanation}`
        : blocked.length
          ? `${blocked.length} line${blocked.length === 1 ? '' : 's'} need ordering, but no supplier is linked yet. ${blocked[0].headline}.`
          : 'Nothing needs ordering right now. Everything Foundry can measure is covered either by stock on hand or by an order already placed.',
    };
  },

  /** Are we overstocked on anything? */
  overstocked(db, workspaceId) {
    const review = planning().excessReview(db, workspaceId);
    const rows = review.rows.slice(0, 15).map((row) => ({
      product: row.displayName,
      problem: row.label,
      onHand: row.onHand,
      daysOfSupply: row.daysOfSupply === null ? '—' : Math.round(row.daysOfSupply),
      tiedUp: row.excessValueMinor > 0 ? money(row.excessValueMinor, row.currency) : '—',
      whatToDo: row.recommendation,
    }));
    return {
      rows,
      columns: ['product', 'problem', 'onHand', 'daysOfSupply', 'tiedUp', 'whatToDo'],
      answer: review.headline,
    };
  },

  /** Can we reduce inventory without risking stockouts? */
  reduce_inventory(db, workspaceId) {
    const review = planning().excessReview(db, workspaceId);
    const result = planning().sweep(db, workspaceId, { limit: 25 });
    /*
     * Only the changes that free money without lowering protection. A target
     * is how much is bought when a line is reordered; the reorder point is when
     * it is reordered. Lowering the first holds less stock, and leaves the
     * second — the thing that actually prevents a stockout — untouched.
     */
    const safe = result.policyChanges
      .filter((row) => row.kind === 'target_stock' && row.direction === 'decrease');
    const rows = safe.map((row) => ({
      product: row.displayName,
      currentTarget: row.current,
      suggestedTarget: row.recommended,
      why: row.why,
    }));
    return {
      rows,
      columns: ['product', 'currentTarget', 'suggestedTarget', 'why'],
      answer: rows.length
        ? `Yes — ${rows.length} stock target${rows.length === 1 ? ' is' : 's are'} higher than the `
          + 'current pace of sales needs. Lowering them leaves every reorder point where it is, so the '
          + `protection against running out does not change. ${review.headline}`
        : 'Foundry cannot find stock it could release without lowering the protection against running '
          + `out. ${review.headline}`,
    };
  },

  /** Which supplier is most reliable? */
  most_reliable_supplier(db, workspaceId) {
    const suppliers = db.prepare(`SELECT id FROM suppliers
      WHERE workspace_id = ? AND status = 'active'`).all(workspaceId);
    const scored = suppliers
      .map((row) => planning().supplierView(db, workspaceId, row.id))
      .filter(Boolean);

    const rows = scored.map((row) => ({
      supplier: row.supplierName,
      deliveredOrders: row.orderCount,
      onTime: row.onTimeRate === null ? '—' : `${row.onTimeRate}%`,
      averageDays: row.timing.measured ? row.timing.measured.meanDays : '—',
      allArrived: row.fillRate === null ? '—' : `${row.fillRate}%`,
    }));

    const rated = scored.filter((row) => row.enoughEvidence && row.onTimeRate !== null);
    rated.sort((a, b) => b.onTimeRate - a.onTimeRate);
    return {
      rows,
      columns: ['supplier', 'deliveredOrders', 'onTime', 'averageDays', 'allArrived'],
      answer: rated.length
        ? rated[0].summary
        : 'No supplier has enough delivered orders on record for Foundry to say which is most reliable. '
          + 'It will not rank them on one or two deliveries.',
    };
  },

  /** Are my current reorder settings still good? */
  reorder_settings_review(db, workspaceId) {
    const result = planning().sweep(db, workspaceId, { limit: 25 });
    const label = { reorder_point: 'Reorder point', target_stock: 'Stock target', safety_stock: 'Safety stock' };
    const rows = result.policyChanges.map((row) => ({
      product: row.displayName,
      setting: label[row.kind] || row.kind,
      current: row.current,
      suggested: row.recommended,
      why: row.why,
    }));
    return {
      rows,
      columns: ['product', 'setting', 'current', 'suggested', 'why'],
      handoff: rows.length ? { href: '/needs-you', label: 'Open Needs you' } : null,
      answer: rows.length
        ? `${rows.length} setting${rows.length === 1 ? '' : 's'} no longer match what Foundry measures. `
          + result.policyChanges[0].why
        : 'Your reorder settings still match the demand and delivery times Foundry measures.',
    };
  },

  /** Why do you think X demand is increasing? */
  demand_explanation(db, workspaceId, plan) {
    const forecast = require('./forecast');
    const sku = plan && plan.entityQuery ? findSku(db, workspaceId, plan.entityQuery) : null;
    if (!sku) {
      return { rows: [], columns: [],
        answer: 'Foundry needs to know which product you mean before it can explain its demand.' };
    }
    const view = planning().forSku(db, workspaceId, sku.id, {});
    if (!view) return { rows: [], columns: [], answer: 'That product could not be read.' };

    const rows = view.forecast.calculation.map((step) => ({ step: step.step, working: step.detail }));
    const shift = view.anomalies.find((row) => row.kind === 'demand_spike' || row.kind === 'demand_collapse');
    return {
      rows,
      columns: ['step', 'working'],
      answer: `${forecast.summarise(view.forecast, view.sku.displayName)} `
        + (shift ? `${shift.detail} ` : '')
        + `${view.forecast.confidenceLabel}: ${view.forecast.confidenceReasons.join('; ')}.`,
    };
  },

  /** How much stock should Downtown keep? */
  location_stock_advice(db, workspaceId, plan) {
    const rebalance = require('./rebalance');
    const moves = rebalance.sweep(db, workspaceId, {});
    const wanted = plan && plan.entityQuery ? String(plan.entityQuery).trim().toLowerCase() : null;
    const filtered = wanted
      ? moves.filter((row) => row.toLocationName.toLowerCase().includes(wanted)
        || row.fromLocationName.toLowerCase().includes(wanted))
      : moves;
    const rows = filtered.map((row) => ({
      product: row.displayName,
      units: row.units,
      from: row.fromLocationName,
      to: row.toLocationName,
      because: `${row.toLocationName} has ${Math.round(row.destinationDaysOfCover)} days of cover left`,
    }));
    return {
      rows,
      columns: ['product', 'units', 'from', 'to', 'because'],
      answer: rows.length
        ? filtered[0].why
        : 'Foundry cannot see a location that is short of stock another location can spare.',
    };
  },
};

module.exports = { EXECUTORS, INTENTS: Object.keys(EXECUTORS), findSku };
