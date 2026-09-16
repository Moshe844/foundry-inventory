'use strict';

/*
 * Shippo, behind the same five functions as EasyPost.
 *
 * This file is the argument for the seam. Shippo names almost nothing the way
 * EasyPost does — rates are "amount" in dollars as a string rather than
 * "rate", a bought label is a "transaction" rather than a shipment, tracking
 * statuses are SHOUTED, and a shipment is created with a list of parcels
 * rather than one at a time. None of that reaches anything above here.
 *
 * Adding it changed no other file. That is the whole test of whether the
 * abstraction was real.
 *
 * The key is read from the environment and never from the database, exactly as
 * with EasyPost.
 */

const { ValidationError, AuthenticationError } = require('../../domain/errors');
const { safeEqual } = require('../../connections/providers/common');

const BASE = 'https://api.goshippo.com';

function apiKey(ctx = {}) {
  const key = ctx.shippoApiKey || process.env.SHIPPO_API_KEY;
  if (!key) {
    throw new ValidationError('No Shippo API key is configured, so StockChief cannot ask a carrier for '
      + 'rates. Set SHIPPO_API_KEY and restart, or hand the parcel over yourself and record it.');
  }
  return String(key);
}

function isConfigured() { return Boolean(process.env.SHIPPO_API_KEY); }

async function call(ctx, path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `ShippoToken ${apiKey(ctx)}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const detail = body?.detail || body?.error || `Shippo returned ${response.status}.`;
    const error = new ValidationError(typeof detail === 'string' ? detail : JSON.stringify(detail));
    error.status = response.status;
    throw error;
  }
  return body;
}

/** StockChief's address shape, in Shippo's. Nothing is invented. */
function address(input = {}) {
  return {
    name: input.name || undefined,
    company: input.company || undefined,
    street1: input.line1 || undefined,
    street2: input.line2 || undefined,
    city: input.city || undefined,
    state: input.state || undefined,
    zip: input.postalCode || undefined,
    country: input.country || 'US',
    phone: input.phone || undefined,
    email: input.email || undefined,
  };
}

const GRAMS_PER_OUNCE = 28.349523125;
const MM_PER_INCH = 25.4;

/*
 * Shippo wants every parcel to carry dimensions, and refuses without them.
 * A shop that has not measured its boxes is not a shop that cannot ship, so a
 * conservative default stands in — and it is a default, stated here, rather
 * than a measurement StockChief pretends to have.
 */
const DEFAULT_BOX_MM = { length: 300, width: 200, height: 150 };

function parcel(box = {}) {
  return {
    weight: Math.max(0.1, Number(box.weightGrams || 0) / GRAMS_PER_OUNCE).toFixed(2),
    mass_unit: 'oz',
    length: ((Number(box.lengthMm) || DEFAULT_BOX_MM.length) / MM_PER_INCH).toFixed(2),
    width: ((Number(box.widthMm) || DEFAULT_BOX_MM.width) / MM_PER_INCH).toFixed(2),
    height: ((Number(box.heightMm) || DEFAULT_BOX_MM.height) / MM_PER_INCH).toFixed(2),
    distance_unit: 'in',
  };
}

const minorFrom = (amount) => Math.round(Number(amount || 0) * 100);

/** A Shippo rate, in StockChief's shape. */
function readRate(row) {
  const days = row.estimated_days === null || row.estimated_days === undefined
    ? null : Number(row.estimated_days);
  return {
    rateId: row.object_id,
    carrier: String(row.provider || '').toLowerCase(),
    service: row.servicelevel?.name || row.servicelevel_name || 'Service',
    amountMinor: minorFrom(row.amount),
    currency: row.currency || 'USD',
    deliveryDays: days,
    /*
     * Shippo gives a number of days rather than a date. Turned into a date
     * here so that everything above compares dates with dates — a rule about
     * arriving by the promised date should not have to know that one provider
     * counts and another names the day.
     */
    deliveryDate: days === null ? null
      : new Date(Date.now() + days * 24 * 60 * 60_000).toISOString().slice(0, 10),
    guaranteed: Boolean(row.attributes && row.attributes.includes('BESTVALUE') === false
      && row.servicelevel?.terms),
  };
}

/* ----------------------------------------------------------------- rates */

async function quote(ctx, input = {}) {
  const packages = input.packages && input.packages.length ? input.packages : [{}];
  const created = await call(ctx, '/shipments/', { method: 'POST', body: {
    address_from: address(input.from),
    address_to: address(input.to),
    parcels: packages.map(parcel),
    async: false,
  } });
  return {
    providerShipmentIds: [created.object_id],
    rates: (created.rates || []).map(readRate),
  };
}

/* ----------------------------------------------------------------- label */

async function buy(ctx, input = {}) {
  const rateId = (input.rateIds && input.rateIds[0]) || input.rateId;
  const transaction = await call(ctx, '/transactions/', { method: 'POST', body: {
    rate: rateId, label_file_type: 'PDF', async: false,
  }, headers: input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {} });
  if (transaction.status && String(transaction.status).toUpperCase() !== 'SUCCESS') {
    const messages = (transaction.messages || []).map((row) => row.text).filter(Boolean);
    throw new ValidationError(messages.join(' ') || 'Shippo could not buy that label.');
  }
  const rate = transaction.rate && typeof transaction.rate === 'object' ? transaction.rate : null;
  return {
    providerShipmentId: transaction.object_id,
    providerShipmentIds: [transaction.object_id],
    providerLabelIds: [transaction.object_id],
    carrier: String(rate?.provider || input.carrier || '').toLowerCase(),
    service: rate?.servicelevel?.name || null,
    trackingNumber: transaction.tracking_number || null,
    trackingUrl: transaction.tracking_url_provider || null,
    labelUrl: transaction.label_url || null,
    labelFormat: 'PDF',
    labelUrls: [transaction.label_url].filter(Boolean),
    amountMinor: minorFrom(rate?.amount ?? input.amount ?? 0),
    currency: rate?.currency || 'USD',
    deliveryDate: null,
  };
}

async function voidLabel(ctx, input = {}) {
  const ids = (input.providerReferences || input.providerLabelIds || []).filter(Boolean);
  if (!ids.length) throw new ValidationError('StockChief has no Shippo transaction reference to refund.');
  const answers = [];
  for (const id of ids) {
    answers.push(await call(ctx, '/refunds/', { method: 'POST', body: { transaction: id },
      headers: input.idempotencyKey ? { 'Idempotency-Key': `${input.idempotencyKey}:${id}` } : {} }));
  }
  const states = answers.map((row) => String(row.status || '').toUpperCase());
  const failed = states.some((state) => ['ERROR','FAILED','REJECTED'].includes(state));
  const complete = states.length > 0 && states.every((state) => ['SUCCESS','REFUNDED'].includes(state));
  return { status: failed ? 'FAILED' : complete ? 'SUCCEEDED' : 'PENDING', references: ids,
    detail: states.filter(Boolean).join(', ') || 'Refund submitted to Shippo.' };
}

/* -------------------------------------------------------------- tracking */

const STATUS = {
  PRE_TRANSIT: 'PRE_TRANSIT',
  TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  RETURNED: 'RETURNED',
  FAILURE: 'FAILURE',
  UNKNOWN: 'UNKNOWN',
};

const statusOf = (value) => STATUS[String(value || '').toUpperCase()] || 'UNKNOWN';

function readDetails(tracker) {
  return (tracker?.tracking_history || []).map((entry, index) => ({
    externalEventId: entry.object_id || `${tracker.tracking_number}:${index}`,
    status: statusOf(entry.status),
    detail: entry.status_details || null,
    location: [entry.location?.city, entry.location?.state].filter(Boolean).join(', ') || null,
    occurredAt: entry.status_date || null,
  })).filter((entry) => entry.occurredAt);
}

async function track(ctx, input = {}) {
  if (!input.trackingNumber) return null;
  const carrier = String(input.carrier || 'shippo').toLowerCase();
  const tracker = await call(ctx,
    `/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(input.trackingNumber)}`);
  if (!tracker) return null;
  return {
    providerTrackerId: tracker.object_id || null,
    carrier: String(tracker.carrier || carrier).toLowerCase(),
    trackingUrl: tracker.tracking_url_provider || null,
    status: statusOf(tracker.tracking_status?.status),
    detail: tracker.tracking_status?.status_details || null,
    estimatedDeliveryDate: tracker.eta ? String(tracker.eta).slice(0, 10) : null,
    events: readDetails(tracker),
  };
}

/* -------------------------------------------------------------- webhooks */

/**
 * Shippo does not sign its webhooks.
 *
 * So the shared secret is carried in the path or a header the owner sets, and
 * this refuses anything that does not present it. When no secret is configured
 * the message is accepted and read — which is Shippo's own default posture,
 * and worth being explicit about rather than implying a signature check that
 * is not happening.
 */
function verifyEvent(raw, headers = {}, options = {}) {
  const secret = options.webhookSecret || process.env.SHIPPO_WEBHOOK_SECRET;
  if (secret) {
    const presented = headers['x-shippo-secret'] || headers['X-Shippo-Secret'] || '';
    if (!safeEqual(String(presented), String(secret))) {
      throw new AuthenticationError('This shipping webhook did not carry the expected secret.');
    }
  }
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    throw new ValidationError('This shipping webhook was not readable.');
  }
}

function readEvent(event = {}) {
  const tracker = event.data || event;
  return {
    externalEventId: event.object_id || tracker.object_id || null,
    type: event.event || null,
    providerTrackerId: tracker.object_id || null,
    providerShipmentId: tracker.transaction || null,
    trackingNumber: tracker.tracking_number || null,
    carrier: String(tracker.carrier || '').toLowerCase() || null,
    status: statusOf(tracker.tracking_status?.status),
    detail: tracker.tracking_status?.status_details || null,
    estimatedDeliveryDate: tracker.eta ? String(tracker.eta).slice(0, 10) : null,
    events: readDetails(tracker),
  };
}

module.exports = { isConfigured, quote, buy, voidLabel, track, verifyEvent, readEvent,
  address, parcel, statusOf, readRate, call };
