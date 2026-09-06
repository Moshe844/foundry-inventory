'use strict';

/**
 * The seam between Foundry and whoever moves the box.
 *
 * A sales order must not know what EasyPost is, and it must not know what UPS
 * is either. It knows there are goods, an address and a date it promised. Who
 * carries them is a property of the shipment, so adding Shippo later — or a
 * direct FedEx account when the volume justifies one — is a new row value
 * rather than a new idea threaded through fifteen files.
 *
 * This is deliberately the same shape as the payments seam. That is not
 * tidiness: the two problems are the same problem. An outside company does
 * something in the real world, tells us about it in its own vocabulary, and
 * Foundry has to hold exactly the few facts its own records turn on.
 *
 * A provider implements five things, and Foundry never asks for more:
 *
 *   quote(ctx, { from, to, packages })   -> [{ rateId, carrier, service, amountMinor,
 *                                              currency, deliveryDays, deliveryDate,
 *                                              guaranteed }]
 *   buy(ctx, { rateId, shipmentRef })    -> { shipmentId, carrier, service, trackingNumber,
 *                                             trackingUrl, labelUrl, labelFormat,
 *                                             amountMinor, currency, deliveryDate }
 *   track(ctx, { trackingNumber, carrier, providerShipmentId })
 *                                        -> { status, detail, events: [...] }
 *   verifyEvent(raw, headers, options)   -> the event, or throws
 *   readEvent(event)                     -> a shape Foundry understands
 *
 * `readEvent` is the important one, exactly as it is for payments. It turns
 * whatever the carrier calls things into the handful of facts Foundry acts on:
 * which shipment this is about, where the parcel has got to, when that
 * happened, and whether something has gone wrong. Everything downstream — the
 * order's status, the customer's notice, the exception that reaches Needs You
 * — reads that shape and never the provider's.
 *
 * The statuses are Foundry's, not any carrier's. Every carrier has its own
 * words for the same seven things, and translating once here is what stops
 * "IT" and "InTransit" and "in_transit" from all having to be understood by a
 * screen that just wants to say where the parcel is.
 */

const { ValidationError } = require('../domain/errors');

/** Where a parcel can be. The carrier's words are translated into these. */
const STATUSES = ['PRE_TRANSIT', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED',
  'RETURNED', 'FAILURE', 'CANCELLED', 'UNKNOWN'];

/** The ones that mean nobody is waiting for this parcel any more. */
const SETTLED = ['DELIVERED', 'RETURNED', 'CANCELLED'];

/** The ones that mean somebody should look. */
const TROUBLE = ['RETURNED', 'FAILURE'];

const REQUIRED = ['quote', 'buy', 'track', 'verifyEvent', 'readEvent'];

const providers = new Map();

function register(name, provider) {
  const key = String(name || '').toLowerCase();
  if (!key) throw new TypeError('A shipping provider needs a name.');
  const missing = REQUIRED.filter((method) => typeof provider?.[method] !== 'function');
  if (missing.length) {
    throw new TypeError(`Shipping provider "${key}" is missing: ${missing.join(', ')}.`);
  }
  providers.set(key, provider);
  return () => providers.delete(key);
}

function get(name) {
  const key = String(name || '').toLowerCase();
  const found = providers.get(key);
  if (!found) {
    throw new ValidationError(`No shipping provider called "${name}" is connected to this inventory.`);
  }
  return found;
}

function has(name) { return providers.has(String(name || '').toLowerCase()); }

function names() { return [...providers.keys()]; }

/**
 * The one configured for this workspace, or null.
 *
 * Null rather than an error: a shop with no carrier account is not broken, it
 * is a shop that hands parcels over itself. Everything about shipping has to
 * keep working for them, which is why the manual path stays and this only ever
 * adds to it.
 */
function configured() {
  const preferred = String(process.env.SHIPPING_PROVIDER || 'shipengine').toLowerCase();
  if (has(preferred) && get(preferred).isConfigured && get(preferred).isConfigured()) return preferred;
  for (const name of providers.keys()) {
    const provider = providers.get(name);
    if (provider.isConfigured && provider.isConfigured()) return name;
  }
  return null;
}

module.exports = { STATUSES, SETTLED, TROUBLE, REQUIRED, register, get, has, names, configured };
