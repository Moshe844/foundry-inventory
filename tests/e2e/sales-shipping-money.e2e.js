'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const { fakeProvider } = require('../helpers/fake-provider');
const inventory = require('../../src/domain/inventory-engine');
const prices = require('../../src/pricing/price-service');
const repository = require('../../src/domain/repository');
const paymentTerms = require('../../src/sales/payment-terms');

test.after(cleanupAll);

async function submit(page, button) {
  await Promise.all([page.waitForNavigation(), button.click()]);
}

async function createOrder(page, base, item, input) {
  await page.goto(`${base}/sales/new`);
  await page.locator('input[name="customerName"]').fill(input.customer);
  await page.locator('input[name="customerEmail"]').fill(input.email);
  if (input.deliveryMethod === 'PICKUP') {
    await page.locator('input[name="deliveryMethod"][value="PICKUP"]').check({ force:true });
  }
  await page.locator('select[name="skuId"]').first().selectOption(item.skuId);
  await page.locator('input[name="quantity"]').first().fill(String(input.quantity));
  if (input.address) {
    await page.locator('#order-customer-address').fill(input.address);
  }
  await submit(page, page.getByRole('button', { name:new RegExp(`Create order and reserve ${input.quantity}|Create order and continue`) }));
}

test('sales, fulfilment, tracking and Money tell one browser-visible story', { timeout:120000 }, async (context) => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName:'UI Sales Certification' });
  const item = makeQuantityItem(store.db, workspace.ctx, { name:'Certification Widget', baseCode:'CERT-W' });
  prices.setPrice(store.db, workspace.ctx, { skuId:item.skuId, amount:'25.00', currency:'USD' });
  inventory.receive(store.db, workspace.ctx, {
    skuId:item.skuId, locationId:workspace.main.id, quantity:50,
  });
  const app = createApp({
    db:store.db,
    env:'test',
    sessionSecret:'ui-sales-certification',
    aiProvider:fakeProvider({}),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless:process.env.UI_VISIBLE !== '1' });
  const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  context.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await page.goto(`${base}/login`);
  await page.getByLabel('Email', { exact:true }).fill(workspace.account.email);
  await page.getByLabel('Password', { exact:true }).fill(workspace.account.password);
  await submit(page, page.getByRole('button', { name:'Sign in', exact:true }));

  await context.test('a carrier order cannot be created without its own destination', async () => {
    await page.goto(`${base}/sales/new`);
    await page.locator('input[name="customerName"]').fill('Address Required Customer');
    await page.locator('input[name="customerEmail"]').fill('address@example.test');
    await page.locator('select[name="skuId"]').first().selectOption(item.skuId);
    await page.locator('input[name="quantity"]').first().fill('2');
    const address = page.locator('#order-customer-address');
    await page.getByRole('button', { name:/Create order and reserve 2|Create order and continue/ }).click();
    assert.equal(page.url(), `${base}/sales/new`);
    assert.equal(await address.evaluate((element) => element.validity.valueMissing), true);
    assert.match(await address.evaluate((element) => element.validationMessage), /fill|complete|required/i);
  });

  await context.test('the UI creates, reserves, partially fulfils and cancels one order without losing its story', async () => {
    await createOrder(page, base, item, {
      customer:'Partial Customer',
      email:'partial@example.test',
      deliveryMethod:'PICKUP',
      quantity:30,
    });
    assert.match(await page.locator('main').innerText(), /30\s+committed to this customer/i);
    await page.getByText('Record what physically left', { exact:true }).click();
    await page.getByLabel(/Certification Widget from Main Warehouse/).fill('10');
    await submit(page, page.getByRole('button', { name:'Record these goods as gone', exact:true }));
    let body = await page.locator('main').innerText();
    assert.match(body, /Partly gone|Partly fulfilled|10 collected/i);
    assert.match(body, /20\s+committed to this customer/i);
    await page.getByText('Change or cancel this order', { exact:true }).click();
    await page.locator('form[action$="/cancel"] input[name="reason"]').fill('Customer reduced the order during UI certification.');
    await page.getByRole('button', { name:'Cancel unshipped remainder', exact:true }).click();
    await submit(page, page.locator('dialog[open]').getByRole('button', { name:'Cancel unshipped remainder', exact:true }));
    body = await page.locator('main').innerText();
    assert.match(body, /Cancelled/);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 40);
    await page.goto(`${base}/activity?stream=sales`);
    body = await page.locator('main').innerText();
    assert.match(body, /partly fulfilled/i);
    assert.match(body, /commitments released/i);
  });

  await context.test('picking and packing move no stock; carrier handoff moves it once and tracking reaches delivered', async () => {
    await createOrder(page, base, item, {
      customer:'Carrier Customer',
      email:'carrier@example.test',
      deliveryMethod:'SHIP',
      address:'7 Example Lane, Albany, NY 12207, US',
      quantity:5,
    });
    assert.match(await page.locator('main').innerText(), /5\s+committed to this customer/i);
    await submit(page, page.getByRole('button', { name:'Start picking 5 units', exact:true }));
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 40);
    assert.match(await page.locator('main').innerText(), /Nothing in this box has left stock yet/i);
    await submit(page, page.getByRole('button', { name:'Mark packed', exact:true }));
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 40);
    await page.locator('input[name="trackingNumber"]').fill('1Z999AA10123456784');
    await page.getByRole('textbox', { name:'Service (optional)', exact:true }).fill('Ground');
    await submit(page, page.getByRole('button', { name:/Confirm carrier handoff — 5 leaves stock/ }));
    let body = await page.locator('main').innerText();
    assert.match(body, /On its way/);
    assert.match(body, /UPS.*Ground/is);
    assert.match(body, /1Z999AA10123456784/);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 35);
    await submit(page, page.getByRole('button', { name:'Mark delivered', exact:true }));
    body = await page.locator('main').innerText();
    assert.match(body, /Delivered/);
    assert.match(body, /Unpaid · \$125\.00 remaining/i);
    assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 35);
    await page.goto(`${base}/money`);
    body = await page.locator('main').innerText();
    assert.match(body, /You're owed\s+\$375\.00/i);
    assert.match(body, /35 units have no recorded purchase cost/i);
  });

  await context.test('a required deposit visibly blocks picking until the exact payment is recorded', async () => {
    await createOrder(page, base, item, {
      customer:'Deposit Hold Customer',
      email:'deposit-hold@example.test',
      deliveryMethod:'PICKUP',
      quantity:4,
    });
    const orderId = new URL(page.url()).pathname.split('/').at(-1);
    const order = store.db.prepare('SELECT customer_id FROM sales_orders WHERE id = ? AND workspace_id = ?')
      .get(orderId, workspace.workspaceId);
    paymentTerms.setTerms(store.db, workspace.ctx, {
      customerId:order.customer_id,
      kind:'DEPOSIT',
      depositPercent:50,
      holdShipping:false,
    });
    await page.reload();
    let body = await page.locator('main').innerText();
    assert.match(body, /This order is on hold until it is paid/i);
    assert.match(body, /deposit of \$50\.00 is due/i);
    assert.doesNotMatch(body, /Start picking 4 units/i);

    await page.locator('#money > summary').click();
    await page.getByText('Record another payment — cash, cheque, transfer, card machine', { exact:true }).click();
    const paymentForm = page.locator(`form[action="/sales/orders/${orderId}/payment"]`);
    assert.equal(await paymentForm.locator('input[name="amount"]').inputValue(), '50.00');
    await paymentForm.locator('select[name="method"]').selectOption('cheque');
    await paymentForm.locator('input[name="reference"]').fill('UI-DEPOSIT-50');
    await submit(page, paymentForm.getByRole('button', { name:'Record this payment', exact:true }));
    body = await page.locator('main').innerText();
    assert.doesNotMatch(body, /This order is on hold until it is paid/i);
    assert.match(body, /Start picking 4 units/i);
  });

  assert.deepEqual(errors, []);
});
