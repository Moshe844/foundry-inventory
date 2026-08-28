'use strict';

const config = require('../../config');
const { ValidationError } = require('../../domain/errors');
const { safeEqual, requireVerified, jsonRequest } = require('./common');

function oauthBase(environment = config.connections.clover.environment) {
  return environment === 'sandbox' ? 'https://sandbox.dev.clover.com' : 'https://www.clover.com';
}

function apiBase(environment = config.connections.clover.environment) {
  return environment === 'sandbox' ? 'https://apisandbox.dev.clover.com' : 'https://api.clover.com';
}

function metadata() {
  return {
    type: 'clover', name: 'Clover', mark: 'C', category: 'selling', authMode: 'oauth',
    available: config.connections.clover.configured,
    description: 'Connect a Clover merchant to receive completed sales, refunds, and inventory catalog changes.',
    provides: ['completed POS sales', 'refund evidence', 'catalog SKUs and merchant location'],
    unavailableReason: config.connections.clover.configured ? null
      : 'Foundry’s Clover app ID, app secret, and webhook auth code have not been configured on this installation.',
  };
}

function authorizationUrl({ state, input }) {
  if (!config.connections.clover.configured) throw new ValidationError('Clover is not configured on this Foundry installation.');
  const url = new URL(`${oauthBase()}/oauth/v2/authorize`);
  url.searchParams.set('client_id', config.connections.clover.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return { url: url.toString(), metadata: { redirectUri: input.redirectUri,
    environment: config.connections.clover.environment } };
}

function isoFromUnix(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

async function exchangeAuthorization({ query, metadata: authMetadata = {} }) {
  if (query.error) throw new ValidationError(query.error_description || 'Clover authorization was not completed.');
  const merchantId = String(query.merchant_id || query.merchantId || '').trim();
  if (!query.code || !merchantId) throw new ValidationError('Clover did not return an authorization code and merchant.');
  const environment = authMetadata.environment || config.connections.clover.environment;
  const { body } = await jsonRequest(`${apiBase(environment)}/oauth/v2/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      client_id: config.connections.clover.clientId,
      client_secret: config.connections.clover.clientSecret,
      code: query.code,
    }),
  });
  const credentials = {
    environment, merchantId, accessToken: body.access_token, refreshToken: body.refresh_token,
    accessTokenExpiration: body.access_token_expiration, refreshTokenExpiration: body.refresh_token_expiration,
    webhookAuthCode: config.connections.clover.webhookAuthCode,
  };
  if (!credentials.accessToken) throw new ValidationError('Clover did not return a usable access token.');
  const merchant = (await api(credentials, `/v3/merchants/${encodeURIComponent(merchantId)}`)).body;
  return { credentials, accountId: merchantId, accountName: merchant.name || `Clover merchant ${merchantId.slice(-6)}`,
    capabilities: ['READ_MERCHANT', 'READ_INVENTORY', 'READ_ORDERS', 'READ_PAYMENTS', 'WEBHOOKS'],
    expiresAt: isoFromUnix(body.access_token_expiration) };
}

async function refreshCredentials(credentials) {
  const expiresAt = Number(credentials.accessTokenExpiration || 0) * 1000;
  if (!expiresAt || expiresAt > Date.now() + 5 * 60_000) {
    return { credentials, refreshed: false, expiresAt: isoFromUnix(credentials.accessTokenExpiration) };
  }
  if (!credentials.refreshToken) throw new ValidationError('Clover access expired. Reconnect this merchant.');
  const { body } = await jsonRequest(`${apiBase(credentials.environment)}/oauth/v2/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      client_id: config.connections.clover.clientId,
      client_secret: config.connections.clover.clientSecret,
      refresh_token: credentials.refreshToken,
    }),
  });
  const refreshed = { ...credentials, accessToken: body.access_token, refreshToken: body.refresh_token,
    accessTokenExpiration: body.access_token_expiration, refreshTokenExpiration: body.refresh_token_expiration };
  return { credentials: refreshed, refreshed: true, expiresAt: isoFromUnix(body.access_token_expiration) };
}

async function api(credentials, path, options = {}) {
  return jsonRequest(`${apiBase(credentials.environment)}${path}`, { ...options,
    headers: { authorization: `Bearer ${credentials.accessToken}`, accept: 'application/json',
      'content-type': 'application/json', 'user-agent': 'Foundry-Inventory/1.0', ...(options.headers || {}) } });
}

function elements(body) {
  if (Array.isArray(body)) return body;
  return body?.elements || body?.items || [];
}

async function discover({ credentials }) {
  const merchant = (await api(credentials, `/v3/merchants/${encodeURIComponent(credentials.merchantId)}`)).body;
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const response = await api(credentials,
      `/v3/merchants/${encodeURIComponent(credentials.merchantId)}/items?limit=100&offset=${offset}&expand=itemStock`);
    const page = elements(response.body);
    rows.push(...page);
    if (page.length < 100) break;
  }
  const products = rows.filter((item) => !item.hidden && !item.deleted).map((item) => {
    const rawStock = item.stockCount ?? item.itemStock?.quantity ?? item.itemStock?.stockCount;
    const stock = Number(rawStock);
    return { entityType: 'sku', externalId: String(item.id), code: item.sku || item.code || null,
      displayName: item.name || item.sku || String(item.id),
      providerData: { itemName: item.name || item.sku || String(item.id), variationName: null,
        priceMoney: Number.isInteger(Number(item.price)) ? { amount: Number(item.price), currency: merchant.currency || 'USD' } : null,
        inventoryCounts: Number.isInteger(stock) ? [{ externalLocationId: credentials.merchantId,
          state: 'IN_STOCK', quantity: stock }] : [] } };
  });
  return { products, locations: [{ entityType: 'location', externalId: credentials.merchantId,
    displayName: merchant.name || `Clover merchant ${credentials.merchantId.slice(-6)}`,
    providerData: { kind: 'store', address: merchant.address || null } }] };
}

function verifyWebhook({ headers, body, credentials }) {
  requireVerified(safeEqual(headers['x-clover-auth'], credentials.webhookAuthCode),
    'This webhook did not pass Clover auth-code verification.');
  if (body?.appId) requireVerified(safeEqual(body.appId, config.connections.clover.clientId),
    'This Clover webhook belongs to a different app.');
}

function quantity(line) {
  if (line.quantity != null) return Number(line.quantity);
  if (line.unitQty == null) return 1;
  const fixed = Number(line.unitQty);
  return Number.isInteger(fixed) && fixed > 0 && fixed % 1000 === 0 ? fixed / 1000 : fixed;
}

function orderLines(order) {
  return elements(order.lineItems).filter((line) => line.item?.id && quantity(line) > 0).map((line) => ({
    lineId: line.id, externalSku: String(line.item.id), skuCode: line.item.sku || undefined,
    quantity: quantity(line), unitPriceMinor: Number.isInteger(Number(line.price)) ? Number(line.price) : undefined,
  }));
}

async function fetchOrder(credentials, merchantId, orderId) {
  return (await api(credentials, `/v3/merchants/${encodeURIComponent(merchantId)}/orders/${encodeURIComponent(orderId)}`
    + '?expand=lineItems,payments,refunds,customers,orderFulfillmentEvent')).body;
}

function normalizeOrder(order, merchantId, update) {
  const occurredAt = new Date(Number(order.modifiedTime || update.ts || Date.now())).toISOString();
  const version = String(order.modifiedTime || update.ts || '');
  const lines = orderLines(order);
  const events = [];
  if (String(order.paymentState || '').toUpperCase() === 'PAID' && lines.length) {
    lines.forEach((line, index) => events.push({
      eventId: `clover-order:${order.id}:paid:${line.lineId || index}`,
      type: 'sale.completed', version, occurredAt, aggregateId: String(order.id),
      data: { externalOrderId: String(order.id), externalSku: line.externalSku, skuCode: line.skuCode,
        externalLocationId: merchantId, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor,
        reference: `Clover order ${order.id}` },
    }));
  }
  const refunds = elements(order.refunds);
  if (refunds.length || ['REFUNDED', 'PARTIALLY_REFUNDED', 'CREDITED'].includes(String(order.paymentState || '').toUpperCase())) {
    (refunds.length ? refunds : [{ id: `order-${order.id}` }]).forEach((refund) => events.push({
      eventId: `clover-refund:${refund.id}`, type: 'return.reported', version, occurredAt,
      aggregateId: String(order.id), data: { externalOrderId: String(order.id), refundId: String(refund.id),
        amountMinor: refund.amount, reason: refund.note || 'Clover reported a financial refund; physical stock requires confirmation.' },
    }));
  }
  return events;
}

async function normalizeWebhook({ body, credentials, connection }) {
  const merchantId = connection.provider_account_id;
  const updates = body?.merchants?.[merchantId] || [];
  const events = [];
  for (const update of updates) {
    const [kind, objectId] = String(update.objectId || '').split(':', 2);
    const occurredAt = new Date(Number(update.ts || Date.now())).toISOString();
    if (kind === 'I') {
      events.push({ eventId: `clover-item:${objectId}:${update.type}:${update.ts}`, type: 'product.changed',
        version: String(update.ts || ''), occurredAt, data: { externalProductId: objectId } });
    } else if (kind === 'M') {
      events.push({ eventId: `clover-merchant:${objectId}:${update.type}:${update.ts}`, type: 'location.changed',
        version: String(update.ts || ''), occurredAt, data: { externalLocationId: merchantId } });
    } else if (kind === 'O') {
      if (update.type !== 'DELETE') events.push(...normalizeOrder(await fetchOrder(credentials, merchantId, objectId), merchantId, update));
    } else if (kind === 'P') {
      const payment = (await api(credentials,
        `/v3/merchants/${encodeURIComponent(merchantId)}/payments/${encodeURIComponent(objectId)}?expand=order,refunds`)).body;
      const orderId = payment.order?.id || payment.orderId;
      if (orderId) events.push(...normalizeOrder(await fetchOrder(credentials, merchantId, orderId), merchantId, update));
    }
  }
  return events;
}

async function historySummary({ credentials, since }) {
  let operationalRecords = 0;
  for (let offset = 0; ; offset += 100) {
    const filter = encodeURIComponent(`createdTime>=${Date.parse(since)}`);
    const response = await api(credentials,
      `/v3/merchants/${encodeURIComponent(credentials.merchantId)}/payments?limit=100&offset=${offset}&filter=${filter}`);
    const page = elements(response.body).filter((payment) => String(payment.result || '').toUpperCase() === 'SUCCESS');
    operationalRecords += page.length;
    if (elements(response.body).length < 100) break;
  }
  return { operationalRecords, periodStart: since };
}

function webhookUrl({ origin }) { return `${origin}/api/v1/connections/clover/webhooks`; }

module.exports = { metadata, authorizationUrl, exchangeAuthorization, refreshCredentials, discover, verifyWebhook,
  normalizeWebhook, historySummary, webhookUrl, api, oauthBase, apiBase };
