'use strict';

/*
 * EasyPost: UPS, FedEx and USPS through one integration.
 *
 * Chosen over writing three carrier clients because the three carriers do not
 * disagree about anything a shop cares about. They disagree about
 * authentication, address validation, rate envelopes and tracking vocabularies
 * — none of which is a business problem, and all of which would be three times
 * as much code to maintain and three times as much to get wrong.
 *
 * When volume justifies a direct contract with one carrier, that carrier
 * becomes a second adapter behind the same seam and nothing above changes.
 *
 * The key is read from the environment and never from the database. Foundry
 * does not ask anybody to paste a secret into a form it stores, and a key in a
 * table is a key in a backup.
 */

const { ValidationError, AuthenticationError } = require('../../domain/errors');
const { safeEqual } = require('../../connections/providers/common');

const BASE = 'https://api.easypost.com/v2';

function apiKey(ctx = {}) {
  const key = ctx.easypostApiKey || process.env.EASYPOST_API_KEY;
  if (!key) {
    throw new ValidationError('No EasyPost API key is configured, so Foundry cannot ask a carrier '
      + 'for rates. Set EASYPOST_API_KEY and restart, or hand the parcel over yourself and record it.');
  }
  return String(key);
}

function isConfigured() { return Boolean(process.env.EASYPOST_API_KEY); }

async function call(ctx, path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Basic ${Buffer.from(`${apiKey(ctx)}:`).toString('base64')}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const message = body?.error?.message || body?.error || `EasyPost returned ${response.status}.`;
    const error = new ValidationError(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = response.status;
    throw error;
  }
  return body;
}

/* ------------------------------------------------------------- addresses */

/**
 * Foundry's address shape, in EasyPost's.
 *
 * Nothing is invented. A missing line stays missing and EasyPost says so,
 * because a parcel sent to an address Foundry completed on somebody's behalf
 * is a parcel nobody can find.
 */
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

/** EasyPost prices in ounces and inches; Foundry stores grams and millimetres. */
function parcel(box = {}) {
  const out = { weight: Math.max(0.1, Number(box.weightGrams || 0) / GRAMS_PER_OUNCE) };
  if (box.lengthMm && box.widthMm && box.heightMm) {
    out.length = Number(box.lengthMm) / MM_PER_INCH;
    out.width = Number(box.widthMm) / MM_PER_INCH;
    out.height = Number(box.heightMm) / MM_PER_INCH;
  }
  return out;
}

const minorFrom = (rate) => Math.round(Number(rate) * 100);

function readRate(row) {
  return {
    rateId: row.id,
    carrier: String(row.carrier || '').toLowerCase(),
    service: row.service,
    amountMinor: minorFrom(row.rate),
    currency: row.currency || 'USD',
    deliveryDays: row.delivery_days === null || row.delivery_days === undefined
      ? null : Number(row.delivery_days),
    deliveryDate: row.delivery_date ? String(row.delivery_date).slice(0, 10) : null,
    guaranteed: Boolean(row.delivery_date_guaranteed),
  };
}

/* ----------------------------------------------------------------- rates */

/**
 * What the carriers would charge for this, today.
 *
 * One EasyPost shipment covers one parcel, so a multi-box shipment is quoted
 * per box and the amounts added. That is also how the carrier bills it.
 */
async function quote(ctx, input = {}) {
  const packages = input.packages && input.packages.length ? input.packages : [{}];
  const quotes = [];
  for (const box of packages) {
    const created = await call(ctx, '/shipments', { method: 'POST', body: { shipment: {
      to_address: address(input.to),
      from_address: address(input.from),
      parcel: parcel(box),
      options: { label_format: 'PDF' },
    } } });
    quotes.push({ providerShipmentId: created.id, rates: (created.rates || []).map(readRate) });
  }

  if (quotes.length === 1) {
    return { providerShipmentIds: [quotes[0].providerShipmentId], rates: quotes[0].rates };
  }

  /*
   * Several boxes: only services every box can go by, priced as the sum.
   *
   * Offering a service one parcel of three can use would be offering something
   * that cannot happen. The rate id kept is the first box's; buying walks all
   * of them, which is why the ids travel together.
   */
  const byService = new Map();
  for (const rate of quotes[0].rates) byService.set(`${rate.carrier}|${rate.service}`, { ...rate });
  for (const rest of quotes.slice(1)) {
    const seen = new Map(rest.rates.map((rate) => [`${rate.carrier}|${rate.service}`, rate]));
    for (const [key, combined] of [...byService]) {
      const match = seen.get(key);
      if (!match) { byService.delete(key); continue; }
      combined.amountMinor += match.amountMinor;
      combined.rateIds = [...(combined.rateIds || [combined.rateId]), match.rateId];
      if (match.deliveryDays && (!combined.deliveryDays || match.deliveryDays > combined.deliveryDays)) {
        combined.deliveryDays = match.deliveryDays;
      }
      if (match.deliveryDate && (!combined.deliveryDate || match.deliveryDate > combined.deliveryDate)) {
        combined.deliveryDate = match.deliveryDate;
      }
      combined.guaranteed = combined.guaranteed && match.guaranteed;
    }
  }
  return {
    providerShipmentIds: quotes.map((entry) => entry.providerShipmentId),
    rates: [...byService.values()],
  };
}

/* ----------------------------------------------------------------- label */

/**
 * Buy the label. This spends money, and it is the only call here that does.
 *
 * The tracking number and the label file come straight back from the carrier;
 * neither is constructed by Foundry. A label URL that Foundry assembled would
 * eventually point at nothing.
 */
async function buy(ctx, input = {}) {
  const ids = input.providerShipmentIds && input.providerShipmentIds.length
    ? input.providerShipmentIds : [input.providerShipmentId];
  const rateIds = input.rateIds && input.rateIds.length ? input.rateIds : [input.rateId];
  const bought = [];
  for (let index = 0; index < ids.length; index += 1) {
    bought.push(await call(ctx, `/shipments/${encodeURIComponent(ids[index])}/buy`, {
      method: 'POST', body: { rate: { id: rateIds[index] || rateIds[0] } },
    }));
  }
  const lead = bought[0];
  const totalMinor = bought.reduce((sum, row) => sum + minorFrom(row.selected_rate?.rate || 0), 0);
  return {
    providerShipmentId: lead.id,
    providerShipmentIds: bought.map((row) => row.id),
    carrier: String(lead.selected_rate?.carrier || '').toLowerCase(),
    service: lead.selected_rate?.service || null,
    trackingNumber: lead.tracking_code || null,
    trackingUrl: lead.tracker?.public_url || null,
    labelUrl: lead.postage_label?.label_url || null,
    labelFormat: lead.postage_label?.label_file_type || null,
    labelUrls: bought.map((row) => row.postage_label?.label_url).filter(Boolean),
    amountMinor: totalMinor,
    currency: lead.selected_rate?.currency || 'USD',
    deliveryDate: lead.selected_rate?.delivery_date
      ? String(lead.selected_rate.delivery_date).slice(0, 10) : null,
  };
}

/* -------------------------------------------------------------- tracking */

/*
 * Every carrier's word for the same seven places a parcel can be.
 *
 * Anything unrecognised becomes UNKNOWN rather than being guessed at. A parcel
 * whose status Foundry cannot read is a parcel it should say nothing about.
 */
const STATUS = {
  pre_transit: 'PRE_TRANSIT',
  in_transit: 'IN_TRANSIT',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  available_for_pickup: 'OUT_FOR_DELIVERY',
  return_to_sender: 'RETURNED',
  failure: 'FAILURE',
  cancelled: 'CANCELLED',
  error: 'FAILURE',
  unknown: 'UNKNOWN',
};

const statusOf = (value) => STATUS[String(value || '').toLowerCase()] || 'UNKNOWN';

function readDetails(tracker) {
  return (tracker?.tracking_details || []).map((entry) => ({
    externalEventId: entry.object_id || `${tracker.id}:${entry.datetime}:${entry.status}`,
    status: statusOf(entry.status),
    detail: entry.message || entry.description || null,
    location: [entry.tracking_location?.city, entry.tracking_location?.state]
      .filter(Boolean).join(', ') || null,
    occurredAt: entry.datetime || null,
  })).filter((entry) => entry.occurredAt);
}

/** Ask where the parcel is. The fallback, not the primary way of knowing. */
async function track(ctx, input = {}) {
  let tracker = null;
  if (input.providerTrackerId) {
    tracker = await call(ctx, `/trackers/${encodeURIComponent(input.providerTrackerId)}`);
  } else if (input.trackingNumber) {
    const found = await call(ctx, `/trackers?tracking_code=${encodeURIComponent(input.trackingNumber)}`);
    tracker = (found?.trackers || [])[0] || null;
    if (!tracker) {
      tracker = await call(ctx, '/trackers', { method: 'POST', body: { tracker: {
        tracking_code: input.trackingNumber,
        carrier: input.carrier ? String(input.carrier).toUpperCase() : undefined,
      } } });
    }
  }
  if (!tracker) return null;
  return {
    providerTrackerId: tracker.id,
    carrier: String(tracker.carrier || '').toLowerCase() || null,
    trackingUrl: tracker.public_url || null,
    status: statusOf(tracker.status),
    detail: tracker.status_detail || null,
    estimatedDeliveryDate: tracker.est_delivery_date
      ? String(tracker.est_delivery_date).slice(0, 10) : null,
    events: readDetails(tracker),
  };
}

/* -------------------------------------------------------------- webhooks */

/**
 * The message really came from EasyPost.
 *
 * EasyPost signs with an HMAC over the raw body. Compared in constant time,
 * and the raw bytes are what is signed — re-serialising the parsed object
 * would change the whitespace and fail a signature that was fine.
 */
function verifyEvent(raw, headers = {}, options = {}) {
  const secret = options.webhookSecret || process.env.EASYPOST_WEBHOOK_SECRET;
  const signature = headers['x-hmac-signature'] || headers['X-Hmac-Signature'];
  if (secret) {
    if (!signature) throw new AuthenticationError('This shipping webhook carried no signature.');
    const crypto = require('node:crypto');
    const expected = `hmac-sha256-hex=${crypto.createHmac('sha256', secret)
      .update(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8')).digest('hex')}`;
    if (!safeEqual(String(signature), expected)) {
      throw new AuthenticationError('This shipping webhook did not come from EasyPost.');
    }
  }
  try {
    return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch {
    throw new ValidationError('This shipping webhook was not readable.');
  }
}

/** The few facts Foundry acts on, out of whatever EasyPost sent. */
function readEvent(event = {}) {
  const tracker = event.result || {};
  return {
    externalEventId: event.id || tracker.id || null,
    type: event.description || null,
    providerTrackerId: tracker.id || null,
    providerShipmentId: tracker.shipment_id || null,
    trackingNumber: tracker.tracking_code || null,
    carrier: String(tracker.carrier || '').toLowerCase() || null,
    status: statusOf(tracker.status),
    detail: tracker.status_detail || null,
    estimatedDeliveryDate: tracker.est_delivery_date
      ? String(tracker.est_delivery_date).slice(0, 10) : null,
    events: readDetails(tracker),
  };
}

module.exports = { isConfigured, quote, buy, track, verifyEvent, readEvent,
  address, parcel, statusOf, readRate, call };
