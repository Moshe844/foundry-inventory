'use strict';

const crypto = require('node:crypto');
const config = require('../../config');
const { ValidationError } = require('../../domain/errors');
const { safeEqual, requireVerified, jsonRequest, postalAddress } = require('./common');
const facts=require('../commerce-facts');

const API_VERSION = '2026-08-19';
const SCOPES = ['ITEMS_READ', 'ORDERS_READ', 'PAYMENTS_READ', 'MERCHANT_PROFILE_READ', 'INVENTORY_READ','ITEMS_WRITE','INVENTORY_WRITE'];
const WEBHOOK_EVENTS = ['payment.created', 'payment.updated', 'refund.created', 'refund.updated','order.created','order.updated','order.fulfillment.updated',
  'catalog.version.updated', 'inventory.count.updated', 'location.created', 'location.updated'];

function base() { return config.connections.square.environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'; }
function oauthConfigured() { return Boolean(config.connections.square.applicationId && config.connections.square.applicationSecret); }
const oauthUnavailableReason='Square sign-in has not been configured on this StockChief installation. Your administrator must complete the secure connection setup.';
function assertOAuthConfigured() { if(!oauthConfigured())throw new ValidationError(oauthUnavailableReason); }
function metadata({oauthOnly=false}={}) {
  // The legacy local sandbox can use a personal token directly. A server-side
  // OAuth connection always requires both application credentials; a personal
  // API token cannot stand in for the secret in the authorization-code flow.
  const available=oauthOnly?oauthConfigured():config.connections.square.configured;
  return { type: 'square', name: 'Square', mark: '□', category: 'selling', authMode: 'oauth', available,
    description: 'Automatically import and keep mapping Square products, variants, prices, inventory and business locations, then receive completed sales and returns.',
    provides: ['completed POS sales', 'returns', 'catalog SKUs and locations'],
    // Square is a source of real business evidence, not a suggestion list.
    // An external id is durable, so a new Square record can safely become a
    // StockChief record once; later discovery maps back to that same record.
    catalogImportMode: 'automatic',
    sandboxMode: config.connections.square.environment === 'sandbox',
    authorizationPrerequisite:config.connections.square.environment==='sandbox'?{
      message:'Before connecting, launch a seller test account from the Square Developer Console and keep it open in this browser. Square Sandbox requires that signed-in seller session; otherwise its authorization window may appear blank.',
      label:'Open Square Developer Console',href:'https://developer.squareup.com/apps'}:null,
    unavailableReason: available ? null : oauthUnavailableReason,
  };
}

function authorizationUrl({ state, input }) {
  assertOAuthConfigured();
  const url = new URL(`${base()}/oauth2/authorize`);
  url.searchParams.set('client_id', config.connections.square.applicationId);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri',input.redirectUri);
  url.searchParams.set('session', config.connections.square.environment === 'production' ? 'false' : 'true');
  return { url: url.toString(), metadata: { redirectUri: input.redirectUri } };
}

async function tryDirectAuthorization() {
  if (config.connections.square.environment !== 'sandbox' || !config.connections.square.sandboxAccessToken) return null;
  const credentials = { accessToken: config.connections.square.sandboxAccessToken,
    environment: 'sandbox', authMode: 'sandbox_personal' };
  const merchant = (await api(credentials, '/v2/merchants/me')).body.merchant;
  if (!merchant?.id) throw new ValidationError('Square did not return a Sandbox merchant for this access token.');
  credentials.merchantId=merchant.id;
  return { credentials, accountId: merchant.id,
    accountName: merchant.business_name || `Square merchant ${String(merchant.id).slice(-6)}`,
    capabilities: [...SCOPES, 'WEBHOOKS'] };
}

async function exchangeAuthorization({ query,metadata={} }) {
  if (query.error) throw new ValidationError(query.error_description || 'Square authorization was not completed.');
  assertOAuthConfigured();
  const { body } = await jsonRequest(`${base()}/oauth2/token`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'square-version': API_VERSION }, body: JSON.stringify({
      client_id: config.connections.square.applicationId, client_secret: config.connections.square.applicationSecret,
      code: query.code, grant_type: 'authorization_code',
      ...(metadata.redirectUri?{redirect_uri:metadata.redirectUri}:{}),
    }) });
  const credentials={accessToken:body.access_token,refreshToken:body.refresh_token,
    merchantId:body.merchant_id,expiresAt:body.expires_at,environment:config.connections.square.environment};
  const granted=(await api(credentials,'/oauth2/token/status',{method:'POST'})).body;
  requireVerified(granted.merchant_id===body.merchant_id&&granted.client_id===config.connections.square.applicationId,
    'Square did not verify the authorized merchant and application.');
  return { credentials,
    accountId: body.merchant_id, accountName: `Square merchant ${String(body.merchant_id).slice(-6)}`,
    capabilities: Array.isArray(granted.scopes)?granted.scopes:[], expiresAt: body.expires_at };
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
  // Square accepts at most 1,000 catalog IDs and paginates the resulting
  // location counts independently. Never silently omit a later store or SKU.
  for (let offset=0;offset<variations.length;offset+=1000) {
    const ids=variations.slice(offset,offset+1000).map(variation=>variation.id);
    let countCursor=null;const seen=new Set();
    do {
      const page=(await api(credentials, '/v2/inventory/counts/batch-retrieve', { method: 'POST',
        body: JSON.stringify({catalog_object_ids:ids,states:['IN_STOCK'],limit:1000,...(countCursor?{cursor:countCursor}:{})}) })).body;
      for (const count of page.counts||[]) {
      const rows = countsByVariation.get(count.catalog_object_id) || [];
      rows.push({ externalLocationId: count.location_id, state: count.state, quantity: count.quantity,
        calculatedAt: count.calculated_at });
      countsByVariation.set(count.catalog_object_id, rows);
      }
      countCursor=page.cursor||null;
      if(countCursor&&seen.has(countCursor))throw new ValidationError('Square inventory pagination did not advance. No stock was assumed for missing pages.');
      if(countCursor)seen.add(countCursor);
    }while(countCursor);
  }
  const products = variations.map((variation) => ({ entityType: 'sku',
    externalId: variation.id, parentExternalId: variation.item_variation_data?.item_id,
    code: variation.item_variation_data?.sku || null,
    displayName: `${itemNames.get(variation.item_variation_data?.item_id) || 'Square item'}${variation.item_variation_data?.name ? ` / ${variation.item_variation_data.name}` : ''}`,
    providerData: { version: variation.version,
      itemName: itemNames.get(variation.item_variation_data?.item_id) || 'Square item',
      variationName: variation.item_variation_data?.name || null,
      barcode: variation.item_variation_data?.upc || null,
      trackInventory: !!variation.item_variation_data?.track_inventory,
      priceMoney: variation.item_variation_data?.price_money || null,
      locationPriceOverrides:variation.item_variation_data?.location_overrides||[],
      inventoryCounts: countsByVariation.get(variation.id) || [] },
  }));
  return { products, locations };
}

async function registerWebhooks({ credentials, webhookUrl }) {
  // Subscriptions belong to the application. Merchant OAuth must still own
  // every business read/write; it cannot administer application subscriptions.
  let management=credentials;
  if(credentials.authMode!=='sandbox_personal'){
    if(credentials.environment!=='sandbox'||!config.connections.square.sandboxAccessToken){
      if(credentials.webhookSignatureKey||config.connections.square.webhookSignatureKey)
        return {credentials,externallyConfigured:true};
      throw new ValidationError('Square event delivery needs an application-owned webhook subscription. Configure its notification URL and signature key before relying on automatic updates.');
    }
    management={environment:'sandbox',accessToken:config.connections.square.sandboxAccessToken};
    const owner=(await api(management,'/oauth2/token/status',{method:'POST'})).body;
    const merchant=(await api(credentials,'/oauth2/token/status',{method:'POST'})).body;
    requireVerified(config.connections.square.environment==='sandbox'
      &&owner.client_id===config.connections.square.applicationId
      &&merchant.client_id===owner.client_id&&merchant.merchant_id===credentials.merchantId,
    'Square webhook administration and merchant authorization must belong to the same application.');
  }
  const subscriptions=[];let cursor;
  do{
    const query=new URLSearchParams({include_disabled:'true',limit:'100'});if(cursor)query.set('cursor',cursor);
    const page=(await api(management,'/v2/webhooks/subscriptions?'+query)).body;
    subscriptions.push(...(page.subscriptions||[]));cursor=page.cursor;
  }while(cursor);
  const existing = subscriptions.find((subscription) => subscription.notification_url === webhookUrl);
  const subscription = { name: 'StockChief inventory events', enabled: true,
    event_types: WEBHOOK_EVENTS, notification_url: webhookUrl, api_version: API_VERSION };
  const response = existing
    ? await api(management, `/v2/webhooks/subscriptions/${encodeURIComponent(existing.id)}`, {
      method: 'PUT', body: JSON.stringify({ subscription }) })
    : await api(management, '/v2/webhooks/subscriptions', { method: 'POST',
      body: JSON.stringify({ idempotency_key: crypto.createHash('sha256').update(webhookUrl).digest('hex').slice(0,45), subscription }) });
  let saved = response.body.subscription;
  if(saved?.id&&!saved.signature_key)saved=(await api(management,`/v2/webhooks/subscriptions/${encodeURIComponent(saved.id)}`)).body.subscription;
  requireVerified(saved?.notification_url===webhookUrl&&saved.enabled===true
    &&WEBHOOK_EVENTS.every(type=>saved.event_types?.includes(type)),
  'Square did not confirm the requested webhook destination and event scope.');
  if (!saved?.signature_key) throw new ValidationError('Square created the webhook but did not return its signature key.');
  return { credentials: { ...credentials, webhookSignatureKey: saved.signature_key,webhookSubscriptionId:saved.id }, subscriptionId: saved.id };
}

function verifyWebhook({ headers, rawBody, webhookUrl, credentials, connection, body }) {
  const key = credentials.webhookSignatureKey || config.connections.square.webhookSignatureKey;
  if (!key) throw new ValidationError('Square webhook verification is not configured for this StockChief installation.');
  const expected = crypto.createHmac('sha256', key).update(`${webhookUrl}${rawBody.toString('utf8')}`).digest('base64');
  requireVerified(safeEqual(headers['x-square-hmacsha256-signature'], expected), 'This webhook did not pass Square signature verification.');
  const merchantId=credentials.merchantId||connection?.provider_account_id;
  if(merchantId)requireVerified(body?.merchant_id===merchantId,'This Square event does not belong to the connected merchant.');
}

async function createSandboxCheckout({ credentials, externalSku, externalLocationId, quantity }) {
  if (credentials.environment !== 'sandbox') {
    throw new ValidationError('Sandbox checkout links are only available for a Square Sandbox connection.');
  }
  const result = await api(credentials, '/v2/online-checkout/payment-links', { method: 'POST',
    body: JSON.stringify({ idempotency_key: crypto.randomUUID(),
      description: 'StockChief connector end-to-end Sandbox test',
      order: { location_id: externalLocationId,
        line_items: [{ catalog_object_id: externalSku, quantity: String(quantity) }] },
      checkout_options: { allow_tipping: false },
      payment_note: 'StockChief connector customer-operated Sandbox test',
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
    requireVerified(order?.id===payment.order_id&&order.location_id===payment.location_id,'Square payment and order identities disagree.');
    return [...orderEvents(order,eventId,occurredAt),{eventId:eventId+':payment',effectKey:facts.effectKey('square','payment',payment.id),type:'payment.reported',
      aggregateId:order.id,occurredAt:payment.created_at||occurredAt,data:{externalOrderId:order.id,externalPaymentId:payment.id,amountMinor:payment.amount_money?.amount,currency:payment.amount_money?.currency}}];
  }
  if(type.startsWith('order.')){
    const externalId=body.data?.object?.order_created?.order_id||body.data?.object?.order_updated?.order_id||body.data?.object?.order_fulfillment_updated?.order_id;
    if(!externalId)throw new ValidationError('The Square order notification is missing its order identity.');
    const order=(await api(credentials,'/v2/orders/'+encodeURIComponent(externalId))).body.order;
    requireVerified(order?.id===externalId,'Square did not confirm that order.');
    return orderEvents(order,eventId,occurredAt);
  }
  if(type==='inventory.count.updated')return [{eventId,type:'product.changed',occurredAt,
    data:{inventoryCountChanged:true}}];
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
function orderEvents(order,delivery,at){
 const occurredAt=order.updated_at||order.created_at||at,version=String(order.version||occurredAt||'');
 if(!order.id||!version)throw new ValidationError('The Square order is missing a durable identity or version.');
 if(order.state==='CANCELED')return [{eventId:delivery+':cancel',effectKey:facts.effectKey('square','order-cancel',order.id),type:'sales_order.cancelled',aggregateId:order.id,version,occurredAt,data:{externalOrderId:order.id,reason:'Cancelled in Square'}}];
 if(!order.line_items?.length)return [{eventId:delivery+':notice',effectKey:facts.effectKey('square','order-notice',order.id,version),type:'fulfillment.reported',aggregateId:order.id,version,occurredAt,data:{externalOrderId:order.id,reference:'Square order contains no supported inventory lines'}}];
 const fulfillments=order.fulfillments||[],methods=[...new Set(fulfillments.map(f=>({PICKUP:'PICKUP',IN_STORE:'PICKUP',SHIPMENT:'SHIP',DELIVERY:'DELIVERY'})[f.type]))];
 if(methods.includes(undefined)||methods.length>1)throw new ValidationError('This Square order has unsupported or mixed fulfillment destinations. Reconcile its fulfillment scope before posting.');
 const deliveryMethod=methods[0]||'PICKUP',recipient=fulfillments[0]?.shipment_details?.recipient||fulfillments[0]?.delivery_details?.recipient||fulfillments[0]?.pickup_details?.recipient,address=recipient?.address||{};
 const shippingAddress=postalAddress({line1:address.address_line_1,line2:address.address_line_2,city:address.locality,region:address.administrative_district_level_1,postalCode:address.postal_code,country:address.country});
 const data={externalOrderId:order.id,orderNumber:order.reference_id||undefined,sourceSnapshotComplete:true,externalLocationId:order.location_id,deliveryMethod,shippingAddress,customerEmail:recipient?.email_address,
  customer:{externalId:order.customer_id||undefined,name:recipient?.display_name||(order.customer_id?'Square customer '+order.customer_id:'Square counter customer')},...facts.square(order)};
 const events=[{eventId:delivery+':order',effectKey:facts.effectKey('square','order-snapshot',order.id,version),type:'sales_order.snapshot',aggregateId:order.id,version,occurredAt,data}];
 // Payment is not handoff. Only a completed provider order with completed
 // fulfillments can own the physical issue; every tender shares this identity.
 if(order.state==='COMPLETED'&&(order.fulfillments||[]).every(f=>f.state==='COMPLETED'))events.push({eventId:delivery+':fulfilled',effectKey:facts.effectKey('square','order-fulfilled',order.id),type:'sales_order.fulfilled',aggregateId:order.id,version,occurredAt,data:{externalOrderId:order.id,fulfillmentMode:'cumulative',lines:data.lines.map(l=>({externalLineId:l.externalLineId,externalSku:l.externalSku,quantity:l.quantity,externalLocationId:order.location_id}))}});
 return events;
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

module.exports = { catalogueCapabilities:Object.freeze(['products','skus','stock','locations']), metadata, authorizationUrl, tryDirectAuthorization, exchangeAuthorization, discover,
  registerWebhooks, verifyWebhook, normalizeWebhook, createSandboxCheckout, historySummary, api, orderEvents, API_VERSION };
Object.assign(module.exports,require('./commerce-position').adapter('square',{api}));
