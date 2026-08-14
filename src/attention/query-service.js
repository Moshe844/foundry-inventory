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
  'on_order',
  'late_orders',
  'last_cost',
  'suppliers_for_item',
  'unsupported',
];

const MAX_ROWS = 25;
const MAX_WINDOW_DAYS = 365;

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
function searchTerms(query) {
  return String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3)
    .map((word) => (word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word))
    .slice(0, 6);
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
      const blocked = result.blocked.length;
      return {
        rows: [],
        answer:
          covered || blocked
            ? `Nothing needs ordering right now. ${covered} line(s) are above their reorder point or already covered by stock on order` +
              (blocked ? `, and ${blocked} cannot be assessed yet.` : '.')
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
  stock_level(db, workspaceId, plan) {
    const skus = resolveSkus(db, workspaceId, plan.entityQuery, plan.limit);
    if (skus.length === 0) return { rows: [], answer: notFound(plan) };

    const totals = db.prepare(
      'SELECT COALESCE(SUM(on_hand), 0) AS onHand FROM balances WHERE workspace_id = ? AND sku_id = ?'
    );
    const rows = skus.map((sku) => ({
      label: label(sku),
      code: sku.code,
      onHand: totals.get(workspaceId, sku.id).onHand,
      unitLabel: sku.unit_label,
    }));

    const answer =
      rows.length === 1
        ? `${rows[0].label}: ${rows[0].onHand} ${rows[0].unitLabel}${rows[0].onHand === 1 ? '' : 's'} on hand.`
        : `${rows.length} lines matched. ${rows
            .slice(0, 5)
            .map((r) => `${r.label}: ${r.onHand}`)
            .join('; ')}.`;
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

function notFound(plan) {
  return `Foundry could not find anything matching "${plan.entityQuery}".`;
}

/**
 * Runs a plan. Read-only by construction: there is no statement here that can
 * write, and the executor map is the entire surface a plan can reach.
 */
Object.assign(EXECUTORS, PURCHASING_EXECUTORS);

function execute(db, workspaceId, rawPlan) {
  const plan = normalisePlan(rawPlan);
  const executor = EXECUTORS[plan.intent] || EXECUTORS.unsupported;
  const started = Date.now();
  const result = executor(db, workspaceId, plan);
  return {
    plan,
    isAction: result.isAction === true,
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
