'use strict';

/**
 * The seam between Foundry and whoever processes the money.
 *
 * Sales orders must not know what Stripe is. An order knows it is owed an
 * amount and that somebody was asked to pay it; which company ran the card is a
 * property of the request, so adding Square later is a new row value rather
 * than a new idea threaded through fifteen files.
 *
 * A provider implements six things, and Foundry never asks for more:
 *
 *   createCustomer(ctx, { name, email })        -> { externalCustomerId }
 *   createInvoice(ctx, { ... })                 -> { externalInvoiceId, hostedUrl, status }
 *   getHostedPaymentUrl(ctx, { externalInvoiceId }) -> string | null
 *   refundPayment(ctx, { externalPaymentId, amountMinor }) -> { externalRefundId }
 *   verifyEvent(raw, headers)                   -> the event, or throws
 *   readEvent(event)                            -> a shape Foundry understands
 *
 * `readEvent` is the important one. It turns whatever the provider calls things
 * into the only four facts Foundry acts on: which request this is about, how
 * much was paid, what the provider's own id for that payment is, and whether
 * anything went wrong. Everything downstream — receipts, the invoice balance,
 * the fulfilment hold — reads that shape and never the provider's.
 *
 * Nothing here handles a card number, and nothing ever should: payment happens
 * on the provider's own hosted page, and Foundry only ever learns the outcome.
 */

const { ValidationError } = require('../domain/errors');

const REQUIRED = ['createCustomer', 'createInvoice', 'getHostedPaymentUrl',
  'refundPayment', 'verifyEvent', 'readEvent'];

const providers = new Map();

function register(name, provider) {
  const key = String(name || '').toLowerCase();
  if (!key) throw new TypeError('A payment provider needs a name.');
  const missing = REQUIRED.filter((method) => typeof provider?.[method] !== 'function');
  if (missing.length) {
    throw new TypeError(`Payment provider "${key}" is missing: ${missing.join(', ')}.`);
  }
  providers.set(key, provider);
  return () => providers.delete(key);
}

function get(name) {
  const key = String(name || '').toLowerCase();
  const found = providers.get(key);
  if (!found) {
    throw new ValidationError(`No payment provider called "${name}" is connected to this inventory.`);
  }
  return found;
}

function has(name) {
  return providers.has(String(name || '').toLowerCase());
}

function list() {
  return [...providers.keys()];
}

/**
 * The shape `readEvent` must return.
 *
 * `kind` is deliberately small. A provider has forty event types and Foundry
 * acts on three of them; the rest are recorded and ignored, which is both
 * honest and the reason a new provider is a day's work rather than a month's.
 */
const KINDS = ['PAID', 'FAILED', 'REFUNDED', 'IGNORED'];

function normalise(read) {
  if (!read || !KINDS.includes(read.kind)) {
    return { kind: 'IGNORED', reason: 'Foundry does not act on this kind of event.' };
  }
  return {
    kind: read.kind,
    externalInvoiceId: read.externalInvoiceId || null,
    externalPaymentId: read.externalPaymentId || null,
    amountMinor: read.amountMinor === undefined || read.amountMinor === null
      ? null : Math.round(Number(read.amountMinor)),
    currency: read.currency || null,
    method: read.method || null,
    paidAt: read.paidAt || null,
    reason: read.reason || null,
  };
}

module.exports = { register, get, has, list, normalise, REQUIRED, KINDS };
