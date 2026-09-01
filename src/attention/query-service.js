'use strict';

/**
 * Ask Foundry — the deterministic half.
 *
 * A question in ordinary language is turned into a *plan*: one intent from a
 * fixed list, plus a few bounded parameters. The model never sees SQL, never
 * writes SQL, and never receives a database handle. Every query below is
 * hand-written, parameterised, and scoped to the caller's workspace, so the
 * worst a bad plan can do is ask a supported question about the wrong thing.
 *
 * Answers are composed from the rows that came back. Nothing is narrated that
 * was not returned by one of these queries.
 */

const attention = require('./attention-engine');
const { round } = require('../signals/signal-engine');

const INTENTS = [
  'inventory_summary',
  'stock_level',
  'stock_by_location',
  'movement_history',
  'recent_adjustments',
  'expiring_soon',
  'idle_stock',
  'top_moving',
  'attention_summary',
  // Not a question at all: they are asking Foundry to do something. Answering
  // "I can't" would be false — Foundry can, on the actions page — so this
  // hands over instead of refusing.
  'action',
  // Purchasing. Mission 6 made these answerable from real records, so they are
  // no longer refusals — a question about what to buy, what is coming, what is
  // late, what something cost, or who sells it now has an answer.
  'replenishment',
  // "Why is this low?" is a different question from "how many are there?" and
  // from "what should I order?". It asks for the reasoning, and Foundry has it
  // — the replenishment planner produces exactly that. Answering with the
  // on-hand figure told someone what they already knew.
  'why_low',
  'on_order',
  'late_orders',
  'supplier_order_status',
  'supplier_document_changes',
  'supplier_price_changes',
  'last_cost',
  'suppliers_for_item',
  'selling_price',
  'sales_summary',
  // Mission 14 financial questions. Every answer below is calculated from the
  // posted ledger and subledgers; the model only chooses one bounded intent.
  'financial_summary',
  'business_health',
  'cash_pressure',
  'customer_orders_at_risk',
  'stock_coverage',
  'supplier_risk',
  'next_attention',
  'profit_and_loss',
  'balance_sheet',
  'cash_position',
  'receivables_aging',
  'payables_aging',
  'inventory_valuation',
  'sales_tax_summary',
  'bills_due',
  'customer_payments',
  'supplier_spend',
  'product_profitability',
  'location_profitability',
  'financial_comparison',
  'slow_inventory_value',
  'connection_summary',
  'connection_last_event',
  'connection_mapping_issues',
  'connection_diagnostics',
  // Mission 7. Foundry now does work of its own, so "what have you been doing"
  // is a real question with a real answer — read from the work records, never
  // from a model's recollection.
  'foundry_activity',
  'foundry_why',
  'stop_automation',
  'books_health',
  'unsupported',
];

const MAX_ROWS = 25;
const MAX_WINDOW_DAYS = 365;
const moneyForBrain = (minor, currency = 'USD') => new Intl.NumberFormat('en-US', {
  style: 'currency', currency,
}).format(Number(minor || 0) / 100);

/** Keeps a plan inside what the executor can honour, whatever the model said. */
function normalisePlan(raw) {
  const plan = raw && typeof raw === 'object' ? raw : {};
  const intent = INTENTS.includes(plan.intent) ? plan.intent : 'unsupported';
  const windowDays = Number.isFinite(Number(plan.windowDays))
    ? Math.min(Math.max(Math.round(Number(plan.windowDays)), 1), MAX_WINDOW_DAYS)
    : 30;
  const limit = Number.isFinite(Number(plan.limit))
    ? Math.min(Math.max(Math.round(Number(plan.limit)), 1), MAX_ROWS)
    : 10;

  return {
    intent,
    // Free text, but only ever used as a bound LIKE parameter.
    entityQuery: typeof plan.entityQuery === 'string' ? plan.entityQuery.trim().slice(0, 120) : '',
    locationQuery: typeof plan.locationQuery === 'string' ? plan.locationQuery.trim().slice(0, 120) : '',
    windowDays,
    limit,
    unsupportedReason:
      typeof plan.unsupportedReason === 'string' ? plan.unsupportedReason.trim().slice(0, 300) : '',
  };
}

const like = (text) => `%${String(text).replace(/[%_]/g, (c) => `\\${c}`)}%`;
const since = (days) => new Date(Date.now() - days * 86400000).toISOString();

/**
 * The words worth matching on. People ask about "brass gate valves" when the
 * product is "Brass Gate Valve 22mm", so each word is matched separately and a
 * plain plural is stemmed — "valves" finds "Valve". Words must all be present,
 * which keeps this a stricter search rather than a fuzzy one.
 */
/**
 * Words that name nothing.
 *
 * Every term has to match, which is what keeps this a strict search rather
 * than a fuzzy one — but it also means one word that identifies nothing
 * guarantees no result at all. "The" is three letters, so it survived the
 * length filter, and "move it to the warehouse" found no warehouse while
 * "move it to warehouse" found one. Shorter articles were already dropped by
 * the length rule; this finishes the job for the rest.
 *
 * A product or place genuinely called "The Works" is unaffected: the remaining
 * words still match it, and locations try an exact name first.
 */
const NAMES_NOTHING = new Set([
  'the', 'our', 'my', 'its', 'their', 'this', 'that', 'these', 'those', 'some', 'any', 'all',
]);

function searchTerms(query) {
  const words = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3)
    .map((word) => (word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));

  // Only drop them when something identifying is left. A query of nothing but
  // filler should go on finding nothing rather than matching everything.
  const meaningful = words.filter((word) => !NAMES_NOTHING.has(word));
  return (meaningful.length ? meaningful : words).slice(0, 6);
}

const SKU_SELECT = `SELECT s.id, s.code, i.name, i.unit_label, s.variant_label
     FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1`;

const MATCHES_TERM =
  `(i.name LIKE ? ESCAPE '\\' OR s.code LIKE ? ESCAPE '\\'
    OR i.base_code LIKE ? ESCAPE '\\' OR s.variant_label LIKE ? ESCAPE '\\')`;

/** Resolves the words a person used to actual SKUs, without guessing. */
function resolveSkus(db, workspaceId, query, limit) {
  if (!query) {
    return db.prepare(`${SKU_SELECT} ORDER BY i.name, s.position LIMIT ?`).all(workspaceId, limit);
  }

  const terms = searchTerms(query);
  if (terms.length) {
    const clauses = terms.map(() => MATCHES_TERM).join(' AND ');
    const params = terms.flatMap((term) => [like(term), like(term), like(term), like(term)]);
    const rows = db
      .prepare(`${SKU_SELECT} AND ${clauses} ORDER BY i.name, s.position LIMIT ?`)
      .all(workspaceId, ...params, limit);
    if (rows.length) return rows;
  }

  // Nothing matched word by word: try the phrase as typed, in case it is a
  // code or a name with punctuation the tokeniser dropped.
  return db
    .prepare(`${SKU_SELECT} AND ${MATCHES_TERM} ORDER BY i.name, s.position LIMIT ?`)
    .all(workspaceId, like(query), like(query), like(query), like(query), limit);
}

function resolveLocation(db, workspaceId, query) {
  if (!query) return null;
  return (
    db
      .prepare(
        `SELECT id, name FROM locations
          WHERE workspace_id = ? AND is_active = 1 AND name LIKE ? ESCAPE '\\'
          ORDER BY name LIMIT 1`
      )
      .get(workspaceId, like(query)) || null
  );
}

const label = (row) => (row.variant_label ? `${row.name} — ${row.variant_label}` : row.name);

// --- the supported questions -------------------------------------------------

const PURCHASING_EXECUTORS = {
  /** "What should I order today?" */
  replenishment(db, workspaceId, plan) {
    const replenishment = require('../purchasing/replenishment');
    const scoped = plan.entityQuery ? resolveSkus(db, workspaceId, plan.entityQuery, plan.limit) : null;
    if (plan.entityQuery && (!scoped || scoped.length === 0)) return { rows: [], answer: notFound(plan) };

    const result = replenishment.evaluateWorkspace(db, workspaceId, {
      skuIds: scoped ? scoped.map((s) => s.id) : null,
    });

    const rows = result.recommendations.slice(0, plan.limit).map((line) => ({
      label: line.displayName,
      onHand: line.onHand,
      onOrder: line.onOrder,
      recommended: line.quantityUnits,
      purchaseUnits: line.quantityPurchaseUnits === line.quantityUnits ? null : line.quantityPurchaseUnits,
      purchaseUnit: line.purchaseUnit,
      supplier: line.supplier ? line.supplier.supplierName : null,
      estimatedCost: line.estimatedCost,
      why: line.explanation,
    }));

    if (rows.length === 0) {
      const covered = result.covered.length;
      // Short and stuck is a fact; no history at all is an absence of facts.
      // Reporting the second as "needs ordering" would invent the demand figure
      // Foundry is deliberately refusing to guess.
      const stuck = result.blocked.filter((line) => line.reason === 'no_supplier');
      const unknown = result.blocked.filter((line) => line.reason !== 'no_supplier');

      // A line below its reorder point that Foundry cannot act on still needs
      // ordering. Answering "nothing needs ordering" and appending a bare count
      // of what "cannot be assessed" is the opposite of what was asked, and it
      // hides the only line the question was about.
      if (stuck.length) {
        return {
          rows: stuck.slice(0, plan.limit).map((line) => ({
            label: line.displayName,
            onHand: line.onHand,
            onOrder: line.onOrder,
            recommended: null,
            why: line.headline,
          })),
          columns: ['label', 'onHand', 'onOrder', 'recommended', 'why'],
          answer:
            `${stuck.length} line(s) need ordering, but Foundry cannot prepare an order for ` +
            `${stuck.length === 1 ? 'it' : 'them'} yet. ${stuck[0].displayName}: ${stuck[0].headline}.` +
            (stuck.some((line) => line.reason === 'no_supplier')
              ? ' Add a supplier for the product and Foundry can prepare the order.'
              : ''),
        };
      }

      if (unknown.length) {
        return {
          rows: unknown.slice(0, plan.limit).map((line) => ({
            label: line.displayName,
            onHand: line.onHand,
            onOrder: line.onOrder,
            why: line.headline,
          })),
          columns: ['label', 'onHand', 'onOrder', 'why'],
          answer:
            `Foundry cannot tell yet. ${unknown.length} line(s) have no outbound history, so it has no ` +
            'basis for saying whether they need ordering, and it will not guess one. Record sales or ' +
            'usage, or set a reorder point yourself.',
        };
      }

      return {
        rows: [],
        answer:
          covered
            ? `Nothing needs ordering right now. ${covered} line(s) are above their reorder point or already covered by stock on order.`
            : 'Nothing needs ordering right now.',
      };
    }

    const suppliers = result.bySupplier.length;
    return {
      rows,
      answer:
        `${rows.length} line(s) need ordering` +
        (suppliers > 1 ? ` across ${suppliers} suppliers` : suppliers === 1 ? ` from ${result.bySupplier[0].supplierName}` : '') +
        `. Starting with ${rows[0].label}: ${rows[0].recommended} recommended.`,
    };
  },

  /** "What's already on order?" / "What is arriving this week?" */
  /**
   * Why a product is low, rather than how much of it there is.
   *
   * Asking "why is this low?" and being told "48 units on hand" is being told
   * the thing you already knew — and Foundry had the whole answer, worked out
   * and sitting in Needs you. This reaches it.
   *
   * The plan is the answer: the level, the position against it, where the stock
   * actually is, and what Foundry would do about it. Nothing is computed here.
   */
  why_low(db, workspaceId, plan) {
    const replenishmentPlan = require('../purchasing/replenishment-plan');
    const signalEngine = require('../signals/signal-engine');

    const scoped = plan.entityQuery ? resolveSkus(db, workspaceId, plan.entityQuery, plan.limit) : null;
    if (plan.entityQuery && (!scoped || scoped.length === 0)) return { rows: [], answer: notFound(plan) };
    const skuIds = scoped ? scoped.map((s) => s.id) : null;

    const signals = signalEngine.skuSignals(db, workspaceId, skuIds ? { skuIds } : {});
    const plans = signals
      .filter((sku) => sku.isActive)
      .map((sku) => replenishmentPlan.buildPlan(db, workspaceId, sku));

    // Without a product, only the ones actually asking for something are worth
    // listing; naming one means answering about that one either way.
    const relevant = skuIds
      ? plans
      : plans.filter((entry) => entry.belowReorderPoint || entry.decision !== 'none');

    if (!relevant.length) {
      return {
        rows: [],
        answer: 'Nothing is below a reorder point at the moment.',
      };
    }

    const rows = relevant.slice(0, plan.limit).map((entry) => ({
      label: entry.displayName,
      onHand: entry.onHandTotal,
      onOrder: entry.onOrder,
      reorderPoint: entry.reorderPoint === null ? null : entry.reorderPoint,
      where: entry.byLocation.map((loc) => `${loc.onHand} at ${loc.locationName}`).join(', '),
      why: entry.explanation,
    }));
    const columns = ['label', 'onHand', 'onOrder', 'reorderPoint', 'where', 'why'];

    const first = relevant[0];

    // No level set is not a shortage — it is the absence of anything to be
    // short of, and saying so is more use than an invented judgement.
    if (first.reorderPoint === null) {
      return {
        rows,
        columns,
        answer:
          `${first.displayName} has ${first.onHandTotal} on hand and no reorder point set, so Foundry ` +
          'has nothing to call it low against. Set one on the product and Foundry will watch it, ' +
          'and tell you when it is crossed.',
      };
    }

    if (!first.belowReorderPoint) {
      return {
        rows,
        columns,
        answer:
          `${first.displayName} is not low: ${first.onHandTotal} on hand` +
          `${first.onOrder ? ` and ${first.onOrder} on order` : ''} is ${first.networkPosition}, ` +
          `above its reorder point of ${first.reorderPoint}.` +
          (first.decision === 'transfer'
            ? ` It is not evenly spread, though — ${first.explanation}`
            : ''),
      };
    }

    const doing = replenishmentPlan.recommendationFor(first);
    return {
      rows,
      columns,
      answer: `${first.explanation} ${doing}`,
    };
  },


  on_order(db, workspaceId, plan) {
    const position = require('../purchasing/position');
    const scoped = plan.entityQuery ? resolveSkus(db, workspaceId, plan.entityQuery, plan.limit) : null;
    if (plan.entityQuery && (!scoped || scoped.length === 0)) return { rows: [], answer: notFound(plan) };

    if (scoped) {
      const rows = scoped.map((sku) => {
        const state = position.positionForSku(db, workspaceId, sku.id);
        return {
          label: label(sku),
          onHand: state.onHand,
          onOrder: state.onOrder,
          expected: state.nextExpectedDate,
          orders: state.orders.map((o) => o.poNumber).join(', ') || null,
        };
      });
      const first = rows[0];
      return {
        rows,
        answer:
          rows.length === 1
            ? first.onOrder > 0
              ? `${first.onOrder} of ${first.label} are on order${first.orders ? ` on ${first.orders}` : ''}` +
                `${first.expected ? `, expected ${first.expected}` : ''}. ${first.onHand} on hand.`
              : `Nothing is on order for ${first.label}. ${first.onHand} on hand.`
            : `${rows.filter((r) => r.onOrder > 0).length} of ${rows.length} lines have stock on order.`,
      };
    }

    // "Arriving this week" narrows by the window the person implied.
    const arriving = plan.windowDays <= 31
      ? position.arrivingSoon(db, workspaceId, { days: plan.windowDays })
      : position.openOrders(db, workspaceId);

    const rows = arriving.slice(0, plan.limit).map((po) => ({
      label: po.po_number,
      supplier: po.supplier_name,
      expected: po.expected_date,
      outstanding: po.outstanding_units,
      status: po.status,
    }));

    return {
      rows,
      answer: rows.length
        ? `${rows.length} purchase order(s) with ${rows.reduce((n, r) => n + r.outstanding, 0)} unit(s) outstanding.`
        : 'There is nothing on order at the moment.',
    };
  },

  /** "Which purchase orders are late?" */
  late_orders(db, workspaceId, plan) {
    const position = require('../purchasing/position');
    const late = position.lateOrders(db, workspaceId).slice(0, plan.limit);
    const rows = late.map((po) => ({
      label: po.po_number,
      supplier: po.supplier_name,
      expected: po.expected_date,
      daysLate: po.daysLate,
      outstanding: po.outstanding_units,
    }));
    return {
      rows,
      answer: rows.length
        ? `${rows.length} purchase order(s) are past their expected date. ${rows[0].label} from ${rows[0].supplier} is ${rows[0].daysLate} day(s) late with ${rows[0].outstanding} outstanding.`
        : 'No purchase orders are past their expected arrival date.',
    };
  },

  /** "How much did we last pay for this?" */
  last_cost(db, workspaceId, plan) {
    const poService = require('../purchasing/po-service');
    const skus = resolveSkus(db, workspaceId, plan.entityQuery, plan.limit);
    if (skus.length === 0) return { rows: [], answer: notFound(plan) };

    const rows = [];
    for (const sku of skus) {
      const history = poService.costHistory(db, workspaceId, sku.id, { limit: 3 });
      rows.push({
        label: label(sku),
        lastCost: history.length ? history[0].unitCost : null,
        supplier: history.length ? history[0].supplierName : null,
        poNumber: history.length ? history[0].poNumber : null,
        orderedOn: history.length ? history[0].orderDate : null,
        previousCost: history.length > 1 ? history[1].unitCost : null,
      });
    }

    const first = rows[0];
    if (rows.length === 1) {
      if (first.lastCost === null) {
        return { rows, answer: `Foundry has no purchase history for ${first.label}.` };
      }
      const movement =
        first.previousCost !== null && first.previousCost !== first.lastCost
          ? ` It was ${first.previousCost} the time before.`
          : '';
      return {
        rows,
        answer: `${first.label} last cost ${first.lastCost} each, from ${first.supplier} on ${first.poNumber}.${movement}`,
      };
    }
    return { rows, answer: `Last purchase cost for ${rows.length} lines.` };
  },

  /** "Who supplies this?" / "Which supplier should I use?" */
  suppliers_for_item(db, workspaceId, plan) {
    const supplierService = require('../purchasing/supplier-service');
    const replenishment = require('../purchasing/replenishment');
    const skus = resolveSkus(db, workspaceId, plan.entityQuery, plan.limit);
    if (skus.length === 0) return { rows: [], answer: notFound(plan) };

    const sku = skus[0];
    const options = supplierService.suppliersForSku(db, workspaceId, sku.id);
    if (options.length === 0) {
      return { rows: [], answer: `No supplier is on file for ${label(sku)}.` };
    }

    const rows = options.map((option) => ({
      label: option.supplierName,
      supplierSku: option.supplierSku,
      unitCost: option.lastUnitCost,
      leadTimeDays: option.effectiveLeadTimeDays,
      purchaseUnit:
        option.unitsPerPurchaseUnit > 1
          ? `${option.purchaseUnit} of ${option.unitsPerPurchaseUnit}`
          : option.purchaseUnit,
      preferred: option.isPreferred,
    }));

    const signals = require('../signals/signal-engine').skuSignals(db, workspaceId, { skuIds: [sku.id] })[0];
    const choice = replenishment.chooseSupplier(options, {
      daysOfStockRemaining: signals ? signals.estimated.daysOfStockRemaining : null,
    });

    return {
      rows,
      answer:
        options.length === 1
          ? `${label(sku)} comes from ${options[0].supplierName}.`
          : `${label(sku)} has ${options.length} suppliers on file. ${choice.because}.`,
    };
  },
};

const EXECUTORS = {
  foundry_activity: foundryActivity,
  foundry_why: foundryWhy,
  stop_automation: stopAutomation,
  inventory_summary(db, workspaceId) {
    const products = db.prepare(
      'SELECT COUNT(*) AS n FROM items WHERE workspace_id = ? AND is_active = 1'
    ).get(workspaceId).n;
    const variants = db.prepare(
      `SELECT COUNT(*) AS n FROM skus s JOIN items i ON i.id = s.item_id
        WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1`
    ).get(workspaceId).n;
    const units = db.prepare(
      `SELECT COALESCE(SUM(b.on_hand), 0) AS n FROM balances b
         JOIN skus s ON s.id = b.sku_id JOIN items i ON i.id = s.item_id
        WHERE b.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1`
    ).get(workspaceId).n;
    const locations = db.prepare(
      'SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ? AND is_active = 1'
    ).get(workspaceId).n;
    const rows = [
      { measure: 'Active products', value: products },
      { measure: 'Tracked variants', value: variants },
      { measure: 'Units on hand', value: units },
      { measure: 'Active locations', value: locations },
    ];
    return {
      rows,
      answer:
        `This inventory has ${products} active product${products === 1 ? '' : 's'}, `
        + `${variants} tracked variant${variants === 1 ? '' : 's'}, and ${units} unit${units === 1 ? '' : 's'} `
        + `on hand across ${locations} active location${locations === 1 ? '' : 's'}.`,
      columns: ['measure', 'value'],
    };
  },

  financial_summary(db, workspaceId, plan) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return { supported: false, rows: [],
      handoff: { href: '/accounting', label: 'Set up accounting' },
      answer: 'Accounting is not set up yet. Foundry does not know what you paid or which expenses belong in the period, so it will not guess at profit or cash.' };
    const reports = require('../accounting/reports');
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - (plan.windowDays - 1) * 86400000).toISOString().slice(0, 10);
    const pnl = reports.profitAndLoss(db, workspaceId, { from, to });
    const balance = reports.balanceSheet(db, workspaceId, { asOf: to });
    const ar = reports.arAging(db, workspaceId, { asOf: to });
    const ap = reports.apAging(db, workspaceId, { asOf: to });
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    const cash = balance.assets.filter((a) => a.subtype === 'CASH').reduce((sum, a) => sum + a.net_minor, 0);
    const rows = [
      { measure: 'Revenue', amountMinor: pnl.revenueMinor, display: money(pnl.revenueMinor) },
      { measure: 'Gross profit', amountMinor: pnl.grossProfitMinor, display: money(pnl.grossProfitMinor) },
      { measure: 'Net income', amountMinor: pnl.netIncomeMinor, display: money(pnl.netIncomeMinor) },
      { measure: 'Cash', amountMinor: cash, display: money(cash) },
      { measure: 'Customers owe', amountMinor: ar.totalMinor, display: money(ar.totalMinor) },
      { measure: 'Bills to pay', amountMinor: ap.totalMinor, display: money(ap.totalMinor) },
    ];
    return { rows, columns: ['measure', 'display'],
      answer: `For ${from} through ${to}, revenue is ${money(pnl.revenueMinor)}, gross profit is ${money(pnl.grossProfitMinor)}, and recorded net income is ${money(pnl.netIncomeMinor)}. Cash is ${money(cash)}; customers owe ${money(ar.totalMinor)} and open supplier bills total ${money(ap.totalMinor)}. Net income includes only expenses recorded in Foundry; it is incomplete if costs such as rent or payroll have not been entered.` };
  },

  business_health(db, workspaceId) {
    const brain = require('../manager/business-brain').build(db, workspaceId);
    const rows = [
      { measure: 'Physical stock', value: brain.inventory.onHand },
      { measure: 'Committed to customers', value: brain.inventory.committed },
      { measure: 'Available now', value: brain.inventory.available },
      { measure: 'Incoming from suppliers', value: brain.inventory.incoming },
      { measure: 'Open customer orders', value: brain.sales.open },
      { measure: 'Open purchase orders', value: brain.purchasing.open },
      { measure: 'Customers still owe', value: brain.finance ? moneyForBrain(brain.finance.customers.balanceMinor, brain.currency) : 'No evidence' },
      { measure: 'Still owed to suppliers', value: brain.finance ? moneyForBrain(brain.acquisition.supplierOwedMinor, brain.currency) : 'No evidence' },
    ];
    return { rows, columns: ['measure', 'value'], handoff: { href: '/', label: 'Open the business briefing' },
      answer: [brain.briefing.headline, ...brain.briefing.lines].join(' ') };
  },

  cash_pressure(db, workspaceId) {
    const brain = require('../manager/business-brain').build(db, workspaceId);
    if (!brain.finance) return EXECUTORS.financial_summary(db, workspaceId, { windowDays: 30 });
    const causes = [];
    if (brain.finance.customers.balanceMinor > 0) causes.push(`${moneyForBrain(brain.finance.customers.balanceMinor, brain.currency)} is still with customers`);
    if (brain.acquisition.stillOwnedMinor > 0) causes.push(`${moneyForBrain(brain.acquisition.stillOwnedMinor, brain.currency)} remains tied up in products still owned`);
    if (brain.acquisition.supplierPaidMinor > brain.finance.cashActivity.customerReceivedMinor) causes.push(`supplier payments exceed customer receipts for the period by ${moneyForBrain(brain.acquisition.supplierPaidMinor - brain.finance.cashActivity.customerReceivedMinor, brain.currency)}`);
    const rows = [
      { measure: 'Cash currently recorded', value: moneyForBrain(brain.finance.currentCashMinor, brain.currency) },
      { measure: 'Customer money still outstanding', value: moneyForBrain(brain.finance.customers.balanceMinor, brain.currency) },
      { measure: 'Cost still held in inventory', value: moneyForBrain(brain.acquisition.stillOwnedMinor, brain.currency) },
      { measure: 'Supplier bills still owed', value: moneyForBrain(brain.acquisition.supplierOwedMinor, brain.currency) },
    ];
    return { rows, columns: ['measure', 'value'], handoff: { href: '/accounting#cash', label: 'See where cash went' },
      answer: causes.length ? `The strongest evidence-based reasons are: ${causes.join('; ')}. Foundry does not infer bank money it has not received.`
        : 'Foundry does not have evidence of a specific cash-pressure cause in the recorded customer payments, supplier payments, or inventory value.' };
  },

  customer_orders_at_risk(db, workspaceId) {
    const brain = require('../manager/business-brain').build(db, workspaceId);
    const rows = brain.sales.atRisk.map((order) => ({ order: order.order_number,
      customer: order.customer_name, neededBy: order.needed_by,
      unitsStillNeeded: order.outstanding, unitsNotProtected: order.unprotected,
      status: order.overdue ? 'OVERDUE' : 'AT RISK' }));
    return { rows, columns: ['order', 'customer', 'neededBy', 'unitsStillNeeded', 'unitsNotProtected', 'status'],
      handoff: rows.length ? { href: '/sales', label: 'Open customer orders' } : null,
      answer: rows.length ? `${rows.length} customer order${rows.length === 1 ? '' : 's'} may miss the requested date because ${rows.reduce((sum, row) => sum + row.unitsNotProtected, 0)} needed units are not protected by committed stock.`
        : 'No dated customer order is currently shown at risk from an unprotected stock shortage.' };
  },

  stock_coverage(db, workspaceId) {
    const brain = require('../manager/business-brain').build(db, workspaceId);
    const uncovered = brain.sales.backorderedUnits;
    const rows = brain.inventory.rows.filter((row) => row.committed || row.incoming)
      .map((row) => ({ product: `${row.item_name}${row.variant_label ? ` / ${row.variant_label}` : ''}`,
        location: row.location_name, onHand: row.onHand, committed: row.committed,
        available: row.available, incoming: row.incoming }));
    return { rows, columns: ['product', 'location', 'onHand', 'committed', 'available', 'incoming'],
      answer: uncovered ? `Current stock does not fully cover open customer orders: ${uncovered} unit${uncovered === 1 ? '' : 's'} is not protected by a commitment. ${brain.purchasing.incomingUnits} supplier units are still expected.`
        : `Current commitments are covered by recorded stock. ${brain.purchasing.incomingUnits} more supplier units are still expected.` };
  },

  supplier_risk(db, workspaceId) {
    const brain = require('../manager/business-brain').build(db, workspaceId);
    const rows = brain.purchasing.late.map((po) => ({ supplier: po.supplier_name,
      purchaseOrder: po.po_number, expected: po.current_eta, outstanding: po.outstanding,
      backordered: po.backordered }));
    return { rows, columns: ['supplier', 'purchaseOrder', 'expected', 'outstanding', 'backordered'],
      answer: rows.length ? `${rows.length} supplier order${rows.length === 1 ? '' : 's'} is late. The largest outstanding order is ${rows.sort((a,b) => b.outstanding - a.outstanding)[0].purchaseOrder}.`
        : 'No open supplier order is past its latest recorded expected arrival date.' };
  },

  next_attention(db, workspaceId) {
    const brain = require('../manager/business-brain').build(db, workspaceId);
    const rows = brain.attention.map((entry) => ({ priority: entry.priority,
      what: entry.title, why: entry.because }));
    return { rows, columns: ['priority', 'what', 'why'], handoff: rows.length ? { href: '/needs-you', label: 'Open Needs you' } : null,
      answer: rows.length ? `${brain.attention[0].title}. ${brain.attention[0].because}` : 'Nothing in the recorded cross-business state is likely to require attention next.' };
  },

  profit_and_loss(db, workspaceId, plan) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, plan);
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - (plan.windowDays - 1) * 86400000).toISOString().slice(0, 10);
    const pnl = require('../accounting/reports').profitAndLoss(db, workspaceId, { from, to });
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    const rows = [
      { measure: 'Revenue', amountMinor: pnl.revenueMinor, display: money(pnl.revenueMinor) },
      { measure: 'Cost of goods sold', amountMinor: pnl.cogsMinor, display: money(pnl.cogsMinor) },
      { measure: 'Gross profit', amountMinor: pnl.grossProfitMinor, display: money(pnl.grossProfitMinor) },
      { measure: 'Operating expenses', amountMinor: pnl.operatingExpenseMinor, display: money(pnl.operatingExpenseMinor) },
      { measure: 'Net income', amountMinor: pnl.netIncomeMinor, display: money(pnl.netIncomeMinor) },
    ];
    const noActivity = pnl.revenueMinor === 0 && pnl.cogsMinor === 0 && pnl.operatingExpenseMinor === 0;
    return { rows, columns: ['measure', 'display'], handoff: { href: `/accounting/reports/profit-and-loss?from=${from}&to=${to}`, label: 'Open profit and loss' },
      // "Have I made any profit yet?" is a yes or no before it is a figure.
      // What this verdict is about, so a question asking the opposite gets
      // the opposite answer rather than an agreeable one.
      assertsProfit: true,
      verdict: noActivity
        ? { yes: false, asserts: PROFIT_WORDS, opposite: LOSS_WORDS, summary: 'nothing has been sold or bought in this period yet.' }
        : { yes: pnl.netIncomeMinor > 0, asserts: PROFIT_WORDS, opposite: LOSS_WORDS,
            summary: `${money(Math.abs(pnl.netIncomeMinor))} ${pnl.netIncomeMinor > 0 ? 'so far' : pnl.netIncomeMinor < 0 ? 'lost so far' : 'exactly break-even'}, on ${money(pnl.revenueMinor)} of sales.` },
      answer: noActivity
        ? `No revenue, product cost, or operating expense has been posted for ${from} through ${to}, so Foundry does not have a realized margin to report yet. The Accounting inventory view shows on-hand cost, selling value, and potential gross profit separately.`
        : `This is ${money(pnl.netIncomeMinor)} net ${pnl.netIncomeMinor >= 0 ? 'profit' : 'loss'} based on the expenses recorded in Foundry for ${from} through ${to}: ${money(pnl.revenueMinor)} revenue minus ${money(pnl.cogsMinor)} cost of goods and ${money(pnl.operatingExpenseMinor)} operating expenses recorded in Foundry. Gross profit is ${money(pnl.grossProfitMinor)}; it is not the same as net profit. This net result is incomplete if business costs such as rent or payroll have not been recorded in Foundry.` };
  },

  /**
   * "Is anything wrong with my books?"
   *
   * The checks live in accounting/books-review, which reads the owner
   * dashboard's own figures — so this answer and the Accounting screen cannot
   * disagree, and a new thing worth noticing is a new entry there rather than
   * another branch here.
   *
   * Every row carries the record it came from, so the answer is a way in rather
   * than a verdict to be taken on trust.
   */
  books_health(db, workspaceId) {
    const review = require('../accounting/books-review').review(db, workspaceId);
    const rows = review.findings.map((finding) => ({
      finding: finding.what,
      severity: finding.severity,
      whatToDo: finding.action.label,
      href: finding.action.href,
    }));
    const answer = review.clean
      ? `Nothing is wrong that Foundry can see, across ${review.checksRun} checks: what customers owe, `
        + 'what you owe suppliers, stock received without a bill, payments that look duplicated, sales '
        + 'with no payment recorded, cash due out against cash in, stock with no proven cost, and stock '
        + 'that is not selling.'
      : `${review.findings.length} of ${review.checksRun} checks found something. `
        + review.findings.map((finding) => `${finding.what} ${finding.why}`).join(' ');
    return {
      rows,
      columns: ['finding', 'severity', 'whatToDo'],
      handoff: { href: '/accounting', label: 'Open Accounting' },
      verdict: {
        yes: !review.clean,
        asserts: ['wrong', 'problem', 'issue', 'error', 'mistake', 'missing', 'off'],
        opposite: ['right', 'correct', 'in order', 'fine', 'clean', 'healthy', 'all good'],
        summary: review.clean
          ? `nothing found across ${review.checksRun} checks.`
          : `${review.findings.length} thing${review.findings.length === 1 ? '' : 's'} to look at.`,
      },
      answer,
    };
  },

  balance_sheet(db, workspaceId) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, { windowDays: 30 });
    const asOf = new Date().toISOString().slice(0, 10);
    const report = require('../accounting/reports').balanceSheet(db, workspaceId, { asOf });
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    const rows = [
      { measure: 'Assets', display: money(report.assetMinor) },
      { measure: 'Liabilities', display: money(report.liabilityMinor) },
      { measure: 'Equity including current earnings', display: money(report.equityMinor) },
    ];
    return { rows, columns: ['measure', 'display'], handoff: { href: `/accounting/reports/balance-sheet?asOf=${asOf}`, label: 'Open balance sheet' },
      answer: `As of ${asOf}, assets are ${money(report.assetMinor)}, liabilities are ${money(report.liabilityMinor)}, and equity including current earnings is ${money(report.equityMinor)}. The ledger is ${report.balanced ? 'balanced' : 'not balanced and needs review'}.` };
  },

  cash_position(db, workspaceId) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, { windowDays: 30 });
    const asOf = new Date().toISOString().slice(0, 10);
    const report = require('../accounting/reports').balanceSheet(db, workspaceId, { asOf });
    const accounts = report.assets.filter((a) => a.subtype === 'CASH');
    const total = accounts.reduce((sum, a) => sum + a.net_minor, 0);
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows: accounts.map((a) => ({ account: a.name, amountMinor: a.net_minor, display: money(a.net_minor) })), columns: ['account', 'display'],
      answer: `Ledger cash is ${money(total)} as of ${asOf}. This is the book balance; bank reconciliation shows whether statements agree.` };
  },

  receivables_aging(db, workspaceId) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, { windowDays: 30 });
    const report = require('../accounting/reports').arAging(db, workspaceId);
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows: report.rows.slice(0, 25), handoff: { href: '/accounting/receivables', label: 'Open receivables' },
      answer: `Customers owe ${money(report.totalMinor)} across ${report.rows.length} open invoice${report.rows.length === 1 ? '' : 's'}. ${money(report.buckets.over90)} is more than 90 days past due.` };
  },

  payables_aging(db, workspaceId) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, { windowDays: 30 });
    const report = require('../accounting/reports').apAging(db, workspaceId);
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows: report.rows.slice(0, 25), handoff: { href: '/accounting/payables', label: 'Open bills' },
      answer: `Open supplier bills total ${money(report.totalMinor)} across ${report.rows.length} bill${report.rows.length === 1 ? '' : 's'}. ${money(report.buckets.over90)} is more than 90 days past due.` };
  },

  inventory_valuation(db, workspaceId) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, { windowDays: 30 });
    const valuation = require('../accounting/costing').valuation(db, workspaceId);
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows: valuation.rows.slice(0, 25), handoff: { href: '/accounting/reports/inventory-valuation', label: 'Open inventory valuation' },
      answer: `${valuation.totalUnits} units carry a total weighted-average value of ${money(valuation.totalCostMinor)}. This is cost value, not selling-price value.` };
  },

  sales_tax_summary(db, workspaceId) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, { windowDays: 30 });
    const trial = require('../accounting/reports').trialBalance(db, workspaceId, { from: '1900-01-01', to: new Date().toISOString().slice(0, 10) });
    const payable = trial.accounts.find((a) => a.system_key === 'SALES_TAX_PAYABLE')?.net_minor || 0;
    const recoverable = trial.accounts.find((a) => a.system_key === 'SALES_TAX_RECOVERABLE')?.net_minor || 0;
    const net = payable - recoverable;
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows: [
      { measure: 'Collected/payable', display: money(payable) },
      { measure: 'Recoverable', display: money(recoverable) },
      { measure: 'Net liability', display: money(net) },
    ], columns: ['measure', 'display'], answer: `The ledger shows ${money(payable)} of sales tax payable, ${money(recoverable)} recoverable, and a net ${money(net)} liability. Filing status is not inferred from the balance.` };
  },

  bills_due(db, workspaceId, plan) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, { windowDays: 30 });
    const today = new Date().toISOString().slice(0, 10);
    const through = new Date(Date.now() + Math.max(1, plan.windowDays) * 86400000).toISOString().slice(0, 10);
    const rows = db.prepare(`SELECT b.bill_number, b.supplier_invoice_number, b.due_date,
        b.balance_minor, b.currency, s.name AS supplier
      FROM accounting_supplier_bills b JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.workspace_id = ? AND b.status IN ('OPEN','PARTIALLY_PAID')
        AND b.balance_minor > 0 AND b.due_date IS NOT NULL AND b.due_date <= ?
      ORDER BY b.due_date, b.bill_number LIMIT ?`).all(workspaceId, through, plan.limit);
    const total = rows.reduce((sum, row) => sum + Number(row.balance_minor), 0);
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows, handoff: { href: '/accounting/payables', label: 'Open bills' },
      answer: rows.length ? `${rows.length} bill${rows.length === 1 ? '' : 's'} totaling ${money(total)} are due by ${through}; overdue bills are included.`
        : `No recorded supplier bills are due by ${through}.`,
      columns: ['supplier', 'supplier_invoice_number', 'due_date', 'balance_minor'] };
  },

  customer_payments(db, workspaceId, plan) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, plan);
    const from = new Date(Date.now() - (plan.windowDays - 1) * 86400000).toISOString().slice(0, 10);
    const terms = searchTerms(plan.entityQuery);
    const rows = db.prepare(`SELECT p.payment_date, p.amount_minor, p.reference, c.name AS customer
      FROM accounting_payments p JOIN customers c ON c.id = p.customer_id
      WHERE p.workspace_id = ? AND p.direction = 'CUSTOMER_RECEIPT' AND p.status = 'POSTED'
        AND p.payment_date >= ? ORDER BY p.payment_date DESC`).all(workspaceId, from)
      .filter((row) => !terms.length || terms.every((term) => row.customer.toLowerCase().includes(term)))
      .slice(0, plan.limit);
    const total = rows.reduce((sum, row) => sum + Number(row.amount_minor), 0);
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows, handoff: { href: '/accounting/receivables', label: 'Open receivables' },
      answer: rows.length ? `${plan.entityQuery || 'Customers'} paid ${money(total)} in ${rows.length} recorded payment${rows.length === 1 ? '' : 's'} during the last ${plan.windowDays} days.`
        : `No matching customer payments were recorded in the last ${plan.windowDays} days.` };
  },

  supplier_spend(db, workspaceId, plan) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, plan);
    const from = new Date(Date.now() - (plan.windowDays - 1) * 86400000).toISOString().slice(0, 10);
    const terms = searchTerms(plan.entityQuery);
    const rows = db.prepare(`SELECT s.id, s.name AS supplier,
        COALESCE(SUM(CASE WHEN a.system_key = 'ACCOUNTS_PAYABLE' THEN l.credit_minor - l.debit_minor ELSE 0 END),0) AS purchases_minor
      FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id = l.entry_id
      JOIN accounting_accounts a ON a.id = l.account_id JOIN suppliers s ON s.id = l.supplier_id
      WHERE l.workspace_id = ? AND e.status = 'POSTED' AND e.posting_date >= ?
        AND e.source_type IN ('purchase_receipt','supplier_bill','supplier_invoice_variance')
      GROUP BY s.id ORDER BY purchases_minor DESC`).all(workspaceId, from)
      .filter((row) => !terms.length || terms.every((term) => row.supplier.toLowerCase().includes(term)))
      .slice(0, plan.limit).map((row) => ({ ...row,
        paymentsMinor: Number(db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS n FROM accounting_payments
          WHERE workspace_id = ? AND supplier_id = ? AND direction = 'SUPPLIER_PAYMENT'
            AND status = 'POSTED' AND payment_date >= ?`).get(workspaceId, row.id, from).n) }));
    const purchases = rows.reduce((sum, row) => sum + Number(row.purchases_minor), 0);
    const paid = rows.reduce((sum, row) => sum + row.paymentsMinor, 0);
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows, answer: rows.length ? `Recorded purchases from ${plan.entityQuery || 'suppliers'} are ${money(purchases)} in the last ${plan.windowDays} days; recorded cash payments are ${money(paid)}. Purchases and payments are intentionally separate.`
      : `No matching supplier purchases were posted in the last ${plan.windowDays} days.` };
  },

  product_profitability(db, workspaceId, plan) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, plan);
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - (plan.windowDays - 1) * 86400000).toISOString().slice(0, 10);
    const rows = require('../accounting/reports').profitability(db, workspaceId, { from, to, dimension: 'product' }).rows
      .filter((row) => row.id).slice(0, plan.limit);
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows, answer: rows.length ? `${rows[0].label} has the highest recorded gross profit for this period at ${money(rows[0].grossProfitMinor)} (${money(rows[0].revenueMinor)} revenue minus ${money(rows[0].cogsMinor)} product cost). This is gross, not net, profitability.`
      : 'No product-level revenue and COGS are posted for this period.' };
  },

  location_profitability(db, workspaceId, plan) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, plan);
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - (plan.windowDays - 1) * 86400000).toISOString().slice(0, 10);
    const rows = require('../accounting/reports').profitability(db, workspaceId, { from, to, dimension: 'location' }).rows
      .filter((row) => row.id).slice(0, plan.limit);
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows, answer: rows.length ? `${rows[0].label} has the highest recorded gross profit for this period at ${money(rows[0].grossProfitMinor)}. Location-level operating expenses are not allocated, so this is not net location profit.`
      : 'No location-level revenue and COGS are posted for this period.' };
  },

  financial_comparison(db, workspaceId, plan) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, plan);
    const days = Math.max(1, plan.windowDays);
    const currentTo = new Date().toISOString().slice(0, 10);
    const currentFrom = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const priorTo = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const priorFrom = new Date(Date.now() - (days * 2 - 1) * 86400000).toISOString().slice(0, 10);
    const service = require('../accounting/reports');
    const current = service.profitAndLoss(db, workspaceId, { from: currentFrom, to: currentTo });
    const prior = service.profitAndLoss(db, workspaceId, { from: priorFrom, to: priorTo });
    const delta = current.netIncomeMinor - prior.netIncomeMinor;
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows: [{ period: 'Current', revenueMinor: current.revenueMinor, cogsMinor: current.cogsMinor,
      expensesMinor: current.operatingExpenseMinor, netIncomeMinor: current.netIncomeMinor },
    { period: 'Prior', revenueMinor: prior.revenueMinor, cogsMinor: prior.cogsMinor,
      expensesMinor: prior.operatingExpenseMinor, netIncomeMinor: prior.netIncomeMinor }],
    answer: `Net income ${delta >= 0 ? 'increased' : 'decreased'} by ${money(Math.abs(delta))} versus the preceding ${days}-day period. Revenue changed by ${money(current.revenueMinor - prior.revenueMinor)}, COGS by ${money(current.cogsMinor - prior.cogsMinor)}, and recorded operating expenses by ${money(current.operatingExpenseMinor - prior.operatingExpenseMinor)}.` };
  },

  slow_inventory_value(db, workspaceId, plan) {
    const accounting = require('../accounting/ledger').settings(db, workspaceId);
    if (!accounting.enabled) return EXECUTORS.financial_summary(db, workspaceId, plan);
    const report = require('../accounting/reports').slowInventoryValue(db, workspaceId, {
      before: new Date(Date.now() - plan.windowDays * 86400000).toISOString().slice(0, 10),
    });
    const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: accounting.currency }).format(n / 100);
    return { rows: report.rows.slice(0, plan.limit), handoff: { href: '/accounting/reports/inventory-valuation', label: 'Open inventory valuation' },
      answer: `${money(report.totalCostMinor)} is tied up in ${report.rows.length} stock position${report.rows.length === 1 ? '' : 's'} with no outbound movement in the last ${plan.windowDays} days.` };
  },

  /** Confirmation, outstanding quantity and lateness for a supplier or PO. */
  supplier_order_status(db, workspaceId, plan) {
    const query = plan.entityQuery;
    const po = query ? db.prepare(`SELECT po.*, s.name AS supplier_name
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.workspace_id = ? AND po.po_number LIKE ? ESCAPE '\\'
      ORDER BY CASE WHEN lower(po.po_number) = lower(?) THEN 0 ELSE 1 END, po.created_at DESC LIMIT 1`)
      .get(workspaceId, like(query), query) : null;
    const supplier = !po && query ? db.prepare(`SELECT * FROM suppliers WHERE workspace_id = ? AND status = 'active'
      AND name LIKE ? ESCAPE '\\' ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, name LIMIT 1`)
      .get(workspaceId, like(query), query) : null;
    if (query && !po && !supplier) return { rows: [], answer: `Foundry could not find a supplier or purchase order matching "${query}".` };

    const clauses = ['po.workspace_id = ?'];
    const params = [workspaceId];
    if (po) { clauses.push('po.id = ?'); params.push(po.id); }
    else {
      clauses.push("po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED')");
      if (supplier) { clauses.push('po.supplier_id = ?'); params.push(supplier.id); }
    }
    const rows = db.prepare(`SELECT po.id, po.po_number AS label, po.status, po.expected_date AS expected,
        s.name AS supplier,
        COALESCE((SELECT SUM(pol.quantity_units - pol.quantity_received_units)
          FROM purchase_order_lines pol WHERE pol.purchase_order_id = po.id), 0) AS outstanding,
        (SELECT d.document_type FROM supplier_documents d WHERE d.workspace_id = po.workspace_id
          AND d.purchase_order_id = po.id ORDER BY d.processed_at DESC, d.rowid DESC LIMIT 1) AS latestEvidence,
        (SELECT d.processed_at FROM supplier_documents d WHERE d.workspace_id = po.workspace_id
          AND d.purchase_order_id = po.id ORDER BY d.processed_at DESC, d.rowid DESC LIMIT 1) AS latestEvidenceAt,
        EXISTS(SELECT 1 FROM supplier_documents d WHERE d.workspace_id = po.workspace_id
          AND d.purchase_order_id = po.id AND d.document_type = 'order_acknowledgement'
          AND d.status IN ('MATCHED','RECORDED')) AS confirmed
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      WHERE ${clauses.join(' AND ')} ORDER BY po.created_at DESC LIMIT ?`)
      .all(...params, plan.limit).map((row) => ({ ...row, confirmed: Boolean(row.confirmed) }));
    if (!rows.length) return { rows: [], answer: supplier
      ? `Foundry has no purchase orders recorded for ${supplier.name}.`
      : 'Foundry has no purchase orders recorded yet.' };
    const first = rows[0];
    const confirmation = first.confirmed ? `${first.supplier} has confirmed ${first.label}.`
      : `Foundry has not recorded a confirmation for ${first.label}.`;
    const timing = first.expected && first.expected < new Date().toISOString().slice(0, 10) && first.outstanding > 0
      ? ` It is past its expected date with ${first.outstanding} unit(s) outstanding${first.latestEvidence ? `; the latest supplier evidence is ${first.latestEvidence.replaceAll('_', ' ')}` : ' and no newer supplier update is recorded'}.`
      : ` ${first.outstanding} unit(s) remain outstanding${first.expected ? `, expected ${first.expected}` : ''}.`;
    return { rows, answer: rows.length === 1 ? `${confirmation}${timing}`
      : `${rows.length} order(s) are recorded for ${supplier?.name || 'this scope'}; ${rows.reduce((n, row) => n + Number(row.outstanding), 0)} unit(s) remain outstanding.` };
  },

  /** Consequential differences extracted from a supplier document. */
  supplier_document_changes(db, workspaceId, plan) {
    const query = plan.entityQuery;
    const params = [workspaceId];
    let filter = '';
    if (query) {
      filter = ` AND (d.document_reference LIKE ? ESCAPE '\\' OR po.po_number LIKE ? ESCAPE '\\'
        OR s.name LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\')`;
      params.push(like(query), like(query), like(query), like(query));
    }
    const docs = db.prepare(`SELECT d.id, d.document_type, d.document_reference, d.discrepancies,
        d.processed_at, d.status, po.po_number, s.name AS supplier_name
      FROM supplier_documents d
      LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
      LEFT JOIN suppliers s ON s.id = d.supplier_id
      JOIN connection_email_messages m ON m.id = d.message_id
      WHERE d.workspace_id = ?${filter} ORDER BY d.processed_at DESC, d.rowid DESC LIMIT ?`)
      .all(...params, plan.limit);
    if (!docs.length) return { rows: [], answer: query
      ? `Foundry could not find a supplier document matching "${query}".`
      : 'Foundry has not processed any supplier documents yet.' };
    const rows = docs.map((doc) => {
      let differences = [];
      try { differences = JSON.parse(doc.discrepancies || '[]'); } catch { differences = []; }
      return { label: doc.document_reference || doc.document_type.replaceAll('_', ' '), supplier: doc.supplier_name,
        purchaseOrder: doc.po_number, type: doc.document_type.replaceAll('_', ' '),
        differences: differences.map((entry) => entry.message).filter(Boolean).join(' ') || 'No consequential difference',
        received: doc.processed_at };
    });
    return { rows, answer: rows[0].differences === 'No consequential difference'
      ? `${rows[0].label} matched the recorded order; Foundry found no consequential difference.`
      : `${rows[0].supplier || 'The supplier'} changed: ${rows[0].differences}` };
  },

  /** Evidence-backed supplier price increases in the requested period. */
  supplier_price_changes(db, workspaceId, plan) {
    const query = plan.entityQuery;
    const params = [workspaceId];
    let filter = '';
    if (query) { filter = ` AND s.name LIKE ? ESCAPE '\\'`; params.push(like(query)); }
    const history = db.prepare(`SELECT h.supplier_id, h.sku_id, h.unit_cost, h.currency, h.observed_at,
        s.name AS supplier, i.name, sk.variant_label
      FROM supplier_price_history h JOIN suppliers s ON s.id = h.supplier_id
      JOIN skus sk ON sk.id = h.sku_id JOIN items i ON i.id = sk.item_id
      WHERE h.workspace_id = ?${filter}
      ORDER BY h.supplier_id, h.sku_id, h.observed_at, h.rowid`).all(...params);
    if (query && !history.length) return { rows: [], answer: `Foundry could not find supplier price evidence matching "${query}".` };
    const cutoff = Date.parse(since(plan.windowDays));
    const previous = new Map(); const changes = [];
    for (const row of history) {
      const key = `${row.supplier_id}:${row.sku_id}`;
      const prior = previous.get(key);
      if (prior && Date.parse(row.observed_at) >= cutoff && Number(row.unit_cost) > Number(prior.unit_cost)) {
        const percent = Number(prior.unit_cost) === 0 ? 100
          : round((Number(row.unit_cost) - Number(prior.unit_cost)) / Number(prior.unit_cost) * 100, 1);
        changes.push({ label: row.variant_label ? `${row.name} — ${row.variant_label}` : row.name,
          supplier: row.supplier, previous: prior.unit_cost, current: row.unit_cost,
          increasePercent: percent, currency: row.currency, observed: row.observed_at });
      }
      previous.set(key, row);
    }
    const rows = changes.sort((a, b) => Date.parse(b.observed) - Date.parse(a.observed)).slice(0, plan.limit);
    return { rows, answer: rows.length
      ? `${rows.length} supplier price increase(s) were recorded in the last ${plan.windowDays} day(s). ${rows[0].label} from ${rows[0].supplier} increased from ${rows[0].previous} to ${rows[0].current} (${rows[0].increasePercent}%).`
      : `No supplier price increases were recorded in the last ${plan.windowDays} day(s).` };
  },
  selling_price(db, workspaceId, plan) {
    const prices = require('../pricing/price-service');
    const skus = resolveSkus(db, workspaceId, plan.entityQuery, plan.limit);
    if (!skus.length) return { rows: [], answer: notFound(plan) };
    const rows = skus.map((sku) => {
      const current = prices.currentForSku(db, workspaceId, sku.id);
      return { label: label(sku), code: sku.code, price: current.formatted };
    });
    return {
      rows,
      answer: rows.length === 1
        ? `${rows[0].label} is priced at ${rows[0].price}.`
        : `Current selling prices for ${rows.length} stock lines.`,
      columns: ['label', 'code', 'price'],
    };
  },
  sales_summary(db, workspaceId) {
    const orders = db.prepare(
      `SELECT COUNT(*) AS openOrders FROM sales_orders
        WHERE workspace_id = ? AND status NOT IN ('FULFILLED','CANCELLED')`
    ).get(workspaceId).openOrders;
    const totals = db.prepare(
      `SELECT COALESCE(SUM(sol.quantity_ordered), 0) AS ordered,
              COALESCE(SUM(sol.quantity_fulfilled), 0) AS fulfilled,
              COALESCE(SUM((SELECT COALESCE(SUM(a.quantity), 0) FROM sales_order_allocations a
                             WHERE a.sales_order_line_id = sol.id)), 0) AS committed
         FROM sales_order_lines sol JOIN sales_orders so ON so.id = sol.sales_order_id
        WHERE sol.workspace_id = ? AND so.status NOT IN ('CANCELLED')`
    ).get(workspaceId);
    const waiting = Math.max(0, Number(totals.ordered) - Number(totals.fulfilled) - Number(totals.committed));
    const rows = [
      { measure: 'Open orders', value: orders },
      { measure: 'Ordered units', value: totals.ordered },
      { measure: 'Committed units', value: totals.committed },
      { measure: 'Waiting for stock', value: waiting },
      { measure: 'Fulfilled units', value: totals.fulfilled },
    ];
    return {
      rows,
      answer: `${orders} open sales order${orders === 1 ? '' : 's'}; ${totals.committed} units committed and ${waiting} waiting for stock.`,
      columns: ['measure', 'value'],
    };
  },
  connection_summary(db, workspaceId) {
    const service = require('../connections/service');
    const connections = service.refreshHealth(db, workspaceId);
    const rows = connections.map((connection) => ({
      connection: connection.display_name,
      status: connection.publicStatus,
      lastActivity: connection.last_activity_at || 'No activity received',
      issues: connection.openIssues,
      provides: connection.provides.join(', '),
    }));
    const attention = rows.filter((row) => row.status === 'Needs attention').length;
    return { rows,
      answer: rows.length
        ? `${rows.length} connection${rows.length === 1 ? '' : 's'}: ${attention} need${attention === 1 ? 's' : ''} attention.`
        : 'No external systems are connected yet.',
      columns: ['connection', 'status', 'lastActivity', 'issues', 'provides'] };
  },
  connection_last_event(db, workspaceId, plan) {
    const all = db.prepare('SELECT id, display_name FROM workspace_connectors WHERE workspace_id = ? ORDER BY updated_at DESC')
      .all(workspaceId);
    const terms = searchTerms(plan.entityQuery);
    const selected = terms.length
      ? all.find((row) => terms.every((term) => row.display_name.toLowerCase().includes(term)))
      : all[0];
    if (!selected) return { rows: [], answer: 'No matching connection is configured.' };
    const event = db.prepare(`SELECT external_event_id, event_type, status, occurred_at, received_at, action_type, error_message
      FROM connector_feed_events WHERE workspace_id = ? AND connector_id = ? ORDER BY received_at DESC, rowid DESC LIMIT 1`)
      .get(workspaceId, selected.id);
    if (!event) return { rows: [], answer: `${selected.display_name} has not delivered any events yet.` };
    const rows = [{ connection: selected.display_name, eventId: event.external_event_id, type: event.event_type,
      status: event.status, occurred: event.occurred_at || 'Not supplied', received: event.received_at,
      foundryAction: event.action_type || 'None', problem: event.error_message || '' }];
    return { rows,
      answer: `The last event from ${selected.display_name} was ${event.event_type} (${event.external_event_id}), received ${event.received_at}. Its status is ${event.status}.`,
      columns: ['connection', 'eventId', 'type', 'status', 'occurred', 'received', 'foundryAction', 'problem'] };
  },
  connection_mapping_issues(db, workspaceId, plan) {
    const terms = searchTerms(plan.entityQuery);
    const connections = db.prepare('SELECT id, display_name, provider_type FROM workspace_connectors WHERE workspace_id = ?')
      .all(workspaceId);
    const selected = terms.length ? connections.find((row) => {
      const text = `${row.display_name} ${row.provider_type}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    }) : connections[0];
    if (!selected) return { rows: [], answer: 'No matching connection is configured.' };
    const rows = db.prepare(`SELECT entity_type AS type, display_name AS externalRecord, code,
      external_id AS externalId FROM connection_external_records WHERE workspace_id = ? AND connector_id = ?
      AND selected = 1 AND mapping_status = 'UNMAPPED' ORDER BY entity_type, display_name COLLATE NOCASE`)
      .all(workspaceId, selected.id);
    return { rows, answer: rows.length
      ? `${selected.display_name} has ${rows.length} product or location match${rows.length === 1 ? '' : 'es'} waiting for you.`
      : `${selected.display_name} has no unresolved product or location mappings.`,
    columns: ['type', 'externalRecord', 'code', 'externalId'] };
  },
  connection_diagnostics(db, workspaceId, plan) {
    const service = require('../connections/service');
    const all = service.refreshHealth(db, workspaceId);
    const terms = searchTerms(plan.entityQuery);
    const selected = terms.length ? all.find((row) => {
      const text = `${row.display_name} ${row.provider_type}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    }) : all[0];
    if (!selected) return { rows: [], answer: 'No matching connection is configured.' };
    const last = db.prepare(`SELECT event_type, status, received_at, error_message FROM connector_feed_events
      WHERE workspace_id = ? AND connector_id = ? ORDER BY received_at DESC, rowid DESC LIMIT 1`)
      .get(workspaceId, selected.id);
    const rows = [{ connection: selected.display_name, status: selected.publicStatus,
      lastEvent: last ? `${last.event_type} · ${last.status}` : 'No event received',
      received: last?.received_at || '', mappingsNeeded: selected.itemsNeedingMapping,
      problem: selected.last_error || last?.error_message || (selected.openIssues ? `${selected.openIssues} issue(s) need attention` : '') }];
    const reason = selected.publicStatus === 'Connected' && last
      ? `The connection is active; its last event arrived ${last.received_at}.`
      : selected.publicStatus === 'Connected'
        ? 'The connection is active, but it has not delivered an event yet.'
        : `Its status is ${selected.publicStatus}${selected.last_error ? `: ${selected.last_error}` : '.'}`;
    return { rows, answer: `${selected.display_name}: ${reason} ${selected.itemsNeedingMapping ? `${selected.itemsNeedingMapping} mapping${selected.itemsNeedingMapping === 1 ? '' : 's'} still need you.` : ''}`.trim(),
      columns: ['connection', 'status', 'lastEvent', 'received', 'mappingsNeeded', 'problem'] };
  },
  stock_level(db, workspaceId, plan) {
    const allSkus = resolveSkus(db, workspaceId, plan.entityQuery, 100000);
    if (allSkus.length === 0) return { rows: [], answer: notFound(plan) };
    const skus = allSkus.slice(0, plan.limit);

    const totals = db.prepare(
      'SELECT COALESCE(SUM(on_hand), 0) AS onHand FROM balances WHERE workspace_id = ? AND sku_id = ?'
    );
    const answerRows = allSkus.map((sku) => ({
      label: label(sku),
      code: sku.code,
      onHand: totals.get(workspaceId, sku.id).onHand,
      unitLabel: sku.unit_label,
    }));
    const rows = answerRows.slice(0, plan.limit);

    const total = answerRows.reduce((sum, row) => sum + row.onHand, 0);
    const unitLabels = [...new Set(answerRows.map((row) => row.unitLabel).filter(Boolean))];
    const unit = unitLabels.length === 1 ? unitLabels[0] : 'unit';
    const totalLabel = `${total} ${unit}${total === 1 ? '' : 's'}`;
    const least = [...answerRows].sort((a, b) => a.onHand - b.onHand || a.label.localeCompare(b.label))[0];
    const answer = answerRows.length === 1
      ? `${answerRows[0].label}: ${totalLabel} on hand.`
      : `${totalLabel} on hand across ${answerRows.length} stock positions. ` +
        `Lowest is ${least.label} at ${least.onHand} ${least.unitLabel}${least.onHand === 1 ? '' : 's'}.`;
    return { rows, answer, columns: ['label', 'code', 'onHand'] };
  },

  stock_by_location(db, workspaceId, plan) {
    const skus = resolveSkus(db, workspaceId, plan.entityQuery, plan.limit);
    if (skus.length === 0) return { rows: [], answer: notFound(plan) };
    const ids = skus.map((s) => s.id);
    const placeholders = ids.map(() => '?').join(',');

    const rows = db
      .prepare(
        `SELECT l.name AS location, i.name AS name, s.variant_label, b.on_hand AS onHand
           FROM balances b
           JOIN locations l ON l.id = b.location_id
           JOIN skus s ON s.id = b.sku_id
           JOIN items i ON i.id = s.item_id
          WHERE b.workspace_id = ? AND b.sku_id IN (${placeholders}) AND b.on_hand <> 0
          ORDER BY b.on_hand DESC LIMIT ?`
      )
      .all(workspaceId, ...ids, MAX_ROWS)
      .map((r) => ({ location: r.location, label: label(r), onHand: r.onHand }));

    const answer = rows.length
      ? `${rows.map((r) => `${r.location}: ${r.onHand}`).join('; ')}.`
      : 'There is none on hand at any location.';
    return { rows, answer, columns: ['location', 'label', 'onHand'] };
  },

  movement_history(db, workspaceId, plan) {
    const skus = resolveSkus(db, workspaceId, plan.entityQuery, plan.limit);
    const location = resolveLocation(db, workspaceId, plan.locationQuery);
    const filters = ['m.workspace_id = ?', 'm.occurred_at >= ?'];
    const params = [workspaceId, since(plan.windowDays)];

    if (plan.entityQuery) {
      if (skus.length === 0) return { rows: [], answer: notFound(plan) };
      filters.push(`m.sku_id IN (${skus.map(() => '?').join(',')})`);
      params.push(...skus.map((s) => s.id));
    }
    if (location) {
      filters.push('m.location_id = ?');
      params.push(location.id);
    }

    const rows = db
      .prepare(
        `SELECT m.occurred_at AS occurredAt, m.operation, m.quantity_delta AS delta,
                i.name AS name, s.variant_label, l.name AS location, u.name AS actor,
                m.reason_code AS reason
           FROM movements m
           JOIN skus s ON s.id = m.sku_id
           JOIN items i ON i.id = m.item_id
           JOIN locations l ON l.id = m.location_id
           JOIN users u ON u.id = m.actor_user_id
          WHERE ${filters.join(' AND ')}
          ORDER BY m.occurred_at DESC, m.seq DESC LIMIT ?`
      )
      .all(...params, plan.limit)
      .map((r) => ({ ...r, label: label(r) }));

    const answer = rows.length
      ? `${rows.length} movement${rows.length === 1 ? '' : 's'} in the last ${plan.windowDays} days.`
      : `No movements in the last ${plan.windowDays} days.`;
    return { rows, answer, columns: ['occurredAt', 'operation', 'label', 'location', 'delta', 'actor'] };
  },

  recent_adjustments(db, workspaceId, plan) {
    const rows = db
      .prepare(
        `SELECT a.created_at AS occurredAt, a.expected_qty AS expected, a.counted_qty AS counted,
                (a.counted_qty - a.expected_qty) AS delta, a.reason_code AS reason,
                i.name AS name, s.variant_label, l.name AS location, u.name AS actor
           FROM adjustments a
           JOIN skus s ON s.id = a.sku_id
           JOIN items i ON i.id = s.item_id
           JOIN locations l ON l.id = a.location_id
           JOIN users u ON u.id = a.actor_user_id
          WHERE a.workspace_id = ? AND a.created_at >= ?
          ORDER BY ABS(a.counted_qty - a.expected_qty) DESC, a.created_at DESC LIMIT ?`
      )
      .all(workspaceId, since(plan.windowDays), plan.limit)
      .map((r) => ({ ...r, label: label(r) }));

    const answer = rows.length
      ? `${rows.length} correction${rows.length === 1 ? '' : 's'} in the last ${plan.windowDays} days, ` +
        `largest ${rows[0].delta > 0 ? '+' : ''}${rows[0].delta} on ${rows[0].label}.`
      : `No stock corrections were recorded in the last ${plan.windowDays} days.`;
    return { rows, answer, columns: ['occurredAt', 'label', 'location', 'expected', 'counted', 'delta', 'actor'] };
  },

  expiring_soon(db, workspaceId, plan) {
    const rows = db
      .prepare(
        `SELECT lo.code AS lot, lo.expires_at AS expiresAt, i.name AS name, s.variant_label,
                COALESCE(SUM(lb.quantity), 0) AS quantity
           FROM lots lo
           JOIN skus s ON s.id = lo.sku_id
           JOIN items i ON i.id = s.item_id
           LEFT JOIN lot_balances lb ON lb.lot_id = lo.id
          WHERE lo.workspace_id = ? AND lo.expires_at IS NOT NULL AND lo.expires_at <= ?
          GROUP BY lo.id HAVING quantity > 0
          ORDER BY lo.expires_at LIMIT ?`
      )
      .all(workspaceId, new Date(Date.now() + plan.windowDays * 86400000).toISOString(), plan.limit)
      .map((r) => ({ ...r, label: label(r) }));

    const answer = rows.length
      ? `${rows.length} lot${rows.length === 1 ? '' : 's'} expire within ${plan.windowDays} days.`
      : `No lots expire within the next ${plan.windowDays} days.`;
    return { rows, answer, columns: ['lot', 'label', 'quantity', 'expiresAt'] };
  },

  idle_stock(db, workspaceId, plan) {
    const rows = db
      .prepare(
        `SELECT i.name AS name, s.variant_label, SUM(b.on_hand) AS onHand,
                MAX((SELECT MAX(m.occurred_at) FROM movements m
                      WHERE m.sku_id = s.id AND m.quantity_delta < 0)) AS lastOutbound
           FROM balances b
           JOIN skus s ON s.id = b.sku_id
           JOIN items i ON i.id = s.item_id
          WHERE b.workspace_id = ? AND b.on_hand > 0
          GROUP BY s.id
         HAVING lastOutbound IS NULL OR lastOutbound < ?
          ORDER BY onHand DESC LIMIT ?`
      )
      .all(workspaceId, since(plan.windowDays), plan.limit)
      .map((r) => ({
        label: label(r),
        onHand: r.onHand,
        lastOutbound: r.lastOutbound ? r.lastOutbound.slice(0, 10) : 'never issued',
      }));

    const answer = rows.length
      ? `${rows.length} line${rows.length === 1 ? '' : 's'} have not been issued in ${plan.windowDays} days.`
      : `Everything on hand has moved within the last ${plan.windowDays} days.`;
    return { rows, answer, columns: ['label', 'onHand', 'lastOutbound'] };
  },

  top_moving(db, workspaceId, plan) {
    const rows = db
      .prepare(
        `SELECT i.name AS name, s.variant_label, SUM(-m.quantity_delta) AS issued,
                COUNT(*) AS movements
           FROM movements m
           JOIN skus s ON s.id = m.sku_id
           JOIN items i ON i.id = s.item_id
          WHERE m.workspace_id = ? AND m.operation = 'issue' AND m.occurred_at >= ?
          GROUP BY s.id ORDER BY issued DESC LIMIT ?`
      )
      .all(workspaceId, since(plan.windowDays), plan.limit)
      .map((r) => ({ label: label(r), issued: r.issued, movements: r.movements }));

    const answer = rows.length
      ? `Over the last ${plan.windowDays} days the busiest was ${rows[0].label} at ${rows[0].issued} issued.`
      : `Nothing was issued in the last ${plan.windowDays} days.`;
    return { rows, answer, columns: ['label', 'issued', 'movements'] };
  },

  attention_summary(db, workspaceId, plan) {
    const items = attention.listAttention(db, workspaceId, { limit: plan.limit });
    const counts = attention.summarise(items);
    const rows = items.map((i) => ({
      label: i.title,
      severity: i.severity,
      summary: i.conciseSummary,
      attentionId: i.attentionId,
    }));
    const answer = counts.healthy
      ? 'Nothing needs your attention right now.'
      : `${counts.total} open: ${counts.critical} urgent, ${counts.important} important, ${counts.watch} to watch.`;
    return { rows, answer, columns: ['severity', 'label', 'summary'] };
  },

  action(db, workspaceId, plan) {
    return {
      rows: [],
      answer: 'That is something Foundry can carry out rather than look up.',
      columns: [],
      supported: false,
      isAction: true,
    };
  },

  unsupported(db, workspaceId, plan) {
    return {
      rows: [],
      answer:
        plan.unsupportedReason ||
        'Foundry can answer questions about stock levels, movements, corrections, expiry and what needs attention. That one is outside what it can look up.',
      columns: [],
      supported: false,
    };
  },
};

/**
 * "What did you do today?"
 *
 * Straight from the work records. A day with nothing on it says so — inventing
 * activity to look busy would poison every other answer on this page.
 */
function foundryActivity(db, workspaceId, plan, options = {}) {
  const autopilotPresenter = require('../autopilot/presenter');
  const summary = autopilotPresenter.summariseDay(db, workspaceId);
  const setupRows = db.prepare(
    `SELECT source_name, result, applied_at
       FROM setup_documents
      WHERE workspace_id = ? AND status = 'APPLIED' AND date(applied_at) = date('now')
      ORDER BY applied_at DESC`
  ).all(workspaceId).map((row) => {
    const result = JSON.parse(row.result || '{}');
    const units = Number(result.units || 0);
    const unit = result.unitLabel || 'unit';
    return {
      what: `Set up inventory from ${row.source_name}`,
      detail:
        `Created ${result.products || 0} products and ${result.variants || 0} variants; ` +
        `received ${units} ${unit}${units === 1 ? '' : 's'} into ${result.location || 'the recorded location'}; ` +
        `linked ${result.supplier || 'the supplier'} and recorded purchase order ${result.poNumber || 'from the document'}.`,
      verified: 'yes',
    };
  });
  const workRows = summary.did.actions.map((action) => ({
    what: action.headline,
    detail: action.detail || '',
    verified: action.verified ? 'yes' : 'not verified',
  }));
  const rows = [...setupRows, ...workRows];
  const activityLines = [
    ...setupRows.map((row) => `${row.what}. ${row.detail}`),
    ...(workRows.length ? summary.lines : []),
  ];

  const question = String(options.question || '').toLowerCase();
  if (/what\s+(?:do\s+you\s+)?need|need\s+from\s+me|needs?\s+my\s+attention/.test(question)) {
    const readiness = require('../manager/readiness').decisions(db, workspaceId);
    if (readiness.length) {
      activityLines.push(`What needs you: ${readiness.map((item) => `${item.title}. ${item.because}`).join(' ')}`);
    } else {
      activityLines.push('Nothing needs you right now.');
    }
  }

  return {
    answer: activityLines.length ? activityLines.join('\n') : summary.lines.join('\n'),
    rows,
    columns: ['what', 'detail', 'verified'],
  };
}

/**
 * "Why did you move those tights?"
 *
 * Answered from the most recent matching piece of work: the measurements that
 * triggered it, the policy that allowed it, and the verified result.
 */
function foundryWhy(db, workspaceId, plan) {
  const autopilotPresenter = require('../autopilot/presenter');
  const workItems = require('../autopilot/work-items');
  const businessBrain = require('../manager/business-brain');

  // Purchasing is a cross-business story, not only an autopilot work item.
  // Match against the PO, supplier, products, variants and ordered quantities,
  // then use the shared trace that also powers consistency and owner reporting.
  const purchaseCandidates = db.prepare(`SELECT po.id, po.po_number, s.name AS supplier_name,
      GROUP_CONCAT(i.name || ' ' || COALESCE(sk.variant_label, '') || ' '
        || CAST(pol.quantity_units AS TEXT), ' ') AS line_text
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
    JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
    JOIN skus sk ON sk.id = pol.sku_id JOIN items i ON i.id = sk.item_id
    WHERE po.workspace_id = ?
    GROUP BY po.id ORDER BY po.created_at DESC LIMIT 50`).all(workspaceId);
  const wantedTerms = searchTerms(plan.entityQuery);
  const purchase = wantedTerms.length ? purchaseCandidates.find((row) => {
    const evidence = `${row.po_number} ${row.supplier_name} ${row.line_text}`.toLowerCase();
    return wantedTerms.every((term) => evidence.includes(term));
  }) : null;
  if (purchase) {
    const story = businessBrain.purchaseOrderStory(db, workspaceId, purchase.id);
    const explanation = story.explanation;
    return {
      answer: [explanation.whatHappened, explanation.whyKeeperConcludedThis,
        explanation.keeperAction, explanation.whatHappensNext].join(' '),
      handoff: { href: `/purchasing/orders/${purchase.id}`, label: `Open ${purchase.po_number}` },
      rows: [
        { measure: 'What happened', value: explanation.whatHappened },
        { measure: 'Why Foundry concluded this', value: explanation.whyKeeperConcludedThis },
        { measure: 'Evidence used', value: `${explanation.evidenceUsed.length} linked business record(s)` },
        { measure: 'What Foundry did', value: explanation.keeperAction },
        { measure: 'What happens next', value: explanation.whatHappensNext },
      ],
      columns: ['measure', 'value'],
    };
  }

  const recent = workItems.list(db, workspaceId, { limit: 50 });
  const wanted = String(plan.entityQuery || '').trim().toLowerCase();
  const match = wanted
    ? recent.find((item) => {
        const name = ((item.affectedEntities || {}).displayName || '').toLowerCase();
        const supplier = ((item.affectedEntities || {}).supplierName || '').toLowerCase();
        return searchTerms(wanted).every((term) => name.includes(term) || supplier.includes(term));
      })
    : recent.find((item) => item.executionStatus === 'COMPLETED');

  if (!match) {
    return {
      answer: wanted
        ? `Foundry has not done anything to ${plan.entityQuery} that it has a record of.`
        : 'Foundry has not done anything yet.',
      rows: [],
    };
  }

  const explanation = autopilotPresenter.explain(db, workspaceId, match.id);
  return {
    answer: explanation.paragraphs.join(' '),
    rows: explanation.evidence.map((fact) => ({ measure: fact.label, value: String(fact.value) })),
    columns: ['measure', 'value'],
  };
}

/**
 * "Stop automatically moving inventory."
 *
 * Names the policies that would be switched off and hands over — turning
 * something off is a decision, so it is made on a screen with a button rather
 * than inferred from a sentence.
 */
function stopAutomation(db, workspaceId, plan) {
  const policyService = require('../autopilot/policy-service');
  const active = policyService.list(db, workspaceId, { activeOnly: true });

  if (!active.length) {
    return {
      answer: 'Foundry is not doing anything automatically — every action already waits for you.',
      rows: [],
    };
  }
  return {
    // Not `isAction` — that hands over to the actions page, which changes stock.
    // Switching a policy off is a different decision, made in a different place.
    handoff: { href: '/autopilot', label: 'Manage what Foundry does on its own' },
    answer:
      `Foundry has ${active.length} active polic${active.length === 1 ? 'y' : 'ies'}: ` +
      `${active.map((policy) => policy.name).join(', ')}. Turn it off on the policy page — ` +
      'anything already done stays in the history.',
    rows: active.map((policy) => ({ policy: policy.name, allows: policyService.describe(policy)[0] })),
    columns: ['policy', 'allows'],
  };
}

function notFound(plan) {
  return `Foundry could not find anything matching "${plan.entityQuery}".`;
}

/**
 * Runs a plan. Read-only by construction: there is no statement here that can
 * write, and the executor map is the entire surface a plan can reach.
 */
Object.assign(EXECUTORS, PURCHASING_EXECUTORS);

const PROFIT_WORDS = ['profit', 'profitable', 'making money', 'earning', 'in the black'];
const LOSS_WORDS = ['loss', 'lose', 'losing', 'lost', 'in the red'];

/**
 * Intents whose question is really "is there any?".
 *
 * Most of these executors return the things themselves — the late orders, the
 * lots expiring, the bills due — so whether there are any is a fact already in
 * hand. What each one needs is the words that ask for it, and the words that
 * ask for its opposite, because "are any orders late?" and "is everything on
 * time?" want opposite answers from the same row count.
 *
 * A question matching neither list gets no verdict at all. That is the whole
 * safety of this: Foundry only agrees or disagrees when it knows which
 * proposition it is being asked about.
 */
const LIST_VERDICTS = {
  late_orders: {
    asserts: ['late', 'overdue', 'delayed', 'behind'],
    opposite: ['on time', 'on schedule'],
    some: (n) => `${n} order${n === 1 ? ' is' : 's are'} late.`,
    none: 'nothing is late.',
  },
  expiring_soon: {
    asserts: ['expir', 'use by', 'best before', 'going off', 'out of date'],
    opposite: ['in date', 'still good'],
    some: (n) => `${n} lot${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} expiring soon.`,
    none: 'nothing is expiring soon.',
  },
  idle_stock: {
    asserts: ['idle', 'not moving', 'not selling', 'stuck', 'dead stock', 'sitting'],
    opposite: ['moving', 'selling'],
    some: (n) => `${n} product${n === 1 ? ' is' : 's are'} not moving.`,
    none: 'everything has moved recently.',
  },
  // replenishment is deliberately absent. Its rows mean different things in
  // different branches — recommendations in one, lines it cannot assess in
  // another — so a uniform "any rows means yes" would answer "13 lines need
  // ordering" about thirteen lines the executor had just said it has no basis
  // to judge. It states its own verdict, per branch, below.
  on_order: {
    asserts: ['on order', 'coming', 'arriving', 'ordered', 'on the way', 'incoming'],
    opposite: ['nothing coming', 'nothing on order'],
    some: (n) => `${n} order${n === 1 ? ' is' : 's are'} on the way.`,
    none: 'nothing is on order.',
  },
  customer_orders_at_risk: {
    asserts: ['risk', 'short', 'late', 'miss', 'unable', 'problem'],
    opposite: ['covered', 'fine', 'on track'],
    some: (n) => `${n} customer order${n === 1 ? ' is' : 's are'} at risk.`,
    none: 'no customer order is at risk.',
  },
  bills_due: {
    asserts: ['owe', 'due', 'pay', 'bill', 'outstanding'],
    opposite: ['paid up', 'settled', 'clear'],
    some: (n) => `${n} bill${n === 1 ? ' is' : 's are'} due.`,
    none: 'no bills are due.',
  },
  receivables_aging: {
    asserts: ['owe me', 'owed', 'unpaid', 'customers owe', 'receivable'],
    opposite: ['paid', 'settled'],
    some: (n) => `${n} customer invoice${n === 1 ? ' is' : 's are'} unpaid.`,
    none: 'no customer owes you anything.',
  },
  payables_aging: {
    asserts: ['owe', 'supplier', 'payable', 'unpaid'],
    opposite: ['paid up', 'settled', 'clear'],
    some: (n) => `${n} supplier bill${n === 1 ? ' is' : 's are'} unpaid.`,
    none: 'you owe your suppliers nothing.',
  },
  connection_mapping_issues: {
    asserts: ['unmapped', 'mapping', 'match', 'unmatched', 'issue', 'problem'],
    opposite: ['all mapped', 'all matched', 'fine'],
    some: (n) => `${n} record${n === 1 ? '' : 's'} still need${n === 1 ? 's' : ''} matching.`,
    none: 'everything from your connections is matched.',
  },
  recent_adjustments: {
    asserts: ['adjust', 'correction', 'changed', 'written off', 'shrink'],
    opposite: ['no adjustments', 'untouched'],
    some: (n) => `${n} adjustment${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} recorded.`,
    none: 'no adjustments were recorded.',
  },
  supplier_price_changes: {
    asserts: ['price change', 'gone up', 'increase', 'cheaper', 'more expensive', 'changed'],
    opposite: ['same price', 'unchanged', 'held'],
    some: (n) => `${n} supplier price${n === 1 ? ' has' : 's have'} changed.`,
    none: 'no supplier prices have changed.',
  },
  attention_summary: {
    asserts: ['wrong', 'attention', 'problem', 'issue', 'need me', 'needs me', 'anything i should'],
    opposite: ['all clear', 'all fine', 'all good', 'nothing wrong'],
    some: (n) => `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you.`,
    none: 'nothing needs you right now.',
  },
};

// The words a question starts with when it wants a yes or a no. 'How much'
// and 'why' do not, and prefixing those with 'Yes' would be noise.
const VERDICT_OPENERS = new Set(['have','has','had','did','do','does','is','are','am','was','were','can','should','will','any']);

/**
 * Answers the question that was actually asked, before stating the figures.
 *
 * Every answer here is assembled from real numbers rather than written by a
 * model, which is why Foundry cannot invent one. But a template states a fact
 * regardless of what was asked, so "Have I made any profit yet?" — a yes or no
 * question — was answered "This is 9.92 net profit based on the expenses
 * recorded in Foundry for 2026-08-03 through 2026-09-01: ...". Every figure
 * correct, and not an answer. An accountant asked that question says "Yes,
 * about a hundred dollars" and then tells you what it excludes.
 *
 * So an executor that knows its question has a yes-or-no form says so, and the
 * evidence follows the answer instead of replacing it. Executors that cannot
 * be reduced to a verdict return nothing here and read exactly as before.
 */
function leadWithTheAnswer(question, result) {
  if (!result || !result.verdict || !result.answer) return result;
  const asked = String(question || '').trim().toLowerCase();
  const firstWord = asked.split(/[^a-z]+/).filter(Boolean)[0] || '';
  if (!VERDICT_OPENERS.has(firstWord)) return result;

  /*
   * Which proposition the question actually makes.
   *
   * A verdict is only safe when Foundry knows what it is agreeing with. The
   * first version answered "Am I making a loss?" with "Yes — 4.50 so far"
   * about a profitable month, because it asserted its own proposition and
   * ignored the questioner's. Being confidently wrong is worse than the
   * unshaped answer it replaced.
   *
   * So the executor states what its verdict asserts, and unless the question
   * plainly asks about that or its opposite, no verdict is offered and the
   * evidence stands alone — the same rule the rest of Foundry follows.
   */
  const { yes, summary, asserts, opposite } = result.verdict;
  /*
   * The longer phrase decides.
   *
   * "Is anything not moving?" contains both "not moving" and "moving", so a
   * plain contains-check saw the question assert and deny the same thing and
   * gave up. The more specific phrase is the one the reader meant.
   */
  const longestMatch = (words) => (words || [])
    .filter((word) => asked.includes(word))
    .reduce((longest, word) => Math.max(longest, word.length), 0);
  const positive = longestMatch(asserts);
  const negative = longestMatch(opposite);
  if (positive === negative) return result;

  const answersYes = negative > positive ? !yes : yes;
  const opening = summary
    ? (answersYes ? 'Yes — ' : 'No — ') + summary
    : (answersYes ? 'Yes.' : 'No.');
  return { ...result, answer: opening + ' ' + result.answer };
}
function execute(db, workspaceId, rawPlan, options = {}) {
  const plan = normalisePlan(rawPlan);
  const executor = EXECUTORS[plan.intent] || EXECUTORS.unsupported;
  const started = Date.now();
  const executed = executor(db, workspaceId, plan, options);

  // An executor may state its own verdict; otherwise, for the intents whose
  // question is "is there any?", the rows it returned already answer that.
  const listVerdict = LIST_VERDICTS[plan.intent];
  const withVerdict = executed.verdict || !listVerdict || !Array.isArray(executed.rows)
    ? executed
    : { ...executed,
        verdict: {
          yes: executed.rows.length > 0,
          asserts: listVerdict.asserts,
          opposite: listVerdict.opposite,
          summary: executed.rows.length
            ? listVerdict.some(executed.rows.length)
            : listVerdict.none,
        } };
  const result = leadWithTheAnswer(options.question, withVerdict);
  return {
    plan,
    isAction: result.isAction === true,
    handoff: result.handoff || null,
    supported: result.supported !== false,
    answer: result.answer,
    rows: result.rows,
    columns: result.columns || [],
    rowCount: result.rows.length,
    durationMs: round(Date.now() - started, 0),
  };
}

module.exports = {
  INTENTS,
  MAX_ROWS,
  MAX_WINDOW_DAYS,
  normalisePlan,
  execute,
  searchTerms,
  resolveSkus,
  EXECUTORS,
};
