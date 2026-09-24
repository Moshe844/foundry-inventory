'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const { fakeProvider } = require('../helpers/fake-provider');
const auth = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const prices = require('../../src/pricing/price-service');
const sales = require('../../src/sales/sales-order-service');
const paymentTerms = require('../../src/sales/payment-terms');
const paymentProviders = require('../../src/payments/provider');
const paymentAccounts = require('../../src/payments/accounts');
const modes = require('../../src/autopilot/modes');
const capabilities = require('../../src/autopilot/capabilities');
const connections = require('../../src/connections/service');
const credentials = require('../../src/connections/credentials');
const communications = require('../../src/sales/customer-communications');
const gmail = require('../../src/connections/providers/gmail');

test.after(cleanupAll);

async function submit(page, button) {
  await Promise.all([page.waitForNavigation(), button.click()]);
}

async function createOrder(page, base, item, customer) {
  await page.goto(`${base}/sales/new`);
  await page.locator('input[name="customerName"]').fill(customer.name);
  await page.locator('input[name="customerEmail"]').fill(customer.email);
  await page.locator('input[name="deliveryMethod"][value="PICKUP"]').check({ force:true });
  await page.locator('select[name="skuId"]').first().selectOption(item.skuId);
  await page.locator('input[name="quantity"]').first().fill('2');
  await submit(page, page.getByRole('button', { name:/Create order and reserve|Create order and continue/ }));
}

test('authorized routine payment requests send automatically while unauthorized ones wait', { timeout:60000 }, async (context) => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName:'UI Payment Automation Certification' });
  const membership = auth.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  require('../../src/accounting/automatic').ensure(store.db, workspace.workspaceId, { actorId:workspace.ownerId });
  const item = makeQuantityItem(store.db, workspace.ctx, { name:'Automatic Payment Widget', baseCode:'AUTO-PAY' });
  prices.setPrice(store.db, workspace.ctx, { skuId:item.skuId, amount:'10.00', currency:'USD' });
  inventory.receive(store.db, workspace.ctx, { skuId:item.skuId, locationId:workspace.main.id, quantity:20 });

  const originalStripe = paymentProviders.get('stripe');
  paymentProviders.register('stripe', {
    async createCustomer() { return { externalCustomerId:'cus_auto_pay' }; },
    async createInvoice(_ctx, input) {
      return { externalInvoiceId:`in_${input.attemptId}`, hostedUrl:`https://pay.example.test/${input.attemptId}` };
    },
    async getHostedPaymentUrl() { return 'https://pay.example.test/current'; },
    async refundPayment() { return { externalRefundId:'re_auto_pay' }; },
    verifyEvent(raw) { return raw; },
    readEvent() { return { kind:'IGNORED' }; },
  });
  paymentAccounts.connect(store.db, workspace.ctx, membership, { secretKey:'sk_test_auto_payment' });

  const mailbox = connections.create(store.db, workspace.ctx, membership, {
    providerType:'supplier_email', displayName:'Customer Mailbox',
  });
  store.db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', status = 'connected',
    setup_status = 'CONNECTED', paused_at = NULL WHERE id = ?`).run(mailbox.connection.id);
  credentials.put(store.db, workspace.workspaceId, mailbox.connection.id, 'provider', {
    accessToken:'test-token', refreshToken:'test-refresh', mailbox:'payments@example.test',
    expiresAt:Date.now() + 60 * 60_000,
  });
  communications.setPolicy(store.db, workspace.ctx, { connectorId:mailbox.connection.id });
  const originalSend = gmail.send;
  const sent = [];
  gmail.send = async (...args) => {
    const message = args[1] || args[0]?.message;
    sent.push(message);
    return { externalMessageId:`sent-${sent.length}`, externalThreadId:`thread-${sent.length}` };
  };

  const authorizedCustomer = sales.createCustomer(store.db, workspace.ctx, {
    name:'Authorized Payment Customer', email:'authorized-pay@example.test',
  });
  const waitingCustomer = sales.createCustomer(store.db, workspace.ctx, {
    name:'Waiting Payment Customer', email:'waiting-pay@example.test',
  });
  for (const customer of [authorizedCustomer, waitingCustomer]) {
    paymentTerms.setTerms(store.db, workspace.ctx, {
      customerId:customer.id, kind:'BEFORE_FULFILMENT', autoRequestEnabled:1,
      autoRequestLimitMinor:5000,
    });
  }
  modes.setMode(store.db, workspace.ctx, membership, 'POLICY_AUTOMATED');
  capabilities.set(store.db, workspace.ctx, membership, 'payment_requests', true);

  const app = createApp({ db:store.db, env:'test', sessionSecret:'ui-payment-automation', aiProvider:fakeProvider({}) });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless:process.env.UI_VISIBLE !== '1' });
  const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  context.after(async () => {
    gmail.send = originalSend;
    paymentProviders.register('stripe', originalStripe);
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await page.goto(`${base}/login`);
  await page.getByLabel('Email', { exact:true }).fill(workspace.account.email);
  await page.getByLabel('Password', { exact:true }).fill(workspace.account.password);
  await submit(page, page.getByRole('button', { name:'Sign in', exact:true }));

  await context.test('explicit authority creates one provider request and sends one grounded email', async () => {
    await createOrder(page, base, item, authorizedCustomer);
    const text = await page.locator('main').innerText();
    assert.match(text, /StockChief asked Authorized Payment Customer for \$20\.00 and emailed the link/i);
    assert.equal(sent.length, 1);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM payment_requests WHERE workspace_id = ?
      AND customer_id = ?`).get(workspace.workspaceId, authorizedCustomer.id).n, 1);
    const message = store.db.prepare(`SELECT * FROM customer_communications WHERE workspace_id = ?
      AND customer_id = ? AND message_kind = 'payment_request'`).get(workspace.workspaceId, authorizedCustomer.id);
    assert.equal(message.status, 'SENT');
    assert.equal(message.recipient, authorizedCustomer.email);
    assert.match(message.body, /USD 20\.00/);
  });

  await context.test('without job authority the same routine request is prepared and visibly waits', async () => {
    capabilities.set(store.db, workspace.ctx, membership, 'payment_requests', false);
    await createOrder(page, base, item, waitingCustomer);
    const text = await page.locator('main').innerText();
    assert.match(text, /made a \$20\.00 payment link and wrote the email/i);
    assert.match(text, /Nobody has authorised StockChief to ask customers to pay on its own/i);
    assert.match(text, /ready to send/i);
    assert.equal(sent.length, 1, 'the second customer was not contacted');
    const message = store.db.prepare(`SELECT * FROM customer_communications WHERE workspace_id = ?
      AND customer_id = ? AND message_kind = 'payment_request'`).get(workspace.workspaceId, waitingCustomer.id);
    assert.equal(message.status, 'PREPARED');
    await page.locator('#money > summary').click();
    assert.equal(await page.getByRole('link', { name:'Read the email and send it' }).count(), 1);
  });

  assert.deepEqual(errors, []);
});
