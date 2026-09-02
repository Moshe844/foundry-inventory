'use strict';

/**
 * Asking a customer to pay, and learning that they did.
 *
 * Two halves. Going out: Foundry works out what is due from the customer's
 * terms, asks a provider for a hosted page, and keeps the link so it can be put
 * in front of the customer. Coming back: the provider sends an event, and
 * Foundry turns it into an ordinary receipt.
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
 * out of the payment position, which comes out of the invoice.
 */
function amountToRequest(db, workspaceId, order, purpose) {
  const position = paymentTerms.positionForOrder(db, workspaceId, order);
  if (!position.invoiced) {
    throw new ValidationError('There is no invoice on this order yet, so there is nothing to ask them to pay.');
  }
  if (purpose === 'DEPOSIT') {
    if (!position.dueNowMinor) {
      throw new ValidationError('No deposit is outstanding on this order.');
    }
    return { amountMinor: position.dueNowMinor, position };
  }
  if (!position.remainingMinor) throw new ValidationError('This order is already paid in full.');
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
    .run(id, ctx.workspaceId, invoice.id, orderId, customer.id, providerName, purpose,
      amountMinor, position.currency, previous ? previous.external_customer_id : null,
      ctx.actorId || null, now, now);

  try {
    const externalCustomerId = previous ? previous.external_customer_id
      : (await provider.createCustomer(ctx, { name: customer.name, email: customer.email })).externalCustomerId;

    const created = await provider.createInvoice(ctx, {
      externalCustomerId,
      amountMinor,
      currency: position.currency,
      description: purpose === 'DEPOSIT'
        ? `Deposit for ${order.order_number}`
        : `${order.order_number}`,
      reference: invoice.invoice_number,
      dueDate: invoice.due_date || null,
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
    return { applied: false, outcome: record(read.reason || 'Nothing Foundry acts on.') };
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
      outcome: record('A refund was reported. Foundry recorded it and did not post it.', matched.id) };
  }

  const amountMinor = read.amountMinor && read.amountMinor > 0
    ? read.amountMinor
    : Number(matched.amount_minor);

  /*
   * Who Foundry is acting as when a provider tells it money arrived.
   *
   * Nobody is signed in — a webhook is a machine talking to a machine — so
   * there is no membership to carry. Attributing the receipt to the workspace
   * owner would be a lie about who did it, and refusing to post until somebody
   * signs in would mean a verified payment sits unrecorded until a person
   * notices, which is the entire thing this feature exists to stop.
   *
   * So Foundry acts with exactly one permission: recording a payment. It is
   * reachable only from here, only after the provider's signature verified, and
   * only for an event matched to a request Foundry itself created. The receipt
   * records no user, which is true: no user did this.
   */
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
      amountMinor,
      method: read.method || 'card',
      reference: read.externalPaymentId || externalEventId,
      sourceKey: `${providerName}:${externalEventId}`,
      allocations: matched.invoice_id ? [{ invoiceId: matched.invoice_id, amountMinor }] : [],
    });

    const paid = Number(matched.paid_minor) + amountMinor;
    db.prepare(`UPDATE payment_requests SET paid_minor = ?, status = ?, paid_at = ?, updated_at = ?
      WHERE id = ?`)
      .run(paid, paid >= Number(matched.amount_minor) ? 'PAID' : 'OPEN',
        paid >= Number(matched.amount_minor) ? now : null, now, matched.id);

    const payment = receipt && receipt.payment ? receipt.payment : receipt;
    record(`Recorded ${(amountMinor / 100).toFixed(2)} against ${matched.invoice_id ? 'the invoice' : 'the customer'}.`,
      matched.id, payment && payment.id ? payment.id : null);
    return { applied: true, amountMinor, paymentId: payment && payment.id };
  });

  return { ...outcome, request: get(db, ctx.workspaceId, matched.id),
    outcome: `Recorded ${(amountMinor / 100).toFixed(2)}.` };
}

module.exports = {
  get, forInvoice, forOrder, openLinkForOrder, amountToRequest,
  request, voidRequest, receiveEvent,
};
