'use strict';

process.env.SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || 'ui-certification-client';
process.env.SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || 'ui-certification-shopify-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const { fakeProvider } = require('../helpers/fake-provider');
const inventory = require('../../src/domain/inventory-engine');
const repository = require('../../src/domain/repository');
const prices = require('../../src/pricing/price-service');
const sales = require('../../src/sales/sales-order-service');
const connections = require('../../src/connections/service');
const credentials = require('../../src/connections/credentials');
const providerService = require('../../src/connections/provider-service');
const paymentProviders = require('../../src/payments/provider');
const paymentAccounts = require('../../src/payments/accounts');
const accounting = require('../../src/accounting/automatic');
const config = require('../../src/config');

test.after(cleanupAll);

function addProvider(db, workspace, type, configValue = {}) {
  const id = `con_${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workspace_connectors
    (id, workspace_id, connector_key, display_name, provider_type, status, capabilities, provides, config,
     expected_interval_minutes, setup_status, authorized_by_user_id, provider_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'connected', '[]', '[]', ?, 360, 'CONNECTED', ?, ?, ?, ?)`)
    .run(id, workspace.workspaceId, `${type}:${id}`, type === 'shopify' ? 'Shopify Store' : 'Square POS',
      type, JSON.stringify(configValue), workspace.ownerId, `${type}-account`, now, now);
  return connections.get(db, workspace.workspaceId, id);
}

function hmac(secret, raw) {
  return crypto.createHmac('sha256', secret).update(raw).digest('base64');
}

async function submit(page, button) {
  await Promise.all([page.waitForNavigation(), button.click()]);
}

async function signIn(page, base, workspace) {
  await page.goto(`${base}/login`);
  await page.getByLabel('Email', { exact:true }).fill(workspace.account.email);
  await page.getByLabel('Password', { exact:true }).fill(workspace.account.password);
  await submit(page, page.getByRole('button', { name:'Sign in', exact:true }));
}

test('signed commerce and payment webhooks remain exactly-once and visible in the UI', { timeout:120000 }, async (context) => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName:'UI Webhook Certification' });
  const item = makeQuantityItem(store.db, workspace.ctx, { name:'Webhook Widget', baseCode:'WEBHOOK-1' });
  prices.setPrice(store.db, workspace.ctx, { skuId:item.skuId, amount:'30.00', currency:'USD' });
  inventory.receive(store.db, workspace.ctx, { skuId:item.skuId, locationId:workspace.store.id, quantity:50 });
  accounting.ensure(store.db, workspace.workspaceId, { actorId:workspace.ownerId });

  const shopify = addProvider(store.db, workspace, 'shopify', { shop:'ui-certification.myshopify.com' });
  credentials.put(store.db, workspace.workspaceId, shopify.id, 'provider', {
    shop:'ui-certification.myshopify.com', accessToken:'encrypted-token',
  });
  connections.mapExternal(store.db, workspace.ctx, shopify.id, {
    entityType:'sku', externalId:'gid://shopify/ProductVariant/1001', foundryRecordId:item.skuId,
  });
  connections.mapExternal(store.db, workspace.ctx, shopify.id, {
    entityType:'location', externalId:'gid://shopify/Location/2001', foundryRecordId:workspace.store.id,
  });

  const square = addProvider(store.db, workspace, 'square');
  const squareSignatureKey = 'ui-square-signature-key';
  credentials.put(store.db, workspace.workspaceId, square.id, 'provider', {
    environment:'sandbox', accessToken:'encrypted-token', webhookSignatureKey:squareSignatureKey,
  });
  connections.mapExternal(store.db, workspace.ctx, square.id, {
    entityType:'sku', externalId:'square-variation-1', foundryRecordId:item.skuId,
  });
  connections.mapExternal(store.db, workspace.ctx, square.id, {
    entityType:'location', externalId:'square-location-1', foundryRecordId:workspace.store.id,
  });

  const originalStripe = paymentProviders.get('stripe');
  paymentProviders.register('stripe', {
    async createCustomer() { return { externalCustomerId:'cus_ui_certification' }; },
    async createInvoice(_ctx, input) {
      return { externalInvoiceId:`in_${input.attemptId}`, hostedUrl:`https://pay.example.test/${input.attemptId}` };
    },
    async getHostedPaymentUrl() { return 'https://pay.example.test/current'; },
    async refundPayment() { return { externalRefundId:'re_ui_certification' }; },
    verifyEvent(raw) { return JSON.parse(String(raw)); },
    readEvent(event) { return event.normalized; },
  });
  paymentAccounts.connect(store.db, workspace.ctx, { role:'owner' }, {
    secretKey:'sk_test_ui_certification', webhookSecret:'whsec_ui_certification',
  });

  const app = createApp({ db:store.db, env:'test', sessionSecret:'ui-webhook-certification', aiProvider:fakeProvider({}) });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless:process.env.UI_VISIBLE !== '1' });
  const browserContext = await browser.newContext({ viewport:{ width:1440, height:1000 } });
  await browserContext.route('https://pay.example.test/**', (route) => route.fulfill({
    contentType:'text/html', body:'<title>Provider-hosted checkout</title><p>Test checkout</p>',
  }));
  const page = await browserContext.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  context.after(async () => {
    paymentProviders.register('stripe', originalStripe);
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await signIn(page, base, workspace);

  await context.test('a signed Shopify order is committed once and appears as a real customer order', async () => {
    const body = {
      id:91001, name:'#UI-1001', currency:'USD', location_id:2001, created_at:'2026-09-22T12:00:00Z',
      customer:{ id:77, first_name:'Shopify', last_name:'Buyer', email:'shopify-buyer@example.test' },
      shipping_address:{ address1:'7 Example Lane', city:'Albany', province:'NY', zip:'12207', country_code:'US' },
      line_items:[{ variant_id:1001, sku:'WEBHOOK-1', quantity:3, price:'30.00' }],
    };
    const raw = JSON.stringify(body);
    const endpoint = `/api/v1/connections/shopify/webhooks/${shopify.id}`;
    const headers = {
      'content-type':'application/json', 'x-shopify-topic':'orders/create',
      'x-shopify-webhook-id':'ui-shopify-delivery-1',
      'x-shopify-hmac-sha256':hmac(config.connections.shopify.clientSecret, raw),
    };
    const first = await page.request.post(`${base}${endpoint}`, { data:raw, headers });
    assert.equal(first.status(), 200);
    assert.equal((await first.json()).accepted, 1);
    const replay = await page.request.post(`${base}${endpoint}`, { data:raw, headers });
    assert.equal((await replay.json()).replayed, 1);
    const mapping = connections.mapping(store.db, workspace.workspaceId, shopify.id, 'sales_order', '91001');
    const order = sales.getOrder(store.db, workspace.workspaceId, mapping.foundry_record_id);
    assert.equal(order.totals.allocated, 3);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.store.id), 50);
    await page.goto(`${base}/orders/${order.id}`);
    const text = await page.locator('main').innerText();
    assert.match(text, /Shopify Buyer/);
    assert.match(text, /3\s+committed to this customer/i);
    await submit(page, page.getByRole('button', { name:'Start picking 3 units', exact:true }));
    assert.match(await page.locator('main').innerText(), /7 Example Lane/);
  });

  await context.test('Square payment lifecycle events issue stock once and the completed sale is visible', async () => {
    const endpoint = `/api/v1/connections/square/webhooks/${square.id}`;
    const send = async (eventId) => {
      const body = { event_id:eventId, type:'payment.updated', created_at:'2026-09-22T13:00:00Z',
        merchant_id:'square-account', data:{ object:{ payment:{ id:'square-payment-1', status:'COMPLETED',
          order_id:'square-order-1', location_id:'square-location-1', created_at:'2026-09-22T13:00:00Z',
          updated_at:'2026-09-22T13:00:00Z' }, order:{ id:'square-order-1', location_id:'square-location-1',
          line_items:[{ catalog_object_id:'square-variation-1', quantity:'2',
            base_price_money:{ amount:3000, currency:'USD' } }] } } } };
      const raw = JSON.stringify(body);
      const webhookUrl = `${providerService.providerOrigin(base)}${endpoint}`;
      const signature = crypto.createHmac('sha256', squareSignatureKey).update(`${webhookUrl}${raw}`).digest('base64');
      return page.request.post(`${base}${endpoint}`, { data:raw, headers:{
        'content-type':'application/json', 'x-square-hmacsha256-signature':signature,
      } });
    };
    assert.equal((await (await send('ui-square-delivery-1')).json()).accepted, 1);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.store.id), 48);
    assert.equal((await (await send('ui-square-delivery-2')).json()).replayed, 1);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.store.id), 48);
    await page.goto(`${base}/sales`);
    const text = await page.locator('main').innerText();
    assert.match(text, /Completed sales/i);
    assert.match(text, /Square POS/i);
    assert.match(text, /2 units/i);
  });

  await context.test('two Stripe lifecycle webhooks for one cumulative payment record money once', async () => {
    const customer = sales.createCustomer(store.db, workspace.ctx, {
      name:'Stripe Certification Customer', email:'stripe-cert@example.test',
    });
    const order = sales.confirm(store.db, workspace.ctx, sales.createOrder(store.db, workspace.ctx, {
      customerId:customer.id, deliveryMethod:'PICKUP', fulfillmentLocationId:workspace.main.id,
      lines:[{ skuId:item.skuId, quantity:2 }],
    }).id);
    await page.goto(`${base}/orders/${order.id}#money`);
    const popupPromise = browserContext.waitForEvent('page');
    await page.getByRole('button', { name:/Take \$60\.00 now/ }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    await popup.close();
    const request = store.db.prepare(`SELECT * FROM payment_requests WHERE workspace_id = ?
      AND sales_order_id = ? ORDER BY created_at DESC LIMIT 1`).get(workspace.workspaceId, order.id);
    assert.ok(request);
    const event = (id) => ({ id, normalized:{ kind:'PAID', externalInvoiceId:request.external_invoice_id,
      externalPaymentId:'pi_ui_one_payment', amountMinor:6000, currency:'USD', method:'card',
      paidAt:new Date().toISOString() } });
    const endpoint = `${base}/webhooks/payments/stripe/${workspace.workspaceId}`;
    const first = await page.request.post(endpoint, { data:JSON.stringify(event('evt_invoice_paid')),
      headers:{ 'content-type':'application/json' } });
    const firstBody = await first.json();
    assert.equal(first.status(), 200, JSON.stringify(firstBody));
    assert.equal(firstBody.applied, true);
    const second = await page.request.post(endpoint, { data:JSON.stringify(event('evt_payment_succeeded')),
      headers:{ 'content-type':'application/json' } });
    assert.equal(second.status(), 200);
    assert.equal((await second.json()).applied, false);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM accounting_payments WHERE workspace_id = ?
      AND source_key LIKE 'stripe:%'`).get(workspace.workspaceId).n, 1);
    await page.goto(`${base}/orders/${order.id}#money`);
    const text = await page.locator('main').innerText();
    assert.match(text, /Paid in full.*owes \$0\.00/is);
  });

  assert.deepEqual(errors, []);
});
