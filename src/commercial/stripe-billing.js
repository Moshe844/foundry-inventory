'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { providerFetch } = require('../lib/provider-http');
const { ValidationError, AuthenticationError } = require('../domain/errors');

const API = 'https://api.stripe.com/v1';

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
  const headers = { Authorization:`Bearer ${secretKey}`, 'Content-Type':'application/x-www-form-urlencoded' };
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

async function retrieveCheckout(sessionId, options = {}) {
  return call(`/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`, {...options,method:'GET'});
}

async function retrieveSubscription(subscriptionId, options = {}) {
  return call(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {...options,method:'GET'});
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
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const valid = signatures.some((candidate) => {
    const left = Buffer.from(expected);const right = Buffer.from(candidate);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
  if (!valid) throw new AuthenticationError('That billing event did not come from Stripe.');
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new AuthenticationError('That billing event is too old.');
  return JSON.parse(body);
}

module.exports = { createCheckout,createPortal,retrieveCheckout,retrieveSubscription,listInvoices,createInvoiceItem,verifyEvent,
  __internal:{call,form} };
