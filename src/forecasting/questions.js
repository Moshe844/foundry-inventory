'use strict';

/**
 * The planning questions, answered.
 *
 * "What am I likely to run out of?" "Should I order anything this week?" "Are
 * my reorder settings still any good?" These arrive through Tell StockChief as
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
  /**
   * Products which exist in the catalogue but have never had a stock movement.
   *
   * This deliberately matches the inventory list's "None yet" status. A
   * missing balance row is not the same thing as a zero balance: it means no
   * stock has ever been recorded, so a balance-only query silently loses the
   * very products the owner is asking about.
   */
  never_stocked(db, workspaceId) {
    const rows = db.prepare(`SELECT i.id AS item_id, i.name AS product,
        COUNT(DISTINCT s.id) AS tracked_variants,
        GROUP_CONCAT(DISTINCT s.code) AS sku_codes
      FROM items i
      JOIN skus s ON s.item_id = i.id AND s.is_active = 1
      WHERE i.workspace_id = ? AND i.is_active = 1
        AND NOT EXISTS (
          SELECT 1 FROM movements m
          WHERE m.workspace_id = i.workspace_id AND m.item_id = i.id
        )
      GROUP BY i.id, i.name
      ORDER BY i.name`).all(workspaceId).map((row) => ({
      product: row.product,
      skus: Number(row.tracked_variants) === 1 ? row.sku_codes : `${row.tracked_variants} variants`,
      status: 'None yet — no stock movement has been recorded',
    }));

    return {
      rows,
      columns: ['product', 'skus', 'status'],
      handoff: { href: '/inventory/table', label: 'Open inventory' },
      answer: rows.length
        ? `${rows.length} product${rows.length === 1 ? ' shows' : 's show'} “None yet” because no stock has ever been recorded for ${rows.length === 1 ? 'it' : 'them'}: ${rows.map((row) => row.product).join(', ')}.`
        : 'None. Every product has had stock recorded at some point, so nothing is showing “None yet”.',
    };
  },

  /** What demand is StockChief expecting over the requested future period? */
  demand_forecast(db, workspaceId, plan = {}) {
    const horizonDays = Math.max(1, Math.min(Number(plan.windowDays || 30), 365));
    /*
     * A named product is the question. "Do we have enough gloves for the
     * winter?" was forecast across the whole inventory and answered about
     * Copper Elbow, the busiest product, with gloves nowhere in the sentence.
     * When the person named something, the forecast is for that, and the
     * answer puts what they hold beside what they are expected to sell —
     * which is what "enough" asks.
     */
    const scoped = plan.entityQuery
      ? require('../attention/query-service').resolveSkus(db, workspaceId, plan.entityQuery, 400)
      : null;
    if (plan.entityQuery && (!scoped || !scoped.length)) {
      return { rows: [], columns: ['product', 'expectedUnits', 'days'], answer: `StockChief could not find a product matching “${plan.entityQuery}” to forecast.` };
    }
    const skuIds = scoped ? scoped.map((s) => s.id) : db.prepare(`SELECT s.id FROM skus s
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
    if (scoped) {
      const onHand = db.prepare(`SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ? AND sku_id IN (${skuIds.map(() => '?').join(',')})`)
        .get(workspaceId, ...skuIds).n;
      const expected = rows.reduce((n, row) => n + Number(row.expectedUnits || 0), 0);
      const label = scoped.length === 1 ? rows[0] ? rows[0].product : plan.entityQuery : `${plan.entityQuery} (${scoped.length} variants)`;
      const months = Math.round(horizonDays / 30);
      const span = months >= 2 ? `${months} months` : `${horizonDays} days`;
      const verdict = !measurable.length
        ? `${label}: ${onHand} on hand. None of ${scoped.length === 1 ? 'it' : 'these'} has sold often enough yet for StockChief to predict demand, so it cannot say whether that is enough.`
        : `${label}: ${onHand} on hand, and StockChief expects about ${expected} to sell over the next ${span} — ${onHand >= expected ? `enough, with about ${onHand - expected} to spare` : `about ${expected - onHand} short`} (${measurable[0].confidence} confidence, from recent sales).`;
      return { rows: rows.slice(0, 25), columns: ['product', 'expectedUnits', 'days', 'dailyRate', 'confidence', 'evidence'],
        handoff: { href: '/planning', label: 'Open Planning and forecasts' }, answer: verdict };
    }
    return {
      rows: rows.slice(0, 25),
      columns: ['product', 'expectedUnits', 'days', 'dailyRate', 'confidence', 'evidence'],
      handoff: { href: '/planning', label: 'Open Planning and forecasts' },
      answer: !rows.length
        ? 'There are no active products to forecast yet. Add products and record some sales first.'
        : !measurable.length
          ? `None of your ${rows.length} product${rows.length === 1 ? '' : 's'} has sold often enough yet for StockChief to predict demand. What customers have already ordered is listed instead — that part is certain.`
          : `Over the next ${horizonDays} days StockChief expects the most demand for ${measurable[0].product}: about ${measurable[0].expectedUnits} units (${measurable[0].confidence} confidence). It can predict ${measurable.length} of your ${rows.length} product${rows.length === 1 ? '' : 's'}; the rest have not sold enough yet to say.`,
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
    const empty = db.prepare(`SELECT i.id AS item_id, i.name AS product,
        COUNT(DISTINCT s.id) AS tracked_variants,
        COALESCE(SUM(b.on_hand), 0) AS on_hand
      FROM items i
      JOIN skus s ON s.item_id = i.id AND s.is_active = 1
      LEFT JOIN balances b ON b.sku_id = s.id AND b.workspace_id = i.workspace_id
      WHERE i.workspace_id = ? AND i.is_active = 1
        AND EXISTS (
          SELECT 1 FROM movements m
          WHERE m.workspace_id = i.workspace_id AND m.item_id = i.id
        )
      GROUP BY i.id, i.name
      HAVING COALESCE(SUM(b.on_hand), 0) <= 0
      ORDER BY i.name`).all(workspaceId);

    const held = db.prepare(`SELECT COALESCE(SUM(b.on_hand), 0) AS units,
        COUNT(DISTINCT i.id) AS products
      FROM items i
      JOIN skus s ON s.item_id = i.id AND s.is_active = 1
      LEFT JOIN balances b ON b.sku_id = s.id AND b.workspace_id = i.workspace_id
      WHERE i.workspace_id = ? AND i.is_active = 1`).get(workspaceId);

    const incoming = require("../purchasing/position").onOrderBySku(db, workspaceId);

    const itemSkuRows = db.prepare(`SELECT i.id AS item_id, s.id AS sku_id
      FROM items i JOIN skus s ON s.item_id = i.id AND s.is_active = 1
      WHERE i.workspace_id = ? AND i.is_active = 1`).all(workspaceId);
    const incomingByItem = new Map();
    for (const row of itemSkuRows) {
      const onOrder = incoming.get(row.sku_id);
      if (!onOrder || !Number(onOrder.onOrder)) continue;
      const current = incomingByItem.get(row.item_id) || { quantity: 0, nextExpectedDate: null };
      current.quantity += Number(onOrder.onOrder);
      if (onOrder.nextExpectedDate && (!current.nextExpectedDate || onOrder.nextExpectedDate < current.nextExpectedDate)) {
        current.nextExpectedDate = onOrder.nextExpectedDate;
      }
      incomingByItem.set(row.item_id, current);
    }

    const rows = empty.map((row) => {
      const onOrder = incomingByItem.get(row.item_id);
      return {
        product: row.product,
        variants: Number(row.tracked_variants),
        onHand: Number(row.on_hand),
        onTheWay: onOrder ? `${onOrder.quantity} due${onOrder.nextExpectedDate ? ' ' + onOrder.nextExpectedDate : ''}` : 'nothing ordered',
      };
    });

    /*
     * The "nothing is empty" answer matters as much as the list. Somebody asks
     * this because a screen looked wrong to them, and the useful reply is the
     * count they can check rather than a bare denial.
     */
    return {
      rows,
      columns: ['product', 'variants', 'onHand', 'onTheWay'],
      handoff: { href: '/inventory/table', label: 'Open inventory' },
      answer: rows.length
        ? `${rows.length} product${rows.length === 1 ? ' is' : 's are'} completely out of stock: ${rows.map((row) => `${row.product} (${row.onTheWay})`).join(', ')}. Everything else adds up to ${held.units} units across ${held.products} products.`
        : `Nothing is at zero. You hold ${held.units} units across ${held.products} products. (Products that have never had stock recorded are not counted here — ask “which products show None yet” for those.)`,
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

    /*
     * "No" has to be a sentence a person can check. The old wording —
     * "nothing StockChief can measure a sales rate for is heading for zero
     * inside the period it can see" — described the engine's limits instead
     * of answering the question. So: what is already at zero (running low by
     * anyone's definition), how many products were checked, and how many it
     * cannot judge yet, in that order.
     */
    let nothingAnswer = null;
    let nothingHandoff = null;
    if (!rows.length) {
      const empty = EXECUTORS.out_of_stock(db, workspaceId);
      const checked = Number(result.evaluated || 0);
      const scanned = Number(result.scanned || 0);
      const unjudged = Math.max(0, scanned - checked);
      const parts = [];
      if (empty.rows.length) {
        const named = empty.rows.slice(0, 3).map((row) => `${row.product} (${row.onTheWay})`).join(', ');
        const more = empty.rows.length > 3 ? ` and ${empty.rows.length - 3} more` : '';
        parts.push(`${empty.rows.length === 1 ? 'One product is' : `${empty.rows.length} products are`} already at zero: ${named}${more}.`);
        parts.push(checked
          ? `Nothing else is on track to run out — StockChief checked ${checked} product${checked === 1 ? '' : 's'} against how fast they sell.`
          : 'Nothing else is on track to run out.');
        nothingHandoff = { href: '/inventory/table?group=low', label: 'See what is at zero' };
      } else {
        parts.push(checked
          ? `No. StockChief checked ${checked} product${checked === 1 ? '' : 's'} against how fast they sell, and none is on track to run out.`
          : 'No. Nothing is at zero and nothing is on track to run out.');
      }
      if (unjudged) {
        parts.push(`${unjudged} product${unjudged === 1 ? ' has' : 's have'} not sold enough yet for StockChief to judge, so it is not guessing about ${unjudged === 1 ? 'that one' : 'those'}.`);
      }
      nothingAnswer = parts.join(' ');
    }

    return {
      rows,
      columns: ['product', 'runsOut', 'inDays', 'alreadyCovered', 'confidence'],
      handoff: exposed.length ? { href: '/needs-you', label: 'Open Needs you' } : nothingHandoff,
      answer: !rows.length
        ? nothingAnswer
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
          ? `${blocked.length} product${blocked.length === 1 ? ' needs' : 's need'} ordering, but StockChief does not know who to buy ${blocked.length === 1 ? 'it' : 'them'} from yet. ${blocked[0].headline}. Link a supplier and it will write the order for you to check.`
          : 'Nothing needs ordering right now. Every product StockChief has enough sales history for is covered, either by what is on the shelf or by an order already on its way.',
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
        ? `Yes. ${rows.length} product${rows.length === 1 ? ' is' : 's are'} being kept higher than sales justify. Lowering ${rows.length === 1 ? 'that target' : 'those targets'} frees cash without touching any reorder point, so you are no more likely to run out. ${review.headline}`
        : `No. Every stock target is already as low as it can go without raising the risk of running out. ${review.headline}`,
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
        : 'Not enough deliveries yet to say. StockChief needs a few completed orders from each supplier before it will rank them — one or two deliveries is not a pattern.',
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
        ? `${rows.length} reorder setting${rows.length === 1 ? ' is' : 's are'} out of date compared with how those products actually sell and how long suppliers take. `
          + result.policyChanges[0].why
        : 'Your reorder settings still fit how your products sell and how long your suppliers take. Nothing to change.',
    };
  },

  /** Why do you think X demand is increasing? */
  demand_explanation(db, workspaceId, plan) {
    const forecast = require('./forecast');
    const sku = plan && plan.entityQuery ? findSku(db, workspaceId, plan.entityQuery) : null;
    if (!sku) {
      return { rows: [], columns: [],
        answer: 'Which product? Name it and StockChief will explain what it expects to sell and why.' };
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
        : 'No move is worth making right now. No location is short of something another location has spare.',
    };
  },
};

module.exports = { EXECUTORS, INTENTS: Object.keys(EXECUTORS), findSku };
