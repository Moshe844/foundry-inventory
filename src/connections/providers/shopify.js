'use strict';

const crypto = require('node:crypto');
const config = require('../../config');
const { ValidationError, AuthenticationError } = require('../../domain/errors');
const { safeEqual, hmacBase64, requireVerified, jsonRequest } = require('./common');

const API_VERSION = '2026-07';
const SCOPES = ['read_orders', 'read_products', 'read_locations', 'read_inventory', 'read_fulfillments'];

function metadata() {
  return { type: 'shopify', name: 'Shopify', mark: 'S', category: 'selling', authMode: 'oauth', available: config.connections.shopify.configured,
    description: 'Automatically receive Shopify orders, cancellations, fulfillment, returns, products, SKUs, and locations.',
    provides: ['customer orders', 'cancellations', 'fulfillment', 'returns', 'products, SKUs and locations'],
    unavailableReason: config.connections.shopify.configured ? null : 'Foundry’s Shopify app credentials have not been configured on this installation.',
  };
}

function normalizeShop(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const shop = raw.endsWith('.myshopify.com') ? raw : `${raw}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new ValidationError('Enter your Shopify store name or its myshopify.com address.');
  return shop;
}

function authorizationUrl({ state, input }) {
  if (!config.connections.shopify.configured) throw new ValidationError('Shopify is not configured on this Foundry installation.');
  const shop = normalizeShop(input.shop);
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', config.connections.shopify.clientId);
  url.searchParams.set('scope', SCOPES.join(','));
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', state);
  return { url: url.toString(), metadata: { shop, redirectUri: input.redirectUri } };
}

function expiresAt(seconds) {
  const ttl = Math.max(60, Number(seconds) || 86_399);
  return new Date(Date.now() + ttl * 1000).toISOString();
}

async function exchangeClientCredentials(shop) {
  const form = new URLSearchParams({
    client_id: config.connections.shopify.clientId,
    client_secret: config.connections.shopify.clientSecret,
    grant_type: 'client_credentials',
  });
  const { body } = await jsonRequest(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const accessTokenExpiresAt = expiresAt(body.expires_in);
  return {
    credentials: { accessToken: body.access_token, shop, authMode: 'client_credentials', accessTokenExpiresAt },
    expiresAt: accessTokenExpiresAt,
    accountId: shop,
    accountName: shop.replace('.myshopify.com', ''),
    capabilities: body.scope ? body.scope.split(',') : SCOPES,
  };
}

async function tryDirectAuthorization({ input }) {
  const shop = normalizeShop(input.shop);
  try { return await exchangeClientCredentials(shop); }
  catch (error) {
    const raw = String(error.providerBody?.raw || '');
    const rawCode = raw.match(/oauth error\s+([a-z_]+)/i)?.[1];
    const providerCode = String(error.providerBody?.error || error.providerBody?.code || rawCode || '').toLowerCase();
    // A different organization's store must use the merchant approval flow.
    if (providerCode === 'shop_not_permitted') return null;
    if (providerCode === 'app_not_installed') {
      throw new ValidationError(`Shopify says Foundry Inventory is not installed on ${shop}. Install it from the Shopify Dev Dashboard—or uninstall and reinstall it—then try Connect Shopify again.`);
    }
    if (error instanceof TypeError && error.message === 'fetch failed') {
      throw new ValidationError('Foundry could not reach Shopify securely. Check the internet connection and try again.');
    }
    throw new ValidationError('Shopify did not authorize this connection. Check that the store address is correct and that Foundry has the client ID and secret for the installed app.');
  }
}

async function refreshCredentials(credentials) {
  if (credentials?.authMode !== 'client_credentials') return { credentials, refreshed: false };
  const validUntil = Date.parse(credentials.accessTokenExpiresAt || '');
  if (Number.isFinite(validUntil) && validUntil > Date.now() + 5 * 60_000) {
    return { credentials, expiresAt: credentials.accessTokenExpiresAt, refreshed: false };
  }
  const result = await exchangeClientCredentials(normalizeShop(credentials.shop));
  return { credentials: result.credentials, expiresAt: result.expiresAt, refreshed: true };
}

function verifyOAuthQuery(query) {
  const hmac = String(query.hmac || '');
  const message = Object.keys(query).filter((key) => key !== 'hmac' && key !== 'signature')
    .sort().map((key) => `${key}=${Array.isArray(query[key]) ? query[key].join(',') : query[key]}`).join('&');
  const expected = crypto.createHmac('sha256', config.connections.shopify.clientSecret).update(message).digest('hex');
  if (!safeEqual(hmac, expected)) throw new AuthenticationError('Shopify could not be verified. Please start the connection again.');
}

async function exchangeAuthorization({ query, metadata: stateMeta }) {
  verifyOAuthQuery(query);
  const shop = normalizeShop(query.shop);
  if (shop !== stateMeta.shop) throw new AuthenticationError('The Shopify store does not match the connection request.');
  const form = new URLSearchParams({
    client_id: config.connections.shopify.clientId,
    client_secret: config.connections.shopify.clientSecret,
    code: String(query.code || ''),
  });
  const { body } = await jsonRequest(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  return { credentials: { accessToken: body.access_token, shop }, accountId: shop,
    accountName: shop.replace('.myshopify.com', ''), capabilities: body.scope ? body.scope.split(',') : SCOPES };
}

async function graphql(credentials, query, variables = {}) {
  const { body } = await jsonRequest(`https://${credentials.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': credentials.accessToken },
    body: JSON.stringify({ query, variables }),
  });
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
}

async function bootstrapSnapshot({ credentials }) {
  const productsById = new Map(); let cursor = null; let currency = 'USD';
  do {
    const data = await graphql(credentials, `query CatalogBootstrap($after:String){
      shop{currencyCode}
      productVariants(first:100,after:$after){nodes{
        id title sku price selectedOptions{name value}
        product{id title status isGiftCard}
        inventoryItem{tracked inventoryLevels(first:250){nodes{
          location{id name isActive}
          quantities(names:["on_hand"]){name quantity}
        }}}
      } pageInfo{hasNextPage endCursor}}
    }`, { after: cursor });
    currency = data.shop?.currencyCode || currency;
    for (const variant of data.productVariants.nodes) {
      const product = productsById.get(variant.product.id) || {
        externalId: variant.product.id,
        title: variant.product.title,
        status: variant.product.status,
        isGiftCard: !!variant.product.isGiftCard,
        variants: [],
      };
      product.variants.push({
        externalId: variant.id,
        title: variant.title,
        sku: variant.sku || null,
        price: variant.price,
        selectedOptions: variant.selectedOptions || [],
        tracked: !!variant.inventoryItem?.tracked,
        inventoryLevels: (variant.inventoryItem?.inventoryLevels?.nodes || []).map((level) => ({
          externalLocationId: level.location.id,
          name: level.location.name,
          active: !!level.location.isActive,
          onHand: Number(level.quantities?.find((quantity) => quantity.name === 'on_hand')?.quantity || 0),
        })),
      });
      productsById.set(product.externalId, product);
    }
    cursor = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (cursor);
  const locations = []; cursor = null;
  do {
    const data = await graphql(credentials, `query Locations($after:String){locations(first:100,after:$after,includeInactive:true){nodes{id name isActive} pageInfo{hasNextPage endCursor}}}`, { after: cursor });
    for (const location of data.locations.nodes) locations.push({ externalId: location.id,
      name: location.name, active: !!location.isActive });
    cursor = data.locations.pageInfo.hasNextPage ? data.locations.pageInfo.endCursor : null;
  } while (cursor);
  return { currency, products: [...productsById.values()], locations };
}

async function discover({ credentials }) {
  const snapshot = await bootstrapSnapshot({ credentials });
  const products = snapshot.products.flatMap((product) => product.variants.map((variant) => ({
    entityType: 'sku', externalId: variant.externalId,
    parentExternalId: product.externalId, code: variant.sku,
    displayName: `${product.title}${variant.title && variant.title !== 'Default Title' ? ` / ${variant.title}` : ''}`,
    providerData: {
      productId: product.externalId, productStatus: product.status, isGiftCard: product.isGiftCard,
      itemName: product.title,
      variationName: variant.title && variant.title !== 'Default Title' ? variant.title : null,
      tracked: variant.tracked, price: variant.price, currency: snapshot.currency,
      priceMoney: Number.isFinite(Number(variant.price))
        ? { amount: Math.round(Number(variant.price) * 100), currency: snapshot.currency }
        : null,
      selectedOptions: variant.selectedOptions, inventoryLevels: variant.inventoryLevels,
      inventoryCounts: variant.inventoryLevels.map((level) => ({
        externalLocationId: level.externalLocationId, state: 'IN_STOCK', quantity: level.onHand,
      })),
    },
  })));
  const locations = snapshot.locations.map((location) => ({ entityType: 'location', externalId: location.externalId,
    displayName: location.name, providerData: { active: location.active } }));
  return { products, locations };
}

async function registerWebhooks({ credentials, webhookUrl }) {
  const topics = ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'ORDERS_FULFILLED',
    'FULFILLMENTS_CREATE', 'REFUNDS_CREATE',
    'PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'LOCATIONS_CREATE', 'LOCATIONS_UPDATE', 'APP_UNINSTALLED'];
  const mutation = `mutation AddWebhook($topic:WebhookSubscriptionTopic!,$input:WebhookSubscriptionInput!){webhookSubscriptionCreate(topic:$topic,webhookSubscription:$input){userErrors{message} webhookSubscription{id}}}`;
  const results = [];
  for (const topic of topics) {
    const data = await graphql(credentials, mutation, { topic, input: { uri: webhookUrl, format: 'JSON' } });
    const errors = data.webhookSubscriptionCreate.userErrors || [];
    if (errors.length) results.push({ topic, error: errors.map((e) => e.message).join('; ') });
    else results.push({ topic, id: data.webhookSubscriptionCreate.webhookSubscription?.id });
  }
  return results;
}

async function historySummary({ credentials, since }) {
  const query = `created_at:>=${since}`;
  const data = await graphql(credentials, `query HistoryCount($query:String!){ordersCount(query:$query,limit:10000){count precision}}`, { query });
  return { operationalRecords: Number(data.ordersCount?.count || 0), periodStart: since,
    detail: { precision: data.ordersCount?.precision || 'unknown' } };
}

function verifyWebhook({ headers, rawBody }) {
  const provided = headers['x-shopify-hmac-sha256'];
  const expected = hmacBase64(config.connections.shopify.clientSecret, rawBody);
  requireVerified(safeEqual(provided, expected), 'This webhook did not pass Shopify signature verification.');
}

function shopifyGid(type, value) {
  const id = String(value || '');
  if (!id || id.startsWith('gid://shopify/')) return id;
  return `gid://shopify/${type}/${id}`;
}

function orderLines(payload) {
  return (payload.line_items || []).filter((line) => Number(line.quantity) > 0).map((line) => ({
    externalSku: line.variant_id ? shopifyGid('ProductVariant', line.variant_id) : shopifyGid('Product', line.product_id),
    skuCode: line.sku || undefined,
    quantity: Number(line.quantity), unitPriceMinor: line.price ? Math.round(Number(line.price) * 100) : undefined,
  }));
}

function normalizeWebhook({ headers, body }) {
  const topic = String(headers['x-shopify-topic'] || '').toLowerCase();
  const delivery = String(headers['x-shopify-webhook-id'] || headers['x-shopify-event-id'] || body.id);
  const occurredAt = headers['x-shopify-triggered-at'] || body.updated_at || body.created_at;
  const version = body.updated_at || occurredAt;
  if (topic === 'orders/create') return [{ eventId: delivery, type: 'sales_order.created', version, occurredAt,
    aggregateId: String(body.id), data: { externalOrderId: String(body.id), orderNumber: body.name,
      customer: body.customer ? { externalId: String(body.customer.id), name: [body.customer.first_name, body.customer.last_name].filter(Boolean).join(' ') || body.customer.email } : undefined,
      externalLocationId: body.location_id ? shopifyGid('Location', body.location_id) : undefined, currency: body.currency,
      lines: orderLines(body) } }];
  if (topic === 'orders/updated') return [{ eventId: delivery, type: 'sales_order.snapshot', version, occurredAt,
    aggregateId: String(body.id), data: { externalOrderId: String(body.id), lines: orderLines(body) } }];
  if (topic === 'orders/cancelled') return [{ eventId: delivery, type: 'sales_order.cancelled', version, occurredAt,
    aggregateId: String(body.id), data: { externalOrderId: String(body.id), reason: body.cancel_reason || 'Cancelled in Shopify' } }];
  if (topic === 'orders/fulfilled') return [{ eventId: delivery, type: 'sales_order.fulfilled', version, occurredAt,
    aggregateId: String(body.id), data: { externalOrderId: String(body.id) } }];
  if (topic === 'fulfillments/create') return [{ eventId: delivery, type: 'sales_order.fulfilled', version, occurredAt,
    aggregateId: String(body.order_id), data: { externalOrderId: String(body.order_id), lines: (body.line_items || []).map((line) => ({
      externalSku: line.variant_id ? shopifyGid('ProductVariant', line.variant_id) : shopifyGid('Product', line.product_id),
      skuCode: line.sku || undefined,
      externalLocationId: body.location_id ? shopifyGid('Location', body.location_id) : undefined, quantity: Number(line.quantity),
    })) } }];
  if (topic === 'refunds/create') return (body.refund_line_items || []).filter((row) => row.restock_type && row.restock_type !== 'no_restock').map((row, i) => ({
    eventId: `${delivery}:${i}`, type: 'return.completed', version, occurredAt,
    data: { externalSku: row.line_item?.variant_id ? shopifyGid('ProductVariant', row.line_item.variant_id)
      : shopifyGid('Product', row.line_item?.product_id), skuCode: row.line_item?.sku,
      externalLocationId: row.location_id ? shopifyGid('Location', row.location_id) : undefined, quantity: Number(row.quantity),
      reason: `Shopify refund ${body.id} (${row.restock_type})` },
  }));
  if (topic.startsWith('products/')) return [{ eventId: delivery, type: 'product.changed', version, occurredAt,
    data: { externalProductId: shopifyGid('Product', body.id), name: body.title, variants: body.variants || [] } }];
  if (topic.startsWith('locations/')) return [{ eventId: delivery, type: 'location.changed', version, occurredAt,
    data: { externalLocationId: shopifyGid('Location', body.id), name: body.name } }];
  if (topic === 'app/uninstalled') return [];
  throw new ValidationError(`Shopify topic ${topic || '(missing)'} is not supported.`);
}

module.exports = { metadata, normalizeShop, authorizationUrl, tryDirectAuthorization, refreshCredentials,
  verifyOAuthQuery, exchangeAuthorization, discover, bootstrapSnapshot, registerWebhooks, historySummary, verifyWebhook,
  normalizeWebhook, graphql, API_VERSION };
