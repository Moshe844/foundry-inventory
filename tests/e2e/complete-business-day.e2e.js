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
const repository = require('../../src/domain/repository');
const locations = require('../../src/domain/location-service');
const prices = require('../../src/pricing/price-service');
const openingBalances = require('../../src/accounting/opening-balances');
const payables = require('../../src/accounting/payables');
const suppliers = require('../../src/purchasing/supplier-service');
const purchaseOrders = require('../../src/purchasing/po-service');
const connections = require('../../src/connections/service');
const credentials = require('../../src/connections/credentials');
const communications = require('../../src/sales/customer-communications');
const paymentTerms = require('../../src/sales/payment-terms');
const paymentProviders = require('../../src/payments/provider');
const paymentAccounts = require('../../src/payments/accounts');
const emailIngestion = require('../../src/connections/email-ingestion');
const orderFromEmail = require('../../src/sales/order-from-email');
const gmail = require('../../src/connections/providers/gmail');
const shipping = require('../../src/shipping');
const reactions = require('../../src/manager/reactions');

test.after(cleanupAll);

async function submit(page, button) {
  await Promise.all([page.waitForNavigation(), button.click()]);
}

test('one complete business day stays linked from customer demand through books and owner reporting',
  { timeout:180000 }, async (context) => {
    const store = makeDatabase();
    const workspace = seedWorkspace(store.db, { workspaceName:'Complete Business Day Certification' });
    const membership = auth.getMembership(store.db, workspace.workspaceId, workspace.accountId);
    const item = makeQuantityItem(store.db, workspace.ctx, {
      name:'Business Day Widget', baseCode:'DAY-1',
    });
    prices.setPrice(store.db, workspace.ctx, { skuId:item.skuId, amount:'25.00', currency:'USD' });
    const opening = inventory.receive(store.db, workspace.ctx, {
      skuId:item.skuId, locationId:workspace.main.id, quantity:2,
    });
    const today = new Date().toISOString().slice(0, 10);
    const openingSet = openingBalances.prepare(store.db, workspace.ctx, membership, {
      startDate:today, currency:'USD', costingMethod:'WEIGHTED_AVERAGE',
      sourceDescription:'Verified opening inventory for complete-business-day certification',
      lines:[
        { accountKey:'INVENTORY_ASSET', debitMinor:2000 },
        { accountKey:'OPENING_BALANCE_EQUITY', creditMinor:2000 },
      ],
      inventory:[{ skuId:item.skuId, locationId:workspace.main.id,
        quantityUnits:2, totalCostMinor:2000 }],
    });
    openingBalances.approve(store.db, workspace.ctx, membership, openingSet.id,
      openingSet.integrity_hash);
    locations.updateLocation(store.db, workspace.ctx, workspace.main.id, {
      name:workspace.main.name, kind:workspace.main.kind,
      address:'100 Dispatch Road, Albany, NY 12207, US', phone:'+15185550100',
    });

    const mailbox = connections.create(store.db, workspace.ctx, membership, {
      providerType:'supplier_email', displayName:'Business operations Gmail',
    });
    store.db.prepare(`UPDATE workspace_connectors SET provider_type = 'gmail', status = 'connected',
      setup_status = 'CONNECTED', paused_at = NULL WHERE id = ?`).run(mailbox.connection.id);
    credentials.put(store.db, workspace.workspaceId, mailbox.connection.id, 'provider', {
      accessToken:'test-token', refreshToken:'test-refresh', mailbox:'operations@example.test',
      expiresAt:Date.now() + 60 * 60_000,
    });
    communications.setPolicy(store.db, workspace.ctx, { connectorId:mailbox.connection.id });

    const supplier = suppliers.createSupplier(store.db, workspace.ctx, membership, {
      name:'Business Day Supply', contactName:'Dana', email:'orders@business-day-supply.test',
      defaultLeadTimeDays:2, paymentTerms:'Net 30',
    });
    suppliers.updateSupplier(store.db, workspace.ctx, membership, supplier.id, {
      watchedConnectorId:mailbox.connection.id,
    });
    suppliers.linkItem(store.db, workspace.ctx, membership, {
      supplierId:supplier.id, skuId:item.skuId, supplierSku:'SUP-DAY-1', purchaseUnit:'unit',
      unitsPerPurchaseUnit:1, minimumOrderQuantity:1, orderMultiple:1, leadTimeDays:2,
      lastUnitCost:10,
    });

    const customer = require('../../src/sales/sales-order-service').createCustomer(store.db, workspace.ctx, {
      name:'Email Order Customer', email:'buyer@example.test', phone:'+15185550101',
      shippingAddress:'7 Example Lane, Albany, NY 12207, US',
    });
    paymentTerms.setTerms(store.db, workspace.ctx, {
      customerId:customer.id, kind:'DEPOSIT', depositPercent:20, holdShipping:false,
      autoRequestEnabled:1, autoRequestLimitMinor:5000,
    });
    require('../../src/autopilot/modes').setMode(store.db, workspace.ctx, membership, 'POLICY_AUTOMATED');
    require('../../src/autopilot/capabilities').set(store.db, workspace.ctx, membership,
      'payment_requests', true);

    const captured = emailIngestion.capture(store.db, {
      workspaceId:workspace.workspaceId, connectorId:mailbox.connection.id,
    }, { occurredAt:new Date().toISOString(), data:{
      messageId:'complete-day-customer-order', sender:customer.email,
      subject:'Please ship five Business Day Widgets',
      bodyText:'I would like to order 5 Business Day Widgets, SKU DAY-1, and ship them to 7 Example Lane, Albany, NY 12207, US.',
      attachments:[],
    } });
    const drafted = await orderFromEmail.draft(store.db, workspace.ctx, captured.actionRecordId, {
      provider:{ complete:async () => ({ data:{ isAnOrder:true, contactName:customer.name,
        phone:customer.phone, deliveryMethod:'SHIP',
        shippingAddress:'7 Example Lane, Albany, NY 12207, US',
        lines:[{ itemText:'DAY-1', variantText:'', quantity:5 }] } }) },
    });
    assert.ok(drafted.order, drafted.because);

    const originalSend = gmail.send;
    const sent = [];
    gmail.send = async (...args) => {
      const message = args[1] || args[0]?.message;
      sent.push(message);
      return { externalMessageId:`complete-day-${sent.length}`, externalThreadId:`day-thread-${sent.length}` };
    };

    const originalStripe = paymentProviders.get('stripe');
    paymentProviders.register('stripe', {
      async createCustomer() { return { externalCustomerId:'cus_complete_day' }; },
      async createInvoice(_ctx, input) {
        return { externalInvoiceId:`in_${input.attemptId}`,
          hostedUrl:`https://pay.example.test/${input.attemptId}` };
      },
      async getHostedPaymentUrl() { return 'https://pay.example.test/current'; },
      async refundPayment() { return { externalRefundId:'re_complete_day' }; },
      verifyEvent(raw) { return JSON.parse(String(raw)); },
      readEvent(event) { return event.normalized; },
    });
    paymentAccounts.connect(store.db, workspace.ctx, membership, {
      secretKey:'sk_test_complete_day', webhookSecret:'whsec_complete_day',
    });

    const originalShipEngine = shipping.provider.get('shipengine');
    shipping.provider.register('shipengine', {
      isConfigured:() => true,
      quote:async () => ({ providerShipmentIds:['day-carrier-shipment'], rates:[{
        rateId:'day-ground', carrier:'ups', service:'Ground', amountMinor:875, currency:'USD',
        deliveryDays:2, deliveryDate:'2026-09-25', guaranteed:false,
      }] }),
      buy:async () => ({ providerShipmentId:'day-carrier-shipment',
        providerShipmentIds:['day-carrier-shipment'], providerLabelIds:['day-label'], carrier:'ups',
        service:'Ground', trackingNumber:'1ZCOMPLETEBUSINESSDAY',
        trackingUrl:'https://tracking.example.test/1ZCOMPLETEBUSINESSDAY',
        labelUrl:'https://labels.example.test/day-label.pdf', labelFormat:'PDF', amountMinor:875,
        currency:'USD', deliveryDate:'2026-09-25' }),
      track:async (_ctx, input) => ({ status:'DELIVERED', detail:'Delivered to customer',
        events:[], trackingNumber:input.trackingNumber }),
      verifyEvent:async (raw) => JSON.parse(Buffer.from(raw).toString('utf8')),
      readEvent:(event) => event,
    });
    shipping.accounts.connect(store.db, workspace.ctx, membership, {
      provider:'shipengine', apiKey:'TEST_COMPLETE_BUSINESS_DAY', webhookSecret:'day-secret',
    });

    const app = createApp({
      db:store.db, env:'test', sessionSecret:'complete-business-day', aiProvider:fakeProvider({}),
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ headless:process.env.UI_VISIBLE !== '1' });
    const page = await browser.newPage({ viewport:{ width:1440, height:1100 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    context.after(async () => {
      gmail.send = originalSend;
      paymentProviders.register('stripe', originalStripe);
      shipping.provider.register('shipengine', originalShipEngine);
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    });

    await page.goto(`${base}/login`);
    await page.getByLabel('Email', { exact:true }).fill(workspace.account.email);
    await page.getByLabel('Password', { exact:true }).fill(workspace.account.password);
    await submit(page, page.getByRole('button', { name:'Sign in', exact:true }));

    let purchaseOrder;
    let supplierBill;

    await context.test('customer email becomes a grounded order, exposes the shortage and requests only the authorised deposit', async () => {
      await page.goto(`${base}/orders/${drafted.order.id}`);
      let body = await page.locator('main').innerText();
      assert.match(body, /Read from an email from buyer@example\.test/i);
      assert.match(body, /5.*Business Day Widget/is);
      await page.getByRole('button', { name:'Confirm order and reserve stock', exact:true }).click();
      await page.getByText(/3 units still short/).waitFor();
      body = await page.locator('main').innerText();
      assert.match(body, /2\s+committed to this customer/i);
      assert.match(body, /3\s+waiting for stock/i);
      assert.match(body, /asked Email Order Customer for \$25\.00 and emailed the link/i);
      assert.equal(sent.length, 1);

      const request = store.db.prepare(`SELECT * FROM payment_requests WHERE workspace_id = ?
        AND sales_order_id = ?`).get(workspace.workspaceId, drafted.order.id);
      const event = { id:'evt_complete_day_deposit', normalized:{ kind:'PAID',
        externalInvoiceId:request.external_invoice_id, externalPaymentId:'pi_complete_day_deposit',
        amountMinor:2500, currency:'USD', method:'card', paidAt:new Date().toISOString() } };
      const response = await page.request.post(`${base}/webhooks/payments/stripe/${workspace.workspaceId}`, {
        data:JSON.stringify(event), headers:{ 'content-type':'application/json' },
      });
      assert.equal(response.status(), 200);
      await page.reload();
      assert.match(await page.locator('main').innerText(), /\$100\.00 still owed/i);
    });

    await context.test('StockChief prepares one supplier order; the owner approves and sends the exact prepared communication', async () => {
      purchaseOrder = purchaseOrders.createOrder(store.db, workspace.ctx, membership, {
        supplierId:supplier.id, destinationLocationId:workspace.main.id,
        expectedDate:'2026-09-24', notes:`Replenishes shortage on ${drafted.order.order_number}`,
        lines:[{ skuId:item.skuId, quantityUnits:4, unitCost:10 }],
      });
      await page.goto(`${base}/purchasing/orders/${purchaseOrder.id}`);
      let body = await page.locator('main').innerText();
      assert.match(body, /I drafted the order/i);
      assert.match(body, /4 units/);
      await submit(page, page.getByRole('button', { name:'Approve order', exact:true }));
      await page.goto(`${base}/purchasing/orders/${purchaseOrder.id}/detail`);
      await submit(page, page.getByRole('button', { name:'Send to supplier', exact:true }));
      body = await page.locator('main').innerText();
      assert.match(body, /was sent to Business Day Supply/i);
      assert.equal(sent.length, 2);
      assert.match(sent[1].subject, new RegExp(purchaseOrder.poNumber));

      const draftBill = payables.createDraft(store.db, workspace.ctx, membership, {
        supplierId:supplier.id, purchaseOrderId:purchaseOrder.id,
        supplierInvoiceNumber:'DAY-INVOICE-1', issueDate:today, dueDate:'2026-10-22',
        sourceKey:'complete-day-supplier-invoice', lines:[{
          description:'4 Business Day Widgets', quantity:4, unitCostMinor:1000,
          itemId:item.itemId, skuId:item.skuId, purchaseOrderLineId:purchaseOrder.lines[0].id,
        }],
      });
      supplierBill = payables.open(store.db, workspace.ctx, membership, draftBill.bill.id);
      assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 2,
        'a supplier invoice does not receive stock');
      await page.goto(`${base}/purchasing/orders/${purchaseOrder.id}`);
      body = await page.locator('main').innerText();
      assert.match(body, /\$40\.00/);
      await page.goto(`${base}/accounting/payables`);
      assert.match(await page.locator('main').innerText(), /DAY-INVOICE-1/);
    });

    await context.test('partial and final receipts update physical stock and automatically satisfy the linked customer shortage', async () => {
      const lineId = purchaseOrders.get(store.db, workspace.workspaceId, purchaseOrder.id).lines[0].id;
      await page.goto(`${base}/purchasing/orders/${purchaseOrder.id}/receive`);
      await page.locator(`input[name="qty_${lineId}"]`).fill('2');
      await page.locator('input[name="reference"]').fill('DAY-PARTIAL-1');
      await submit(page, page.getByRole('button', { name:'Book it in', exact:true }));
      let body = await page.locator('main').innerText();
      assert.match(body, /Partially received/i);
      assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 4);

      await page.goto(`${base}/purchasing/orders/${purchaseOrder.id}/receive`);
      await page.locator(`input[name="qty_${lineId}"]`).fill('2');
      await page.locator('input[name="reference"]').fill('DAY-FINAL-2');
      await submit(page, page.getByRole('button', { name:'Book it in', exact:true }));
      body = await page.locator('main').innerText();
      assert.match(body, /Received/i);
      assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 6);
      await page.goto(`${base}/orders/${drafted.order.id}`);
      assert.match(await page.locator('main').innerText(), /5\s+committed to this customer/i);
    });

    await context.test('the linked order is picked, labelled, handed to the carrier, delivered and paid without losing its evidence', async () => {
      await submit(page, page.getByRole('button', { name:'Start picking 5 units', exact:true }));
      await page.getByLabel('Weight in grams (optional)').fill('1800');
      await submit(page, page.getByRole('button', { name:'Mark packed', exact:true }));
      await submit(page, page.getByRole('button', { name:'Get carrier rates', exact:true }));
      await submit(page, page.getByRole('button', { name:'Buy label', exact:true }));
      assert.match(await page.locator('main').innerText(), /1ZCOMPLETEBUSINESSDAY/);
      await submit(page, page.getByRole('button', { name:/Handed to carrier — 5 leaves stock/ }));
      await submit(page, page.getByRole('button', { name:'Mark delivered', exact:true }));
      reactions.drainWorkspace(store.db, workspace.workspaceId);
      assert.equal(repository.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 1);

      await page.goto(`${base}/orders/${drafted.order.id}?open=money`);
      await page.getByText('Record another payment — cash, cheque, transfer, card machine', { exact:true }).click();
      const form = page.locator(`form[action="/sales/orders/${drafted.order.id}/payment"]`);
      await form.locator('input[name="amount"]').fill('100.00');
      await form.locator('select[name="method"]').selectOption('bank transfer');
      await form.locator('input[name="reference"]').fill('DAY-FINAL-CUSTOMER-PAYMENT');
      await submit(page, form.getByRole('button', { name:'Record this payment', exact:true }));
      const body = await page.locator('main').innerText();
      assert.match(body, /fully paid/i);
      assert.match(body, /\$0\.00\s+STILL OWED/i);
      assert.match(body, /Came in by email from buyer@example\.test/i);
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM payment_requests
        WHERE workspace_id = ? AND sales_order_id = ? AND status = 'OPEN'`)
        .get(workspace.workspaceId, drafted.order.id).n, 0);
    });

    await context.test('supplier payment, inventory valuation, trial balance, Home and Needs You report the same completed day', async () => {
      await page.goto(`${base}/accounting/payables`);
      const bill = page.locator('.bill-row').filter({ hasText:'DAY-INVOICE-1' });
      await bill.getByText('Record payment', { exact:true }).click();
      await bill.getByLabel('Amount paid', { exact:true }).fill('20.00');
      await bill.getByLabel('Reference', { exact:true }).fill('DAY-SUPPLIER-PARTIAL');
      await submit(page, bill.getByRole('button', { name:'Record it', exact:true }));
      assert.match(await page.locator('.bill-row').filter({ hasText:'DAY-INVOICE-1' }).innerText(),
        /partly paid[\s\S]*\$20\.00\s+of \$40\.00/i);
      assert.equal(store.db.prepare('SELECT balance_minor FROM accounting_supplier_bills WHERE id = ?')
        .get(supplierBill.id).balance_minor, 2000);

      const today = new Date().toISOString().slice(0, 10);
      await page.goto(`${base}/accounting/reports/inventory-valuation?asOf=${today}`);
      let body = await page.locator('main').innerText();
      assert.match(body, /1 units?/i);
      assert.match(body, /Cost subledger \$10\.00 · Inventory control \$10\.00/i);
      assert.match(body, /Reconciled/i);
      await page.goto(`${base}/accounting/reports/trial-balance?from=1900-01-01&to=${today}`);
      assert.match(await page.locator('main').innerText(), /Debits equal credits/i);

      await page.goto(`${base}/purchasing/orders/${purchaseOrder.id}/detail`);
      body = await page.locator('main').innerText();
      assert.match(body, /Sent successfully.*to orders@business-day-supply\.test/is);
      await page.goto(`${base}/purchasing/orders/${purchaseOrder.id}`);
      body = await page.locator('main').innerText();
      assert.match(body, /Received 4 units/i);
      assert.match(body, /\$20\.00.*owed|owed.*\$20\.00/is);
      await page.goto(`${base}/accounting/payables`);
      assert.match(await page.locator('.bill-row').filter({ hasText:'DAY-INVOICE-1' }).innerText(),
        /partly paid[\s\S]*\$20\.00\s+of \$40\.00/i);
      await page.goto(`${base}/needs-you`);
      assert.doesNotMatch(await page.locator('main').innerText(), /3.*Business Day Widget.*waiting for stock/is);
      await page.goto(`${base}/`);
      assert.match(await page.locator('main').innerText(), /Business Day|operations|ready|attention/i);
    });

    assert.deepEqual(errors, []);
  });
