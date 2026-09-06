'use strict';

/*
 * The actual browser handoff after a customer pays.
 *
 * Route tests prove the money reaches the ledger. This test proves the part a
 * person sees: Stripe's popup closes, Foundry performs one final provider
 * check, the order visibly becomes paid, and both printable documents remain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const { fakeProvider } = require('../helpers/fake-provider');
const authService = require('../../src/domain/auth-service');
const registry = require('../../src/payments/provider');
const collection = require('../../src/payments/collection');
const stripe = require('../../src/payments/providers/stripe');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const inventory = require('../../src/domain/inventory-engine');
const receivables = require('../../src/accounting/receivables');

test.after(cleanupAll);

test('a successful Stripe popup closes and returns to a visibly paid order', { timeout: 30000 }, async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Popup Payment Shop' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  require('../../src/accounting/automatic').ensure(store.db, workspace.workspaceId,
    { actorId: workspace.ctx.actorId });
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Black Shirt', baseCode: 'SHIRT' });
  prices.setPrice(store.db, workspace.ctx, { skuId: item.skuId, amount: '50.00', currency: 'USD' });
  inventory.receive(store.db, workspace.ctx,
    { skuId: item.skuId, locationId: workspace.main.id, quantity: 2 });
  const customer = sales.createCustomer(store.db, workspace.ctx,
    { name: 'Popup Customer', email: 'popup@example.test' });
  const order = sales.confirm(store.db, workspace.ctx,
    sales.createOrder(store.db, workspace.ctx,
      { customerId: customer.id, lines: [{ skuId: item.skuId, quantity: 1 }] }).id);
  const drafted = receivables.createDraft(store.db, workspace.ctx, membership, {
    customerId: customer.id, salesOrderId: order.id,
    issueDate: new Date().toISOString().slice(0, 10),
    lines: [{ description: 'Black Shirt', quantity: 1, unitPriceMinor: 5000 }],
  });
  receivables.open(store.db, workspace.ctx, membership, drafted.invoice.id);

  let providerInvoice = {
    id: 'in_popup', status: 'open', amount_due: 5000, amount_paid: 0,
    currency: 'usd', attempted: false, attempt_count: 0, payments: { data: [] },
  };
  const undo = registry.register('fake', {
    async createCustomer() { return { externalCustomerId: 'cus_popup' }; },
    async createInvoice() {
      return { externalInvoiceId: 'in_popup', hostedUrl: 'https://pay.test/in_popup' };
    },
    async getHostedPaymentUrl() { return 'https://pay.test/in_popup'; },
    async refundPayment() { return { externalRefundId: 're_popup' }; },
    verifyEvent(raw) { return raw; },
    readEvent: stripe.readEvent,
    eventFromInvoice: stripe.eventFromInvoice,
    async readInvoice() { return providerInvoice; },
  });

  let server;
  let browser;
  try {
    const asked = await collection.request(store.db, workspace.ctx, order.id,
      { provider: 'fake', purpose: 'BALANCE' });
    const app = createApp({ db: store.db, env: 'test', sessionSecret: 'popup-payment', aiProvider: fakeProvider({}) });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.route('https://pay.test/**', (route) => route.fulfill({
      contentType: 'text/html', body: '<title>Stripe test checkout</title><p>Paid</p>',
    }));
    const page = await context.newPage();
    await page.goto(`${base}/login`);
    await page.locator('#email').fill(workspace.account.email);
    await page.locator('#password').fill(workspace.account.password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.endsWith('/login')),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);

    const popupPromise = context.waitForEvent('page');
    await page.goto(`${base}/orders/${order.id}?pay=${asked.id}`);
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    providerInvoice = {
      ...providerInvoice,
      status: 'paid', amount_paid: 5000, attempted: true, attempt_count: 1,
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
    };
    await popup.close();

    await page.getByText(`Payment completed and recorded on ${order.order_number}.`).waitFor();
    assert.match(page.url(), /payment=paid/);
    await page.getByRole('link', { name: 'Print receipt', exact: true }).waitFor();
    await page.getByRole('link', { name: 'View or print Stripe invoice', exact: true }).waitFor();
    assert.equal(store.db.prepare('SELECT balance_minor FROM accounting_customer_invoices WHERE id = ?')
      .get(drafted.invoice.id).balance_minor, 0);
  } finally {
    undo();
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    store.db.close();
  }
});
