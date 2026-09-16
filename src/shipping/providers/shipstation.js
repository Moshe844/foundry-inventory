'use strict';

/*
 * ShipStation V2 behind StockChief's provider-independent shipping contract.
 * ShipStation is not treated as a carrier: the merchant connects UPS, FedEx,
 * USPS, DHL, or another carrier inside ShipStation and StockChief compares the
 * resulting carrier rates. ShipStation platform keys are live-only; TEST_
 * keys are available only to ShipStation API customers (formerly ShipEngine).
 */

const { ValidationError, AuthenticationError } = require('../../domain/errors');
const shipengine = require('./shipengine');

const BASE = 'https://api.shipstation.com/v2';

function apiKey(ctx = {}) {
  const key = ctx.shipstationApiKey || process.env.SHIPSTATION_API_KEY;
  if (!key) throw new ValidationError('No ShipStation account is connected. Connect this business’s '
    + 'ShipStation V2 API key before asking carriers for rates or buying a label.');
  return String(key);
}

function isConfigured() { return Boolean(process.env.SHIPSTATION_API_KEY); }

async function call(ctx, path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'API-Key': apiKey(ctx),
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
    const errors = Array.isArray(body?.errors)
      ? body.errors.map((row) => row.message || row.detail).filter(Boolean) : [];
    const message = errors.join(' ') || body?.message || body?.detail || body?.error
      || `ShipStation returned ${response.status}.`;
    const ErrorType = response.status === 401 || response.status === 403
      ? AuthenticationError : ValidationError;
    const error = new ErrorType(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = response.status;
    throw error;
  }
  return body;
}

async function carrierIds(ctx) {
  const body = await call(ctx, '/carriers');
  return (body?.carriers || []).filter((row) => row.carrier_id).map((row) => row.carrier_id);
}

async function quote(ctx, input = {}) {
  const ids = await carrierIds(ctx);
  if (!ids.length) throw new ValidationError('This ShipStation account has no active carrier. '
    + 'Connect a carrier in ShipStation before asking for rates.');
  const body = await call(ctx, '/rates', { method: 'POST', body: {
    rate_options: { carrier_ids: ids },
    shipment: {
      validate_address: 'validate_and_clean',
      ship_to: shipengine.address(input.to),
      ship_from: shipengine.address(input.from),
      packages: (input.packages?.length ? input.packages : [{}]).map(shipengine.parcel),
    },
  } });
  const response = body?.rate_response || body || {};
  return {
    providerShipmentIds: [body?.shipment_id || response.shipment_id].filter(Boolean),
    rates: (response.rates || []).filter((row) => row.rate_id).map(shipengine.readRate),
  };
}

const minorFrom = (amount) => Math.round(Number(amount || 0) * 100);

async function buy(ctx, input = {}) {
  const ids = input.rateIds?.length ? input.rateIds : [input.rateId];
  const labels = [];
  for (const rateId of ids.filter(Boolean)) {
    labels.push(await call(ctx, `/labels/rates/${encodeURIComponent(rateId)}`, {
      method: 'POST',
      body: { label_format: 'pdf', label_layout: '4x6', label_download_type: 'url' },
      // StockChief also records a durable PENDING transaction before this call;
      // an ambiguous response is reviewed rather than retried and duplicated.
      headers: input.idempotencyKey ? { 'Idempotency-Key': `${input.idempotencyKey}:${labels.length}` } : {},
    }));
  }
  if (!labels.length) throw new ValidationError('Choose a current carrier rate before buying a label.');
  const lead = labels[0];
  const labelIds = labels.map((row) => row.label_id).filter(Boolean);
  return {
    providerShipmentId: lead.label_id || lead.shipment_id,
    providerShipmentIds: labelIds.length ? labelIds
      : labels.map((row) => row.shipment_id).filter(Boolean),
    providerLabelIds: labelIds,
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

async function voidLabel(ctx, input = {}) {
  const ids = (input.providerReferences || input.providerLabelIds || []).filter(Boolean);
  if (!ids.length) throw new ValidationError('StockChief has no ShipStation label reference to void.');
  const answers = [];
  for (const id of ids) answers.push(await call(ctx, `/labels/${encodeURIComponent(id)}/void`, { method: 'PUT' }));
  const failed = answers.some((row) => row.approved === false || row.status === 'error');
  return {
    status: failed ? 'FAILED' : 'SUCCEEDED', references: ids,
    detail: answers.map((row) => row.message).filter(Boolean).join(' ') || 'ShipStation voided the label.',
  };
}

const STATUS = {
  UN: 'UNKNOWN', NY: 'PRE_TRANSIT', AC: 'PRE_TRANSIT', IT: 'IN_TRANSIT',
  OF: 'OUT_FOR_DELIVERY', AT: 'OUT_FOR_DELIVERY', DE: 'DELIVERED',
  EX: 'FAILURE', CA: 'CANCELLED', RT: 'RETURNED',
};
const statusOf = (value) => STATUS[String(value || '').toUpperCase()] || ({
  UNKNOWN: 'UNKNOWN', ACCEPTED: 'PRE_TRANSIT', IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED', EXCEPTION: 'FAILURE', DELIVERY_ATTEMPT: 'OUT_FOR_DELIVERY',
}[String(value || '').toUpperCase()] || 'UNKNOWN');

function readDetails(tracker = {}) {
  return (tracker.events || tracker.tracking_events || []).map((entry, index) => ({
    externalEventId: entry.event_code
      ? `${tracker.tracking_number}:${entry.occurred_at}:${entry.event_code}`
      : `${tracker.tracking_number}:${entry.occurred_at}:${index}`,
    status: statusOf(entry.status_code || tracker.status_code),
    detail: entry.description || entry.event_description || null,
    location: [entry.city_locality, entry.state_province, entry.country_code].filter(Boolean).join(', ') || null,
    occurredAt: entry.occurred_at || null,
  })).filter((entry) => entry.occurredAt);
}

async function track(ctx, input = {}) {
  const labelId = String(input.providerShipmentId || '').split(',').filter(Boolean)[0];
  if (!labelId) return null;
  const body = await call(ctx, `/labels/${encodeURIComponent(labelId)}/track`);
  return {
    providerTrackerId: labelId,
    carrier: String(input.carrier || body?.carrier_code || '').toLowerCase() || null,
    trackingUrl: body?.tracking_url || null,
    status: statusOf(body?.status_code || body?.status_description),
    detail: body?.exception_description || body?.carrier_status_description || body?.status_description || null,
    estimatedDeliveryDate: body?.estimated_delivery_date
      ? String(body.estimated_delivery_date).slice(0, 10) : null,
    events: readDetails(body),
  };
}

module.exports = {
  isConfigured, quote, buy, voidLabel, track,
  verifyEvent: shipengine.verifyEvent,
  readEvent: shipengine.readEvent,
  address: shipengine.address,
  parcel: shipengine.parcel,
  readRate: shipengine.readRate,
  statusOf, call, carrierIds,
};
