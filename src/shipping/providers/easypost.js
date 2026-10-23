'use strict';

/* Provider adapter. PostgreSQL supplies this business’s encrypted customer account through ctx. */

const { ValidationError, AuthenticationError } = require('../../domain/errors');
const { providerFetch } = require('../../lib/provider-http');
const { safeEqual } = require('../../connections/providers/common');

const BASE = 'https://api.easypost.com/v2';

function apiKey(ctx = {}) {
  const key = ctx.easypostApiKey || process.env.EASYPOST_API_KEY;
  if (!key) {
    throw new ValidationError('No EasyPost API key is configured, so StockChief cannot ask a carrier '
      + 'for rates. Set EASYPOST_API_KEY and restart, or hand the parcel over yourself and record it.');
  }
  return String(key);
}

function isConfigured() { return Boolean(process.env.EASYPOST_API_KEY); }

async function call(ctx, path, options = {}) {
  const response = await providerFetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Basic ${Buffer.from(`${apiKey(ctx)}:`).toString('base64')}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }, { provider: 'EasyPost', retries: options.retries,timeoutMs:options.timeoutMs });
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
 * StockChief's address shape, in EasyPost's.
 *
 * Nothing is invented. A missing line stays missing and EasyPost says so,
 * because a parcel sent to an address StockChief completed on somebody's behalf
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

/** EasyPost prices in ounces and inches; StockChief stores grams and millimetres. */
function parcel(box = {}) {
  const out = { weight: Math.max(0.1, Number(box.weightGrams || 0) / GRAMS_PER_OUNCE) };
  if (box.lengthMm && box.widthMm && box.heightMm) {
    out.length = Number(box.lengthMm) / MM_PER_INCH;
    out.width = Number(box.widthMm) / MM_PER_INCH;
    out.height = Number(box.heightMm) / MM_PER_INCH;
  }
  return out;
}

const money=require('../provider-money');

function readRate(row) {
  return {
    rateId: row.id,
    carrier: String(row.carrier || '').toLowerCase(),carrierAccount:row.carrier_account_id||null,
    service: row.service,
    amountMinor: money.amount(row.rate,row.currency),
    currency: require('../../domain/currency').code(row.currency),
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
      // EasyPost reverses these on its return label. The shared contract is
      // always the physical route, so give its API the original direction.
      to_address: address(input.isReturn?input.from:input.to),
      from_address: address(input.isReturn?input.to:input.from),
      parcel: parcel(box),
      ...(input.isReturn?{is_return:true}:{}),
      options: {label_format:input.options?.labelFormat||'PDF',label_size:input.options?.labelLayout==='letter'?'8.5x11':'4x6',
        ...(input.options?.signature==='SIGNATURE'?{delivery_confirmation:'SIGNATURE'}:input.options?.signature==='ADULT'?{delivery_confirmation:'ADULT_SIGNATURE'}:{})},
    } } });
    quotes.push({ providerShipmentId: created.id, rates: (created.rates || []).map(readRate) });
  }

  return require('../parcel-rates').combine(quotes.map(row=>({providerShipmentIds:[row.providerShipmentId],rates:row.rates})));
}

/* ----------------------------------------------------------------- label */

/**
 * Buy the label. This spends money, and it is the only call here that does.
 *
 * The tracking number and the label file come straight back from the carrier;
 * neither is constructed by StockChief. A label URL that StockChief assembled would
 * eventually point at nothing.
 */
async function buy(ctx, input = {}) {
  const ids = input.providerShipmentIds && input.providerShipmentIds.length
    ? input.providerShipmentIds : [input.providerShipmentId];
  const rateIds = input.rateIds && input.rateIds.length ? input.rateIds : [input.rateId];
  const bought = [];
  if(input.approvedAmountMinor!=null){const rates=[];for(const [index,id]of ids.entries()){
    const shipment=await call(ctx,'/shipments/'+encodeURIComponent(id)),rate=(shipment.rates||[]).find(row=>row.id===(rateIds[index]||rateIds[0]));
    if(!rate)throw new ValidationError('The saved carrier rate is no longer available. Refresh rates before purchasing.');rates.push({amount:rate.rate,currency:rate.currency});
  }money.approved(money.total(rates),input);}
  const reference={externalId:ids[0],externalIds:ids,expectedCount:ids.length};
  await input.onCheckpoint?.(reference);
  for (let index = 0; index < ids.length; index += 1) {
    try{bought.push(await call(ctx, `/shipments/${encodeURIComponent(ids[index])}/buy`, {
      method: 'POST', retries: 0,timeoutMs:60000, body: { rate: { id: rateIds[index] || rateIds[0] } },
      headers: input.idempotencyKey ? { 'x-idempotency-key': `${input.idempotencyKey}:${index}` } : {},
    }));}catch(error){if(bought.length)error.providerOutcomeUncertain=true;error.providerReference=reference;throw error;}
  }
  return purchaseResult(bought);
}
function purchaseResult(bought){return money.receipt({externalId:bought[0]?.id,externalIds:bought.map(row=>row.id),expectedCount:bought.length},()=>{
  if(!bought.length||bought.some(row=>!row.postage_label?.label_url))throw new ValidationError('EasyPost has not confirmed every parcel label. The saved purchases must be checked without buying again.');
  const lead = bought[0];
  if(bought.some(row=>require('../parcel-contract').format(row.postage_label?.label_file_type)!==require('../parcel-contract').format(lead.postage_label?.label_file_type)))throw new ValidationError('The carrier returned different print formats for this parcel group. Verify each saved label before printing.');
  const total=money.total(bought.map(row=>({amount:row.selected_rate?.rate,currency:row.selected_rate?.currency})));
  return {
    providerShipmentId: lead.id,
    providerShipmentIds: bought.map((row) => row.id),
    providerLabelIds: bought.map((row) => row.id),
    carrier: String(lead.selected_rate?.carrier || '').toLowerCase(),
    service: lead.selected_rate?.service || null,
    packages:bought.map(row=>({externalId:row.id,trackingNumber:row.tracking_code,trackingUrl:row.tracker?.public_url||null})),
    trackingNumber: lead.tracking_code || null,
    trackingUrl: lead.tracker?.public_url || null,
    labelUrl: lead.postage_label?.label_url || null,
    labelFormat: require('../parcel-contract').format(lead.postage_label?.label_file_type),
    labelUrls: bought.map((row) => row.postage_label?.label_url).filter(Boolean),
    customsUrls:bought.flatMap(row=>(row.forms||[]).map(form=>form.form_url).filter(Boolean)),
    amountMinor: total.amountMinor,
    currency: total.currency,
    deliveryDate: lead.selected_rate?.delivery_date
      ? String(lead.selected_rate.delivery_date).slice(0, 10) : null,
  };
});}
async function verifyPurchase(ctx,reference={}){
 const ids=reference.externalIds||[reference.externalId];if(!ids.length||ids.some(id=>!id))throw new ValidationError('The saved EasyPost shipment identities are required.');
 if(reference.expectedCount&&reference.expectedCount!==ids.length)throw Object.assign(new ValidationError('Every parcel purchase must be identified before confirmation. No purchase was repeated.'),{retryable:false});
 const rows=[];for(const id of ids)rows.push(await call(ctx,'/shipments/'+encodeURIComponent(id)));return purchaseResult(rows);
}

/** Ask EasyPost to refund unused postage. Its submitted state is deliberately
 * not called refunded: the carrier may still reject it after this response. */
async function voidLabel(ctx, input = {}) {
  const ids = (input.providerReferences || input.providerShipmentIds || []).filter(Boolean);
  if (!ids.length) throw new ValidationError('StockChief has no EasyPost shipment reference to refund.');
  const answers = [];
  for (let index = 0; index < ids.length; index += 1) {
    answers.push(await call(ctx, `/shipments/${encodeURIComponent(ids[index])}/refund`, {
      method: 'POST', retries: 0,
      headers: input.idempotencyKey ? { 'x-idempotency-key': `${input.idempotencyKey}:${index}` } : {},
    }));
  }
  const states = answers.map((row) => String(row.refund_status || '').toLowerCase());
  const failed = states.length>0&&states.every((state) => ['rejected','failed'].includes(state));
  const complete = states.length > 0 && states.every((state) => ['refunded','success'].includes(state));
  return {
    status: failed ? 'FAILED' : complete ? 'SUCCEEDED' : 'PENDING',
    refundStatus: failed ? 'REJECTED' : complete ? 'CONFIRMED' : 'PENDING',
    references: ids,
    detail: states.filter(Boolean).join(', ') || 'Refund submitted to EasyPost.',
  };
}

async function verifyVoid(ctx,input={}){
 const ids=(input.providerReferences||[]).filter(Boolean);if(!ids.length)throw new ValidationError('The original EasyPost shipment references are required.');
 const rows=[];for(const id of ids)rows.push(await call(ctx,'/shipments/'+encodeURIComponent(id)));
 const states=rows.map(row=>String(row.refund_status||'').toLowerCase()),failed=states.every(state=>state==='rejected'),complete=states.every(state=>state==='refunded');
 return {status:failed?'FAILED':complete?'SUCCEEDED':'PENDING',refundStatus:failed?'REJECTED':complete?'CONFIRMED':'PENDING',references:ids,detail:states.filter(Boolean).join(', ')};
}

/* -------------------------------------------------------------- tracking */

/*
 * Every carrier's word for the same seven places a parcel can be.
 *
 * Anything unrecognised becomes UNKNOWN rather than being guessed at. A parcel
 * whose status StockChief cannot read is a parcel it should say nothing about.
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
  if (!secret) throw new AuthenticationError('A customer webhook secret must be configured before receiving carrier events.');
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

/** The few facts StockChief acts on, out of whatever EasyPost sent. */
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

module.exports = { supportsReturnLabels:true,isConfigured, quote, buy, verifyPurchase, voidLabel, verifyVoid, track, verifyEvent, readEvent,
  ensureWebhook:(ctx,input)=>require('./webhook-registration').easypost(call,ctx,input),
  address, parcel, statusOf, readRate, call };
