'use strict';

const crypto = require('node:crypto');
const config = require('../../config');
const { ValidationError, AuthenticationError } = require('../../domain/errors');
const { safeEqual, hmacBase64, requireVerified, jsonRequest, postalAddress } = require('./common');
const money = require('../../domain/currency');
const facts = require('../commerce-facts');

const API_VERSION = '2026-07';
const SCOPES = ['read_orders', 'read_products', 'read_locations', 'read_inventory', 'read_fulfillments'];
const SUPPORTED_SCOPES = new Set([...SCOPES,'write_products','write_inventory','write_orders',
  'write_fulfillments','write_merchant_managed_fulfillment_orders']);

// Store-bound deployment policy controls the permission request, never
// authority to execute business operations. Other stores remain read-only.
function requestedScopes(shop) {
  let policy;
  try { policy=JSON.parse(config.connections.shopify.scopePolicy); }
  catch { throw new ValidationError('The Shopify permission policy is invalid. Contact your deployment administrator.'); }
  if(!policy||typeof policy!=='object'||Array.isArray(policy))throw new ValidationError('The Shopify permission policy must identify stores.');
  const values=Object.hasOwn(policy,shop)?policy[shop]:SCOPES;
  if(!Array.isArray(values)||!values.length||values.some(value=>!SUPPORTED_SCOPES.has(value)))throw new ValidationError(
    'The configured Shopify permission request contains unsupported access.');
  return [...new Set([...SCOPES,...values])];
}

function missingScopes(granted,required) {
  const actual=new Set(granted);
  return required.filter(scope=>!actual.has(scope)&&!(scope.startsWith('read_')&&actual.has('write_'+scope.slice(5))));
}

async function grantedScopes(body,credentials) {
  if(typeof body.scope==='string'&&body.scope.trim())return [...new Set(body.scope.split(',').map(s=>s.trim()).filter(Boolean))];
  // A provider response without scopes is not evidence that our request
  // was granted. Read the installation instead of inventing capabilities.
  const data=await graphql(credentials,'query GrantedPermissions { currentAppInstallation { accessScopes { handle } } }');
  const scopes=data.currentAppInstallation?.accessScopes;
  if(!Array.isArray(scopes))throw new ValidationError('Shopify did not confirm the installed permissions.');
  return [...new Set(scopes.map(scope=>scope.handle))];
}

function metadata() {
  return { type: 'shopify', name: 'Shopify', mark: 'S', category: 'selling', authMode: 'oauth', available: config.connections.shopify.configured,
    description: 'Automatically receive Shopify orders, cancellations, fulfillment, returns, products, SKUs, and locations.',
    provides: ['customer orders', 'cancellations', 'fulfillment', 'returns', 'products, SKUs and locations'],
    unavailableReason: config.connections.shopify.configured ? null : 'StockChief’s Shopify app credentials have not been configured on this installation.',
  };
}

function normalizeShop(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const shop = raw.endsWith('.myshopify.com') ? raw : `${raw}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new ValidationError('Enter your Shopify store name or its myshopify.com address.');
  return shop;
}

function validateInput(input) {
  normalizeShop(input.shop);
}

function authorizationUrl({ state, input }) {
  if (!config.connections.shopify.configured) throw new ValidationError('Shopify is not configured on this StockChief installation.');
  const shop = normalizeShop(input.shop);
  const scopes = requestedScopes(shop);
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', config.connections.shopify.clientId);
  url.searchParams.set('scope', scopes.join(','));
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', state);
  return { url: url.toString(), metadata: { shop, redirectUri: input.redirectUri, requestedScopes:scopes } };
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
  if(!body.access_token)throw new ValidationError('Shopify did not return an access token.');
  const credential={ accessToken:body.access_token,shop,authMode:'client_credentials',accessTokenExpiresAt };
  return {
    credentials: credential,
    expiresAt: accessTokenExpiresAt,
    accountId: shop,
    accountName: shop.replace('.myshopify.com', ''),
    capabilities: await grantedScopes(body,credential),
  };
}

async function tryDirectAuthorization({ input }) {
  const shop = normalizeShop(input.shop);
  try {
    const result=await exchangeClientCredentials(shop);
    // Refreshing an old installation cannot approve new permissions.
    // Fall back to the merchant consent flow when its grant is incomplete.
    return missingScopes(result.capabilities,requestedScopes(shop)).length?null:result;
  }
  catch (error) {
    const raw = String(error.providerBody?.raw || '');
    const rawCode = raw.match(/oauth error\s+([a-z_]+)/i)?.[1];
    const providerCode = String(error.providerBody?.error || error.providerBody?.code || rawCode || '').toLowerCase();
    // A different organization's store must use the merchant approval flow.
    if (providerCode === 'shop_not_permitted') return null;
    if (providerCode === 'app_not_installed') {
      throw new ValidationError(`Shopify says StockChief Inventory is not installed on ${shop}. Install it from the Shopify Dev Dashboard—or uninstall and reinstall it—then try Connect Shopify again.`);
    }
    if (error instanceof TypeError && error.message === 'fetch failed') {
      throw new ValidationError('StockChief could not reach Shopify securely. Check the internet connection and try again.');
    }
    throw new ValidationError('Shopify did not authorize this connection. Check that the store address is correct and that StockChief has the client ID and secret for the installed app.');
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
  if(!body.access_token)throw new ValidationError('Shopify did not return an access token.');
  const credential={accessToken:body.access_token,shop},scopes=await grantedScopes(body,credential);
  if(missingScopes(scopes,stateMeta.requestedScopes||SCOPES).length)throw new ValidationError(
    'Shopify has not approved all requested permissions. Review the permission prompt for this store and try again.');
  return { credentials:credential,accountId:shop,
    accountName:shop.replace('.myshopify.com',''),capabilities:scopes };
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
        inventoryItem{id tracked inventoryLevels(first:250){nodes{
          location{id name isActive}
          quantities(names:["on_hand"]){name quantity}
        } pageInfo{hasNextPage endCursor}}}
      } pageInfo{hasNextPage endCursor}}
    }`, { after: cursor });
    currency = data.shop?.currencyCode || currency;
    for (const variant of data.productVariants.nodes) {
      const levels=variant.inventoryItem?.inventoryLevels;
      while(levels?.pageInfo?.hasNextPage){
        const next=await graphql(credentials,`query InventoryLevelPage($id:ID!,$after:String!){inventoryItem(id:$id){inventoryLevels(first:250,after:$after){nodes{location{id name isActive} quantities(names:["on_hand"]){name quantity}} pageInfo{hasNextPage endCursor}}}}`,
          {id:variant.inventoryItem.id,after:levels.pageInfo.endCursor});
        const page=next.inventoryItem.inventoryLevels;
        if(page.pageInfo.hasNextPage&&page.pageInfo.endCursor===levels.pageInfo.endCursor)throw new ValidationError('Shopify inventory pagination did not advance. No opening stock was imported.');
        levels.nodes.push(...page.nodes);levels.pageInfo=page.pageInfo;
      }
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
        inventoryItemId:variant.inventoryItem?.id||null,
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
    const data = await graphql(credentials, `query Locations($after:String){locations(first:100,after:$after,includeInactive:true,includeLegacy:true){nodes{id name isActive} pageInfo{hasNextPage endCursor}}}`, { after: cursor });
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
      inventoryItemId:variant.inventoryItemId,
      priceMoney: Number.isFinite(Number(variant.price))
        ? { amount: money.toMinor(variant.price, snapshot.currency), currency: snapshot.currency }
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
  const listed = await graphql(credentials, `query StockChiefWebhooks {
    webhookSubscriptions(first:250){nodes{id topic uri}}
  }`);
  const existing = listed.webhookSubscriptions?.nodes || [];
  const mutation = `mutation AddWebhook($topic:WebhookSubscriptionTopic!,$input:WebhookSubscriptionInput!){webhookSubscriptionCreate(topic:$topic,webhookSubscription:$input){userErrors{message} webhookSubscription{id}}}`;
  const results = [];
  for (const topic of topics) {
    const current = existing.find((hook) => hook.topic === topic && hook.uri === webhookUrl);
    if (current) {
      results.push({ topic, id: current.id, existing: true });
      continue;
    }
    const data = await graphql(credentials, mutation, { topic, input: { uri: webhookUrl, format: 'JSON' } });
    const errors = data.webhookSubscriptionCreate.userErrors || [];
    if (errors.length) results.push({ topic, error: errors.map((e) => e.message).join('; ') });
    else results.push({ topic, id: data.webhookSubscriptionCreate.webhookSubscription?.id });
  }
  if (!results.some((row) => row.error)) {
    const keep = new Set();
    const stale = existing.filter((hook) => {
      let managed = false;
      try { managed = /^\/api\/v1\/connections\/shopify\/webhooks\/[^/]+$/.test(new URL(hook.uri).pathname); }
      catch (_) { return false; }
      if (!managed) return false;
      const key = `${hook.topic}:${hook.uri}`;
      if (hook.uri === webhookUrl && !keep.has(key)) { keep.add(key); return false; }
      return true;
    });
    const remove = `mutation RemoveWebhook($id:ID!){webhookSubscriptionDelete(id:$id){deletedWebhookSubscriptionId userErrors{message}}}`;
    for (const hook of stale) {
      const data = await graphql(credentials, remove, { id: hook.id });
      const errors = data.webhookSubscriptionDelete.userErrors || [];
      results.push(errors.length
        ? { topic: hook.topic, error: errors.map((error) => error.message).join('; ') }
        : { topic: hook.topic, id: hook.id, removedStale: true });
    }
  }
  return results;
}

async function historySummary({ credentials, since }) {
  const query = `created_at:>=${since}`;
  const data = await graphql(credentials, `query HistoryCount($query:String!){ordersCount(query:$query,limit:10000){count precision}}`, { query });
  return { operationalRecords: Number(data.ordersCount?.count || 0), periodStart: since,
    detail: { precision: data.ordersCount?.precision || 'unknown' } };
}

function verifyWebhook({ headers, rawBody, credentials, connection }) {
  const provided = headers['x-shopify-hmac-sha256'];
  const expected = hmacBase64(config.connections.shopify.clientSecret, rawBody);
  requireVerified(safeEqual(provided, expected), 'This webhook did not pass Shopify signature verification.');
  const shop=credentials?.shop||connection?.provider_account_id;
  if(shop)requireVerified(normalizeShop(headers['x-shopify-shop-domain'])===normalizeShop(shop),'This webhook does not belong to the connected Shopify store.');
}

async function hydrateWebhook({headers,body,credentials,connection}){
 const shop=normalizeShop(credentials.shop);
 requireVerified(normalizeShop(headers['x-shopify-shop-domain'])===shop,'This webhook does not belong to the connected Shopify store.');
 if(connection.provider_account_id)requireVerified(normalizeShop(connection.provider_account_id)===shop,'The Shopify account identity changed. Reconnect before applying events.');
 const topic=String(headers['x-shopify-topic']||'').toLowerCase();
 let type;if(topic.startsWith('orders/'))type='Order';else if(topic.startsWith('fulfillments/'))type='Fulfillment';else if(topic==='refunds/create')type='Refund';else return;
 // The shared app HMAC alone does not prove that a record belongs to this
 // tenant. Resolve consequential record IDs using this store's own token.
 if(!body.id)throw new ValidationError('The Shopify event is missing its record identity.');
 const id=shopifyGid(type,body.id),data=await graphql(credentials,`query WebhookOwnership($id:ID!){node(id:$id){id ... on Fulfillment{order{id}} ... on Refund{order{id displayFinancialStatus}}}}`,{id});
 requireVerified(data.node?.id===id,'Shopify did not confirm this record in the connected store.');
 if(type!=='Order')requireVerified(data.node.order?.id===shopifyGid('Order',body.order_id),'Shopify did not confirm the event’s order identity.');
 if(type==='Refund')body._stockchiefOrderFinancialStatus=data.node.order.displayFinancialStatus||null;
}

function shopifyGid(type, value) {
  const id = String(value || '');
  if (!id || id.startsWith('gid://shopify/')) return id;
  return `gid://shopify/${type}/${id}`;
}

function normalizeWebhook({ headers, body }) {
  const topic = String(headers['x-shopify-topic'] || '').toLowerCase();
  const delivery = String(headers['x-shopify-webhook-id'] || headers['x-shopify-event-id'] || body.id);
  const occurredAt = headers['x-shopify-triggered-at'] || body.updated_at || body.created_at;
  const version = body.updated_at || occurredAt;
  if (topic === 'orders/create') return [{ eventId: delivery, effectKey: facts.effectKey('shopify','order-created',body.id), type: 'sales_order.created', version, occurredAt,
    aggregateId: String(body.id), data: { externalOrderId: String(body.id), orderNumber: body.name,
      customer: body.customer ? { externalId: String(body.customer.id), name: [body.customer.first_name, body.customer.last_name].filter(Boolean).join(' ') || body.customer.email } : undefined,
      shippingAddress: postalAddress({ line1: body.shipping_address?.address1, line2: body.shipping_address?.address2,
        city: body.shipping_address?.city, region: body.shipping_address?.province,
        postalCode: body.shipping_address?.zip, country: body.shipping_address?.country_code || body.shipping_address?.country }),
      customerEmail: body.email || body.customer?.email,
      externalLocationId: body.location_id ? shopifyGid('Location', body.location_id) : undefined,
      ...facts.shopify(body) } }];
  if (topic === 'orders/updated') return [{ eventId: delivery, effectKey: facts.effectKey('shopify','order-snapshot',body.id,version), type: 'sales_order.snapshot', version, occurredAt,
    aggregateId: String(body.id), data: { externalOrderId: String(body.id), ...facts.shopify(body) } }];
  if (topic === 'orders/cancelled') return [{ eventId: delivery, effectKey: facts.effectKey('shopify','order-cancelled',body.id), type: 'sales_order.cancelled', version, occurredAt,
    aggregateId: String(body.id), data: { externalOrderId: String(body.id), reason: body.cancel_reason || 'Cancelled in Shopify' } }];
  // Aggregate order notifications are not an additional physical shipment.
  // Per-fulfillment IDs below own the exact issue effect.
  if (topic === 'orders/fulfilled') return [{ eventId: delivery, effectKey: facts.effectKey('shopify','order-fulfilled-notice',body.id), type: 'fulfillment.reported', version, occurredAt,
    aggregateId: String(body.id), data: { externalOrderId: String(body.id), reference: 'Shopify order fulfillment notification' } }];
  if (topic === 'fulfillments/create') return [{ eventId: delivery, effectKey: facts.effectKey('shopify','fulfillment',body.id), type: 'sales_order.fulfilled', version, occurredAt,
    aggregateId: String(body.order_id), shipmentObservation: {
      externalFulfillmentId: String(body.id), externalOrderId: String(body.order_id),
      externalLocationId: body.location_id ? shopifyGid('Location', body.location_id) : undefined,
      carrier: body.tracking_company || null,
      trackingNumber: body.tracking_number || body.tracking_numbers?.[0] || null,
      trackingUrl: body.tracking_url || body.tracking_urls?.[0] || null,
    }, data: { externalOrderId: String(body.order_id), lines: (body.line_items || []).map((line) => ({
      externalSku: line.variant_id ? shopifyGid('ProductVariant', line.variant_id) : shopifyGid('Product', line.product_id),
      skuCode: line.sku || undefined, externalLineId: String(line.id),
      externalLocationId: body.location_id ? shopifyGid('Location', body.location_id) : undefined, quantity: Number(line.quantity),
    })) } }];
  // A refund/restock instruction is not physical receipt confirmation. In
  // particular restock_type=cancel only releases an unfulfilled commitment.
  if (topic === 'refunds/create') return (body.refund_line_items?.length?body.refund_line_items:[{}]).map((row, i) => ({
    eventId: `${delivery}:${i}`, effectKey: facts.effectKey('shopify','refund',body.id,row.id??row.line_item_id??i), type: 'return.reported', version, occurredAt,
    data: { externalSku: row.line_item?.variant_id ? shopifyGid('ProductVariant', row.line_item.variant_id)
      : shopifyGid('Product', row.line_item?.product_id), skuCode: row.line_item?.sku,
      externalLocationId: row.location_id ? shopifyGid('Location', row.location_id) : undefined, quantity: Number(row.quantity),
      externalOrderId: body.order_id==null?undefined:String(body.order_id), externalRefundId:String(body.id),
      restockType:row.restock_type||null,
      reason: `Shopify refund ${body.id} (${row.restock_type||'financial only'})` },
    observationProof:{noFinancialTransactions:Array.isArray(body.transactions)&&body.transactions.length===0,
      sourceOrderUnpaid:['PENDING','VOIDED','EXPIRED'].includes(body._stockchiefOrderFinancialStatus)},
  }));
  if (topic.startsWith('products/')) return [{ eventId: delivery, type: 'product.changed', version, occurredAt,
    data: { externalProductId: shopifyGid('Product', body.id), name: body.title, variants: body.variants || [] } }];
  if (topic.startsWith('locations/')) return [{ eventId: delivery, type: 'location.changed', version, occurredAt,
    data: { externalLocationId: shopifyGid('Location', body.id), name: body.name } }];
  if (topic === 'app/uninstalled') return [];
  throw new ValidationError(`Shopify topic ${topic || '(missing)'} is not supported.`);
}

module.exports = { catalogueCapabilities:Object.freeze(['products','skus','stock','locations']), metadata, normalizeShop, validateInput, authorizationUrl, tryDirectAuthorization, refreshCredentials,
  verifyOAuthQuery, exchangeAuthorization, discover, bootstrapSnapshot, registerWebhooks, historySummary, verifyWebhook,
  normalizeWebhook, hydrateWebhook, graphql, API_VERSION };
