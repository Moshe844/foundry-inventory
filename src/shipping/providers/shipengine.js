'use strict';

/*
 * ShipEngine / ShipStation API behind Foundry's shipping-provider seam.
 *
 * A workspace API key belongs to that business's ShipEngine seller account.
 * The platform key may create seller accounts, but is deliberately never read
 * here: quoting and buying must always happen as the seller who pays for the
 * label.
 */

const crypto = require('node:crypto');
const { ValidationError, AuthenticationError } = require('../../domain/errors');

const BASE = 'https://api.shipengine.com/v1';
const JWKS_URL = 'https://api.shipengine.com/jwks';

function apiKey(ctx = {}) {
  const key = ctx.shipengineApiKey || process.env.SHIPENGINE_API_KEY;
  if (!key) {
    throw new ValidationError('No ShipEngine seller account is connected, so Foundry cannot ask '
      + 'carriers for rates or buy a label. Finish the one-time shipping setup first.');
  }
  return String(key);
}

function isConfigured() { return Boolean(process.env.SHIPENGINE_API_KEY); }

async function call(ctx, path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'api-key': apiKey(ctx),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const errors = Array.isArray(body?.errors) ? body.errors.map((row) => row.message).filter(Boolean) : [];
    const message = errors.join(' ') || body?.message || body?.error
      || `ShipEngine returned ${response.status}.`;
    const ErrorType = response.status === 401 || response.status === 403
      ? AuthenticationError : ValidationError;
    const error = new ErrorType(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = response.status;
    throw error;
  }
  return body;
}

function address(input = {}) {
  return {
    name: input.name || input.company || undefined,
    company_name: input.company || undefined,
    phone: input.phone || undefined,
    email: input.email || undefined,
    address_line1: input.line1 || undefined,
    address_line2: input.line2 || undefined,
    city_locality: input.city || undefined,
    state_province: input.state || undefined,
    postal_code: input.postalCode || undefined,
    country_code: input.country || 'US',
    address_residential_indicator: 'unknown',
  };
}

function parcel(box = {}) {
  const out = {
    weight: { value: Math.max(1, Number(box.weightGrams || 0)), unit: 'gram' },
  };
  if (box.lengthMm && box.widthMm && box.heightMm) {
    out.dimensions = {
      length: Number(box.lengthMm), width: Number(box.widthMm), height: Number(box.heightMm),
      unit: 'millimeter',
    };
  }
  return out;
}

const minorFrom = (amount) => Math.round(Number(amount || 0) * 100);

function readRate(row = {}) {
  return {
    rateId: row.rate_id,
    carrier: String(row.carrier_code || row.carrier_friendly_name || '').toLowerCase(),
    service: row.service_type || row.service_code || 'Carrier service',
    amountMinor: minorFrom(row.shipping_amount?.amount ?? row.rate_details?.[0]?.amount?.amount),
    currency: String(row.shipping_amount?.currency || 'USD').toUpperCase(),
    deliveryDays: row.delivery_days === null || row.delivery_days === undefined
      ? null : Number(row.delivery_days),
    deliveryDate: row.estimated_delivery_date
      ? String(row.estimated_delivery_date).slice(0, 10) : null,
    guaranteed: Boolean(row.guaranteed_service),
  };
}

async function carrierIds(ctx) {
  const body = await call(ctx, '/carriers');
  return (body?.carriers || [])
    .filter((row) => row.carrier_id && row.account_number !== 'stamps_com_disabled')
    .map((row) => row.carrier_id);
}

async function quote(ctx, input = {}) {
  const ids = await carrierIds(ctx);
  if (!ids.length) {
    throw new ValidationError('This ShipEngine account has no active carrier. Open Shipping setup '
      + 'and activate a carrier before asking for rates.');
  }
  const body = await call(ctx, '/rates', { method: 'POST', body: {
    rate_options: { carrier_ids: ids },
    shipment: {
      validate_address: 'validate_and_clean',
      ship_to: address(input.to),
      ship_from: address(input.from),
      packages: (input.packages?.length ? input.packages : [{}]).map(parcel),
    },
  } });
  const response = body?.rate_response || body || {};
  return {
    providerShipmentIds: [body?.shipment_id || response.shipment_id].filter(Boolean),
    rates: (response.rates || []).filter((row) => row.rate_id).map(readRate),
  };
}

async function buy(ctx, input = {}) {
  const ids = input.rateIds?.length ? input.rateIds : [input.rateId];
  const labels = [];
  for (const id of ids.filter(Boolean)) {
    labels.push(await call(ctx, `/labels/rates/${encodeURIComponent(id)}`, {
      method: 'POST', body: { label_format: 'pdf', label_layout: '4x6' },
    }));
  }
  if (!labels.length) throw new ValidationError('Choose a current carrier rate before buying a label.');
  const lead = labels[0];
  return {
    providerShipmentId: lead.shipment_id || lead.label_id,
    providerShipmentIds: labels.map((row) => row.shipment_id || row.label_id).filter(Boolean),
    carrier: String(lead.carrier_code || '').toLowerCase(),
    service: lead.service_code || null,
    trackingNumber: lead.tracking_number || null,
    trackingUrl: lead.tracking_url || null,
    labelUrl: lead.label_download?.pdf || lead.label_download?.href || null,
    labelFormat: String(lead.label_format || 'pdf').toUpperCase(),
    labelUrls: labels.map((row) => row.label_download?.pdf || row.label_download?.href).filter(Boolean),
    amountMinor: labels.reduce((sum, row) => sum + minorFrom(row.shipment_cost?.amount), 0),
    currency: String(lead.shipment_cost?.currency || 'USD').toUpperCase(),
    deliveryDate: lead.estimated_delivery_date
      ? String(lead.estimated_delivery_date).slice(0, 10) : null,
  };
}

const STATUS = {
  UN: 'UNKNOWN', NY: 'PRE_TRANSIT', AC: 'PRE_TRANSIT', IT: 'IN_TRANSIT',
  OF: 'OUT_FOR_DELIVERY', AT: 'OUT_FOR_DELIVERY', DE: 'DELIVERED',
  EX: 'FAILURE', CA: 'CANCELLED', RT: 'RETURNED',
};

function statusOf(value) {
  const key = String(value || '').toUpperCase();
  return STATUS[key] || ({
    UNKNOWN: 'UNKNOWN', ACCEPTED: 'PRE_TRANSIT', IN_TRANSIT: 'IN_TRANSIT',
    DELIVERED: 'DELIVERED', EXCEPTION: 'FAILURE', DELIVERY_ATTEMPT: 'OUT_FOR_DELIVERY',
  }[key] || 'UNKNOWN');
}

function readDetails(tracker = {}) {
  return (tracker.events || []).map((entry, index) => ({
    externalEventId: entry.event_code
      ? `${tracker.tracking_number}:${entry.occurred_at}:${entry.event_code}`
      : `${tracker.tracking_number}:${entry.occurred_at}:${index}`,
    status: statusOf(entry.status_code || tracker.status_code),
    detail: entry.description || entry.event_description || null,
    location: [entry.city_locality, entry.state_province, entry.country_code]
      .filter(Boolean).join(', ') || null,
    occurredAt: entry.occurred_at || null,
  })).filter((entry) => entry.occurredAt);
}

async function track(ctx, input = {}) {
  if (!input.trackingNumber || !input.carrier) return null;
  const body = await call(ctx, `/tracking?carrier_code=${encodeURIComponent(input.carrier)}`
    + `&tracking_number=${encodeURIComponent(input.trackingNumber)}`);
  return {
    providerTrackerId: null,
    carrier: String(input.carrier).toLowerCase(),
    trackingUrl: body?.tracking_url || null,
    status: statusOf(body?.status_code || body?.status_description),
    detail: body?.exception_description || body?.carrier_status_description
      || body?.status_description || null,
    estimatedDeliveryDate: body?.estimated_delivery_date
      ? String(body.estimated_delivery_date).slice(0, 10) : null,
    events: readDetails(body),
  };
}

let jwksCache = null;
async function signingKeys(options = {}) {
  if (options.jwks) return options.jwks;
  if (!options.force && jwksCache && jwksCache.expires > Date.now()) return jwksCache.keys;
  const response = await (options.fetch || fetch)(JWKS_URL, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new AuthenticationError('ShipEngine signing keys could not be loaded.');
  const body = await response.json();
  const keys = body?.keys || [];
  jwksCache = { keys, expires: Date.now() + 12 * 60 * 60_000 };
  return keys;
}

async function verifyEvent(raw, headers = {}, options = {}) {
  const keyId = headers['x-shipengine-rsa-sha256-key-id'];
  const signature = headers['x-shipengine-rsa-sha256-signature'];
  const timestamp = headers['x-shipengine-timestamp'];
  if (!keyId || !signature || !timestamp) {
    const error = new AuthenticationError('This shipping webhook did not carry ShipEngine\'s signature.');
    error.status = 404;
    throw error;
  }
  const when = Date.parse(timestamp);
  if (!Number.isFinite(when) || Math.abs(Date.now() - when) > 5 * 60_000) {
    const error = new AuthenticationError('This shipping webhook is too old to accept safely.');
    error.status = 400;
    throw error;
  }
  let keys = await signingKeys(options);
  let jwk = keys.find((row) => row.kid === keyId);
  // ShipEngine publishes a replacement before rotating to it. If our cached
  // set does not contain that key, refresh once instead of rejecting valid
  // tracking events until the twelve-hour cache expires.
  if (!jwk && !options.jwks) {
    keys = await signingKeys({ ...options, force: true });
    jwk = keys.find((row) => row.kid === keyId);
  }
  if (!jwk) throw new AuthenticationError('ShipEngine signed this webhook with an unknown key.');
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`), bytes]);
  const valid = crypto.verify('RSA-SHA256', signed,
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(String(signature), 'base64'));
  if (!valid) {
    const error = new AuthenticationError('This shipping webhook signature is not valid.');
    error.status = 401;
    throw error;
  }
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new ValidationError('This shipping webhook was not readable.'); }
}

function readEvent(event = {}) {
  const data = event.data || event;
  return {
    externalEventId: data.tracking_number
      ? `${data.tracking_number}:${data.events?.[0]?.occurred_at || data.status_code}` : null,
    type: event.resource_type || null,
    providerTrackerId: null,
    providerShipmentId: null,
    trackingNumber: data.tracking_number || null,
    carrier: String(data.carrier_code || '').toLowerCase() || null,
    status: statusOf(data.status_code || data.status_description),
    detail: data.exception_description || data.carrier_status_description
      || data.status_description || null,
    estimatedDeliveryDate: data.estimated_delivery_date
      ? String(data.estimated_delivery_date).slice(0, 10) : null,
    events: readDetails(data),
  };
}

module.exports = {
  isConfigured, quote, buy, track, verifyEvent, readEvent,
  address, parcel, statusOf, readRate, call, carrierIds,
};
