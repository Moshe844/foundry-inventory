'use strict';

/*
 * ShipStation V2 behind StockChief's provider-independent shipping contract.
 * ShipStation is not treated as a carrier: the merchant connects UPS, FedEx,
 * USPS, DHL, or another carrier inside ShipStation and StockChief compares the
 * resulting carrier rates. ShipStation platform keys are live-only; TEST_
 * keys are available only to ShipStation API customers (formerly ShipEngine).
 */

const { ValidationError, AuthenticationError } = require('../../domain/errors');
const { providerFetch } = require('../../lib/provider-http');
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
  const response = await providerFetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'API-Key': apiKey(ctx),
      'content-type': 'application/json',
      accept: 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }, { provider: 'ShipStation', retries: options.retries,timeoutMs:options.timeoutMs });
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
    const error = new ErrorType(require('../public-error').message(response.status, typeof message === 'string' ? message : JSON.stringify(message), 'ShipStation'));
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
  if(input.isReturn&&input.from?.country!==input.to?.country)throw new ValidationError('ShipStation supports return labels only for domestic shipments. Choose another connected provider for this return.');
  const ids = await carrierIds(ctx);
  if (!ids.length) throw new ValidationError('This ShipStation account has no active carrier. '
    + 'Connect a carrier in ShipStation before asking for rates.');
  const groups=[];
  for(const box of input.packages?.length?input.packages:[{}]){
  const body = await call(ctx, '/rates', { method: 'POST', body: {
    rate_options: { carrier_ids: ids },
    shipment: {
      validate_address: 'validate_and_clean',
      ship_to: shipengine.address(input.to),
      ship_from: shipengine.address(input.from),
      ...(input.options?.signature==='SIGNATURE'?{confirmation:'signature'}:input.options?.signature==='ADULT'?{confirmation:'adult_signature'}:{}),
      packages: [shipengine.parcel(box)],
    },
  } });
  const response = body?.rate_response || body || {};
  groups.push({providerShipmentIds:[body?.shipment_id||response.shipment_id].filter(Boolean),rates:(response.rates||[]).filter(row=>row.rate_id).map(shipengine.readRate)});
  }
  return require('../parcel-rates').combine(groups);
}

const money=require('../provider-money');

async function buy(ctx, input = {}) {
  const ids = input.rateIds?.length ? input.rateIds : [input.rateId];
  const labels = [];
  const returns=[];
  if(!input.isReturn&&input.approvedAmountMinor!=null){const rows=[];for(const id of ids)rows.push(await call(ctx,'/rates/'+encodeURIComponent(id)));
    money.approved(money.total(rows.flatMap(row=>['shipping_amount','insurance_amount','confirmation_amount','other_amount'].map(key=>row[key]).filter(Boolean))),input);}
  if(input.isReturn){
    for(const [index,rateId]of ids.entries()){
      const rate=await call(ctx,'/rates/'+encodeURIComponent(rateId));
      const shipmentId=input.providerShipmentIds?.[index];
      if(!shipmentId||!rate.carrier_id||!rate.service_code)throw new ValidationError('The saved return rate must identify its carrier, service and parcel before purchase.');
      const shipment=await call(ctx,'/shipments/'+encodeURIComponent(shipmentId));
      if(!shipment.ship_from||!shipment.ship_to||shipment.ship_from.country_code!==shipment.ship_to.country_code)throw new ValidationError('ShipStation supports return labels only for verified domestic parcels.');
      returns.push({rate,shipment});
    }
    const total=money.total(returns.flatMap(row=>['shipping_amount','insurance_amount','confirmation_amount','other_amount'].map(key=>row.rate[key]).filter(Boolean)));
    if(input.currency&&total.currency!==input.currency||input.approvedAmountMinor!=null&&total.amountMinor>input.approvedAmountMinor)throw new ValidationError('The return price changed. Request fresh rates before purchasing.');
  }
  for (const rateId of ids.filter(Boolean)) {
    const returned=returns[labels.length],printing={label_format:String(input.options?.labelFormat||'PDF').toLowerCase(), label_layout:input.options?.labelLayout==='letter'?'letter':'4x6', label_download_type: 'url'};
    try{labels.push(await call(ctx, returned?'/labels':`/labels/rates/${encodeURIComponent(rateId)}`, {
      method: 'POST', retries: 0,timeoutMs:60000,
      body: returned?{...printing,is_return_label:true,charge_event:'carrier_default',shipment:{carrier_id:returned.rate.carrier_id,service_code:returned.rate.service_code,
        ship_from:returned.shipment.ship_from,ship_to:returned.shipment.ship_to,packages:returned.shipment.packages,confirmation:returned.shipment.confirmation||'none'}}:printing,
      // StockChief also records a durable PENDING transaction before this call;
      // an ambiguous response is reviewed rather than retried and duplicated.
      headers: input.idempotencyKey ? { 'Idempotency-Key': `${input.idempotencyKey}:${labels.length}` } : {},
    }));}catch(error){if(labels.length){error.providerOutcomeUncertain=true;error.providerReference={externalId:labels[0].label_id,externalIds:labels.map(row=>row.label_id).filter(Boolean),expectedCount:ids.length};}throw error;}
    const held=labels.map(row=>row.label_id).filter(Boolean);if(held.length)await input.onCheckpoint?.({externalId:held[0],externalIds:held,expectedCount:ids.length});
  }
  if (!labels.length) throw new ValidationError('Choose a current carrier rate before buying a label.');
  return purchaseResult(labels,input.options);
}
function purchaseResult(labels,options={}){return money.receipt({externalId:labels[0]?.label_id,externalIds:labels.map(row=>row.label_id).filter(Boolean),expectedCount:labels.length},()=>{
  const lead = labels[0];
  if(labels.some(row=>require('../parcel-contract').format(row.label_format)!==require('../parcel-contract').format(lead?.label_format)))throw new ValidationError('The carrier returned different print formats for this parcel group. Verify its saved labels before printing.');
  if(!lead||labels.some(row=>!row.label_download?.href&&!row.label_download?.[String(row.label_format||options.labelFormat||'PDF').toLowerCase()]))throw new ValidationError('ShipStation has not confirmed every printable label. Check the saved transaction without buying again.');
  const labelIds = labels.map((row) => row.label_id).filter(Boolean);
  const total=money.total(labels.flatMap(row=>[row.shipment_cost,row.insurance_cost].filter(Boolean)));
  return {
    providerShipmentId: lead.label_id || lead.shipment_id,
    providerShipmentIds: labelIds.length ? labelIds
      : labels.map((row) => row.shipment_id).filter(Boolean),
    providerLabelIds: labelIds,
    carrier: String(lead.carrier_code || '').toLowerCase(),
    service: lead.service_code || null,
    packages:labels.map(row=>({externalId:row.label_id,trackingNumber:row.tracking_number,trackingUrl:row.tracking_url||null})),
    trackingNumber: lead.tracking_number || null,
    trackingUrl: lead.tracking_url || null,
    labelUrl: lead.label_download?.[String(lead.label_format||options.labelFormat||'PDF').toLowerCase()] || lead.label_download?.href || null,
    labelFormat: String(lead.label_format || 'pdf').toUpperCase(),
    labelUrls: labels.map((row) => row.label_download?.[String(row.label_format||options.labelFormat||'PDF').toLowerCase()] || row.label_download?.href).filter(Boolean),
    customsUrls:labels.flatMap(row=>[row.form_download?.href||row.form_download?.pdf].filter(Boolean)),
    amountMinor: total.amountMinor,
    currency: total.currency,
    deliveryDate: lead.estimated_delivery_date
      ? String(lead.estimated_delivery_date).slice(0, 10) : null,
  };
});}
async function verifyPurchase(ctx,reference={}){
 const ids=reference.externalIds||[reference.externalId];if(!ids.length||ids.some(id=>!id)||reference.expectedCount&&reference.expectedCount!==ids.length)throw Object.assign(new ValidationError('Every existing ShipStation label must be identified before its group can be confirmed.'),{retryable:false});
 const rows=[];for(const id of ids)rows.push(await call(ctx,'/labels/'+encodeURIComponent(id)));return purchaseResult(rows);
}

async function voidLabel(ctx, input = {}) {
  const ids = (input.providerReferences || input.providerLabelIds || []).filter(Boolean);
  if (!ids.length) throw new ValidationError('StockChief has no ShipStation label reference to void.');
  const answers = [];
  for (const id of ids) answers.push(await call(ctx, `/labels/${encodeURIComponent(id)}/void`, { method: 'PUT', retries: 0 }));
  const failed = answers.length>0&&answers.every((row) => row.approved === false || row.status === 'error');
  const complete=answers.every(row=>row.approved===true);
  return {
    status: failed ? 'FAILED' : complete ? 'SUCCEEDED' : 'PENDING', references: ids,refundStatus:failed?'REJECTED':'PENDING',
    detail: answers.map((row) => row.message).filter(Boolean).join(' ') || 'ShipStation has not yet confirmed the void.',
  };
}

async function verifyVoid(ctx,input={}){
 const ids=(input.providerReferences||[]).filter(Boolean);if(!ids.length)throw new ValidationError('The original ShipStation label references are required.');
 const rows=[];for(const id of ids)rows.push(await call(ctx,'/labels/'+encodeURIComponent(id)));
 const complete=rows.every(row=>row.voided===true||String(row.status).toLowerCase()==='voided');
 return {status:complete?'SUCCEEDED':'PENDING',refundStatus:'PENDING',references:ids,detail:complete?'The label is void. Any postage refund remains subject to the carrier’s settlement.':'The carrier has not yet confirmed this void.'};
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
  supportsReturnLabels:true,
  isConfigured, quote, buy, verifyPurchase, voidLabel, verifyVoid, track,
  ensureWebhook:(ctx,input)=>require('./webhook-registration').shipstation(call,ctx,input),
  verifyEvent: shipengine.verifyEvent,
  readEvent: shipengine.readEvent,
  address: shipengine.address,
  parcel: shipengine.parcel,
  readRate: shipengine.readRate,
  statusOf, call, carrierIds,
};
