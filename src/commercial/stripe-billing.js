'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { providerFetch } = require('../lib/provider-http');
const { ValidationError, AuthenticationError } = require('../domain/errors');

const API = 'https://api.stripe.com/v1';
const API_VERSION='2026-09-30.endive';

function form(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values || {})) {
    if (value === undefined || value === null || value === '') continue;
    body.append(key, String(value));
  }
  return body;
}

async function call(path, options = {}) {
  const secretKey = options.secretKey || config.commercial.stripeSecretKey;
  if (!secretKey) throw new ValidationError('StockChief subscription billing is not configured yet.');
  const headers = { Authorization:`Bearer ${secretKey}`, 'Content-Type':'application/x-www-form-urlencoded','Stripe-Version':API_VERSION };
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await providerFetch(`${API}${path}`, {
    method:options.method || 'POST', headers, body:options.values ? form(options.values) : undefined,
  }, { provider:'StockChief Billing', fetch:options.fetch });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ValidationError(payload?.error?.message || `Stripe Billing refused the request (${response.status}).`);
  return payload;
}

async function createCheckout(input, options = {}) {
  const promotion=input.promotionCodeId?{'discounts[0][promotion_code]':input.promotionCodeId}:{};
  const automaticTax=options.automaticTax??config.commercial.automaticTax;
  return call('/checkout/sessions', {
    ...options,
    idempotencyKey:`stockchief-checkout:${input.attemptId}`,
    values:{
      mode:'subscription',
      success_url:input.successUrl,
      cancel_url:input.cancelUrl,
      customer:input.customerId,
      customer_email:input.customerId ? undefined : input.email,
      'line_items[0][price]':input.priceId,
      'line_items[0][quantity]':1,
      'subscription_data[metadata][stockchief_account_id]':input.accountId,
      'subscription_data[metadata][stockchief_plan_id]':input.planId,
      'metadata[stockchief_account_id]':input.accountId,
      'metadata[stockchief_plan_id]':input.planId,
      'metadata[stockchief_checkout_attempt_id]':input.attemptId,
      allow_promotion_codes:input.promotionCodeId?undefined:'true',
      'subscription_data[trial_period_days]':input.trialDays>0?input.trialDays:undefined,
      billing_address_collection:'auto',
      'automatic_tax[enabled]':automaticTax?'true':undefined,
      ...promotion,
    },
  });
}

async function createPortal(input, options = {}) {
  const flow=input.subscriptionId?{
    'flow_data[type]':'subscription_update',
    'flow_data[subscription_update][subscription]':input.subscriptionId,
    'flow_data[after_completion][type]':'redirect',
    'flow_data[after_completion][redirect][return_url]':input.returnUrl,
  }:{};
  return call('/billing_portal/sessions', {
    ...options,
    idempotencyKey:`stockchief-portal:${input.accountId}:${input.requestId}`,
    values:{customer:input.customerId,return_url:input.returnUrl,...flow},
  });
}

async function createAddonCheckout(input,options={}){return call('/checkout/sessions',{...options,
 idempotencyKey:`stockchief-addon:${input.purchaseId}`,values:{mode:'payment',customer:input.customerId,
 success_url:input.successUrl,cancel_url:input.cancelUrl,'line_items[0][price]':input.priceId,'line_items[0][quantity]':1,
 'metadata[stockchief_purchase_id]':input.purchaseId,'metadata[stockchief_account_id]':input.accountId,
 'payment_intent_data[metadata][stockchief_purchase_id]':input.purchaseId,
 'payment_intent_data[metadata][stockchief_account_id]':input.accountId,
 'payment_intent_data[setup_future_usage]':'off_session'}});}
async function createTopupPayment(input,options={}){return call('/payment_intents',{...options,
 idempotencyKey:`stockchief-topup:${input.purchaseId}`,values:{amount:input.amountMinor,currency:input.currency.toLowerCase(),
 customer:input.customerId,payment_method:input.paymentMethodId,off_session:'true',confirm:'true',
 'metadata[stockchief_purchase_id]':input.purchaseId,'metadata[stockchief_account_id]':input.accountId}});}
async function retrievePaymentMethod(id,options={}){return call(`/payment_methods/${encodeURIComponent(id)}`,{...options,method:'GET'});}
async function retrieveBalanceTransaction(id,options={}){return call(`/balance_transactions/${encodeURIComponent(id)}`,{...options,method:'GET'});}
async function retrieveInvoice(id,options={}){return call(`/invoices/${encodeURIComponent(id)}`,{...options,method:'GET'});}
async function retrievePaymentIntent(id,options={}){return call(`/payment_intents/${encodeURIComponent(id)}?expand[]=latest_charge.balance_transaction`,{...options,method:'GET'});}
async function listInvoicePayments(invoiceId,options={}){
 const payments=[];const seen=new Set();let cursor;
 do{const page=await call(`/invoice_payments?invoice=${encodeURIComponent(invoiceId)}&limit=100${cursor?`&starting_after=${encodeURIComponent(cursor)}`:''}`,{...options,method:'GET'});
  if(!Array.isArray(page.data)||page.has_more&&!page.data.length)throw new ValidationError('Stripe returned incomplete invoice-payment pagination.');
  for(const payment of page.data){if(seen.has(payment.id))throw new ValidationError('Stripe repeated an invoice payment while paginating.');seen.add(payment.id);payments.push(payment);}
  cursor=page.has_more?page.data.at(-1).id:null;
 }while(cursor);
 return payments;
}

async function retrieveCheckout(sessionId, options = {}) {
  return call(`/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`, {...options,method:'GET'});
}

async function retrieveSubscription(subscriptionId, options = {}) {
  return call(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {...options,method:'GET'});
}

async function previewSubscriptionChange(input,options={}){
  return call('/invoices/create_preview',{...options,values:{customer:input.customerId,subscription:input.subscriptionId,
    'subscription_details[items][0][id]':input.itemId,'subscription_details[items][0][price]':input.priceId,
    'subscription_details[items][0][quantity]':1,
    'subscription_details[proration_behavior]':input.prorationBehavior||'create_prorations',
    'subscription_details[proration_date]':input.prorationBehavior==='none'?undefined:input.prorationDate}});
}

async function updateSubscription(input,options={}){
  return call(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`,{...options,
    idempotencyKey:`stockchief-subscription-change:${input.changeId}`,values:{
      'items[0][id]':input.itemId,'items[0][price]':input.priceId,'items[0][quantity]':1,
      proration_behavior:input.prorationBehavior||'create_prorations',payment_behavior:input.paymentBehavior||'pending_if_incomplete',
      proration_date:input.prorationDate,
    }});
}
async function scheduleDowngrade(input,options={}){
 const schedule=await call('/subscription_schedules',{...options,idempotencyKey:`stockchief-schedule:${input.changeId}`,
  values:{from_subscription:input.subscriptionId}});
 return call(`/subscription_schedules/${encodeURIComponent(schedule.id)}`,{...options,
  idempotencyKey:`stockchief-schedule-phases:${input.changeId}`,values:{end_behavior:'release',proration_behavior:'none',
  'phases[0][start_date]':schedule.current_phase.start_date,'phases[0][end_date]':input.periodEnd,
  'phases[0][items][0][price]':input.currentPriceId,'phases[0][items][0][quantity]':1,
  'phases[1][start_date]':input.periodEnd,'phases[1][items][0][price]':input.priceId,'phases[1][items][0][quantity]':1,
  'phases[1][duration][interval]':input.interval==='ANNUAL'?'year':'month','phases[1][duration][interval_count]':1,
  'phases[1][proration_behavior]':'none'}});
}

async function setCancellation(input,options={}){
  return call(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`,{...options,
    idempotencyKey:`stockchief-subscription-cancellation:${input.subscriptionId}:${input.requestId}`,
    values:{cancel_at_period_end:input.cancelAtPeriodEnd?'true':'false',
      'metadata[stockchief_account_id]':input.accountId,'metadata[stockchief_plan_id]':input.planId}});
}

async function listInvoices(customerId, options = {}) {
  return call(`/invoices?customer=${encodeURIComponent(customerId)}&limit=24`, {...options,method:'GET'});
}

async function createInvoiceItem(input,options={}){
  return call('/invoiceitems',{...options,idempotencyKey:`stockchief-overage:${input.chargeId}`,values:{
    customer:input.customerId,subscription:input.subscriptionId,amount:input.amountMinor,currency:input.currency.toLowerCase(),
    description:input.description,'metadata[stockchief_overage_charge_id]':input.chargeId,
    'metadata[stockchief_meter]':input.meter,
  }});
}

function verifyEvent(raw, headers = {}, options = {}) {
  const secret = options.webhookSecret || config.commercial.stripeWebhookSecret;
  const signature = headers['stripe-signature'] || headers['Stripe-Signature'];
  if (!secret) throw new ValidationError('StockChief billing webhook verification is not configured.');
  if (!signature) throw new AuthenticationError('That billing event has no Stripe signature.');
  const pieces = String(signature).split(',').map((part) => part.split('=', 2));
  const timestamp = pieces.find(([key]) => key === 't')?.[1];
  const signatures = pieces.filter(([key]) => key === 'v1').map(([, value]) => value);
  const body = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  if (!timestamp || !signatures.length) throw new AuthenticationError('That billing signature cannot be verified.');
  const previous=options.previousWebhookSecret||config.commercial.stripePreviousWebhookSecret;
  const previousExpires=options.previousWebhookSecretExpiresAt||config.commercial.stripePreviousWebhookSecretExpiresAt;
  const secrets=[secret];
  // A bounded overlap lets a pinned-version endpoint replace an older endpoint
  // without dropping genuine deliveries. An absent/invalid deadline fails closed.
  if(previous&&Date.parse(previousExpires)>Date.now())secrets.push(previous);
  const valid = secrets.some(candidateSecret=>{
   const expected = crypto.createHmac('sha256', candidateSecret).update(`${timestamp}.${body}`).digest('hex');
   return signatures.some((candidate) => {
    const left = Buffer.from(expected);const right = Buffer.from(candidate);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
   });
  });
  if (!valid) throw new AuthenticationError('That billing event did not come from Stripe.');
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new AuthenticationError('That billing event is too old.');
  return JSON.parse(body);
}

module.exports = { createCheckout,createPortal,retrieveCheckout,retrieveSubscription,previewSubscriptionChange,updateSubscription,
  createAddonCheckout,createTopupPayment,retrievePaymentMethod,retrieveBalanceTransaction,retrieveInvoice,retrievePaymentIntent,listInvoicePayments,
  scheduleDowngrade,
  setCancellation,listInvoices,createInvoiceItem,verifyEvent,
  __internal:{call,form,apiVersion:API_VERSION} };
