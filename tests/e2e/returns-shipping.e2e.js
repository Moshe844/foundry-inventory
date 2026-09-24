'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const { fakeProvider } = require('../helpers/fake-provider');
const inventory = require('../../src/domain/inventory-engine');
const repository = require('../../src/domain/repository');
const locations = require('../../src/domain/location-service');
const prices = require('../../src/pricing/price-service');
const accounting = require('../../src/accounting/automatic');
const costing = require('../../src/accounting/costing');
const shipping = require('../../src/shipping');
const reactions = require('../../src/manager/reactions');

test.after(cleanupAll);

async function submit(page, button) {
  await Promise.all([page.waitForNavigation(), button.click()]);
}

async function signIn(page, base, workspace) {
  await page.goto(`${base}/login`);
  await page.getByLabel('Email', { exact:true }).fill(workspace.account.email);
  await page.getByLabel('Password', { exact:true }).fill(workspace.account.password);
  await submit(page, page.getByRole('button', { name:'Sign in', exact:true }));
}

async function createOrder(page, base, item, input) {
  await page.goto(`${base}/sales/new`);
  await page.locator('input[name="customerName"]').fill(input.customer);
  await page.locator('input[name="customerEmail"]').fill(input.email);
  if (input.pickup) {
    await page.locator('input[name="deliveryMethod"][value="PICKUP"]').check({ force:true });
  } else {
    await page.locator('#order-customer-address').fill(input.address);
  }
  await page.locator('select[name="skuId"]').first().selectOption(item.skuId);
  await page.locator('input[name="quantity"]').first().fill(String(input.quantity));
  await submit(page, page.getByRole('button', { name:/Create order and reserve|Create order and continue/ }));
  return new URL(page.url()).pathname.split('/').at(-1);
}

test('returns, carrier labels and delivery exceptions work through the rendered UI', { timeout:120000 }, async (context) => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName:'UI Returns and Shipping Certification' });
  const item = makeQuantityItem(store.db, workspace.ctx, { name:'Returnable Shipping Widget', baseCode:'RSW-1' });
  prices.setPrice(store.db, workspace.ctx, { skuId:item.skuId, amount:'25.00', currency:'USD' });
  accounting.ensure(store.db, workspace.workspaceId, { actorId:workspace.ownerId });
  const opening = inventory.receive(store.db, workspace.ctx, {
    skuId:item.skuId, locationId:workspace.main.id, quantity:40,
  });
  costing.receive(store.db, workspace.ctx, {
    movementIds:opening.movementIds, unitCostMinor:1000,
    sourceType:'certification_opening_stock', sourceRecordId:'ui-returns-shipping-opening',
  });
  locations.updateLocation(store.db, workspace.ctx, workspace.main.id, {
    name:workspace.main.name,
    kind:workspace.main.kind,
    address:'100 Dispatch Road, Albany, NY 12207, US',
    phone:'+15185550100',
  });
  const quarantine = locations.createLocation(store.db, workspace.ctx, {
    name:'Returns quarantine', kind:'staging', note:'Customer returns awaiting inspection',
  });

  const originalShipEngine = shipping.provider.get('shipengine');
  const carrierEvents = new Map();
  shipping.provider.register('shipengine', {
    isConfigured:() => true,
    quote:async () => ({ providerShipmentIds:['carrier-shipment-1'], rates:[
      { rateId:'rate-ground', carrier:'ups', service:'Ground', amountMinor:875, currency:'USD',
        deliveryDays:3, deliveryDate:'2026-09-25', guaranteed:false },
      { rateId:'rate-ground-duplicate', carrier:'ups', service:'Ground', amountMinor:925, currency:'USD',
        deliveryDays:3, deliveryDate:'2026-09-25', guaranteed:false },
    ] }),
    buy:async () => ({ providerShipmentId:'carrier-shipment-1', providerShipmentIds:['carrier-shipment-1'],
      providerLabelIds:['carrier-label-1'], carrier:'ups', service:'Ground', trackingNumber:'1ZCERTIFICATION001',
      trackingUrl:'https://tracking.example.test/1ZCERTIFICATION001',
      labelUrl:'https://labels.example.test/carrier-label-1.pdf', labelFormat:'PDF', amountMinor:875,
      currency:'USD', deliveryDate:'2026-09-25' }),
    track:async (_ctx, input) => carrierEvents.get(input.trackingNumber) || {
      status:'PRE_TRANSIT', detail:'Label created', events:[], trackingNumber:input.trackingNumber,
    },
    verifyEvent:async (raw) => JSON.parse(Buffer.from(raw).toString('utf8')),
    readEvent:(event) => event,
  });
  shipping.accounts.connect(store.db, workspace.ctx,
    { role:'owner' }, { provider:'shipengine', apiKey:'TEST_UI_CERTIFICATION', webhookSecret:'ui-secret' });

  const app = createApp({ db:store.db, env:'test', sessionSecret:'ui-returns-shipping', aiProvider:fakeProvider({}) });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless:process.env.UI_VISIBLE !== '1' });
  const page = await browser.newPage({ viewport:{ width:1440, height:1100 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  context.after(async () => {
    shipping.provider.register('shipengine', originalShipEngine);
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await signIn(page, base, workspace);

  await context.test('a carrier label is bought through the provider abstraction before stock leaves', async () => {
    const before = repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id);
    await createOrder(page, base, item, {
      customer:'Carrier Certification Customer', email:'carrier-cert@example.test', quantity:3,
      address:'7 Example Lane, Albany, NY 12207, US',
    });
    const order = store.db.prepare(`SELECT customer_id FROM sales_orders WHERE id = ? AND workspace_id = ?`)
      .get(new URL(page.url()).pathname.split('/').at(-1), workspace.workspaceId);
    store.db.prepare('UPDATE customers SET phone = ? WHERE id = ? AND workspace_id = ?')
      .run('+15185550101', order.customer_id, workspace.workspaceId);
    await page.reload();
    await submit(page, page.getByRole('button', { name:'Start picking 3 units', exact:true }));
    await page.getByLabel('Weight in grams (optional)').fill('1200');
    await submit(page, page.getByRole('button', { name:'Mark packed', exact:true }));
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), before);
    await submit(page, page.getByRole('button', { name:'Get carrier rates', exact:true }));
    let body = await page.locator('main').innerText();
    assert.match(body, /1 rates\. Nothing has been bought/i, 'duplicate carrier offers are collapsed in the UI');
    assert.equal(await page.locator('input[name="rateId"]').count(), 1);
    await submit(page, page.getByRole('button', { name:'Buy label', exact:true }));
    body = await page.locator('main').innerText();
    assert.match(body, /Label ready — not handed over yet/i);
    assert.match(body, /1ZCERTIFICATION001/);
    assert.match(body, /\$8\.75/);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), before,
      'buying postage does not pretend the parcel left');
    await submit(page, page.getByRole('button', { name:/Handed to carrier — 3 leaves stock/ }));
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), before - 3);
    assert.match(await page.locator('main').innerText(), /On its way|Shipped/i);
  });

  await context.test('a verified carrier exception appears on the shipment and in Needs you', async () => {
    const shipment = store.db.prepare(`SELECT id FROM sales_shipments WHERE workspace_id = ?
      AND tracking_number = '1ZCERTIFICATION001'`).get(workspace.workspaceId);
    const event = {
      externalEventId:'carrier-exception-1', type:'tracking.updated', providerShipmentId:'carrier-shipment-1',
      trackingNumber:'1ZCERTIFICATION001', status:'FAILURE', detail:'Weather delay at the Albany depot',
      estimatedDeliveryDate:'2026-09-28', events:[{
        externalEventId:'carrier-scan-1', status:'FAILURE', detail:'Weather delay at the Albany depot',
        location:'Albany, NY', occurredAt:'2026-09-23T14:00:00.000Z',
      }],
    };
    const response = await page.request.post(`${base}/webhooks/shipping/shipengine/${workspace.workspaceId}`, {
      data:event,
      headers:{ 'content-type':'application/json' },
    });
    assert.equal(response.status(), 200);
    await page.goto(`${base}/fulfilment/${shipment.id}`);
    let body = await page.locator('main').innerText();
    assert.match(body, /failure/i);
    assert.match(body, /Weather delay at the Albany depot/i);
    await page.goto(`${base}/needs-you`);
    body = await page.locator('main').innerText();
    assert.match(body, /Weather delay|carrier|delivery/i);
    const duplicate = await page.request.post(`${base}/webhooks/shipping/shipengine/${workspace.workspaceId}`, {
      data:event, headers:{ 'content-type':'application/json' },
    });
    assert.equal(duplicate.status(), 200);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM shipment_tracking_events
      WHERE workspace_id = ? AND external_event_id = 'carrier-scan-1'`).get(workspace.workspaceId).n, 1);
  });

  await context.test('a customer return is authorized, quarantined, inspected, restocked and refunded in the UI', async () => {
    const before = repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id);
    const orderId = await createOrder(page, base, item, {
      customer:'Return Certification Customer', email:'return-cert@example.test', quantity:2, pickup:true,
    });
    await submit(page, page.getByRole('button', { name:'Start picking 2 units', exact:true }));
    await submit(page, page.getByRole('button', { name:/Customer collected it — 2 leaves stock/ }));
    reactions.drainWorkspace(store.db, workspace.workspaceId);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), before - 2);

    await page.goto(`${base}/warehouse/operations#customer-returns`);
    const returnForm = page.locator('form[action="/warehouse/returns/customer"]');
    await returnForm.locator('select[name="salesOrderId"]').selectOption(orderId);
    const orderLine = store.db.prepare('SELECT id FROM sales_order_lines WHERE sales_order_id = ?').get(orderId);
    await returnForm.locator('select[name="salesOrderLineId"]').selectOption(orderLine.id);
    await returnForm.locator('input[name="quantity"]').fill('2');
    await returnForm.locator('select[name="quarantineLocationId"]').selectOption(quarantine.id);
    await returnForm.locator('select[name="resolution"]').selectOption('REFUND');
    await returnForm.locator('input[name="reason"]').fill('Customer returned unopened goods');
    await submit(page, returnForm.getByRole('button', { name:'Request return', exact:true }));
    assert.match(await page.locator('main').innerText(), /return is requested.*Nothing has moved/is);
    await submit(page, page.getByRole('button', { name:'Authorize return', exact:true }));
    await submit(page, page.getByRole('button', { name:/Receive into Returns quarantine/ }));
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, quarantine.id), 2);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), before - 2);
    await page.locator('input[name="conditionNote"]').fill('Unopened and sellable');
    await page.locator('select[name="restockLocationId"]').selectOption(workspace.main.id);
    await submit(page, page.getByRole('button', { name:'Record inspection', exact:true }));
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, quarantine.id), 0);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), before);
    await page.locator('input[name="revenue"]').fill('50.00');
    await submit(page, page.getByRole('button', { name:'Record the refund', exact:true }));
    const body = await page.locator('main').innerText();
    const completedReturn = store.db.prepare(`SELECT status FROM customer_returns WHERE workspace_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(workspace.workspaceId);
    assert.equal(completedReturn.status, 'COMPLETED', body);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM accounting_sale_refunds WHERE workspace_id = ?`)
      .get(workspace.workspaceId).n, 1);
  });

  assert.deepEqual(errors, []);
});
