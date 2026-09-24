'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const commerce=require('../../src/operations/postgres-commerce');
const workflows=require('../../src/operations/postgres-business-workflows');
const customerReturns=require('../../src/operations/postgres-returns');
const jobs=require('../../src/operations/postgres-job-queue');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');
const {AuthenticationError}=require('../../src/domain/errors');

test('real Chromium queues hosted payments, posts signed results once, and fences uncertain provider outcomes',
  {timeout:240000},async(context)=>{
    const eventDay=new Date().toISOString().slice(0,10);const eventAt=`${eventDay}T15:00:00.000Z`;
    let providerCalls=0;let invoiceSequence=0;let refundSequence=0;let mode='success';
    const provider={
      async createCustomer(_ctx,input){providerCalls+=1;return {externalCustomerId:`cus_${input.email}`};},
      async createInvoice(){providerCalls+=1;if(mode==='ambiguous')throw Object.assign(new Error('Provider timed out after submission.'),
        {code:'provider_timeout'});invoiceSequence+=1;return {externalInvoiceId:`in_fixture_${invoiceSequence}`,
        hostedUrl:`https://payments.example.test/in_fixture_${invoiceSequence}`,status:'open'};},
      async getHostedPaymentUrl(){return null;},async refundPayment(){providerCalls+=1;refundSequence+=1;
        return {externalRefundId:`refund_fixture_${refundSequence}`};},
      verifyEvent(raw,headers,options){if(headers['x-fixture-signature']!==options.webhookSecret)
        throw new AuthenticationError('That event did not come from the payment provider.');return JSON.parse(raw);},
      readEvent(event){return {kind:'PAID',externalInvoiceId:event.data.object.id,
        externalPaymentId:event.data.object.payment_intent,amountMinor:event.data.object.amount_paid,
        currency:'USD',method:'card',paidAt:eventAt};},
    };
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-payments-ui'});
    await migratePostgres(database);
    const paymentOptions={providerResolver:()=>provider,webhookSecret:'payment-webhook-fixture-secret'};
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-payment-secret',paymentOptions});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;

    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Payment Certification');
    await page.getByLabel('Your name').fill('Payment Owner');await page.getByLabel('Work email').fill('payments-pg@example.test');
    await page.getByLabel('Password').fill('payments-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='payments-pg@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};const at=`${eventDay}T14:00:00.000Z`;
    await database.query(`INSERT INTO payment_connect_accounts
      (id,workspace_id,provider,provider_account_id,display_name,charges_enabled,livemode,checked_at,
       connected_by_user_id,created_at,updated_at)
      VALUES('payment-account',$1,'stripe','acct_fixture_business','Fixture business',1,0,$2,$3,$2,$2)`,
    [ctx.workspaceId,at,ctx.actorId]);
    const location=await locations.createLocation(database,ctx,{name:'Payment Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Payment Widget',baseCode:'PAY-WIDGET',trackingMode:'quantity'});
    const supplier=await commerce.createSupplier(database,ctx,{name:'Payment Supply',email:'supply@example.test'});
    const po=await workflows.createPurchaseOrder(database,ctx,{supplierId:supplier.id,destinationLocationId:location.id,
      idempotencyKey:'payment-stock-po',lines:[{skuId:item.skuIds[0],quantityUnits:20,unitCost:5}]});
    await workflows.approvePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'payment-stock-approve'});
    await workflows.placePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'payment-stock-place'});
    await workflows.receivePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'payment-stock-receive',
      reference:'PAY-STOCK',lines:[{lineId:po.lineIds[0],quantity:20,locationId:location.id}]});
    const customer=await commerce.createCustomer(database,ctx,{name:'Payment Customer',email:'customer@example.test'});
    await database.query(`INSERT INTO customer_payment_terms
      (id,workspace_id,customer_id,kind,deposit_percent,deposit_minor,net_days,hold_shipping,credit_approved,
       auto_request_enabled,credit_limit_minor,note,agreed_by_user_id,created_at,updated_at)
      VALUES('payment-terms',$1,$2,'DEPOSIT',50,NULL,NULL,0,0,0,NULL,'Certified terms',$3,$4,$4)`,
    [ctx.workspaceId,customer.id,ctx.actorId,at]);

    async function fulfilledOrder(keySuffix,quantity){const order=await workflows.createSalesOrder(database,ctx,{
      customerId:customer.id,deliveryMethod:'PICKUP',fulfillmentLocationId:location.id,idempotencyKey:`pay-order-${keySuffix}`,
      lines:[{skuId:item.skuIds[0],quantity,unitPriceMinor:1200}]});
      await workflows.confirmSalesOrder(database,ctx,order.salesOrderId,{idempotencyKey:`pay-confirm-${keySuffix}`});
      await workflows.fulfillSalesOrder(database,ctx,order.salesOrderId,{idempotencyKey:`pay-fulfill-${keySuffix}`,
        lines:[{lineId:order.lineIds[0],locationId:location.id,quantity}]});return order;}

    const depositOrder=await workflows.createSalesOrder(database,ctx,{customerId:customer.id,deliveryMethod:'PICKUP',
      fulfillmentLocationId:location.id,idempotencyKey:'pay-order-deposit',
      lines:[{skuId:item.skuIds[0],quantity:2,unitPriceMinor:1200}]});
    await workflows.confirmSalesOrder(database,ctx,depositOrder.salesOrderId,{idempotencyKey:'pay-confirm-deposit'});
    await page.goto(`${base}/orders/${depositOrder.salesOrderId}`);
    assert.match(await page.locator('main').innerText(),/Agreed deposit:.*12\.00.*Still due:.*12\.00/s);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Prepare secure deposit link'}).click()]);
    assert.equal(providerCalls,0);assert.match(await page.locator('main').innerText(),/Provider confirmation pending/);
    const handlerOptions={paymentProviderResolver:()=>provider,paymentAccountContext:()=>({})};
    await jobs.processOne(database,runtimeHandlers.create(undefined,handlerOptions),{owner:'deposit-worker',leaseMs:30000});
    assert.equal(providerCalls,2);await page.reload();
    assert.equal(await page.getByRole('link',{name:'Open secure page'}).getAttribute('href'),
      'https://payments.example.test/in_fixture_1');
    const depositEvent={id:'evt_deposit_confirmed',account:'acct_fixture_business',type:'invoice.payment_succeeded',
      data:{object:{id:'in_fixture_1',payment_intent:'pi_deposit_fixture',amount_paid:1200}}};
    const depositResponse=await page.request.post(`${base}/webhooks/payments/stripe`,{data:JSON.stringify(depositEvent),
      headers:{'content-type':'application/json','x-fixture-signature':'payment-webhook-fixture-secret'}});
    assert.equal(depositResponse.status(),200,await depositResponse.text());
    const beforeFulfillment=(await database.query(`SELECT
        (SELECT COUNT(*) FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2) AS invoices,
        (SELECT COALESCE(SUM(p.amount_minor),0) FROM accounting_payments p WHERE p.workspace_id=$1 AND p.sales_order_id=$2) AS deposits,
        (SELECT COALESCE(SUM(CASE WHEN line.credit_minor>0 THEN line.credit_minor ELSE -line.debit_minor END),0)
          FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id
          WHERE line.workspace_id=$1 AND account.system_key='CUSTOMER_DEPOSITS') AS deposit_liability`,
    [ctx.workspaceId,depositOrder.salesOrderId])).rows[0];
    assert.deepEqual({invoices:Number(beforeFulfillment.invoices),deposits:Number(beforeFulfillment.deposits),
      liability:Number(beforeFulfillment.deposit_liability)},{invoices:0,deposits:1200,liability:1200});
    const depositFulfillment=await workflows.fulfillSalesOrder(database,ctx,depositOrder.salesOrderId,{
      idempotencyKey:'pay-fulfill-deposit',lines:[{lineId:depositOrder.lineIds[0],locationId:location.id,quantity:2}]});
    assert.equal(depositFulfillment.appliedDepositMinor,1200);
    const afterFulfillment=(await database.query(`SELECT invoice.total_minor,invoice.balance_minor,invoice.status,
        (SELECT COALESCE(SUM(a.amount_minor),0) FROM accounting_payment_allocations a
          WHERE a.workspace_id=invoice.workspace_id AND a.customer_invoice_id=invoice.id) AS allocated,
        (SELECT COALESCE(SUM(CASE WHEN line.credit_minor>0 THEN line.credit_minor ELSE -line.debit_minor END),0)
          FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id
          WHERE line.workspace_id=invoice.workspace_id AND account.system_key='CUSTOMER_DEPOSITS') AS deposit_liability
      FROM accounting_customer_invoices invoice WHERE invoice.workspace_id=$1 AND invoice.sales_order_id=$2`,
    [ctx.workspaceId,depositOrder.salesOrderId])).rows[0];
    assert.deepEqual({total:Number(afterFulfillment.total_minor),balance:Number(afterFulfillment.balance_minor),
      status:afterFulfillment.status,allocated:Number(afterFulfillment.allocated),
      liability:Number(afterFulfillment.deposit_liability)},
    {total:2400,balance:1200,status:'PARTIALLY_PAID',allocated:1200,liability:0});

    const order=await fulfilledOrder('confirmed',2);
    await page.goto(`${base}/orders/${order.salesOrderId}`);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Prepare secure payment link'}).click()]);
    assert.equal(providerCalls,2);
    assert.match(await page.locator('main').innerText(),/Provider confirmation pending/);
    const completed=await jobs.processOne(database,runtimeHandlers.create(undefined,handlerOptions),
      {owner:'payment-worker',leaseMs:30000});
    assert.equal(completed.status,'COMPLETED');assert.equal(providerCalls,3);
    assert.equal(await jobs.processOne(database,runtimeHandlers.create(undefined,handlerOptions),
      {owner:'payment-worker',leaseMs:30000}),null);assert.equal(providerCalls,3);
    await page.reload();
    assert.match(await page.locator('main').innerText(),/Ready for customer/);
    assert.equal(await page.getByRole('link',{name:'Open secure page'}).getAttribute('href'),
      'https://payments.example.test/in_fixture_2');

    const event={id:'evt_payment_confirmed',account:'acct_fixture_business',type:'invoice.payment_succeeded',
      data:{object:{id:'in_fixture_2',payment_intent:'pi_fixture_2',amount_paid:2400}}};
    const webhook=await page.request.post(`${base}/webhooks/payments/stripe`,{data:JSON.stringify(event),
      headers:{'content-type':'application/json','x-fixture-signature':'payment-webhook-fixture-secret'}});
    assert.equal(webhook.status(),200);assert.equal((await webhook.json()).applied,true);
    const replay=await page.request.post(`${base}/webhooks/payments/stripe`,{data:JSON.stringify(event),
      headers:{'content-type':'application/json','x-fixture-signature':'payment-webhook-fixture-secret'}});
    assert.equal(replay.status(),200);assert.equal((await replay.json()).replayed,true);
    const paid=(await database.query(`SELECT i.status,i.balance_minor,r.status AS request_status,r.paid_minor,
        (SELECT COUNT(*) FROM accounting_payments p WHERE p.workspace_id=i.workspace_id AND p.sales_order_id=$2) AS payments
      FROM accounting_customer_invoices i JOIN payment_requests r ON r.invoice_id=i.id
      WHERE i.workspace_id=$1 AND i.sales_order_id=$2`,[ctx.workspaceId,order.salesOrderId])).rows[0];
    assert.deepEqual({invoice:paid.status,balance:Number(paid.balance_minor),request:paid.request_status,
      paid:Number(paid.paid_minor),payments:Number(paid.payments)},
    {invoice:'PAID',balance:0,request:'PAID',paid:2400,payments:1});
    await page.reload();assert.match(await page.locator('main').innerText(),/Payment confirmed/);

    const quarantine=await locations.createLocation(database,ctx,{name:'Returns Quarantine',kind:'staging'});
    const requested=await customerReturns.requestCustomerReturn(database,ctx,{salesOrderId:order.salesOrderId,
      quarantineLocationId:quarantine.id,resolution:'REFUND',reason:'Certified provider refund',
      lines:[{salesOrderLineId:order.lineIds[0],quantity:1}],idempotencyKey:'provider-refund-request'});
    await customerReturns.authorizeCustomerReturn(database,ctx,requested.customerReturnId,
      {idempotencyKey:'provider-refund-authorize'});
    const returnState=await customerReturns.getCustomerReturn(database,ctx.workspaceId,requested.customerReturnId);
    await customerReturns.receiveCustomerReturn(database,ctx,requested.customerReturnId,{
      lines:[{lineId:returnState.lines[0].id,quantity:1}],idempotencyKey:'provider-refund-receive'});
    await customerReturns.inspectCustomerReturn(database,ctx,requested.customerReturnId,{
      lines:[{lineId:returnState.lines[0].id,restock:1,scrap:0,repair:0,restockLocationId:location.id}],
      idempotencyKey:'provider-refund-inspect'});
    await page.goto(`${base}/returns/${requested.customerReturnId}`);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve exact refund'}).click()]);
    assert.match(await page.locator('main').innerText(),/Provider confirmation pending/);
    const beforeRefund=(await database.query(`SELECT r.status,i.total_minor,
        (SELECT COUNT(*) FROM accounting_sale_refunds WHERE workspace_id=$1) AS refunds
      FROM customer_returns r JOIN accounting_customer_invoices i ON i.sales_order_id=r.sales_order_id
      WHERE r.workspace_id=$1 AND r.id=$2`,[ctx.workspaceId,requested.customerReturnId])).rows[0];
    assert.deepEqual({status:beforeRefund.status,total:Number(beforeRefund.total_minor),refunds:Number(beforeRefund.refunds)},
      {status:'AWAITING_REFUND',total:2400,refunds:0});
    const refunded=await jobs.processOne(database,runtimeHandlers.create(undefined,handlerOptions),
      {owner:'refund-worker',leaseMs:30000});
    assert.equal(refunded.status,'COMPLETED');assert.equal(providerCalls,4);await page.reload();
    assert.match(await page.locator('main').innerText(),/This return is complete/);
    const afterRefund=(await database.query(`SELECT r.status,i.total_minor,i.balance_minor,pr.status AS provider_status,
        pr.external_refund_id,(SELECT COUNT(*) FROM accounting_sale_refunds WHERE workspace_id=$1) AS refunds
      FROM customer_returns r JOIN accounting_customer_invoices i ON i.sales_order_id=r.sales_order_id
      JOIN payment_refund_requests pr ON pr.customer_return_id=r.id
      WHERE r.workspace_id=$1 AND r.id=$2`,[ctx.workspaceId,requested.customerReturnId])).rows[0];
    assert.deepEqual({status:afterRefund.status,total:Number(afterRefund.total_minor),balance:Number(afterRefund.balance_minor),
      provider:afterRefund.provider_status,external:afterRefund.external_refund_id,refunds:Number(afterRefund.refunds)},
    {status:'COMPLETED',total:1200,balance:0,provider:'SUCCEEDED',external:'refund_fixture_1',refunds:1});

    const uncertain=await fulfilledOrder('uncertain',1);mode='ambiguous';
    await page.goto(`${base}/orders/${uncertain.salesOrderId}`);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Prepare secure payment link'}).click()]);
    const stopped=await jobs.processOne(database,runtimeHandlers.create(undefined,handlerOptions),
      {owner:'payment-worker',leaseMs:30000});
    assert.equal(stopped.status,'DEAD');assert.equal(providerCalls,5);
    assert.equal(await jobs.processOne(database,runtimeHandlers.create(undefined,handlerOptions),
      {owner:'payment-worker',leaseMs:30000}),null);assert.equal(providerCalls,5);
    await page.reload();assert.match(await page.locator('main').innerText(),/Provider outcome needs review/);
    assert.equal(await page.getByRole('button',{name:'Prepare secure payment link'}).count(),0);
    await page.goto(`${base}/needs-you`);assert.match(await page.locator('main').innerText(),/Verify payment request create with stripe/);
    assert.deepEqual(errors,[]);
  });
