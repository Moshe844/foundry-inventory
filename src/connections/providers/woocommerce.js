'use strict';

const crypto = require('node:crypto');
const { ValidationError } = require('../../domain/errors');
const { safeEqual, hmacBase64, requireVerified, normalizeStoreUrl, jsonRequest } = require('./common');

function metadata() {
  return { type: 'woocommerce', name: 'WooCommerce', mark: 'Woo', category: 'selling', authMode: 'application_auth', available: true,
    description: 'Connect a WooCommerce store without scripts. Foundry discovers products and receives order webhooks automatically.',
    provides: ['customer orders', 'cancellations', 'fulfillment', 'products and store activity'],
  };
}

function authorizationUrl({ state, input }) {
  const storeUrl = normalizeStoreUrl(input.storeUrl);
  const url = new URL(`${storeUrl}/wc-auth/v1/authorize`);
  url.searchParams.set('app_name', 'Foundry Inventory');
  url.searchParams.set('scope', 'read_write');
  url.searchParams.set('user_id', state);
  url.searchParams.set('return_url', input.returnUri);
  url.searchParams.set('callback_url', input.callbackUri);
  return { url: url.toString(), metadata: { storeUrl } };
}

function credentialsFromCallback(body, metadata) {
  if (!body.consumer_key || !body.consumer_secret) throw new ValidationError('WooCommerce did not provide usable API credentials.');
  return { consumerKey: body.consumer_key, consumerSecret: body.consumer_secret, storeUrl: metadata.storeUrl,
    webhookSecret: crypto.randomBytes(32).toString('base64url') };
}

async function api(credentials, path, options = {}) {
  const auth = Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString('base64');
  return jsonRequest(`${credentials.storeUrl}/wp-json/wc/v3${path}`, { ...options,
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json', ...(options.headers || {}) } });
}

async function discover({ credentials }) {
  const products = [];
  for (let page = 1; ; page += 1) {
    const response = await api(credentials, `/products?per_page=100&page=${page}`);
    const rows = response.body || [];
    for (const product of rows) {
      if (product.type === 'variable' && product.variations?.length) {
        for (let variantPage = 1; ; variantPage += 1) {
          const variantsResponse = await api(credentials, `/products/${product.id}/variations?per_page=100&page=${variantPage}`);
          const variants = variantsResponse.body || [];
          for (const variant of variants) products.push({ entityType: 'sku', externalId: String(variant.id),
            parentExternalId: String(product.id), code: variant.sku || null,
            displayName: `${product.name}${variant.attributes?.length ? ` / ${variant.attributes.map((a) => a.option).join(' / ')}` : ''}`,
            providerData: { status: variant.status, itemName: product.name,
              variationName: variant.attributes?.map((a) => a.option).join(' / ') || null,
              priceMoney: String(variant.price ?? '').trim() && Number.isFinite(Number(variant.price))
                ? { amount: Math.round(Number(variant.price) * 100), currency: product.currency || 'USD' }
                : null,
              inventoryCounts: variant.manage_stock && Number.isInteger(Number(variant.stock_quantity))
                ? [{ externalLocationId: credentials.storeUrl, state: 'IN_STOCK', quantity: Number(variant.stock_quantity) }]
                : [] } });
          const variantPages = Number(variantsResponse.headers.get('x-wp-totalpages') || 1);
          if (variantPage >= variantPages) break;
        }
      } else products.push({ entityType: 'sku', externalId: String(product.id), code: product.sku || null,
        displayName: product.name, providerData: { status: product.status, itemName: product.name,
          variationName: null,
          priceMoney: String(product.price ?? '').trim() && Number.isFinite(Number(product.price))
            ? { amount: Math.round(Number(product.price) * 100), currency: product.currency || 'USD' }
            : null,
          inventoryCounts: product.manage_stock && Number.isInteger(Number(product.stock_quantity))
            ? [{ externalLocationId: credentials.storeUrl, state: 'IN_STOCK', quantity: Number(product.stock_quantity) }]
            : [] } });
    }
    const pages = Number(response.headers.get('x-wp-totalpages') || 1);
    if (page >= pages) break;
  }
  return { products, locations: [{ entityType: 'location', externalId: credentials.storeUrl,
    displayName: new URL(credentials.storeUrl).hostname, providerData: { kind: 'online_store' } }] };
}

async function registerWebhooks({ credentials, webhookUrl }) {
  const topics = ['order.created', 'order.updated', 'order.deleted', 'product.created', 'product.updated'];
  const existing = [];
  for (let page = 1; ; page += 1) {
    const response = await api(credentials, `/webhooks?per_page=100&page=${page}`);
    existing.push(...(response.body || []));
    if (page >= Number(response.headers.get('x-wp-totalpages') || 1)) break;
  }
  const results = [];
  for (const topic of topics) {
    const current = existing.find((hook) => hook.topic === topic && hook.delivery_url === webhookUrl);
    const payload = { name: `Foundry ${topic}`, topic, delivery_url: webhookUrl,
      secret: credentials.webhookSecret, status: 'active' };
    const { body } = current
      ? await api(credentials, `/webhooks/${current.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await api(credentials, '/webhooks', { method: 'POST', body: JSON.stringify(payload) });
    results.push({ topic, id: body.id });
  }
  return results;
}

async function historySummary({ credentials, since }) {
  const response = await api(credentials, `/orders?after=${encodeURIComponent(since)}&per_page=1`);
  return { operationalRecords: Number(response.headers.get('x-wp-total') || (response.body || []).length), periodStart: since };
}

function verifyWebhook({ headers, rawBody, credentials }) {
  const expected = hmacBase64(credentials.webhookSecret, rawBody);
  requireVerified(safeEqual(headers['x-wc-webhook-signature'], expected), 'This webhook did not pass WooCommerce signature verification.');
}

function lines(order) {
  return (order.line_items || []).filter((line) => Number(line.quantity) > 0).map((line) => ({
    externalSku: String(line.variation_id || line.product_id), skuCode: line.sku || undefined,
    quantity: Number(line.quantity), unitPriceMinor: line.price ? Math.round(Number(line.price) * 100) : undefined,
  }));
}

function normalizeWebhook({ headers, body, connection }) {
  const topic = String(headers['x-wc-webhook-topic'] || `${headers['x-wc-webhook-resource']}.${headers['x-wc-webhook-event']}`).toLowerCase();
  const delivery = String(headers['x-wc-webhook-delivery-id'] || headers['x-wc-delivery-id'] || `${topic}:${body.id}:${body.date_modified_gmt || body.date_created_gmt}`);
  const occurredAt = body.date_modified_gmt || body.date_created_gmt;
  const version = occurredAt;
  const orderData = { externalOrderId: String(body.id), orderNumber: body.number,
      customer: { externalId: body.customer_id ? String(body.customer_id) : undefined,
        name: [body.billing?.first_name, body.billing?.last_name].filter(Boolean).join(' ') || body.billing?.email || 'WooCommerce customer' },
      externalLocationId: connection?.config?.storeUrl || undefined, currency: body.currency, lines: lines(body) };
  const event = (suffix, type, data = orderData) => ({ eventId: `${delivery}:${suffix}`, type, version, occurredAt,
    aggregateId: String(body.id), data });
  if (topic === 'order.created') {
    const created = event('created', 'sales_order.created');
    if (body.status === 'completed') return [created, event('fulfilled', 'sales_order.fulfilled', orderData)];
    if (['cancelled', 'failed'].includes(body.status)) return [created, event('cancelled', 'sales_order.cancelled', {
      externalOrderId: String(body.id), reason: `WooCommerce status: ${body.status}` })];
    return [created];
  }
  if (topic === 'order.updated') {
    if (body.status === 'completed') return [event('snapshot', 'sales_order.snapshot'),
      event('fulfilled', 'sales_order.fulfilled', orderData)];
    if (['cancelled', 'failed'].includes(body.status)) return [event('cancelled', 'sales_order.cancelled', {
      externalOrderId: String(body.id), reason: `WooCommerce status: ${body.status}` })];
    if (body.status === 'refunded') {
      const refunds = Array.isArray(body.refunds) && body.refunds.length ? body.refunds : [{ id: `order-${body.id}` }];
      const reported = refunds.map((refund) => event(`refund-${refund.id}`, 'return.reported', {
        externalOrderId: String(body.id), refundId: String(refund.id), amountMinor: refund.total
          ? Math.round(Math.abs(Number(refund.total)) * 100) : undefined,
        reason: refund.reason || 'WooCommerce reported a financial refund; physical stock requires confirmation.',
      }));
      return body.date_completed_gmt ? reported : [event('cancelled', 'sales_order.cancelled', {
        externalOrderId: String(body.id), reason: 'WooCommerce order refunded before fulfillment' }), ...reported];
    }
    if (['pending', 'processing', 'on-hold'].includes(body.status)) return [event('snapshot', 'sales_order.snapshot')];
    return [];
  }
  if (topic === 'order.deleted') return [{ eventId: `${delivery}:cancelled`, type: 'sales_order.cancelled', version, occurredAt,
    aggregateId: String(body.id), data: { externalOrderId: String(body.id), reason: 'Deleted in WooCommerce' } }];
  if (topic.startsWith('product.')) return [{ eventId: `${delivery}:product`, type: 'product.changed', version, occurredAt,
    data: { externalProductId: String(body.id), name: body.name, sku: body.sku } }];
  throw new ValidationError(`WooCommerce topic ${topic || '(missing)'} is not supported.`);
}

module.exports = { metadata, authorizationUrl, credentialsFromCallback, discover, registerWebhooks,
  historySummary, verifyWebhook, normalizeWebhook, api };
