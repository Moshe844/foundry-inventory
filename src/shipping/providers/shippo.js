'use strict';

/* Provider adapter. PostgreSQL supplies this business’s encrypted customer account through ctx. */

const { ValidationError, AuthenticationError } = require('../../domain/errors');
const { providerFetch } = require('../../lib/provider-http');
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
  const response = await providerFetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `ShippoToken ${apiKey(ctx)}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }, { provider: 'Shippo', retries: options.retries,timeoutMs:options.timeoutMs });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const detail = body?.detail || body?.error || `Shippo returned ${response.status}.`;
    const error = new ValidationError(require('../public-error').message(response.status, typeof detail === 'string' ? detail : JSON.stringify(detail), 'Shippo'));
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


function parcel(box = {}) {
  if(![box.lengthMm,box.widthMm,box.heightMm].every(value=>Number(value)>0))throw new ValidationError('Shippo needs all three measured package dimensions. StockChief will not invent a box size.');
  return {
    weight: Math.max(0.1, Number(box.weightGrams || 0) / GRAMS_PER_OUNCE).toFixed(2),
    mass_unit: 'oz',
    length: (Number(box.lengthMm) / MM_PER_INCH).toFixed(2),
    width: (Number(box.widthMm) / MM_PER_INCH).toFixed(2),
    height: (Number(box.heightMm) / MM_PER_INCH).toFixed(2),
    distance_unit: 'in',
  };
}

const money=require('../provider-money');

/** A Shippo rate, in StockChief's shape. */
function readRate(row) {
  const days = row.estimated_days === null || row.estimated_days === undefined
    ? null : Number(row.estimated_days);
  return {
    rateId: row.object_id,carrierAccount:row.carrier_account||null,
    carrier: String(row.provider || '').toLowerCase(),
    service: row.servicelevel?.name || row.servicelevel_name || 'Service',
    amountMinor: money.amount(row.amount,row.currency),
    currency: require('../../domain/currency').code(row.currency),
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
  const original=String(input.originalCarrier||'').toLowerCase(),scanBasedReturn=input.isReturn&&['usps','ups','fedex'].includes(original);
  if(!(input.isReturn?input.to:input.from)?.email)throw new ValidationError('Add a shipping contact email to the business’s shipping location before requesting Shippo rates.');
  const packages = input.packages && input.packages.length ? input.packages : [{}];
  const groups=[];
  for(const box of packages){
  const created = await call(ctx, '/shipments/', { method: 'POST', body: {
    // Shippo swaps addresses itself for scan-based returns. The rest of
    // StockChief consistently describes the actual customer-to-warehouse route.
    address_from: address(scanBasedReturn?input.to:input.from),
    address_to: address(scanBasedReturn?input.from:input.to),
    parcels: [parcel(box)],
    extra:{...(scanBasedReturn?{is_return:true}:{}),...(input.options?.signature==='SIGNATURE'?{signature_confirmation:'STANDARD'}:input.options?.signature==='ADULT'?{signature_confirmation:'ADULT'}:{})},
    async: false,
  } });
  // Scan-based returns are restricted by Shippo to the original carrier.
  // Otherwise this is ordinary postage in the actual reverse direction.
  groups.push({providerShipmentIds:[created.object_id],rates:(created.rates||[]).map(readRate).filter(rate=>!scanBasedReturn||rate.carrier===original)});
  }
  return require('../parcel-rates').combine(groups);
}

/* ----------------------------------------------------------------- label */

function purchaseResult(transaction,rate,ctx){
  const status=String(transaction.status||'').toUpperCase();
  if(status==='ERROR'){
    let detail=(transaction.messages||[]).filter(row=>typeof row.text==='string').slice(0,3).map(row=>row.text).join(' ');
    const key=apiKey(ctx);detail=detail.replaceAll(key,'[redacted]').replaceAll(Buffer.from(key+':').toString('base64'),'[redacted]').slice(0,500);
    const error=new ValidationError('Shippo refused this label. '+(detail||'Check the parcel and carrier settings before requesting fresh rates.'));
    if(transaction.object_id)error.providerReference={externalId:transaction.object_id};
    throw error;
  }
  if(status!=='SUCCESS'||!transaction.label_url){
    const error=new ValidationError('Shippo accepted the request but has not confirmed the label. Verify the existing transaction before purchasing again.');
    error.providerOutcomeUncertain=true;
    if(transaction.object_id)error.providerReference={externalId:transaction.object_id,rateId:typeof transaction.rate==='string'?transaction.rate:transaction.rate?.object_id||rate?.object_id};
    throw error;
  }
  const actual=transaction.rate&&typeof transaction.rate==='object'?transaction.rate:rate;
  if(!actual||actual.amount===undefined||!actual.currency||!Number.isFinite(Number(actual.amount))||Number(actual.amount)<0){
    const error=new ValidationError('Shippo confirmed a label, but its price could not be verified. The purchase must not be repeated.');
    error.providerOutcomeUncertain=true;error.providerReference={externalId:transaction.object_id};throw error;
  }
  return money.receipt({externalId:transaction.object_id},()=>({
    providerShipmentId: transaction.object_id,
    providerShipmentIds: [transaction.object_id],
    providerLabelIds: [transaction.object_id],
    carrier: String(actual.provider || '').toLowerCase(),
    service: actual.servicelevel?.name || actual.servicelevel_name || actual.servicelevel_token || null,
    trackingNumber: transaction.tracking_number || null,
    trackingUrl: transaction.tracking_url_provider || null,
    labelUrl: transaction.label_url || null,
    labelFormat: require('../parcel-contract').format(transaction.label_file_type,transaction.label_url),
    labelUrls: [transaction.label_url].filter(Boolean),
    customsUrls:[transaction.commercial_invoice_url].filter(Boolean),
    amountMinor: money.amount(actual.amount,actual.currency),
    currency: require('../../domain/currency').code(actual.currency),
    deliveryDate: null,
  }));
}

function combinePurchases(receipts){
 const formats=new Set(receipts.map(row=>row.labelFormat));if(formats.size!==1)throw Object.assign(new ValidationError('The carrier returned different print formats for this parcel group. Verify its saved labels before printing.'),{providerOutcomeUncertain:true});
 const currencies=new Set(receipts.map(row=>row.currency));if(currencies.size!==1)throw new ValidationError('The parcel receipts have different currencies.');
 const amountMinor=receipts.reduce((sum,row)=>sum+row.amountMinor,0);if(!Number.isSafeInteger(amountMinor))throw new ValidationError('The parcel total exceeds the supported amount.');
 return {...receipts[0],providerShipmentIds:receipts.flatMap(row=>row.providerShipmentIds),providerLabelIds:receipts.flatMap(row=>row.providerLabelIds),
  labelUrls:receipts.flatMap(row=>row.labelUrls),customsUrls:receipts.flatMap(row=>row.customsUrls),amountMinor,
  packages:receipts.map(row=>({externalId:row.providerShipmentId,trackingNumber:row.trackingNumber,trackingUrl:row.trackingUrl}))};
}
async function buy(ctx,input={}){
 const ids=input.rateIds?.length?input.rateIds:[input.rateId];if(!ids.length||ids.some(id=>!id))throw new ValidationError('Choose a current Shippo rate before purchasing.');
 const rates=[];
 for(const id of ids)rates.push(await call(ctx,'/rates/'+encodeURIComponent(id)+'/'));
 const total=money.total(rates.map(rate=>({amount:rate.amount,currency:rate.currency})));
 if(input.currency&&total.currency!==input.currency||input.approvedAmountMinor!=null&&total.amountMinor>input.approvedAmountMinor)
  throw new ValidationError('The carrier price increased or changed currency. Request fresh rates before purchasing.');
 const receipts=[],accepted=[];
 for(let i=0;i<ids.length;i++){
  let transaction;
  try{
   transaction=await call(ctx,'/transactions/',{method:'POST',retries:0,timeoutMs:60000,body:{rate:ids[i],label_file_type:input.options?.labelFormat==='ZPL'?'ZPLII':input.options?.labelLayout==='letter'?'PDF':'PDF_4x6',async:false},
    headers:input.idempotencyKey?{'Idempotency-Key':input.idempotencyKey+':'+i}:{}});
   if(transaction.object_id){accepted.push(transaction.object_id);await input.onCheckpoint?.({externalId:accepted[0],externalIds:[...accepted],expectedCount:ids.length});}
   receipts.push(purchaseResult(transaction,rates[i],ctx));
  }catch(error){
   if(receipts.length||error.providerOutcomeUncertain){error.providerOutcomeUncertain=true;if(accepted.length)error.providerReference={externalId:accepted[0],externalIds:[...accepted],expectedCount:ids.length};}
   throw error;
  }
 }
 return combinePurchases(receipts);
}
async function verifyPurchase(ctx,reference={}){
 const ids=reference.externalIds||[reference.externalId];if(!ids.length||ids.some(id=>!id))throw new ValidationError('Existing Shippo transactions are required for verification.');
 if(reference.expectedCount&&reference.expectedCount!==ids.length)throw Object.assign(new ValidationError('Every parcel purchase must be identified before confirmation. No purchase was repeated.'),{retryable:false});
 const receipts=[];
 for(const id of ids){const transaction=await call(ctx,'/transactions/'+encodeURIComponent(id)+'/');
  const rate=transaction.rate&&typeof transaction.rate==='object'?transaction.rate:await call(ctx,'/rates/'+encodeURIComponent(transaction.rate||reference.rateId)+'/');
  receipts.push(purchaseResult(transaction,rate,ctx));}
 return combinePurchases(receipts);
}

async function voidLabel(ctx, input = {}) {
  const ids = (input.providerReferences || input.providerLabelIds || []).filter(Boolean);
  if (!ids.length) throw new ValidationError('StockChief has no Shippo transaction reference to refund.');
  const answers = [];
  for (const id of ids) {
    answers.push(await call(ctx, '/refunds/', { method: 'POST', retries: 0, body: { transaction: id },
      headers: input.idempotencyKey ? { 'Idempotency-Key': `${input.idempotencyKey}:${id}` } : {} }));
  }
  const states = answers.map((row) => String(row.status || '').toUpperCase());
  const failed = states.length>0&&states.every((state) => ['ERROR','FAILED','REJECTED'].includes(state));
  const complete = states.length > 0 && states.every((state) => ['SUCCESS','REFUNDED'].includes(state));
  return { status: failed ? 'FAILED' : complete ? 'SUCCEEDED' : 'PENDING', references: ids,refundStatus:failed?'REJECTED':complete?'CONFIRMED':'PENDING',
    detail: states.filter(Boolean).join(', ') || 'Refund submitted to Shippo.' };
}

async function verifyVoid(ctx,input={}){
 const ids=(input.providerReferences||[]).filter(Boolean);if(!ids.length)throw new ValidationError('The original Shippo transactions are required.');
 const rows=[];for(const id of ids)rows.push(await call(ctx,'/transactions/'+encodeURIComponent(id)+'/'));
 const states=rows.map(row=>String(row.status||'').toUpperCase()),failed=states.every(state=>state==='REFUNDREJECTED'),complete=states.every(state=>state==='REFUNDED');
 return {status:failed?'FAILED':complete?'SUCCEEDED':'PENDING',refundStatus:failed?'REJECTED':complete?'CONFIRMED':'PENDING',references:ids,detail:states.join(', ')};
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

// Shippo supports customer URL tokens; HMAC requires separate provider setup.
// Never accept unverified events, including accounts without a configured secret.
function verifyEvent(raw, headers = {}, options = {}) {
  const secret = options.webhookSecret || process.env.SHIPPO_WEBHOOK_SECRET;
  if (!secret) throw new AuthenticationError('A customer webhook secret must be configured before receiving carrier events.');
  const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(String(raw),'utf8');
  const signed=headers['shippo-auth-signature'];
  if(signed){
    const parts=Object.fromEntries(String(signed).split(',').map(part=>part.trim().split('='))),timestamp=Number(parts.t);
    if(!Number.isFinite(timestamp)||Math.abs(Date.now()/1000-timestamp)>300)throw new AuthenticationError('This shipping webhook signature is expired.');
    const expected=require('node:crypto').createHmac('sha256',secret).update(parts.t+'.').update(bytes).digest('hex');
    if(!safeEqual(String(parts.v1||''),expected))throw new AuthenticationError('This shipping webhook signature is invalid.');
  }else{
    const presented = options.presentedToken || headers['x-shippo-secret'] || headers['X-Shippo-Secret'] || '';
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
    // object_id identifies the tracker/transaction, not an individual update.
    // The receiver uses the digest of the authenticated event bytes instead.
    externalEventId: null,
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

module.exports = { supportsReturnLabels:true,isConfigured, quote, buy, verifyPurchase, voidLabel, verifyVoid, track, verifyEvent, readEvent,
  ensureWebhook:(ctx,input)=>require('./webhook-registration').shippo(call,ctx,input),
  address, parcel, statusOf, readRate, call };
