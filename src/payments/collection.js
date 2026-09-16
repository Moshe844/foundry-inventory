'use strict';

/**
 * Asking a customer to pay, and learning that they did.
 *
 * Two halves. Going out: StockChief works out what is due from the customer's
 * terms, asks a provider for a hosted page, and keeps the link so it can be put
 * in front of the customer. Coming back: the provider sends an event, and
 * StockChief turns it into an ordinary receipt.
 *
 * That second half is the whole point, and it is why nothing here posts its own
 * accounting. A card payment ends up in exactly the same place as "ABC School
 * paid $300 by cheque" — the same `payments.record`, the same allocation
 * against the same invoice, the same journal entry. If online payments had
 * their own path into the books there would be two definitions of paid, and one
 * of them would drift.
 *
 * Idempotency is doubled on purpose, because providers retry and a payment
 * recorded twice is far worse than one recorded late. The event's own id is
 * unique per workspace and provider, so a redelivery is refused at the door;
 * and the receipt carries `sourceKey` naming that same event, so even a
 * redelivery that somehow got past the door is refused by the payment engine.
 */

const { inTransaction } = require('../db');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const providerRegistry = require('./provider');
const paymentTerms = require('../sales/payment-terms');
const payments = require('../accounting/payments');

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    invoiceId: row.invoice_id,
    salesOrderId: row.sales_order_id,
    customerId: row.customer_id,
    provider: row.provider,
    purpose: row.purpose,
    amountMinor: Number(row.amount_minor),
    paidMinor: Number(row.paid_minor),
    remainingMinor: Math.max(0, Number(row.amount_minor) - Number(row.paid_minor)),
    currency: row.currency,
    status: row.status,
    externalCustomerId: row.external_customer_id,
    externalInvoiceId: row.external_invoice_id,
    hostedUrl: row.hosted_url,
    lastError: row.last_error,
    createdAt: row.created_at,
    openedAt: row.opened_at,
    paidAt: row.paid_at,
  };
}

function get(db, workspaceId, id) {
  return hydrate(db.prepare('SELECT * FROM payment_requests WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId));
}

function forInvoice(db, workspaceId, invoiceId) {
  return db.prepare(`SELECT * FROM payment_requests
    WHERE workspace_id = ? AND invoice_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(workspaceId, invoiceId).map(hydrate);
}

function forOrder(db, workspaceId, orderId) {
  return db.prepare(`SELECT * FROM payment_requests
    WHERE workspace_id = ? AND sales_order_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(workspaceId, orderId).map(hydrate);
}

/**
 * The live link a customer can pay on, if there is one.
 *
 * Only an OPEN request qualifies. A paid or voided one still has a URL and
 * putting it in an email would send somebody to a page telling them there is
 * nothing to pay, which reads as a mistake even though it is accurate.
 */
function openLinkForOrder(db, workspaceId, orderId) {
  return forOrder(db, workspaceId, orderId)
    .find((request) => request.status === 'OPEN' && request.hostedUrl) || null;
}

/**
 * How much to ask for, from what the customer's terms already say.
 *
 * Never a new opinion about the amount: the deposit and the balance both come
 * out of the payment position, which comes out of the order and its invoices.
 *
 * This used to refuse any order without an invoice — and StockChief only raises
 * an invoice at shipment, so a deposit before anything was picked was
 * impossible, which is the single most ordinary reason a shop asks for money
 * up front. The provider's own invoice is the document the customer pays
 * against; StockChief does not need to have written one first to ask.
 *
 * A receipt that arrives with no invoice to allocate against is already
 * handled: it becomes a customer deposit, a liability, until there is
 * something to set it against.
 */
function amountToRequest(db, workspaceId, order, purpose) {
  const position = paymentTerms.positionForOrder(db, workspaceId, order);
  if (purpose === 'DEPOSIT') {
    if (!position.dueNowMinor) {
      throw new ValidationError('No deposit is outstanding on this order.');
    }
    return { amountMinor: position.dueNowMinor, position };
  }
  if (!position.remainingMinor) {
    throw new ValidationError(position.totalMinor
      ? 'This order is already paid in full.'
      : 'This order is worth nothing yet, so there is nothing to ask them to pay.');
  }
  return { amountMinor: position.remainingMinor, position };
}

/**
 * Ask for money, through a provider.
 *
 * The provider is called outside the transaction that records the result:
 * it is a network call that can be slow or fail, and holding a write
 * transaction open across it is how a busy database starts timing out.
 */
async function request(db, ctx, orderId, input = {}) {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ? AND workspace_id = ?')
    .get(orderId, ctx.workspaceId);
  if (!order) throw new NotFoundError('That sales order is not in this inventory.');

  const purpose = ['DEPOSIT', 'BALANCE', 'FULL'].includes(input.purpose) ? input.purpose : 'BALANCE';
  const { amountMinor, position } = amountToRequest(db, ctx.workspaceId, order, purpose);
  const invoice = position.invoices[0];
  const providerName = String(input.provider || 'stripe').toLowerCase();
  const provider = providerRegistry.get(providerName);
  /*
   * This workspace's own account, not the server's.
   *
   * A single key for every inventory would mean every merchant's customers
   * paying into one Stripe account — not a billing detail but the money
   * arriving in the wrong bank. The adapter reads its key off ctx before
   * falling back to the environment, so this is the whole of the change here.
   */
  const withKey = require('./accounts').contextFor(db, ctx, providerName);

  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND workspace_id = ?')
    .get(order.customer_id, ctx.workspaceId);
  if (!customer) throw new ValidationError('This order has no customer to bill.');
  if (!customer.email) {
    throw new ValidationError(`There is no email address for ${customer.name}, and a payment link has to reach somebody.`);
  }

  // Reuse the customer at the provider rather than making a second one every
  // time they order; two customers is two payment histories.
  const previous = db.prepare(`SELECT external_customer_id FROM payment_requests
    WHERE workspace_id = ? AND customer_id = ? AND provider = ? AND external_customer_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1`).get(ctx.workspaceId, customer.id, providerName);

  const id = newId('payreq');
  const now = nowIso();
  db.prepare(`INSERT INTO payment_requests
    (id, workspace_id, invoice_id, sales_order_id, customer_id, provider, purpose,
     amount_minor, currency, status, external_customer_id, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, invoice ? invoice.id : null, orderId, customer.id, providerName, purpose,
      amountMinor, position.currency, previous ? previous.external_customer_id : null,
      ctx.actorId || null, now, now);

  try {
    const externalCustomerId = previous ? previous.external_customer_id
      : (await provider.createCustomer(withKey, { name: customer.name, email: customer.email })).externalCustomerId;

    const created = await provider.createInvoice(withKey, {
      externalCustomerId,
      /*
       * This row is one attempt to collect, and the provider should treat it
       * as one. Keying on the invoice number and amount instead meant a
       * second attempt on the same invoice — after the first was voided —
       * collided with the first key and Stripe refused it outright. That is
       * not idempotency; it is a reference that can only ever be billed once.
       */
      attemptId: id,
      amountMinor,
      currency: position.currency,
      description: purpose === 'DEPOSIT'
        ? `Deposit for ${order.order_number}`
        : `${order.order_number}`,
      /*
       * An order paid before it ships has no StockChief invoice to name, so the
       * order number is the reference. It is what the customer recognises on
       * their statement either way.
       */
      reference: invoice ? invoice.invoice_number : order.order_number,
      dueDate: invoice ? invoice.due_date || null : null,
    });

    db.prepare(`UPDATE payment_requests SET status = 'OPEN', external_customer_id = ?,
      external_invoice_id = ?, hosted_url = ?, opened_at = ?, updated_at = ?, last_error = NULL
      WHERE id = ?`)
      .run(externalCustomerId, created.externalInvoiceId, created.hostedUrl || null, now, nowIso(), id);
  } catch (error) {
    db.prepare(`UPDATE payment_requests SET status = 'FAILED', last_error = ?, updated_at = ?
      WHERE id = ?`).run(String(error.message || error), nowIso(), id);
    throw error;
  }
  return get(db, ctx.workspaceId, id);
}

function voidRequest(db, ctx, id, reason = null) {
  const existing = get(db, ctx.workspaceId, id);
  if (!existing) throw new NotFoundError('That payment request is not in this inventory.');
  if (existing.status === 'PAID') throw new ValidationError('That has already been paid.');
  db.prepare(`UPDATE payment_requests SET status = 'VOID', last_error = COALESCE(?, last_error),
    updated_at = ? WHERE id = ?`).run(trimOrNull(reason), nowIso(), id);
  return get(db, ctx.workspaceId, id);
}

/**
 * A provider told us something. Act on it once.
 *
 * Returns what happened in words, because a webhook that silently does nothing
 * and a webhook that silently worked look identical from outside, and the
 * difference is somebody's money.
 */
function receiveEvent(db, ctx, providerName, rawEvent, options = {}) {
  const provider = providerRegistry.get(providerName);
  const externalEventId = String(rawEvent?.id || options.externalEventId || '');
  if (!externalEventId) throw new ValidationError('That event has no id, so it cannot be recorded once.');

  const already = db.prepare(`SELECT * FROM payment_provider_events
    WHERE workspace_id = ? AND provider = ? AND external_event_id = ?`)
    .get(ctx.workspaceId, providerName, externalEventId);
  if (already) {
    return { applied: false, replayed: true, outcome: already.outcome || 'already seen' };
  }

  const read = providerRegistry.normalise(provider.readEvent(rawEvent));
  const eventId = newId('payevt');
  const now = nowIso();

  const matched = read.externalInvoiceId
    ? db.prepare(`SELECT * FROM payment_requests
        WHERE workspace_id = ? AND provider = ? AND external_invoice_id = ?`)
      .get(ctx.workspaceId, providerName, read.externalInvoiceId)
    : null;

  const record = (outcome, requestId = null, paymentId = null) => {
    db.prepare(`INSERT INTO payment_provider_events
      (id, workspace_id, provider, external_event_id, event_type, payload, request_id,
       payment_id, outcome, received_at, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventId, ctx.workspaceId, providerName, externalEventId, read.kind,
        JSON.stringify(rawEvent ?? {}), requestId, paymentId, outcome, now, now);
    return outcome;
  };

  if (read.kind === 'IGNORED') {
    return { applied: false, outcome: record(read.reason || 'Nothing StockChief acts on.') };
  }
  if (!matched) {
    return { applied: false, outcome: record('No payment request in this inventory matches that invoice.') };
  }
  if (read.kind === 'FAILED') {
    db.prepare("UPDATE payment_requests SET last_error = ?, updated_at = ? WHERE id = ?")
      .run(read.reason || 'The payment did not go through.', nowIso(), matched.id);
    return { applied: false, request: get(db, ctx.workspaceId, matched.id),
      outcome: record(read.reason || 'The payment did not go through.', matched.id) };
  }
  if (read.kind === 'REFUNDED') {
    // Recorded and surfaced, never posted here: a refund is money leaving, and
    // it goes through the same approval a payment out always has.
    return { applied: false, request: get(db, ctx.workspaceId, matched.id),
      outcome: record('A refund was reported. StockChief recorded it and did not post it.', matched.id) };
  }

  /*
   * What the provider says arrived, and nothing else.
   *
   * This used to fall back to the amount StockChief had asked for whenever the
   * reported figure was missing or zero. Stripe then finalised an invoice for
   * $0.00 — a separate bug, since fixed — reported amount_paid: 0, and StockChief
   * wrote a $10.00 receipt into the books off the back of it. Twice.
   *
   * Zero is an answer. It means no money arrived, and the one thing StockChief
   * must never do is state a figure no one gave it. So an event that reports
   * nothing arriving records nothing, and says so where the owner will see it.
   */
  const reported = read.amountMinor;
  if (reported === null || reported === undefined || Number.isNaN(Number(reported))) {
    return { applied: false, request: get(db, ctx.workspaceId, matched.id),
      outcome: record(`${providerName} reported a payment without an amount. `
        + 'Nothing was recorded, because StockChief will not supply the figure itself.', matched.id) };
  }
  const amountMinor = Number(reported);
  if (amountMinor <= 0) {
    return { applied: false, request: get(db, ctx.workspaceId, matched.id),
      outcome: record(`${providerName} reported this as settled with nothing paid. `
        + 'Nothing was recorded. Check the invoice on the provider before treating this as money in.',
      matched.id) };
  }

  /*
   * Who StockChief is acting as when a provider tells it money arrived.
   *
   * Nobody is signed in — a webhook is a machine talking to a machine — so
   * there is no membership to carry. Attributing the receipt to the workspace
   * owner would be a lie about who did it, and refusing to post until somebody
   * signs in would mean a verified payment sits unrecorded until a person
   * notices, which is the entire thing this feature exists to stop.
   *
   * So StockChief acts with exactly one permission: recording a payment. It is
   * reachable only from here, only after the provider's signature verified, and
   * only for an event matched to a request StockChief itself created. The receipt
   * records no user, which is true: no user did this.
   */
  /*
   * What the provider reports is the invoice's running total, not this
   * instalment.
   *
   * Stripe sends two events for one payment — invoice.paid and
   * invoice.payment_succeeded — with different event ids and the same
   * amount_paid. StockChief deduplicated on the event id, so both got through,
   * and each added the full figure again: one $300.00 card payment became
   * $600.00 in the books and a request marked as paid twice over.
   *
   * So the arithmetic changes rather than the guard. StockChief records the
   * difference between what the provider says has been paid and what it has
   * already recorded, which is the same number for a first report, zero for a
   * repeat of it, and exactly the instalment for a genuine second payment.
   */
  const alreadyRecordedMinor = Number(matched.paid_minor || 0);
  const newlyPaidMinor = amountMinor - alreadyRecordedMinor;
  if (newlyPaidMinor <= 0) {
    return { applied: false, request: get(db, ctx.workspaceId, matched.id),
      outcome: record(`${providerName} reported ${(amountMinor / 100).toFixed(2)} paid, which `
        + 'StockChief has already recorded. Nothing was added.', matched.id) };
  }

  const authority = options.membership || ctx.membership
    || { role: 'system', permissions: JSON.stringify(['RECORD_PAYMENTS']) };

  const outcome = inTransaction(db, () => {
    /*
     * The same door a cheque comes through.
     *
     * sourceKey names the provider's event, so the payment engine refuses a
     * duplicate even if this function were reached twice.
     */
    const receipt = payments.record(db, { ...ctx, actorId: ctx.actorId || null }, authority, {
      direction: 'CUSTOMER_RECEIPT',
      customerId: matched.customer_id,
      paymentDate: (read.paidAt || now).slice(0, 10),
      amountMinor: newlyPaidMinor,
      method: read.method || 'card',
      reference: read.externalPaymentId || externalEventId,
      /*
       * Named for the money, not for the message that carried it. Two events
       * describing one payment produce one key, so the payment engine refuses
       * the second even if it were reached with a stale balance.
       */
      sourceKey: `${providerName}:${matched.id}:paid:${amountMinor}`,
      /*
       * Which order this was taken against, so a deposit paid before there is
       * anything to allocate it to still counts on the order it belongs to.
       */
      salesOrderId: matched.sales_order_id,
      allocations: matched.invoice_id
        ? [{ invoiceId: matched.invoice_id, amountMinor: newlyPaidMinor }] : [],
    });

    // The provider's own total, not an accumulation of StockChief's arithmetic.
    const paid = amountMinor;
    db.prepare(`UPDATE payment_requests SET paid_minor = ?, status = ?, paid_at = ?, updated_at = ?
      WHERE id = ?`)
      .run(paid, paid >= Number(matched.amount_minor) ? 'PAID' : 'OPEN',
        paid >= Number(matched.amount_minor) ? now : null, now, matched.id);

    const payment = receipt && receipt.payment ? receipt.payment : receipt;
    record(`Recorded ${(newlyPaidMinor / 100).toFixed(2)} against ${matched.invoice_id ? 'the invoice' : 'the customer'}.`,
      matched.id, payment && payment.id ? payment.id : null);
    return { applied: true, amountMinor: newlyPaidMinor, paymentId: payment && payment.id };
  });

  const settledRequest = get(db, ctx.workspaceId, matched.id);
  const controls = require('../accounting/reports').controlReconciliation(db, ctx.workspaceId);
  const reconciled = Boolean(controls.ar.reconciled && controls.ap.reconciled);
  const paymentAccount = providerName === 'stripe'
    ? require('./accounts').describe(db, ctx.workspaceId) : { liveMode: false };
  require('../operations/checkpoints').record(db, 'integration.payment_settlement',
    settledRequest && settledRequest.status === 'PAID' && reconciled ? 'PASS' : 'FAIL', {
      settled: Boolean(settledRequest && settledRequest.status === 'PAID'), reconciled,
      provider: providerName, paymentRequestId: matched.id,
      liveMode: paymentAccount.liveMode === true,
      releaseRef: require('../config').operations.releaseRef,
      arDifferenceMinor: controls.ar.differenceMinor, apDifferenceMinor: controls.ap.differenceMinor,
    });

  return { ...outcome, request: get(db, ctx.workspaceId, matched.id),
    outcome: `Recorded ${(newlyPaidMinor / 100).toFixed(2)}.` };
}

function recordTransportEvidence(db, provider, transport, liveMode) {
  const checkpoints = require('../operations/checkpoints');
  const prior = checkpoints.get(db, 'integration.webhook_fallback');
  const sameProvider = prior?.detail?.provider === provider;
  const priorHasTransport = sameProvider && (prior.detail.webhookVerified === true
    || prior.detail.pollFallbackVerified === true);
  checkpoints.record(db, 'integration.webhook_fallback', 'PASS', {
    provider,
    webhookVerified: transport === 'webhook'
      || (sameProvider && prior.detail.webhookVerified === true),
    pollFallbackVerified: transport === 'poll'
      || (sameProvider && prior.detail.pollFallbackVerified === true),
    liveMode: liveMode === true && (!priorHasTransport || prior.detail.liveMode === true),
    releaseRef: require('../config').operations.releaseRef,
  });
}

/**
 * Ask the provider what happened, and record whatever it says.
 *
 * StockChief knew about a payment only if a webhook arrived, and a webhook needs
 * a public address the provider can reach. On a machine behind a company
 * network that address is a tunnel, and a tunnel that is not running is
 * silence that looks exactly like "nobody has paid". Meanwhile Stripe held a
 * declined charge and an unpaid invoice and would have said so to anybody who
 * asked.
 *
 * So this asks. It changes nothing itself: the answer is turned into the
 * event the provider would have sent and handed to the same engine, which
 * already refuses to record the same thing twice.
 */
async function refresh(db, ctx, requestId, options = {}) {
  const request = get(db, ctx.workspaceId, requestId);
  if (!request) return { checked: false, because: 'That payment request is not in this inventory.' };
  if (request.status !== 'OPEN' || !request.externalInvoiceId) {
    return { checked: false, because: 'There is nothing outstanding on that request.' };
  }
  const provider = providerRegistry.get(request.provider);
  if (typeof provider.readInvoice !== 'function' || typeof provider.eventFromInvoice !== 'function') {
    return { checked: false, because: `${request.provider} cannot be asked; it can only report.` };
  }

  let invoice;
  try {
    // The same context every other provider call is given.
    invoice = await provider.readInvoice(
      { ...require('./accounts').contextFor(db, ctx, request.provider), ...(options.providerContext || {}) },
      { externalInvoiceId: request.externalInvoiceId });
  } catch (error) {
    /*
     * Not being able to reach the provider is not news about the customer.
     * The request is left exactly as it was, and the reason is returned
     * rather than written onto the order as though the payment had failed.
     */
    return { checked: false, because: String(error.message || error) };
  }

  db.prepare('UPDATE payment_requests SET checked_at = ? WHERE id = ?').run(nowIso(), request.id);
  recordTransportEvidence(db, request.provider, 'poll', request.provider === 'stripe'
    && require('./accounts').describe(db, ctx.workspaceId).liveMode === true);
  const event = provider.eventFromInvoice(invoice);
  if (!event) return { checked: true, applied: false, because: 'Nothing has happened to it yet.' };
  const outcome = receiveEvent(db, ctx, request.provider, event);
  return { checked: true, ...outcome, request: get(db, ctx.workspaceId, request.id) };
}

/**
 * Every open request on one order, asked about at most once a minute.
 *
 * Bounded on purpose: this runs when somebody opens the order, and an order
 * page must not become as slow as the network on a bad day. A minute is far
 * inside the time it takes anybody to wonder whether the money arrived.
 */
async function refreshForOrder(db, ctx, orderId, options = {}) {
  const since = new Date(Date.now() - (options.staleAfterMs ?? 60_000)).toISOString();
  const open = db.prepare(`SELECT id FROM payment_requests
    WHERE workspace_id = ? AND sales_order_id = ? AND status = 'OPEN'
      AND external_invoice_id IS NOT NULL
      AND (checked_at IS NULL OR checked_at < ?)
    ORDER BY created_at DESC LIMIT 3`).all(ctx.workspaceId, orderId, since);
  const results = [];
  for (const row of open) {
    try { results.push(await refresh(db, ctx, row.id, options)); }
    catch (error) { results.push({ checked: false, because: String(error.message || error) }); }
  }
  return results;
}

module.exports = {
  get, forInvoice, forOrder, openLinkForOrder, amountToRequest,
  request, voidRequest, receiveEvent, refresh, refreshForOrder, recordTransportEvidence,
};
