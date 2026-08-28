'use strict';

const crypto = require('node:crypto');
const config = require('../../config');
const { ValidationError } = require('../../domain/errors');
const { safeEqual, requireVerified, jsonRequest } = require('./common');

const API_VERSION = '2026-08-19';
const SCOPES = ['ITEMS_READ', 'ORDERS_READ', 'PAYMENTS_READ', 'MERCHANT_PROFILE_READ', 'INVENTORY_READ'];
const WEBHOOK_EVENTS = ['payment.created', 'payment.updated', 'refund.created', 'refund.updated',
  'catalog.version.updated', 'location.created', 'location.updated'];

function base() { return config.connections.square.environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'; }
function metadata() {
  return { type: 'square', name: 'Square', mark: '□', category: 'selling', authMode: 'oauth', available: config.connections.square.configured,
    description: 'Automatically receive completed Square sales and returns, and map catalog items and business locations.',
    provides: ['completed POS sales', 'returns', 'catalog SKUs and locations'],
    sandboxMode: config.connections.square.environment === 'sandbox',
    unavailableReason: config.connections.square.configured ? null : 'Foundry’s Square app credentials have not been configured on this installation.',
  };
}

function authorizationUrl({ state, input }) {
  if (!config.connections.square.configured) throw new ValidationError('Square is not configured on this Foundry installation.');
  const url = new URL(`${base()}/oauth2/authorize`);
  url.searchParams.set('client_id', config.connections.square.applicationId);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('session', config.connections.square.environment === 'production' ? 'false' : 'true');
  return { url: url.toString(), metadata: { redirectUri: input.redirectUri } };
}

async function tryDirectAuthorization() {
  if (config.connections.square.environment !== 'sandbox' || !config.connections.square.sandboxAccessToken) return null;
  const credentials = { accessToken: config.connections.square.sandboxAccessToken,
    environment: 'sandbox', authMode: 'sandbox_personal' };
  const merchant = (await api(credentials, '/v2/merchants/me')).body.merchant;
  if (!merchant?.id) throw new ValidationError('Square did not return a Sandbox merchant for this access token.');
  return { credentials, accountId: merchant.id,
    accountName: merchant.business_name || `Square merchant ${String(merchant.id).slice(-6)}`,
    capabilities: [...SCOPES, 'WEBHOOKS'] };
}

async function exchangeAuthorization({ query }) {
  if (query.error) throw new ValidationError(query.error_description || 'Square authorization was not completed.');
  const { body } = await jsonRequest(`${base()}/oauth2/token`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'square-version': API_VERSION }, body: JSON.stringify({
      client_id: config.connections.square.applicationId, client_secret: config.connections.square.applicationSecret,
      code: query.code, grant_type: 'authorization_code',
    }) });
  return { credentials: { accessToken: body.access_token, refreshToken: body.refresh_token,
      merchantId: body.merchant_id, expiresAt: body.expires_at, environment: config.connections.square.environment },
    accountId: body.merchant_id, accountName: `Square merchant ${String(body.merchant_id).slice(-6)}`,
    capabilities: SCOPES, expiresAt: body.expires_at };
}

async function api(credentials, path, options = {}) {
  return jsonRequest(`${credentials.environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'}${path}`, {
    ...options, headers: { authorization: `Bearer ${credentials.accessToken}`, 'square-version': API_VERSION,
      'content-type': 'application/json', ...(options.headers || {}) },
  });
}

async function discover({ credentials }) {
  const locationsResponse = await api(credentials, '/v2/locations');
  const locations = (locationsResponse.body.locations || []).map((location) => ({ entityType: 'location',
    externalId: location.id, displayName: location.name || location.business_name || location.id,
    providerData: { status: location.status, type: location.type } }));
  const objects = []; let cursor = null;
  do {
    const url = new URL(`${credentials.environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'}/v2/catalog/list`);
    url.searchParams.set('types', 'ITEM,ITEM_VARIATION'); if (cursor) url.searchParams.set('cursor', cursor);
    const response = await jsonRequest(url, { headers: { authorization: `Bearer ${credentials.accessToken}`, 'square-version': API_VERSION } });
    objects.push(...(response.body.objects || [])); cursor = response.body.cursor || null;
  } while (cursor);
  const itemNames = new Map(objects.filter((o) => o.type === 'ITEM').map((o) => [o.id, o.item_data?.name || o.id]));
  const variations = objects.filter((o) => o.type === 'ITEM_VARIATION');
  const countsByVariation = new Map();
  if (variations.length) {
    const counts = (await api(credentials, '/v2/inventory/counts/batch-retrieve', { method: 'POST',
      body: JSON.stringify({ catalog_object_ids: variations.map((variation) => variation.id), states: ['IN_STOCK'] }) }))
      .body.counts || [];
    for (const count of counts) {
      const rows = countsByVariation.get(count.catalog_object_id) || [];
      rows.push({ externalLocationId: count.location_id, state: count.state, quantity: count.quantity,
        calculatedAt: count.calculated_at });
      countsByVariation.set(count.catalog_object_id, rows);
    }
  }
  const products = variations.map((variation) => ({ entityType: 'sku',
    externalId: variation.id, parentExternalId: variation.item_variation_data?.item_id,
    code: variation.item_variation_data?.sku || null,
    displayName: `${itemNames.get(variation.item_variation_data?.item_id) || 'Square item'}${variation.item_variation_data?.name ? ` / ${variation.item_variation_data.name}` : ''}`,
    providerData: { version: variation.version,
      itemName: itemNames.get(variation.item_variation_data?.item_id) || 'Square item',
      variationName: variation.item_variation_data?.name || null,
      trackInventory: !!variation.item_variation_data?.track_inventory,
      priceMoney: variation.item_variation_data?.price_money || null,
      inventoryCounts: countsByVariation.get(variation.id) || [] },
  }));
  return { products, locations };
}

async function registerWebhooks({ credentials, webhookUrl }) {
  if (credentials.authMode !== 'sandbox_personal') return null;
  const subscriptions = (await api(credentials, '/v2/webhooks/subscriptions')).body.subscriptions || [];
  const existing = subscriptions.find((subscription) => subscription.notification_url === webhookUrl);
  const subscription = { name: 'Foundry inventory events', enabled: true,
    event_types: WEBHOOK_EVENTS, notification_url: webhookUrl, api_version: API_VERSION };
  const response = existing
    ? await api(credentials, `/v2/webhooks/subscriptions/${encodeURIComponent(existing.id)}`, {
      method: 'PUT', body: JSON.stringify({ subscription }) })
    : await api(credentials, '/v2/webhooks/subscriptions', { method: 'POST',
      body: JSON.stringify({ idempotency_key: crypto.randomUUID(), subscription }) });
  const saved = response.body.subscription;
  if (!saved?.signature_key) throw new ValidationError('Square created the webhook but did not return its signature key.');
  return { credentials: { ...credentials, webhookSignatureKey: saved.signature_key }, subscriptionId: saved.id };
}

function verifyWebhook({ headers, rawBody, webhookUrl, credentials }) {
  const key = credentials.webhookSignatureKey || config.connections.square.webhookSignatureKey;
  if (!key) throw new ValidationError('Square webhook verification is not configured for this Foundry installation.');
  const expected = crypto.createHmac('sha256', key).update(`${webhookUrl}${rawBody.toString('utf8')}`).digest('base64');
  requireVerified(safeEqual(headers['x-square-hmacsha256-signature'], expected), 'This webhook did not pass Square signature verification.');
}

async function createSandboxCheckout({ credentials, externalSku, externalLocationId, quantity }) {
  if (credentials.environment !== 'sandbox') {
    throw new ValidationError('Sandbox checkout links are only available for a Square Sandbox connection.');
  }
  const result = await api(credentials, '/v2/online-checkout/payment-links', { method: 'POST',
    body: JSON.stringify({ idempotency_key: crypto.randomUUID(),
      description: 'Foundry connector end-to-end Sandbox test',
      order: { location_id: externalLocationId,
        line_items: [{ catalog_object_id: externalSku, quantity: String(quantity) }] },
      checkout_options: { allow_tipping: false },
      payment_note: 'Foundry connector customer-operated Sandbox test',
    }) });
  const link = result.body.payment_link;
  if (!link?.url) throw new ValidationError('Square did not return a Sandbox checkout link.');
  return { url: link.url, orderId: link.order_id || null };
}

async function normalizeWebhook({ body, credentials }) {
  const eventId = String(body.event_id || body.id || '');
  const type = String(body.type || '');
  const occurredAt = body.created_at;
  if (type === 'payment.updated' || type === 'payment.created') {
    const payment = body.data?.object?.payment;
    if (!payment || payment.status !== 'COMPLETED' || !payment.id || !payment.order_id) return [];
    const embedded = body.data?.object?.order;
    const order = embedded || (await api(credentials, `/v2/orders/${encodeURIComponent(payment.order_id)}`)).body.order;
    return (order.line_items || []).filter((line) => line.catalog_object_id && Number(line.quantity) > 0).map((line, i) => ({
      // Square can send both payment.created and payment.updated for one
      // completed payment. The business event identity is the payment line,
      // not the delivery ID; using it makes that provider lifecycle exactly-once.
      eventId: `square-payment:${payment.id}:${i}`, type: 'sale.completed',
      occurredAt: payment.created_at || payment.updated_at || occurredAt, aggregateId: order.id, data: { externalSku: line.catalog_object_id,
        externalLocationId: payment.location_id || order.location_id, quantity: Number(line.quantity),
        unitPriceMinor: Number.isSafeInteger(Number(line.base_price_money?.amount)) ? Number(line.base_price_money.amount) : undefined,
        currency: line.base_price_money?.currency || payment.amount_money?.currency,
        reference: `Square order ${order.id}` },
    }));
  }
  if (type.startsWith('catalog.')) return [{ eventId, type: 'product.changed', occurredAt,
    data: { catalogVersion: body.data?.object?.catalog_version?.updated_at || occurredAt } }];
  if (type.startsWith('location.')) {
    const location = body.data?.object?.location;
    return location ? [{ eventId, type: 'location.changed', occurredAt,
      data: { externalLocationId: location.id, name: location.name } }] : [];
  }
  // A Square payment refund is financial evidence, not proof that stock was
  // physically returned. Preserve it exactly once and ask for confirmation;
  // never increase inventory from a financial refund alone.
  if (type === 'refund.created' || type === 'refund.updated') {
    const refund = body.data?.object?.refund;
    if (!refund || refund.status !== 'COMPLETED' || !refund.id) return [];
    return [{ eventId: `square-refund:${refund.id}`, type: 'return.reported',
      version: refund.updated_at || occurredAt, occurredAt: refund.created_at || occurredAt,
      aggregateId: refund.payment_id || refund.order_id || refund.id,
      data: { reference: `Square refund ${refund.id}`, externalPaymentId: refund.payment_id,
        externalOrderId: refund.order_id, amountMinor: refund.amount_money?.amount,
        currency: refund.amount_money?.currency, reason: refund.reason } }];
  }
  throw new ValidationError(`Square event ${type || '(missing)'} is not supported.`);
}

async function historySummary({ credentials, since, locations = [] }) {
  let cursor = null; const orderIds = new Set();
  do {
    const { body } = await api(credentials, '/v2/orders/search', { method: 'POST', body: JSON.stringify({
      location_ids: locations.length ? locations : undefined, cursor, limit: 100,
      query: { filter: { date_time_filter: { created_at: { start_at: since } }, state_filter: { states: ['COMPLETED'] } } },
    }) });
    for (const order of body.orders || []) orderIds.add(order.id);
    cursor = body.cursor || null;
  } while (cursor);
  return { operationalRecords: orderIds.size, periodStart: since };
}

module.exports = { metadata, authorizationUrl, tryDirectAuthorization, exchangeAuthorization, discover,
  registerWebhooks, verifyWebhook, normalizeWebhook, createSandboxCheckout, historySummary, api, API_VERSION };
