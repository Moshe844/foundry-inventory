'use strict';

/*
 * Shipping as an operation, not a status toggle.
 *
 * "Ship order" used to move stock and set a word. Everything a carrier is
 * actually for happened in somebody's browser on another tab: what it would
 * cost, which service, printing the label, typing the tracking number back in,
 * and then checking it for a week.
 *
 * The sequence here is the sequence a person does:
 *
 *   packages   what is in the box, and what it weighs
 *   quote      what each carrier would charge, and when it would arrive
 *   choose     a rule if one applies, a person if not
 *   buy        the label, the tracking number, the file to print
 *   ship       the existing shipment path — stock moves, customer is told
 *   track      the carrier's scans, until delivered or something goes wrong
 *
 * Buying the label is the only step that spends money, and it is the only one
 * gated by authority. Everything before it can be done freely because asking a
 * carrier what something would cost commits nobody to anything.
 *
 * The manual path is untouched. A shop that walks parcels to the post office
 * still records a shipment the way it always did; this adds a way to do it
 * through a carrier, and never becomes the only way.
 */

const { inTransaction } = require('../db');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const providers = require('./provider');
const addresses = require('./address');
const carriers = require('../sales/carriers');

/* -------------------------------------------------------------- packages */

/** A gram figure for one unit, or null when nobody has ever weighed it. */
function unitWeight(db, workspaceId, skuId) {
  const row = db.prepare('SELECT weight_grams FROM skus WHERE id = ? AND workspace_id = ?')
    .get(skuId, workspaceId);
  return row && row.weight_grams ? Number(row.weight_grams) : null;
}

/**
 * What is in the box, and what it weighs.
 *
 * One package unless somebody said otherwise, because that is what a shop that
 * has never thought about it means. The weight is the sum of what is in it,
 * and it says so: a rate quoted on an estimate can be re-quoted, while one
 * presented as fact and corrected at the counter is a surprise on an invoice.
 */
function packagesFor(db, workspaceId, shipmentId) {
  const existing = db.prepare(`SELECT * FROM shipment_packages
    WHERE workspace_id = ? AND shipment_id = ? ORDER BY position`).all(workspaceId, shipmentId);
  if (existing.length) {
    return existing.map((row) => ({
      id: row.id, position: row.position, weightGrams: row.weight_grams,
      lengthMm: row.length_mm, widthMm: row.width_mm, heightMm: row.height_mm,
      estimated: row.weight_source === 'ESTIMATED',
    }));
  }

  const lines = db.prepare(`SELECT sku_id, quantity FROM sales_shipment_lines
    WHERE workspace_id = ? AND shipment_id = ?`).all(workspaceId, shipmentId);
  let grams = 0;
  let unweighed = 0;
  for (const line of lines) {
    const each = unitWeight(db, workspaceId, line.sku_id);
    if (each === null) unweighed += Number(line.quantity);
    else grams += each * Number(line.quantity);
  }
  return [{ id: null, position: 1, weightGrams: grams || null, lengthMm: null, widthMm: null,
    heightMm: null, estimated: true, unweighedUnits: unweighed }];
}

/** Fix the packages for this box, as somebody actually measured them. */
function setPackages(db, ctx, shipmentId, boxes = []) {
  if (!boxes.length) throw new ValidationError('A shipment needs at least one package.');
  return inTransaction(db, () => {
    const now = nowIso();
    db.prepare('DELETE FROM shipment_packages WHERE workspace_id = ? AND shipment_id = ?')
      .run(ctx.workspaceId, shipmentId);
    const insert = db.prepare(`INSERT INTO shipment_packages
      (id, workspace_id, shipment_id, position, weight_grams, length_mm, width_mm, height_mm,
       weight_source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    boxes.forEach((box, index) => {
      const weight = Number(box.weightGrams || 0);
      if (!(weight > 0)) throw new ValidationError(`Package ${index + 1} needs a weight.`);
      insert.run(newId('pkg'), ctx.workspaceId, shipmentId, index + 1, Math.round(weight),
        box.lengthMm ? Math.round(Number(box.lengthMm)) : null,
        box.widthMm ? Math.round(Number(box.widthMm)) : null,
        box.heightMm ? Math.round(Number(box.heightMm)) : null,
        box.measured === false ? 'ESTIMATED' : 'MEASURED', now, now);
    });
    db.prepare(`UPDATE sales_shipments SET package_count = ?, weight_grams = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`)
      .run(boxes.length, boxes.reduce((sum, box) => sum + Math.round(Number(box.weightGrams || 0)), 0),
        now, shipmentId, ctx.workspaceId);
    return packagesFor(db, ctx.workspaceId, shipmentId);
  });
}

/* ------------------------------------------------------------- addresses */

function requireShipment(db, workspaceId, shipmentId) {
  const row = db.prepare('SELECT * FROM sales_shipments WHERE id = ? AND workspace_id = ?')
    .get(shipmentId, workspaceId);
  if (!row) throw new NotFoundError('That shipment could not be found.');
  return row;
}

/** Where it goes, and where it leaves from. Either can be incomplete. */
function endpoints(db, workspaceId, shipment) {
  const to = addresses.parse(shipment.ship_to_address);
  const location = shipment.ship_from_location_id
    ? db.prepare('SELECT name, address FROM locations WHERE id = ? AND workspace_id = ?')
      .get(shipment.ship_from_location_id, workspaceId)
    : null;
  const from = addresses.parse(location ? location.address : null);
  if (!from.name && location) from.name = location.name;
  return { to, from, locationName: location ? location.name : null };
}

/**
 * Everything that has to be true before a carrier can be asked anything.
 *
 * Returned as a list of things missing rather than thrown, because this is
 * what the screen shows: a person needs to see all four problems at once, not
 * discover them one refresh at a time.
 */
function readiness(db, workspaceId, shipmentId) {
  const shipment = requireShipment(db, workspaceId, shipmentId);
  const { to, from, locationName } = endpoints(db, workspaceId, shipment);
  const boxes = packagesFor(db, workspaceId, shipmentId);
  const blocked = [];

  if (!to.complete) blocked.push({ key: 'to', what: addresses.why(to), href: null });
  if (!from.complete) {
    blocked.push({ key: 'from',
      what: `StockChief does not have a full address for ${locationName || 'the location this ships from'}, `
        + 'and a carrier will not quote without one.',
      href: '/locations' });
  }
  const unweighed = boxes.reduce((sum, box) => sum + Number(box.unweighedUnits || 0), 0);
  if (!boxes.some((box) => Number(box.weightGrams) > 0)) {
    blocked.push({ key: 'weight',
      what: unweighed
        ? `${unweighed} of the items in this box have no weight recorded, so StockChief cannot say what `
          + 'the parcel weighs. Weigh it and enter the figure, or set the product weights once.'
        : 'Nobody has said what this parcel weighs.',
      href: null });
  }
  const account = require('./accounts').forWorkspace(db, workspaceId);
  const provider = account ? account.provider : null;
  if (!provider) {
    blocked.push({ key: 'provider',
      what: 'No shipping account is connected, so StockChief cannot get live rates or buy a label. '
        + 'You can still hand the parcel over and record it.', href: '/settings/connections' });
  }

  return { shipment, to, from, boxes, provider, blocked, ready: blocked.length === 0 };
}

/* ----------------------------------------------------------------- rates */

/** What the customer was promised, if anything was. */
function promisedDate(db, workspaceId, shipment) {
  if (shipment.promised_date) return shipment.promised_date;
  const order = db.prepare('SELECT needed_by FROM sales_orders WHERE id = ? AND workspace_id = ?')
    .get(shipment.sales_order_id, workspaceId);
  return order && order.needed_by ? order.needed_by : null;
}

/** The promise made to the customer, kept apart from a carrier estimate. */
function promiseFor(db, workspaceId, shipmentOrId) {
  const shipment = typeof shipmentOrId === 'string'
    ? requireShipment(db, workspaceId, shipmentOrId) : shipmentOrId;
  const date = promisedDate(db, workspaceId, shipment);
  return {
    service: trimOrNull(shipment.promised_service),
    windowStart: trimOrNull(shipment.promised_window_start),
    windowEnd: trimOrNull(shipment.promised_window_end) || date,
    promisedDate: date,
    customerShippingMinor: shipment.customer_shipping_minor === null
      || shipment.customer_shipping_minor === undefined ? null : Number(shipment.customer_shipping_minor),
    source: trimOrNull(shipment.promise_source) || (date ? 'sales_order' : null),
  };
}

function requireDate(value, label) {
  const date = trimOrNull(value);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ValidationError(`${label} must be a calendar date.`);
  }
  return date;
}

/** Record only what the customer was actually offered or accepted. */
function setPromise(db, ctx, shipmentId, input = {}) {
  const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
  if (!['PICKING', 'PACKED'].includes(shipment.status)) {
    throw new ValidationError('The delivery promise cannot be rewritten after the parcel has left.');
  }
  const start = requireDate(input.windowStart, 'Promise window start');
  const end = requireDate(input.windowEnd || input.promisedDate, 'Promise window end');
  if (start && end && start > end) throw new ValidationError('The promise window ends before it starts.');
  const paid = input.customerShippingMinor === '' || input.customerShippingMinor === null
    || input.customerShippingMinor === undefined ? null : Math.round(Number(input.customerShippingMinor));
  if (paid !== null && (!Number.isFinite(paid) || paid < 0)) {
    throw new ValidationError('Customer shipping charged must be zero or more.');
  }
  db.prepare(`UPDATE sales_shipments SET promised_service = ?, promised_window_start = ?,
    promised_window_end = ?, promised_date = ?, customer_shipping_minor = ?, promise_source = ?,
    updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(trimOrNull(input.service), start, end, end, paid,
      trimOrNull(input.source) || 'owner', nowIso(), shipmentId, ctx.workspaceId);
  return promiseFor(db, ctx.workspaceId, shipmentId);
}

/**
 * Ask the carriers what they would charge.
 *
 * Costs nothing and commits nobody, so it needs no authority. The rates are
 * written down with the time they were quoted, because "StockChief chose UPS
 * Ground" is only checkable next to what it was choosing between.
 */
async function quote(db, ctx, shipmentId, options = {}) {
  const state = readiness(db, ctx.workspaceId, shipmentId);
  if (!state.ready) {
    const promise = promiseFor(db, ctx.workspaceId, state.shipment);
    return { rates: [], blocked: state.blocked, promisedDate: promise.promisedDate, promise };
  }
  /*
   * The workspace's own key, not the process's. Every adapter reads its key
   * off ctx before falling back to the environment, so this is the whole of
   * what multi-tenancy costs at a call site.
   */
  const held = require('./accounts').contextFor(db, ctx);
  const provider = options.provider || providers.get(state.provider);
  const answer = await provider.quote(held ? held.ctx : ctx, {
    to: state.to, from: state.from,
    packages: state.boxes.map((box) => ({ weightGrams: box.weightGrams,
      lengthMm: box.lengthMm, widthMm: box.widthMm, heightMm: box.heightMm })),
  });

  const now = nowIso();
  inTransaction(db, () => {
    db.prepare('DELETE FROM shipment_rates WHERE workspace_id = ? AND shipment_id = ?')
      .run(ctx.workspaceId, shipmentId);
    const insert = db.prepare(`INSERT INTO shipment_rates
      (id, workspace_id, shipment_id, provider, provider_rate_id, carrier, service, amount_minor,
       currency, delivery_days, delivery_date, delivery_guaranteed, quoted_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const rate of answer.rates || []) {
      insert.run(newId('rate'), ctx.workspaceId, shipmentId, state.provider,
        (rate.rateIds || [rate.rateId]).join(','), rate.carrier, rate.service, rate.amountMinor,
        rate.currency || 'USD', rate.deliveryDays, rate.deliveryDate,
        rate.guaranteed ? 1 : 0, now, now);
    }
    db.prepare(`UPDATE sales_shipments SET provider = ?, provider_shipment_id = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`)
      .run(state.provider, (answer.providerShipmentIds || []).join(','), now, shipmentId, ctx.workspaceId);
  });

  const promise = promiseFor(db, ctx.workspaceId, state.shipment);
  return {
    rates: ratesFor(db, ctx.workspaceId, shipmentId),
    blocked: [],
    promisedDate: promise.promisedDate,
    promise,
  };
}

function ratesFor(db, workspaceId, shipmentId) {
  return db.prepare(`SELECT * FROM shipment_rates WHERE workspace_id = ? AND shipment_id = ?
    ORDER BY amount_minor, delivery_days`).all(workspaceId, shipmentId)
    .map((row) => ({
      id: row.id,
      provider: row.provider,
      providerRateId: row.provider_rate_id,
      carrier: row.carrier,
      carrierName: carriers.displayName(row.carrier) || row.carrier,
      service: row.service,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      deliveryDays: row.delivery_days === null ? null : Number(row.delivery_days),
      deliveryDate: row.delivery_date,
      guaranteed: Boolean(row.delivery_guaranteed),
      quotedAt: row.quoted_at,
    }));
}

/* ---------------------------------------------------------------- buying */

function labelTransactions(db, workspaceId, shipmentId) {
  return db.prepare(`SELECT * FROM shipping_label_transactions
    WHERE workspace_id = ? AND shipment_id = ? ORDER BY requested_at, id`).all(workspaceId, shipmentId)
    .map((row) => ({ ...row, providerReference: (() => {
      try { return JSON.parse(row.provider_reference || '[]'); } catch { return []; }
    })() }));
}

function beginLabelTransaction(db, ctx, shipment, operation, idempotencyKey) {
  const existing = db.prepare(`SELECT * FROM shipping_label_transactions
    WHERE workspace_id = ? AND idempotency_key = ?`).get(ctx.workspaceId, idempotencyKey);
  if (existing) return { row: existing, created: false };
  const now = nowIso();
  const id = newId('shiptxn');
  db.prepare(`INSERT INTO shipping_label_transactions
    (id, workspace_id, shipment_id, provider, operation, status, idempotency_key, currency,
     requested_by_user_id, requested_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, shipment.id, shipment.provider || 'unknown', operation,
      idempotencyKey, shipment.currency || 'USD', ctx.actorId || null, now, now);
  return { row: db.prepare('SELECT * FROM shipping_label_transactions WHERE id = ?').get(id), created: true };
}

function finishLabelTransaction(db, id, input = {}) {
  const now = nowIso();
  db.prepare(`UPDATE shipping_label_transactions SET status = ?, provider_reference = ?,
    amount_minor = ?, currency = ?, detail = ?, error_message = ?, completed_at = ?, updated_at = ?
    WHERE id = ?`)
    .run(input.status, input.providerReference ? JSON.stringify(input.providerReference) : null,
      input.amountMinor === undefined ? null : input.amountMinor, input.currency || 'USD',
      trimOrNull(input.detail), trimOrNull(input.errorMessage),
      ['SUCCEEDED', 'FAILED'].includes(input.status) ? now : null, now, id);
}

function purchaseAttempt(db, workspaceId, shipmentId) {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM shipping_label_transactions
    WHERE workspace_id = ? AND shipment_id = ? AND operation = 'PURCHASE'`)
    .get(workspaceId, shipmentId).n;
  return Number(count) + 1;
}

/**
 * Buy the label without claiming the parcel physically left.
 *
 * A label is postage and a tracking number. It is not a carrier handoff. The
 * box therefore stays PACKED and inventory stays on hand until `ship` records
 * the real-world handoff. This distinction also keeps a printed-but-unused
 * label from becoming revenue, COGS, and a false customer shipping notice.
 */
async function buyLabel(db, ctx, shipmentId, rateId, options = {}) {
  const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
  if (shipment.tracking_number && shipment.label_url && shipment.label_status !== 'VOIDED') {
    return { shipment, replayed: true, label: shipment.label_url };
  }
  const rate = db.prepare('SELECT * FROM shipment_rates WHERE id = ? AND workspace_id = ? AND shipment_id = ?')
    .get(rateId, ctx.workspaceId, shipmentId);
  if (!rate) throw new ValidationError('That rate is not one StockChief quoted for this parcel. Get rates again.');

  const held = require('./accounts').contextFor(db, ctx);
  const provider = options.provider
    || providers.get(shipment.provider || (held && held.account.provider));
  const pending = db.prepare(`SELECT * FROM shipping_label_transactions WHERE workspace_id = ?
    AND shipment_id = ? AND operation = 'PURCHASE' AND status IN ('PENDING','REVIEW')
    ORDER BY requested_at DESC LIMIT 1`).get(ctx.workspaceId, shipmentId);
  if (pending) {
    throw new ValidationError('A carrier purchase is still being verified. StockChief will not retry it and risk buying the label twice.');
  }
  const operationKey = options.idempotencyKey
    || `shipment-label:${shipmentId}:${purchaseAttempt(db, ctx.workspaceId, shipmentId)}`;
  const transaction = beginLabelTransaction(db, ctx,
    { ...shipment, provider: rate.provider }, 'PURCHASE', operationKey).row;
  let bought;
  try {
    bought = await provider.buy(held ? held.ctx : ctx, {
      providerShipmentIds: String(shipment.provider_shipment_id || '').split(',').filter(Boolean),
      rateIds: String(rate.provider_rate_id || '').split(',').filter(Boolean),
      idempotencyKey: operationKey,
    });
  } catch (error) {
    const definitive = Number(error.status) >= 400 && Number(error.status) < 500;
    finishLabelTransaction(db, transaction.id, {
      status: definitive ? 'FAILED' : 'REVIEW', currency: rate.currency,
      errorMessage: String(error.message || error),
    });
    throw error;
  }

  const now = nowIso();
  const providerReferences = bought.providerLabelIds || bought.providerShipmentIds
    || [bought.providerShipmentId].filter(Boolean);
  inTransaction(db, () => {
    db.prepare(`UPDATE sales_shipments SET provider_rate_id = ?, provider_shipment_id = ?,
      label_url = ?, label_format = ?, label_status = 'PURCHASED', label_voided_at = NULL,
      postage_refund_minor = NULL, tracking_status = 'PRE_TRANSIT', tracked_at = ?,
      bought_by_rule_id = ?, carrier = ?, service = ?, tracking_number = ?,
      shipping_cost_minor = ?, currency = ?, expected_delivery_date = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`)
      .run(rate.provider_rate_id, (bought.providerShipmentIds || [bought.providerShipmentId])
        .filter(Boolean).join(',') || shipment.provider_shipment_id,
        bought.labelUrl, bought.labelFormat, now, options.ruleId || null,
        bought.carrier, bought.service, bought.trackingNumber, bought.amountMinor,
        bought.currency, bought.deliveryDate, now, shipmentId, ctx.workspaceId);
    finishLabelTransaction(db, transaction.id, { status: 'SUCCEEDED',
      providerReference: providerReferences, amountMinor: bought.amountMinor,
      currency: bought.currency, detail: 'Carrier confirmed the label purchase.' });
  });

  // The carrier's own tracking link beats a pattern-built one when there is one.
  if (bought.trackingUrl) {
    db.prepare('UPDATE sales_shipments SET tracking_url = ? WHERE id = ? AND workspace_id = ?')
      .run(bought.trackingUrl, shipmentId, ctx.workspaceId);
  }

  /*
   * The carrier charged for this, so the books say so.
   *
   * Postage is an expense of selling, not a cost of the goods: it is not part
   * of what the stock cost and it must not end up in inventory value. Money
   * leaves when the label is bought — that is what buying a label is — so it
   * is cash, not a payable.
   *
   * Keyed on the shipment, so a retry that reaches this twice posts once. A
   * failure here never changes the physical record: the label exists and the
   * packed parcel still truthfully says it has not left.
   */
  if (bought.amountMinor > 0) {
    try {
      const ledger = require('../accounting/ledger');
      if (ledger.settings(db, ctx.workspaceId).enabled) {
        ledger.post(db, ctx, {
          postingDate: now.slice(0, 10),
          description: `Postage for ${shipment.shipment_number} — ${bought.carrier || 'carrier'}`
            + `${bought.service ? ` ${bought.service}` : ''}`,
          sourceType: 'shipment_postage',
          sourceRecordType: 'sales_shipment',
          sourceRecordId: shipmentId,
          // A shipment can legitimately buy a replacement after a successful
          // void. The durable purchase transaction, not the shipment alone,
          // is therefore the financial idempotency boundary.
          sourceKey: `shipment-postage:${shipmentId}:${transaction.id}`,
          createdByType: ctx.actorId ? 'USER' : 'SYSTEM',
          approvedByUserId: ctx.actorId || null,
          lines: [
            { accountKey: 'SHIPPING_EXPENSE', debitMinor: bought.amountMinor,
              memo: `${bought.carrier || ''} ${bought.service || ''}`.trim() || 'Postage' },
            { accountKey: 'CASH', creditMinor: bought.amountMinor, memo: 'Paid to the carrier' },
          ],
        });
      }
    } catch (error) {
      console.error('[shipping] postage was not posted to the books', error.message);
    }
  }
  if (held && held.account.source !== 'server'
      && !require('./accounts').isTestKey(held.account.provider, held.account.apiKey)) {
    require('../operations/checkpoints').record(db, 'integration.shipping_onboarding', 'PASS', {
      connected: true, customerFunded: true, platformCharged: false,
      provider: held.account.provider, shipmentId, amountMinor: bought.amountMinor, liveMode: true,
      releaseRef: require('../config').operations.releaseRef,
    });
  }

  return {
    shipment: requireShipment(db, ctx.workspaceId, shipmentId),
    label: bought.labelUrl,
    labels: bought.labelUrls || [bought.labelUrl].filter(Boolean),
    trackingNumber: bought.trackingNumber,
    carrier: bought.carrier,
    service: bought.service,
    amountMinor: bought.amountMinor,
    replayed: false,
  };
}

function postPostageRefund(db, ctx, shipment, amountMinor, detail, transactionId) {
  if (!(amountMinor > 0)) return;
  try {
    const ledger = require('../accounting/ledger');
    if (!ledger.settings(db, ctx.workspaceId).enabled) return;
    ledger.post(db, ctx, {
      postingDate: nowIso().slice(0, 10),
      description: `Postage refund for ${shipment.shipment_number}`,
      sourceType: 'shipment_postage_refund', sourceRecordType: 'sales_shipment',
      sourceRecordId: shipment.id,
      sourceKey: `shipment-postage-refund:${shipment.id}:${transactionId}`,
      createdByType: ctx.actorId ? 'USER' : 'SYSTEM', approvedByUserId: ctx.actorId || null,
      lines: [
        { accountKey: 'CASH', debitMinor: amountMinor, memo: detail || 'Carrier refund' },
        { accountKey: 'SHIPPING_EXPENSE', creditMinor: amountMinor, memo: 'Reversed unused postage' },
      ],
    });
  } catch (error) {
    console.error('[shipping] postage refund was not posted to the books', error.message);
  }
}

/** Void unused postage without erasing the original label evidence. */
async function voidLabel(db, ctx, shipmentId, options = {}) {
  const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
  if (['SHIPPED', 'DELIVERED'].includes(shipment.status)) {
    throw new ValidationError('This parcel already left. Use the return workflow instead of voiding its label.');
  }
  if (shipment.label_status === 'VOIDED') {
    return { shipment, replayed: true, status: 'SUCCEEDED' };
  }
  if (!shipment.label_url || !shipment.tracking_number) {
    throw new ValidationError('This parcel has no purchased carrier label to void.');
  }
  const held = require('./accounts').contextFor(db, ctx);
  const providerName = shipment.provider || (held && held.account.provider);
  const provider = options.provider || providers.get(providerName);
  if (typeof provider.voidLabel !== 'function') {
    throw new ValidationError(`${providerName} does not support label voids through this connection. Contact the carrier and attach its refund evidence.`);
  }
  const purchase = labelTransactions(db, ctx.workspaceId, shipmentId)
    .filter((row) => row.operation === 'PURCHASE' && row.status === 'SUCCEEDED').at(-1);
  // A replacement label is a new financial effect and may itself need to be
  // voided. Scope the retry boundary to the exact purchase being reversed.
  const purchaseBoundary = purchase?.id || shipment.provider_shipment_id || shipment.tracking_number;
  const key = options.idempotencyKey || `shipment-label-void:${shipmentId}:${purchaseBoundary}`;
  const started = beginLabelTransaction(db, ctx, shipment, 'VOID', key);
  if (!started.created) {
    if (started.row.status === 'SUCCEEDED') return { shipment, replayed: true, status: 'SUCCEEDED' };
    if (['PENDING', 'REVIEW'].includes(started.row.status)) {
      return { shipment, replayed: true, status: 'PENDING', detail: started.row.detail };
    }
  }
  const references = purchase?.providerReference?.length ? purchase.providerReference
    : String(shipment.provider_shipment_id || '').split(',').filter(Boolean);
  let result;
  try {
    result = await provider.voidLabel(held ? held.ctx : ctx, {
      providerReferences: references, idempotencyKey: key,
    });
  } catch (error) {
    const definitive = Number(error.status) >= 400 && Number(error.status) < 500;
    finishLabelTransaction(db, started.row.id, { status: definitive ? 'FAILED' : 'REVIEW',
      providerReference: references, currency: shipment.currency,
      errorMessage: String(error.message || error) });
    throw error;
  }
  const normalized = ['SUCCEEDED', 'FAILED'].includes(result.status) ? result.status : 'PENDING';
  const refund = normalized === 'SUCCEEDED' ? Number(shipment.shipping_cost_minor || 0) : null;
  inTransaction(db, () => {
    finishLabelTransaction(db, started.row.id, { status: normalized,
      providerReference: result.references || references, amountMinor: refund,
      currency: shipment.currency, detail: result.detail });
    db.prepare(`UPDATE sales_shipments SET label_status = ?, label_voided_at = ?,
      postage_refund_minor = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(normalized === 'SUCCEEDED' ? 'VOIDED' : normalized === 'FAILED' ? 'PURCHASED' : 'VOID_PENDING',
        normalized === 'SUCCEEDED' ? nowIso() : null, refund, nowIso(), shipmentId, ctx.workspaceId);
  });
  if (normalized === 'SUCCEEDED') {
    postPostageRefund(db, ctx, shipment, refund, result.detail, started.row.id);
  }
  return { shipment: requireShipment(db, ctx.workspaceId, shipmentId), replayed: false,
    status: normalized, amountMinor: refund, detail: result.detail };
}

/** Record a carrier invoice correction from exact evidence; never infer one. */
function recordAdjustment(db, ctx, shipmentId, input = {}) {
  const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
  const amount = Math.round(Number(input.amountMinor));
  if (!Number.isFinite(amount) || amount === 0) throw new ValidationError('Enter the carrier adjustment amount.');
  const evidence = trimOrNull(input.evidence);
  if (!evidence) throw new ValidationError('Carrier adjustments require invoice or carrier evidence.');
  const key = trimOrNull(input.idempotencyKey) || `shipment-adjustment:${shipmentId}:${newId('evidence')}`;
  const started = beginLabelTransaction(db, ctx, shipment, 'ADJUSTMENT', key);
  if (!started.created) return { replayed: true, shipment, transaction: started.row };
  inTransaction(db, () => {
    finishLabelTransaction(db, started.row.id, { status: 'SUCCEEDED', amountMinor: amount,
      currency: shipment.currency || 'USD', detail: evidence });
    db.prepare(`UPDATE sales_shipments SET postage_adjustment_minor =
      COALESCE(postage_adjustment_minor, 0) + ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(amount, nowIso(), shipmentId, ctx.workspaceId);
  });
  try {
    const ledger = require('../accounting/ledger');
    if (ledger.settings(db, ctx.workspaceId).enabled) {
      ledger.post(db, ctx, {
        postingDate: nowIso().slice(0, 10), description: `Carrier adjustment for ${shipment.shipment_number}`,
        sourceType: 'shipment_postage_adjustment', sourceRecordType: 'sales_shipment',
        sourceRecordId: shipmentId, sourceKey: key, createdByType: ctx.actorId ? 'USER' : 'SYSTEM',
        approvedByUserId: ctx.actorId || null,
        lines: amount > 0
          ? [{ accountKey: 'SHIPPING_EXPENSE', debitMinor: amount, memo: evidence },
            { accountKey: 'CASH', creditMinor: amount, memo: 'Carrier adjustment' }]
          : [{ accountKey: 'CASH', debitMinor: Math.abs(amount), memo: 'Carrier credit' },
            { accountKey: 'SHIPPING_EXPENSE', creditMinor: Math.abs(amount), memo: evidence }],
      });
    }
  } catch (error) { console.error('[shipping] carrier adjustment was not posted', error.message); }
  return { replayed: false, shipment: requireShipment(db, ctx.workspaceId, shipmentId),
    transaction: db.prepare('SELECT * FROM shipping_label_transactions WHERE id = ?').get(started.row.id) };
}

/* ------------------------------------------------------- doing it unasked */

/**
 * A parcel is packed, a rule covers it, and StockChief may spend. So it goes.
 *
 * Three separate permissions, and all three have to hold. The mode has to
 * allow StockChief to act at all; the owner has to have granted buying labels
 * specifically; and a rule of theirs has to cover this particular parcel at
 * this particular price by this particular date. Any one of them missing and
 * this does nothing at all — the parcel simply waits on the screen where the
 * rates are, which is where it would have been anyway.
 *
 * Refusing is not failing, and it is not silent either. What comes back says
 * which of the three stopped it, because "StockChief did not ship this" is only
 * useful next to the reason.
 */
async function shipWithinAuthority(db, ctx, shipmentId, options = {}) {
  const capabilities = require('../autopilot/capabilities');
  const rules = require('./rules');

  const handling = require('./operation-policy').get(db, ctx.workspaceId);
  if (handling.mode !== 'AUTOMATIC') {
    return { bought: false, because: handling.mode === 'MANUAL'
      ? 'Shipping is in Manual mode. StockChief will show the rates and leave the choice to you.'
      : 'Shipping is in Recommend mode. StockChief will choose a rate for review but will not buy it.' };
  }

  const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
  if (shipment.status !== 'PACKED') {
    return { bought: false, because: 'Only a packed parcel is ready for a label.' };
  }
  if (shipment.tracking_number) {
    return { bought: false, because: 'This parcel already has a label.' };
  }

  const allowed = capabilities.may(db, ctx.workspaceId, 'shipping_labels');
  if (!allowed.allowed) return { bought: false, because: allowed.because };

  const state = readiness(db, ctx.workspaceId, shipmentId);
  if (!state.ready) return { bought: false, because: state.blocked[0].what, blocked: state.blocked };

  /*
   * Fresh rates, always. A rule is a permission to spend up to a limit, and
   * spending it against a price quoted last week is spending it against a
   * number that may no longer exist.
   */
  const quoted = await quote(db, ctx, shipmentId, options);
  if (!quoted.rates.length) {
    return { bought: false, because: 'No carrier quoted a rate for this parcel.' };
  }

  const decision = rules.decide(db, ctx.workspaceId, quoted.rates,
    { promisedDate: quoted.promisedDate });
  if (!decision.rate) return { bought: false, because: decision.because, rates: quoted.rates };

  const autonomous = require('../autonomous/service');
  const operation = autonomous.create(db, ctx, {
    operationType:'shipping.purchase_label',
    idempotencyKey:`shipping-label:${shipmentId}`,
    sourceKind:'sales_shipment', sourceId:shipmentId,
    title:`Buy shipping for ${shipment.shipment_number}`,
    summary:decision.because,
    link:`/orders/${shipment.sales_order_id}/detail?open=shipping#shipping`,
    evidence:[
      { label:'Chosen carrier', value:`${decision.rate.carrierName || decision.rate.carrier} ${decision.rate.service}` },
      { label:'Quoted price', value:`${decision.rate.currency} ${(decision.rate.amountMinor / 100).toFixed(2)}` },
      ...(quoted.promisedDate ? [{ label:'Promised by', value:quoted.promisedDate }] : []),
    ],
    decision:{ shipmentId, rateId:decision.rate.id, ruleId:decision.rule.id,
      ruleReason:decision.because },
    affectedEntities:{ shipmentId, salesOrderId:shipment.sales_order_id },
    authorityDimensions:{ valueMinor:decision.rate.amountMinor,
      customerId:shipment.customer_id || undefined,
      locationId:shipment.ship_from_location_id || undefined,
      confidence:'high', risk:'high' },
    expectedOutcome:{ labelPurchased:true, trackingNumberRecorded:true,
      quotedAmountMinor:decision.rate.amountMinor },
  });
  const governed = await autonomous.run(db, ctx, null, operation.id,
    { ...options, rule:decision.rule, rate:decision.rate });
  if (governed.operation.status !== 'COMPLETED') {
    const because = (governed.authority?.checks || []).filter((check) => !check.passed)
      .map((check) => check.reason).join(' ') || governed.operation.errorMessage;
    return { bought:false, because, operation:governed.operation };
  }
  return { bought:true, because:decision.because, rule:decision.rule,
    ...governed.operation.actualOutcome, operation:governed.operation };
}

/**
 * Every packed parcel that a rule would cover, done.
 *
 * Runs on the same schedule as everything else StockChief does unattended. A
 * parcel it cannot buy for is left exactly where it was, with the reason, and
 * the next sweep tries again — a carrier that was down at nine is not a parcel
 * that never ships.
 */
async function sweep(db, ctx, options = {}) {
  const capabilities = require('../autopilot/capabilities');
  const allowed = capabilities.may(db, ctx.workspaceId, 'shipping_labels');
  if (!allowed.allowed) return { considered: 0, bought: 0, because: allowed.because };
  if (!require('./accounts').forWorkspace(db, ctx.workspaceId)) {
    return { considered: 0, bought: 0, because: 'No shipping account is connected.' };
  }

  const packed = db.prepare(`SELECT id FROM sales_shipments
    WHERE workspace_id = ? AND status = 'PACKED' AND tracking_number IS NULL
    ORDER BY created_at LIMIT ?`).all(ctx.workspaceId, Number(options.limit || 10));

  const results = [];
  for (const row of packed) {
    try { results.push({ shipmentId: row.id, ...(await shipWithinAuthority(db, ctx, row.id, options)) }); }
    catch (error) { results.push({ shipmentId: row.id, bought: false, because: error.message }); }
  }
  return { considered: packed.length, bought: results.filter((row) => row.bought).length, results };
}

require('../autonomous/service').registerAdapter('shipping.purchase_label', {
  owner:'shipping.service',
  authorize:({ db, ctx, operation, execution }) => {
    const capability = require('../autopilot/capabilities').may(db, ctx.workspaceId, 'shipping_labels');
    const checks = [
      { name:'executionState', passed:execution.allowed,
        reason:execution.because || 'Shipping automation is active.' },
      { name:'shippingGrant', passed:capability.allowed,
        reason:capability.because || 'Buying shipping labels is explicitly enabled.' },
      { name:'shippingRule', passed:Boolean(operation.decision.ruleId),
        reason:'A saved shipping rule must select this exact rate.' },
    ];
    return { allowed:checks.every((check) => check.passed), checks };
  },
  execute:({ db, ctx, operation, runtime }) => buyLabel(db, ctx,
    operation.decision.shipmentId, operation.decision.rateId,
    { ...runtime, ruleId:operation.decision.ruleId }),
  verify:({ db, ctx, operation, actualOutcome }) => {
    const shipment = requireShipment(db, ctx.workspaceId, operation.decision.shipmentId);
    const passed = Boolean(shipment.label_url && shipment.tracking_number)
      && Number(shipment.shipping_cost_minor || 0) === Number(actualOutcome.amountMinor || 0);
    return { passed, reason:passed
      ? 'The carrier label, tracking number, and charged amount were read back from the shipment.'
      : 'The purchased label could not be reconciled to the shipment.',
    shipmentId:shipment.id, trackingNumber:shipment.tracking_number || null };
  },
});

module.exports = {
  packagesFor, setPackages, endpoints, readiness, quote, ratesFor, buyLabel,
  promisedDate, promiseFor, setPromise, requireShipment, labelTransactions,
  voidLabel, recordAdjustment, shipWithinAuthority, sweep,
};
