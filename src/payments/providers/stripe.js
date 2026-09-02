'use strict';

/**
 * Stripe, as a payment provider.
 *
 * Stripe Invoicing is a good fit for what Foundry needs: it hosts the page, it
 * owns the card details, it issues the receipt, and it tells you what happened.
 * Foundry creates a customer, creates an invoice, finalises it to get the
 * hosted URL, and then waits to be told.
 *
 * What this deliberately does not do is decide anything. Stripe's hosted page
 * will not let a customer type in an arbitrary part-payment, and that suits
 * Foundry: the amount is whatever the customer's terms said was due, worked out
 * before this file is reached. A deposit is an invoice for the deposit; the
 * balance is a second invoice later. Two invoices for one order is how a
 * deposit works everywhere else too.
 *
 * Honesty about what is proven: this is written against Stripe's documented
 * API and is exercised in tests through a stub. It has not been run against a
 * live Stripe account, because there is no key on this machine. The seam it
 * implements is proven; the wire format is not. Treat the first real call as
 * the test it is.
 *
 * No card number ever reaches this process. Foundry holds identifiers and a
 * URL, nothing else.
 */

const crypto = require('node:crypto');
const { ValidationError, AuthenticationError } = require('../../domain/errors');

const API = 'https://api.stripe.com/v1';

function credentials(ctx = {}) {
  const key = ctx.stripeSecretKey || process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new ValidationError('Connect Stripe before asking a customer to pay online.');
  }
  return key;
}

/** Stripe takes form-encoded bodies, including for nested fields. */
function form(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    body.append(key, String(value));
  }
  return body;
}

async function call(ctx, path, { method = 'POST', values = null, idempotencyKey = null } = {}) {
  const headers = {
    Authorization: `Bearer ${credentials(ctx)}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  // Stripe deduplicates on this, so a retry after a timeout cannot create a
  // second invoice for the same request.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: values ? form(values) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Stripe refused the request (${response.status}).`;
    if (response.status === 401) throw new AuthenticationError(`Stripe rejected the key: ${message}`);
    throw new ValidationError(message);
  }
  return payload;
}

async function createCustomer(ctx, { name, email }) {
  const created = await call(ctx, '/customers', {
    values: { name, email },
    idempotencyKey: `foundry-customer:${email}`,
  });
  return { externalCustomerId: created.id };
}

/**
 * An invoice with one line, finalised so it has a page somebody can pay on.
 *
 * `collection_method: send_invoice` is what produces a hosted invoice URL
 * rather than an attempt to charge a saved card, which is the whole point: the
 * customer is being asked, not billed.
 */
async function createInvoice(ctx, { externalCustomerId, amountMinor, currency, description, reference, dueDate }) {
  const idempotency = `foundry-invoice:${reference}:${amountMinor}`;

  await call(ctx, '/invoiceitems', {
    values: {
      customer: externalCustomerId,
      amount: Math.round(Number(amountMinor)),
      currency: String(currency || 'usd').toLowerCase(),
      description,
    },
    idempotencyKey: `${idempotency}:item`,
  });

  const invoice = await call(ctx, '/invoices', {
    values: {
      customer: externalCustomerId,
      collection_method: 'send_invoice',
      days_until_due: dueDate ? undefined : 30,
      due_date: dueDate ? Math.floor(new Date(`${dueDate}T00:00:00Z`).getTime() / 1000) : undefined,
      description,
      'metadata[foundry_reference]': reference,
    },
    idempotencyKey: idempotency,
  });

  const finalised = await call(ctx, `/invoices/${invoice.id}/finalize`, {
    idempotencyKey: `${idempotency}:finalize`,
  });

  return {
    externalInvoiceId: finalised.id,
    hostedUrl: finalised.hosted_invoice_url || null,
    status: finalised.status || null,
  };
}

async function getHostedPaymentUrl(ctx, { externalInvoiceId }) {
  const invoice = await call(ctx, `/invoices/${externalInvoiceId}`, { method: 'GET' });
  return invoice.hosted_invoice_url || null;
}

async function refundPayment(ctx, { externalPaymentId, amountMinor }) {
  const refund = await call(ctx, '/refunds', {
    values: { payment_intent: externalPaymentId, amount: amountMinor ? Math.round(Number(amountMinor)) : undefined },
    idempotencyKey: `foundry-refund:${externalPaymentId}:${amountMinor || 'all'}`,
  });
  return { externalRefundId: refund.id };
}

/**
 * Prove the event came from Stripe before believing a word of it.
 *
 * A webhook endpoint is a URL anybody can post to. Without this check, a
 * stranger could tell Foundry an invoice was paid, and Foundry would write it
 * into the books.
 */
function verifyEvent(raw, headers = {}, options = {}) {
  const secret = options.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET;
  const signature = headers['stripe-signature'] || headers['Stripe-Signature'];
  if (!secret) throw new ValidationError('Set the Stripe webhook signing secret before accepting events.');
  if (!signature) throw new AuthenticationError('That event arrived without a Stripe signature.');

  const parts = Object.fromEntries(String(signature).split(',')
    .map((piece) => piece.split('=', 2)).filter((pair) => pair.length === 2));
  const timestamp = parts.t;
  const provided = parts.v1;
  if (!timestamp || !provided) throw new AuthenticationError('That Stripe signature is not in a form Foundry can check.');

  const body = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new AuthenticationError('That event did not come from Stripe.');
  }

  // Five minutes, so a captured request cannot be replayed a day later.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) {
    throw new AuthenticationError('That Stripe event is too old to accept.');
  }
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * Stripe's vocabulary, translated into the four facts Foundry acts on.
 */
function readEvent(event) {
  const type = String(event?.type || '');
  const object = event?.data?.object || {};

  if (type === 'invoice.payment_succeeded' || type === 'invoice.paid') {
    return {
      kind: 'PAID',
      externalInvoiceId: object.id || null,
      externalPaymentId: object.payment_intent || object.charge || null,
      // amount_paid is what actually arrived, which is not always the total.
      amountMinor: object.amount_paid !== undefined ? object.amount_paid : object.amount_due,
      currency: (object.currency || '').toUpperCase() || null,
      method: 'card',
      paidAt: object.status_transitions?.paid_at
        ? new Date(object.status_transitions.paid_at * 1000).toISOString() : null,
    };
  }
  if (type === 'invoice.payment_failed') {
    return {
      kind: 'FAILED',
      externalInvoiceId: object.id || null,
      reason: object.last_finalization_error?.message || 'Stripe reported that the payment failed.',
    };
  }
  if (type === 'charge.refunded' || type === 'invoice.voided') {
    return {
      kind: 'REFUNDED',
      externalInvoiceId: object.invoice || object.id || null,
      externalPaymentId: object.payment_intent || object.id || null,
      amountMinor: object.amount_refunded,
      reason: 'Stripe reported a refund.',
    };
  }
  return { kind: 'IGNORED', reason: `Foundry does not act on ${type || 'that'}.` };
}

module.exports = {
  createCustomer, createInvoice, getHostedPaymentUrl, refundPayment, verifyEvent, readEvent,
  // Exported for tests; nothing above this file should reach for them.
  __internal: { call, form, credentials },
};
