'use strict';

/*
 * "Use UPS Ground automatically if it arrives by the promised date and costs
 * under $25. Ask me otherwise."
 *
 * Stored as three conditions and a choice, not as that sentence. A sentence
 * has to be re-read every time a parcel is ready, and a reader that is right
 * ninety-nine times out of a hundred is wrong about one parcel a week — which,
 * for a rule that spends money, is not a rounding error.
 *
 * So the sentence is read once, by a person or by Tell Foundry, and what is
 * kept is what it meant. The original words are kept beside it so the owner
 * can see that Foundry understood them, and change it if it did not.
 *
 * Every rule is a permission to spend within limits. It can only ever choose
 * between rates a carrier has actually quoted, it can never pick one that
 * misses the date the customer was promised unless it was told to, and a
 * parcel that no rule covers is not a failure — it is a question, which is
 * what Needs You is for.
 */

const { inTransaction } = require('../db');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, trimOrNull } = require('../lib/util');

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    carrier: row.carrier,
    service: row.service,
    maxCostMinor: row.max_cost_minor === null ? null : Number(row.max_cost_minor),
    requireByPromised: Boolean(row.require_by_promised),
    maxDeliveryDays: row.max_delivery_days === null ? null : Number(row.max_delivery_days),
    active: Boolean(row.is_active),
    statedText: row.stated_text,
  };
}

function list(db, workspaceId, { activeOnly = true } = {}) {
  const clause = activeOnly ? ' AND is_active = 1' : '';
  return db.prepare(`SELECT * FROM shipping_rules WHERE workspace_id = ?${clause}
    ORDER BY created_at`).all(workspaceId).map(hydrate);
}

function get(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM shipping_rules WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId);
  if (!row) throw new NotFoundError('That shipping rule could not be found.');
  return hydrate(row);
}

function save(db, ctx, input = {}) {
  const name = trimOrNull(input.name)
    || describe({ carrier: input.carrier, service: input.service,
      maxCostMinor: input.maxCostMinor, requireByPromised: input.requireByPromised !== false,
      maxDeliveryDays: input.maxDeliveryDays });
  const cost = input.maxCostMinor === null || input.maxCostMinor === undefined || input.maxCostMinor === ''
    ? null : Math.round(Number(input.maxCostMinor));
  if (cost !== null && !(cost > 0)) throw new ValidationError('A spending limit has to be more than nothing.');
  const days = input.maxDeliveryDays === null || input.maxDeliveryDays === undefined || input.maxDeliveryDays === ''
    ? null : Math.round(Number(input.maxDeliveryDays));

  return inTransaction(db, () => {
    const now = nowIso();
    if (input.id) {
      db.prepare(`UPDATE shipping_rules SET name = ?, carrier = ?, service = ?, max_cost_minor = ?,
        require_by_promised = ?, max_delivery_days = ?, is_active = ?, stated_text = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?`)
        .run(name, trimOrNull(input.carrier), trimOrNull(input.service), cost,
          input.requireByPromised === false ? 0 : 1, days,
          input.active === false ? 0 : 1, trimOrNull(input.statedText), now,
          input.id, ctx.workspaceId);
      return get(db, ctx.workspaceId, input.id);
    }
    const id = newId('shiprule');
    db.prepare(`INSERT INTO shipping_rules
      (id, workspace_id, name, carrier, service, max_cost_minor, require_by_promised,
       max_delivery_days, is_active, stated_text, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, name, trimOrNull(input.carrier), trimOrNull(input.service), cost,
        input.requireByPromised === false ? 0 : 1, days,
        input.active === false ? 0 : 1, trimOrNull(input.statedText), ctx.actorId || null, now, now);
    return get(db, ctx.workspaceId, id);
  });
}

function remove(db, ctx, id) {
  db.prepare('UPDATE shipping_rules SET is_active = 0, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(nowIso(), id, ctx.workspaceId);
}

/** The rule, in the owner's own terms, for a screen and for a confirmation. */
function describe(rule) {
  const money = (minor) => `$${(Number(minor) / 100).toFixed(2)}`;
  const service = [rule.carrier ? String(rule.carrier).toUpperCase() : null, rule.service]
    .filter(Boolean).join(' ') || 'the cheapest service';
  const conditions = [];
  if (rule.maxCostMinor) conditions.push(`it costs less than ${money(rule.maxCostMinor)}`);
  if (rule.requireByPromised !== false) conditions.push('it arrives by the date the customer was promised');
  if (rule.maxDeliveryDays) conditions.push(`it arrives within ${rule.maxDeliveryDays} days`);
  return conditions.length
    ? `Use ${service} when ${conditions.join(' and ')}.`
    : `Use ${service}.`;
}

/* ---------------------------------------------------------------- choosing */

const matchesService = (rule, rate) => {
  if (rule.carrier && String(rate.carrier).toLowerCase() !== String(rule.carrier).toLowerCase()) return false;
  if (rule.service && String(rate.service).toLowerCase() !== String(rule.service).toLowerCase()) return false;
  return true;
};

/**
 * Which rate a rule allows Foundry to buy, and why — or why none of them.
 *
 * Returns `{ rate, rule, because }` when a rule covers this parcel, and
 * `{ rate: null, because }` when none does. The second is not an error and is
 * not silence: it is the sentence the owner reads next to the choice they are
 * being asked to make.
 *
 * A rule that names no service picks the cheapest that qualifies, because
 * "under $25 and there by Tuesday" describes a budget rather than a carrier,
 * and inside a budget the cheapest is what anybody would have chosen.
 */
function decide(db, workspaceId, rates, options = {}) {
  const promised = options.promisedDate || null;
  if (!rates.length) return { rate: null, rule: null, because: 'No carrier quoted a rate for this parcel.' };

  const rules = options.rules || list(db, workspaceId);
  if (!rules.length) {
    return { rate: null, rule: null,
      because: 'You have not told Foundry which service to use on its own, so it is asking.' };
  }

  const failures = [];
  for (const rule of rules) {
    const named = rates.filter((rate) => matchesService(rule, rate));
    if (!named.length) {
      failures.push(`${rule.name} — no carrier quoted that service for this parcel.`);
      continue;
    }
    const allowed = named.filter((rate) => {
      if (rule.maxCostMinor !== null && rate.amountMinor > rule.maxCostMinor) return false;
      if (rule.maxDeliveryDays !== null && rate.deliveryDays !== null
        && rate.deliveryDays > rule.maxDeliveryDays) return false;
      /*
       * The promised date is a promise. A rate with no date at all cannot be
       * shown to keep it, so it does not qualify — Foundry does not get to
       * assume a carrier will be on time because it declined to say.
       */
      if (rule.requireByPromised && promised) {
        if (!rate.deliveryDate) return false;
        if (rate.deliveryDate > promised) return false;
      }
      return true;
    });
    if (!allowed.length) {
      const cheapest = [...named].sort((a, b) => a.amountMinor - b.amountMinor)[0];
      failures.push(`${rule.name} — the cheapest ${cheapest.carrierName} ${cheapest.service} is `
        + `$${(cheapest.amountMinor / 100).toFixed(2)}`
        + (cheapest.deliveryDate ? `, arriving ${cheapest.deliveryDate}` : ', with no date given')
        + '.');
      continue;
    }
    const chosen = [...allowed].sort((a, b) => a.amountMinor - b.amountMinor)[0];
    return {
      rate: chosen,
      rule,
      because: `${rule.name} covers this: ${chosen.carrierName} ${chosen.service} at `
        + `$${(chosen.amountMinor / 100).toFixed(2)}`
        + (chosen.deliveryDate ? `, arriving ${chosen.deliveryDate}` : '')
        + (promised ? `, and the customer was promised ${promised}.` : '.'),
    };
  }

  return { rate: null, rule: null,
    because: `No rule covers this parcel. ${failures.join(' ')}`.trim() };
}

/**
 * What Foundry would suggest when no rule applies.
 *
 * A recommendation, never an action. The cheapest rate that still keeps the
 * promise, or simply the cheapest when nothing was promised — which is what a
 * person does when nobody is waiting on a particular day.
 */
function performanceFor(db, workspaceId) {
  const rows = db.prepare(`SELECT carrier, service,
      COUNT(*) AS delivered,
      SUM(CASE WHEN expected_delivery_date IS NOT NULL AND delivered_at IS NOT NULL
        AND date(delivered_at) <= date(expected_delivery_date) THEN 1 ELSE 0 END) AS on_time,
      SUM(CASE WHEN expected_delivery_date IS NOT NULL AND delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS measured
    FROM sales_shipments WHERE workspace_id = ? AND status = 'DELIVERED'
    GROUP BY carrier, service`).all(workspaceId);
  return new Map(rows.map((row) => [`${String(row.carrier || '').toLowerCase()}|${String(row.service || '').toLowerCase()}`, {
    delivered: Number(row.delivered), measured: Number(row.measured), onTime: Number(row.on_time),
    reliability: Number(row.measured) ? Number(row.on_time) / Number(row.measured) : null,
  }]));
}

function recommend(rates, promisedDate, options = {}) {
  if (!rates.length) return null;
  const inTime = promisedDate
    ? rates.filter((rate) => rate.deliveryDate && rate.deliveryDate <= promisedDate)
    : rates;
  let pool = inTime.length ? inTime : rates;
  const paid = options.customerShippingMinor;
  const withinPaid = paid === null || paid === undefined ? []
    : pool.filter((rate) => rate.amountMinor <= paid);
  if (withinPaid.length) pool = withinPaid;
  const preferred = new Set((options.preferredCarriers || []).map((value) => String(value).toLowerCase()));
  const evidence = options.performance || new Map();
  const details = (rate) => evidence.get(`${String(rate.carrier).toLowerCase()}|${String(rate.service).toLowerCase()}`)
    || { reliability: null, measured: 0 };
  const best = [...pool].sort((a, b) => {
    const preferredDelta = Number(preferred.has(String(b.carrier).toLowerCase()))
      - Number(preferred.has(String(a.carrier).toLowerCase()));
    if (preferredDelta) return preferredDelta;
    if (a.amountMinor !== b.amountMinor) return a.amountMinor - b.amountMinor;
    return Number(details(b).reliability || 0) - Number(details(a).reliability || 0);
  })[0];
  const history = details(best);
  const reasons = [promisedDate && inTime.length
    ? `Cheapest qualifying service that still arrives by ${promisedDate}.`
    : promisedDate
      ? `Nothing quoted arrives by ${promisedDate}; this is the cheapest available exception.`
      : 'Cheapest qualifying quoted service.'];
  if (paid !== null && paid !== undefined) {
    const difference = Number(best.amountMinor) - Number(paid);
    reasons.push(difference <= 0
      ? `It is $${(Math.abs(difference) / 100).toFixed(2)} within the shipping amount charged to the customer.`
      : `It costs $${(difference / 100).toFixed(2)} more than the customer paid for shipping.`);
  }
  if (history.reliability !== null) {
    reasons.push(`${Math.round(history.reliability * 100)}% on time across ${history.measured} comparable delivered parcels.`);
  } else {
    reasons.push('Foundry has no comparable delivery history yet, so it did not invent a reliability score.');
  }
  return {
    rate: best,
    because: reasons.join(' '),
    comparisons: rates.map((rate) => ({ rateId: rate.id,
      keepsPromise: !promisedDate || Boolean(rate.deliveryDate && rate.deliveryDate <= promisedDate),
      customerShippingDeltaMinor: paid === null || paid === undefined ? null : rate.amountMinor - paid,
      reliability: details(rate).reliability, measuredDeliveries: details(rate).measured })),
  };
}

module.exports = { list, get, save, remove, describe, decide, recommend, performanceFor, hydrate };
