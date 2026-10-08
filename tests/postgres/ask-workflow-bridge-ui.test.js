'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const commerce=require('../../src/operations/postgres-commerce');
const workflows=require('../../src/operations/postgres-business-workflows');
const transfers=require('../../src/transfers/postgres-transfer-service');
const connections=require('../../src/connections/postgres-service');
const mail=require('../../src/connections/postgres-mail');
const credentials=require('../../src/connections/postgres-credential-store');
const ledger=require('../../src/accounting/postgres-ledger');
const costing=require('../../src/accounting/postgres-costing');
const pricing=require('../../src/pricing/postgres-service');
const imports=require('../../src/imports/postgres-service');
const jobs=require('../../src/operations/postgres-job-queue');
const runtimeHandlers=require('../../src/operations/postgres-runtime-handlers');

function step(capability,args={}){return {capability,arguments:Object.entries(args).map(([name,value])=>({name,value:String(value)})),
  dependsOn:[],continuesPending:false};}
async function register(page,base,business,email){
  await page.goto(`${base}/register`);
  await page.getByLabel('Business name').fill(business);
  await page.getByLabel('Your name').fill(`${business} Owner`);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('ask-workflow-password');
  await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
}
async function prepareAndApprove(page,base,database,workspaceId,message,capability){
  await page.goto(`${base}/ask`);
  await page.getByLabel('Ask StockChief').fill(message);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue'}).click()]);
  const proposal=(await database.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[workspaceId])).rows[0];
  assert.ok(proposal,`Ask did not prepare ${capability}: ${(await page.locator('main').innerText()).slice(0,900)}`);
  assert.equal(proposal.action_type,capability,
    `Ask did not prepare ${capability}: ${(await page.locator('main').innerText()).slice(0,1000)}`);
  assert.equal(proposal.status,'PENDING');
  await page.goto(`${base}/actions/${proposal.id}`);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and execute'}).click()]);
  const saved=(await database.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 AND id=$2`,[workspaceId,proposal.id])).rows[0];
  assert.equal(saved.status,'EXECUTED',`Approval failed: ${(await page.locator('body').innerText()).slice(0,1200)}`);
  return saved;
}

test('Ask browser controls a real customer order, payment, and return through the canonical PostgreSQL engines',
  {timeout:240000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'ask-workflow-bridge-browser'});
    await migratePostgres(database);
    const plans=new Map();
    const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      if(input.schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
      assert.equal(input.schemaName,'stockchief_capability_plan');
      const message=JSON.parse(input.prompt).message;
      const planned=plans.get(message);assert.ok(planned,`No fixture plan for ${message}`);
      return {data:{steps:Array.isArray(planned)?planned:[planned],clarifyingQuestion:''},usage:pricedUsage()};
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'ask-workflow-bridge-secret',aiProvider:provider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage();const other=await browser.newPage();
    await register(page,base,'Workflow One','workflow-one@example.test');
    await register(other,base,'Workflow Two','workflow-two@example.test');
    const owners=(await database.query(`SELECT w.name,w.id AS workspace_id,u.id AS actor_id
      FROM workspaces w JOIN users u ON u.workspace_id=w.id AND u.role='owner'
      WHERE w.name IN ('Workflow One','Workflow Two')`)).rows;
    const one=owners.find((row)=>row.name==='Workflow One');
    const two=owners.find((row)=>row.name==='Workflow Two');
    const ctx={workspaceId:one.workspace_id,actorId:one.actor_id};
    const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,ctx.actorId])).rows[0];
    const catalogue=await require('../../src/assistant/postgres-control-plane').planningCatalogue(database,ctx,actor);
    assert.ok(catalogue.get('sales_order.confirm'));
    const place=await locations.createLocation(database,ctx,{name:'Main Warehouse',kind:'warehouse'});
    const quarantine=await locations.createLocation(database,ctx,{name:'Returns Quarantine',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Work Boot',trackingMode:'quantity'});
    await ledger.configure(database,ctx,{startDate:'2026-01-01',currency:'USD'});
    const opening=await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:place.id,quantity:12,
      reference:'OPENING',idempotencyKey:'ask-workflow-opening'});
    await database.transaction(async(client)=>{
      const posted=await ledger.postInTransaction(client,ctx,{postingDate:'2026-09-23',sourceKey:'ask-workflow-opening-cost',
        description:'Opening work-boot inventory',sourceType:'opening_inventory',sourceRecordType:'movement',
        sourceRecordId:opening.movementId,lines:[{accountKey:'INVENTORY_ASSET',debitMinor:12000},
          {accountKey:'OPENING_BALANCE_EQUITY',creditMinor:12000}]});
      await costing.receiveInTransaction(client,ctx,{movementId:opening.movementId,totalCostMinor:12000,
        journalEntryId:posted.entry.id,sourceType:'opening_inventory',sourceRecordId:opening.movementId});
    },{isolation:'SERIALIZABLE',retrySafe:true});
    const customer=await commerce.createCustomer(database,ctx,{name:'Builder Co',email:'builder@example.test',
      shippingAddress:'10 Builder Street, New York, NY 10001'});
    const bootSupplier=await commerce.createSupplier(database,ctx,{name:'Boot Supply Co'});
    const skuCode=(await database.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,item.skuIds[0]])).rows[0].code;
    const supplierLinkMessage=`Link ${skuCode} to Boot Supply Co at $10.25 per unit with a 12-day lead time; do not place an order`;
    plans.set(supplierLinkMessage,step('supplier.link_product',{recordReference:'Boot Supply Co',sku:skuCode,
      amount:'10.25',leadTimeDays:'12'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,supplierLinkMessage,'supplier.link_product');
    const linked=(await database.query(`SELECT supplier_id,sku_id,last_unit_cost,lead_time_days,is_active
      FROM supplier_items WHERE workspace_id=$1 AND supplier_id=$2 AND sku_id=$3`,
    [ctx.workspaceId,bootSupplier.id,item.skuIds[0]])).rows[0];
    assert.equal(linked.supplier_id,bootSupplier.id);
    assert.equal(linked.sku_id,item.skuIds[0]);
    assert.equal(Number(linked.last_unit_cost),10.25);
    assert.equal(Number(linked.lead_time_days),12);
    assert.equal(Number(linked.is_active),1);
    await pricing.setPrice(database,ctx,{skuId:item.skuIds[0],amountMinor:2500,currency:'USD'});
    const pickup='Prepare a one-boot draft order for Builder Co, customer pickup at Main Warehouse';
    plans.set(pickup,step('sales_order.create',{customer:'Builder Co',sku:'Work Boot',quantity:1,
      deliveryMethod:'customer pickup',location:'Main Warehouse',shipToAddress:'Main Warehouse'}));
    const pickupProposal=await prepareAndApprove(page,base,database,ctx.workspaceId,pickup,'sales_order.create');
    const pickupOrder=(await database.query(`SELECT delivery_method,ship_to_address,fulfillment_location_id,status
      FROM sales_orders WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,pickupProposal.result.salesOrderId])).rows[0];
    assert.deepEqual({method:pickupOrder.delivery_method,address:pickupOrder.ship_to_address,
      location:pickupOrder.fulfillment_location_id,status:pickupOrder.status},
    {method:'PICKUP',address:null,location:place.id,status:'DRAFT'});
    const combined='Create another two-boot order for Builder Co dated 2026-08-14, pickup at Main Warehouse, and reserve the stock';
    plans.set(combined,[step('sales_order.create',{customer:'Builder Co',sku:'Work Boot',quantity:2,
      deliveryMethod:'customer pickup',location:'Main Warehouse',orderDate:'2026-08-14'}),
    {...step('sales_order.confirm',{recordReference:'Builder Co'}),dependsOn:[0]}]);
    const combinedCreate=await prepareAndApprove(page,base,database,ctx.workspaceId,combined,'sales_order.create');
    const combinedConfirm=(await database.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND action_type='sales_order.confirm' ORDER BY created_at DESC,id DESC LIMIT 1`,
    [ctx.workspaceId])).rows[0];
    assert.equal(combinedConfirm.status,'PENDING');
    assert.equal(combinedConfirm.payload.recordId,combinedCreate.result.salesOrderId);
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,combinedCreate.result.salesOrderId])).rows[0].status,'DRAFT');
    await page.goto(`${base}/ask`);
    assert.match(await page.locator('main').innerText(),/1 of 2 parts settled/);
    await page.goto(`${base}/actions/${combinedConfirm.id}`);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and execute'}).click()]);
    const combinedOrder=(await database.query('SELECT status,order_date FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,combinedCreate.result.salesOrderId])).rows[0];
    assert.equal(combinedOrder.status,'CONFIRMED');
    assert.equal(combinedOrder.order_date,'2026-08-14');
    const combinedAllocation=(await database.query(`SELECT a.quantity FROM sales_order_allocations a
      JOIN sales_order_lines l ON l.id=a.sales_order_line_id WHERE a.workspace_id=$1 AND l.sales_order_id=$2`,
    [ctx.workspaceId,combinedCreate.result.salesOrderId])).rows;
    assert.equal(combinedAllocation.reduce((sum,row)=>sum+Number(row.quantity),0),2);
    const created=await workflows.createSalesOrder(database,ctx,{customerId:customer.id,deliveryMethod:'SHIP',
      fulfillmentLocationId:place.id,idempotencyKey:'ask-workflow-order',
      lines:[{skuId:item.skuIds[0],quantity:3,unitPriceMinor:2500}]});
    const orderNumber=created.orderNumber;
    const confirm=`Confirm customer order ${orderNumber} and reserve its available stock`;
    plans.set(confirm,step('sales_order.confirm'));
    await prepareAndApprove(page,base,database,ctx.workspaceId,confirm,'sales_order.confirm');
    let order=(await database.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,created.salesOrderId])).rows[0];
    assert.equal(order.status,'CONFIRMED');
    const allocation=(await database.query(`SELECT quantity FROM sales_order_allocations a
      JOIN sales_order_lines l ON l.id=a.sales_order_line_id WHERE a.workspace_id=$1 AND l.sales_order_id=$2`,
    [ctx.workspaceId,created.salesOrderId])).rows;
    assert.equal(allocation.reduce((sum,row)=>sum+Number(row.quantity),0),3);

    const prioritize=`Set allocation priority of ${orderNumber} to 20`;
    plans.set(prioritize,step('sales_order.allocation_priority',
      {recordReference:orderNumber,allocationPriority:20}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,prioritize,'sales_order.allocation_priority');
    assert.equal(Number((await database.query(`SELECT allocation_priority FROM sales_orders
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,created.salesOrderId])).rows[0].allocation_priority),20);

    const fulfill=`The three boots on ${orderNumber} have physically left; fulfill the order`;
    plans.set(fulfill,step('sales_order.fulfill',{recordReference:orderNumber}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,fulfill,'sales_order.fulfill');
    order=(await database.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,created.salesOrderId])).rows[0];
    assert.equal(order.status,'FULFILLED');
    const invoice=(await database.query(`SELECT id,balance_minor,status FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,created.salesOrderId])).rows[0];
    assert.equal(Number(invoice.balance_minor),7500);
    const balance=(await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,item.skuIds[0],place.id])).rows[0];
    assert.equal(Number(balance.on_hand),9);

    const paid=`Record the full $75 bank-transfer payment already received for ${orderNumber}`;
    plans.set(paid,step('customer_payment.record',{recordReference:orderNumber,amount:'75',paymentMethod:'bank_transfer'}));
    const payment=await prepareAndApprove(page,base,database,ctx.workspaceId,paid,'customer_payment.record');
    assert.equal(payment.result.amountMinor,7500);
    const paidInvoice=(await database.query(`SELECT balance_minor,status FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,invoice.id])).rows[0];
    assert.equal(Number(paidInvoice.balance_minor),0);assert.equal(paidInvoice.status,'PAID');

    const returnMessage=`Request return of one Work Boot on ${orderNumber}; customer says it is damaged; use Returns Quarantine`;
    plans.set(returnMessage,step('customer_return.request',{recordReference:orderNumber,
      sku:'Work Boot',quantity:1,reason:'Damaged',location:'Returns Quarantine',returnResolution:'NO_REFUND'}));
    const requested=await prepareAndApprove(page,base,database,ctx.workspaceId,returnMessage,'customer_return.request');
    const returnId=requested.result.customerReturnId;
    assert.ok(returnId);
    let returned=(await database.query(`SELECT return_number,status,quarantine_location_id FROM customer_returns
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,returnId])).rows[0];
    assert.equal(returned.status,'REQUESTED');assert.equal(returned.quarantine_location_id,quarantine.id);

    const authorize=`Authorize customer return ${returned.return_number}`;
    plans.set(authorize,step('customer_return.authorize',{recordReference:returned.return_number}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,authorize,'customer_return.authorize');
    const receive=`I physically received all authorized goods on customer return ${returned.return_number}`;
    plans.set(receive,step('customer_return.receive',{recordReference:returned.return_number}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,receive,'customer_return.receive');
    returned=(await database.query('SELECT status FROM customer_returns WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,returnId])).rows[0];
    assert.equal(returned.status,'RECEIVED');
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1
      AND sku_id=$2 AND location_id=$3`,[ctx.workspaceId,item.skuIds[0],quarantine.id])).rows[0].on_hand),1);
    const inspect=`Inspect ${requested.result.returnNumber}: the returned unit is damaged; scrap it`;
    plans.set(inspect,step('customer_return.inspect',{recordReference:requested.result.returnNumber,
      disposition:'scrap',reason:'Damaged beyond repair'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,inspect,'customer_return.inspect');
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1
      AND sku_id=$2 AND location_id=$3`,[ctx.workspaceId,item.skuIds[0],quarantine.id])).rows[0].on_hand),0);
    const refundRequest=`Customer returned another Work Boot on ${orderNumber} because it is faulty; refund it into Returns Quarantine`;
    plans.set(refundRequest,step('customer_return.request',{recordReference:orderNumber,
      sku:'Work Boot',quantity:1,reason:'Faulty',location:'Returns Quarantine',returnResolution:'REFUND'}));
    const secondReturn=await prepareAndApprove(page,base,database,ctx.workspaceId,refundRequest,'customer_return.request');
    const refundNumber=secondReturn.result.returnNumber;
    for(const [instruction,capability,args] of [
      [`Authorize ${refundNumber}`,'customer_return.authorize',{recordReference:refundNumber}],
      [`Receive the returned boot on ${refundNumber}`,'customer_return.receive',{recordReference:refundNumber}],
      [`Inspect ${refundNumber} and restock the good boot in Main Warehouse`,'customer_return.inspect',
        {recordReference:refundNumber,disposition:'restock',location:'Main Warehouse',reason:'Good condition'}]]){
      plans.set(instruction,step(capability,args));
      await prepareAndApprove(page,base,database,ctx.workspaceId,instruction,capability);
    }
    const ambiguousRefund=`Handle the refund on ${refundNumber}`;
    plans.set(ambiguousRefund,step('customer_return.refund',{recordReference:refundNumber}));
    await page.goto(`${base}/ask`);
    await page.getByLabel('Ask StockChief').fill(ambiguousRefund);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/reduce an unpaid invoice balance or return money already paid/);
    const clarified=(await database.query(`SELECT status,intent FROM stockchief_runtime.assistant_interactions
      WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    assert.equal(clarified.status,'CLARIFY');
    assert.equal(clarified.intent.controlPlane.capability,'customer_return.refund');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 AND action_type='customer_return.refund'`,[ctx.workspaceId])).rows[0].count,0);
    const refundInstruction=`Refund the paid amount on ${refundNumber} in cash`;
    plans.set(refundInstruction,step('customer_return.refund',
      {recordReference:refundNumber,refundDestination:'CASH'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,refundInstruction,'customer_return.refund');
    const refundState=(await database.query(`SELECT status FROM customer_returns WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,secondReturn.result.customerReturnId])).rows[0];
    assert.equal(refundState.status,'COMPLETED');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM accounting_sale_refunds
      WHERE workspace_id=$1 AND refund_reference=$2`,[ctx.workspaceId,refundNumber])).rows[0].count,1);

    const shipmentOrder=await workflows.createSalesOrder(database,ctx,{customerId:customer.id,
      deliveryMethod:'SHIP',fulfillmentLocationId:place.id,idempotencyKey:'ask-workflow-shipping-order',
      lines:[{skuId:item.skuIds[0],quantity:1,unitPriceMinor:2500}]});
    await workflows.confirmSalesOrder(database,ctx,shipmentOrder.salesOrderId,
      {idempotencyKey:'ask-workflow-shipping-confirm'});
    const pack=`Pack the allocated boot on ${shipmentOrder.orderNumber} for shipment`;
    plans.set(pack,step('shipping.prepare',{recordReference:shipmentOrder.orderNumber}));
    const preparedShipment=await prepareAndApprove(page,base,database,ctx.workspaceId,pack,'shipping.prepare');
    const shipmentId=preparedShipment.result.shipmentId;
    const shipmentNumber=preparedShipment.result.shipmentNumber;
    assert.equal((await database.query('SELECT status FROM sales_shipments WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,shipmentId])).rows[0].status,'PACKED');
    const measure=`The package for ${shipmentNumber} weighs 850 grams and measures 300 by 220 by 140 millimeters`;
    plans.set(measure,step('shipping.package_measurement',{recordReference:shipmentNumber,
      weightGrams:850,lengthMm:300,widthMm:220,heightMm:140}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,measure,'shipping.package_measurement');
    assert.equal(Number((await database.query(`SELECT weight_grams FROM shipment_packages
      WHERE workspace_id=$1 AND shipment_id=$2`,[ctx.workspaceId,shipmentId])).rows[0].weight_grams),850);
    const handoff=`Carrier picked up ${shipmentNumber} with tracking 1Z999AA10123456784`;
    plans.set(handoff,step('shipping.handoff',{recordReference:shipmentNumber,
      handover:'CARRIER',trackingNumber:'1Z999AA10123456784'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,handoff,'shipping.handoff');
    assert.equal((await database.query('SELECT status FROM sales_shipments WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,shipmentId])).rows[0].status,'SHIPPED');
    assert.equal((await database.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,shipmentOrder.salesOrderId])).rows[0].status,'FULFILLED');
    const delivered=`The parcel ${shipmentNumber} was delivered to the customer`;
    plans.set(delivered,step('shipping.delivered',{recordReference:shipmentNumber}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,delivered,'shipping.delivered');
    assert.equal((await database.query('SELECT status FROM sales_shipments WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,shipmentId])).rows[0].status,'DELIVERED');
    const at=new Date().toISOString();
    await database.query(`INSERT INTO payment_connect_accounts
      (id,workspace_id,provider,provider_account_id,display_name,charges_enabled,livemode,checked_at,
       connected_by_user_id,created_at,updated_at)
      VALUES('ask-payment-account',$1,'stripe','acct_fixture_ask','Fixture merchant',1,0,$2,$3,$2,$2)`,
    [ctx.workspaceId,at,ctx.actorId]);
    const link=`Prepare a Stripe payment link for the open balance on ${shipmentOrder.orderNumber}`;
    plans.set(link,step('customer_payment.link',{recordReference:shipmentOrder.orderNumber,paymentPurpose:'BALANCE'}));
    const linkProposal=await prepareAndApprove(page,base,database,ctx.workspaceId,link,'customer_payment.link');
    assert.equal(linkProposal.result.request.amountMinor,2500);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM payment_requests
      WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,shipmentOrder.salesOrderId])).rows[0].count,1);
    const shipmentInvoice=(await database.query(`SELECT id,invoice_number FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND sales_order_id=$2`,
    [ctx.workspaceId,shipmentOrder.salesOrderId])).rows[0];
    const standalonePayment=`Record the $25 cash payment already received for invoice ${shipmentInvoice.invoice_number}`;
    plans.set(standalonePayment,step('customer_invoice.payment',{recordReference:shipmentInvoice.invoice_number,
      amount:25,paymentMethod:'cash'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,standalonePayment,'customer_invoice.payment');
    assert.equal(Number((await database.query(`SELECT balance_minor FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,shipmentInvoice.id])).rows[0].balance_minor),0);
    await page.goto(`${base}/actions/${linkProposal.id}`);
    const csrf=await page.locator('input[name="_csrf"]').first().getAttribute('value');
    const replay=await page.request.post(`${base}/actions/${linkProposal.id}/approve`,
      {form:{_csrf:csrf},maxRedirects:0});
    assert.equal(replay.status(),303);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM payment_requests
      WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,shipmentOrder.salesOrderId])).rows[0].count,1);

    const destination=await locations.createLocation(database,ctx,{name:'Branch Store',kind:'store'});
    const requestedTransfer=await transfers.request(database,ctx,{fromLocationId:place.id,toLocationId:destination.id,
      idempotencyKey:'ask-workflow-transfer',lines:[{skuId:item.skuIds[0],quantity:2}]});
    const transferNumber=requestedTransfer.transfer_number;
    for(const [verb,capability] of [
      ['approve','transfer.approve'],['pick','transfer.pick'],['dispatch','transfer.dispatch'],
      ['mark in transit','transfer.in_transit'],['receive all good units','transfer.receive']]){
      const instruction=`${verb} inventory transfer ${transferNumber}`;
      plans.set(instruction,step(capability,{recordReference:transferNumber}));
      await prepareAndApprove(page,base,database,ctx.workspaceId,instruction,capability);
    }
    const transferState=(await database.query(`SELECT status FROM inventory_transfers WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,requestedTransfer.id])).rows[0];
    assert.equal(transferState.status,'RECEIVED');
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1
      AND sku_id=$2 AND location_id=$3`,[ctx.workspaceId,item.skuIds[0],destination.id])).rows[0].on_hand),2);
    const supplier=await commerce.createSupplier(database,ctx,{name:'Safety Supply',email:'supply@example.test'});
    const bill='Record Safety Supply invoice SS-EXP-1 for one safety audit at $20 plus $2 tax';
    plans.set(bill,step('supplier_bill.create',{recordReference:'Safety Supply',
      supplierInvoiceNumber:'SS-EXP-1',description:'Safety audit',quantity:1,unitAmount:20,tax:2}));
    const recordedBill=await prepareAndApprove(page,base,database,ctx.workspaceId,bill,'supplier_bill.create');
    assert.equal(recordedBill.result.totalMinor,2200);
    assert.equal((await database.query(`SELECT status FROM accounting_supplier_bills
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,recordedBill.result.billId])).rows[0].status,'OPEN');
    const mailConnectorId='ask-workflow-mailbox';const mailAt=new Date().toISOString();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
       expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,'Workflow Mailbox','gmail','connected','[]','[]','{}',5,'CONNECTED',$4,$5,$5)`,
    [mailConnectorId,ctx.workspaceId,`gmail:${mailConnectorId}`,ctx.actorId,mailAt]);
    const mailMessage=await mail.capture(database,{id:mailConnectorId,workspace_id:ctx.workspaceId,
      provider_type:'gmail'},{externalMessageId:'ask-mail-1',sender:'supply@example.test',
      subject:'Safety Supply delivery update',bodyText:'Can you confirm the delivery date?',
      receivedAt:mailAt});
    assert.equal(mailMessage.accepted,true);
    assert.equal((await database.query(`SELECT reply_state FROM connection_email_messages
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,mailMessage.messageId])).rows[0].reply_state,'NEEDS_REPLY');
    const handled='The Safety Supply delivery update needs no response; mark it handled';
    plans.set(handled,step('mail.state',{recordReference:'Safety Supply delivery update',
      mailboxState:'handled',reason:'No response needed'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,handled,'mail.state');
    assert.equal((await database.query(`SELECT reply_state FROM connection_email_messages
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,mailMessage.messageId])).rows[0].reply_state,'HANDLED');
    await database.query(`UPDATE workspace_connectors SET credential_ref=$3 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,mailConnectorId,`connection_credentials:${mailConnectorId}`]);
    await database.transaction((client)=>credentials.put(client,ctx.workspaceId,mailConnectorId,'provider',
      {accessToken:'synthetic-mail-token'}));
    await mail.setState(database,ctx,mailMessage.messageId,'NEEDS_REPLY','Owner changed their mind.');
    await mail.saveDraft(database,ctx,mailMessage.messageId,{subject:'Re: Safety Supply delivery update',
      body:'Thanks for the update. Please confirm the delivery date.'});
    const sendReply='Send my saved reply to the Safety Supply delivery update';
    plans.set(sendReply,step('mail.send_saved_reply',{recordReference:'Safety Supply delivery update'}));
    const sentProposal=await prepareAndApprove(page,base,database,ctx.workspaceId,sendReply,
      'mail.send_saved_reply');
    assert.equal((await database.query(`SELECT status FROM stockchief_runtime.email_reply_outbox
      WHERE workspace_id=$1 AND message_id=$2`,[ctx.workspaceId,mailMessage.messageId])).rows[0].status,'PENDING');
    const deliveredReplies=[];
    await mail.executeSendEffect(database,ctx.workspaceId,sentProposal.result.effectId,{provider:{
      async send({message}){deliveredReplies.push(message);return {externalMessageId:'synthetic-sent-1'};}}});
    assert.equal(deliveredReplies.length,1);
    assert.equal((await database.query(`SELECT reply_state FROM connection_email_messages
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,mailMessage.messageId])).rows[0].reply_state,'WAITING');
    await page.goto(`${base}/actions/${sentProposal.id}`);
    const mailCsrf=await page.locator('input[name="_csrf"]').first().getAttribute('value');
    const mailReplay=await page.request.post(`${base}/actions/${sentProposal.id}/approve`,
      {form:{_csrf:mailCsrf},maxRedirects:0});
    assert.equal(mailReplay.status(),303);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM stockchief_runtime.email_reply_outbox
      WHERE workspace_id=$1 AND message_id=$2`,[ctx.workspaceId,mailMessage.messageId])).rows[0].count,1);
    assert.equal(deliveredReplies.length,1);
    const purchase=await workflows.createPurchaseOrder(database,ctx,{supplierId:supplier.id,
      destinationLocationId:place.id,idempotencyKey:'ask-workflow-purchase',
      lines:[{skuId:item.skuIds[0],quantityUnits:5,unitCost:10,destinationLocationId:place.id}]});
    const revisePurchase=`Change the draft quantity on ${purchase.poNumber} for ${skuCode} from five to seven units without approving or sending it`;
    plans.set(revisePurchase,step('purchase_order.revise_draft_line',{recordReference:purchase.poNumber,
      sku:skuCode,quantity:7}));
    const revision=await prepareAndApprove(page,base,database,ctx.workspaceId,revisePurchase,
      'purchase_order.revise_draft_line');
    const revisedLine=(await database.query(`SELECT quantity_units,quantity_purchase_units,line_total
      FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2`,
    [ctx.workspaceId,purchase.purchaseOrderId])).rows[0];
    assert.equal(Number(revisedLine.quantity_units),7);
    assert.equal(Number(revisedLine.quantity_purchase_units),7);
    assert.equal(Number(revisedLine.line_total),70);
    assert.equal((await database.query(`SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,purchase.purchaseOrderId])).rows[0].status,'DRAFT');
    const revisionReplay=await workflows.reviseDraftPurchaseOrderLine(database,ctx,purchase.purchaseOrderId,
      {...revision.payload,idempotencyKey:revision.idempotency_key});
    assert.equal(revisionReplay.replayed,true);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM purchase_order_events
      WHERE workspace_id=$1 AND purchase_order_id=$2 AND event='draft_line_revised'`,
    [ctx.workspaceId,purchase.purchaseOrderId])).rows[0].count,1);
    const approvePurchase=`Approve supplier purchase order ${purchase.poNumber}`;
    plans.set(approvePurchase,step('purchase_order.approve',{recordReference:purchase.poNumber}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,approvePurchase,'purchase_order.approve');
    const placePurchase=`Record that ${purchase.poNumber} was placed with Safety Supply under reference SS-45`;
    plans.set(placePurchase,step('purchase_order.place',{recordReference:purchase.poNumber,reference:'SS-45'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,placePurchase,'purchase_order.place');
    const ordered=(await database.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,purchase.purchaseOrderId])).rows[0];
    assert.equal(ordered.status,'ORDERED');
    const cancelPurchase=`Cancel ${purchase.poNumber}; the supplier says it cannot ship`;
    plans.set(cancelPurchase,step('purchase_order.cancel',{recordReference:purchase.poNumber,
      reason:'Supplier cannot ship'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,cancelPurchase,'purchase_order.cancel');
    assert.equal((await database.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,purchase.purchaseOrderId])).rows[0].status,'CANCELLED');
    const uiPurchase=await workflows.createPurchaseOrder(database,ctx,{supplierId:supplier.id,
      destinationLocationId:place.id,idempotencyKey:'ask-workflow-ui-purchase',
      lines:[{skuId:item.skuIds[0],quantityUnits:1,unitCost:10,destinationLocationId:place.id}]});
    await page.goto(`${base}/purchasing/orders/${uiPurchase.purchaseOrderId}`);
    const uiCsrf=await page.locator('input[name="_csrf"]').first().getAttribute('value');
    const uiCancelled=await page.request.post(`${base}/purchasing/orders/${uiPurchase.purchaseOrderId}/cancel`,
      {form:{_csrf:uiCsrf,reason:'Supplier unavailable'},maxRedirects:0});
    assert.equal(uiCancelled.status(),303);
    assert.equal((await database.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,uiPurchase.purchaseOrderId])).rows[0].status,'CANCELLED');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM purchase_order_events
      WHERE workspace_id=$1 AND purchase_order_id=$2 AND event='cancelled'`,
    [ctx.workspaceId,uiPurchase.purchaseOrderId])).rows[0].count,1);
    for(const [instruction,capability,args] of [
      ['Pause automatic work while we review a stock problem','autopilot.pause',
        {reason:'Reviewing a stock problem'}],
      ['Keep StockChief in watch-only mode','autopilot.mode',{mode:'OBSERVE'}],
      ['Resume automatic monitoring under the current rules','autopilot.resume',{}]]){
      plans.set(instruction,step(capability,args));
      await prepareAndApprove(page,base,database,ctx.workspaceId,instruction,capability);
    }
    const autopilot=(await database.query('SELECT mode,paused FROM workspace_autopilot WHERE workspace_id=$1',
      [ctx.workspaceId])).rows[0];
    assert.equal(autopilot.mode,'OBSERVE');assert.equal(Number(autopilot.paused),0);
    const feed=await connections.createFeed(database,ctx,{displayName:'Warehouse Event Feed'});
    for(const [instruction,capability] of [
      ['Pause Warehouse Event Feed','connection.pause'],
      ['Resume Warehouse Event Feed','connection.resume'],
      ['Disconnect Warehouse Event Feed and revoke its token','connection.disconnect']]){
      plans.set(instruction,step(capability,{recordReference:'Warehouse Event Feed'}));
      await prepareAndApprove(page,base,database,ctx.workspaceId,instruction,capability);
    }
    const connector=(await database.query(`SELECT status,credential_ref,paused_at FROM workspace_connectors
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,feed.connection.id])).rows[0];
    assert.equal(connector.status,'disconnected');assert.equal(connector.credential_ref,null);
    assert.ok(connector.paused_at);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM connector_feed_tokens
      WHERE workspace_id=$1 AND connector_id=$2 AND revoked_at IS NOT NULL`,
    [ctx.workspaceId,feed.connection.id])).rows[0].count,1);
    const rename='Rename this inventory to Workflow One Operations';
    plans.set(rename,step('workspace.rename',{workspaceName:'Workflow One Operations'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,rename,'workspace.rename');
    assert.equal((await database.query('SELECT name FROM workspaces WHERE id=$1',
      [ctx.workspaceId])).rows[0].name,'Workflow One Operations');
    const invite='Invite Jamie at jamie@example.test as an accountant';
    plans.set(invite,step('team.invite',{inviteeName:'Jamie',inviteeEmail:'jamie@example.test',
      memberRole:'accountant'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,invite,'team.invite');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM workspace_invitations
      WHERE workspace_id=$1 AND email='jamie@example.test' AND role='accountant' AND status='PENDING'`,
    [ctx.workspaceId])).rows[0].count,1);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM users
      WHERE workspace_id=$1 AND name='Jamie'`,[ctx.workspaceId])).rows[0].count,0);
    const alerts='Enable important email alerts for ops@example.test and owner@example.test';
    plans.set(alerts,step('settings.email_alerts',{enabled:true,minimumSeverity:'important',
      recipientEmails:'ops@example.test, owner@example.test'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,alerts,'settings.email_alerts');
    const alertState=(await database.query(`SELECT enabled,minimum_severity,recipients
      FROM notification_email_settings WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];
    assert.equal(Number(alertState.enabled),1);
    assert.equal(alertState.minimum_severity,'important');
    assert.deepEqual(JSON.parse(alertState.recipients),['ops@example.test','owner@example.test']);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM notification_email_settings
      WHERE workspace_id=$1`,[two.workspace_id])).rows[0].count,0);
    const importPlan=await imports.analyse(database,ctx,{text:
      'Product,SKU,Location,Quantity\nAsk Imported Clamp,AIC-1,Main Warehouse,4\n',
    filename:'ask-workflow-opening.csv'});
    const approveImport='Approve the ask-workflow-opening.csv preview without importing yet';
    plans.set(approveImport,step('import.approve',{recordReference:'ask-workflow-opening.csv'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,approveImport,'import.approve');
    assert.equal((await database.query(`SELECT approval_status FROM import_plans
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,importPlan.id])).rows[0].approval_status,'APPROVED');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM items
      WHERE workspace_id=$1 AND name='Ask Imported Clamp'`,[ctx.workspaceId])).rows[0].count,0);
    const runImport='Import and verify the approved ask-workflow-opening.csv preview';
    plans.set(runImport,step('import.run',{recordReference:'ask-workflow-opening.csv'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,runImport,'import.run');
    const importHandler=runtimeHandlers.create()['import.execute-approved'];
    const completedImport=await jobs.processOne(database,
      {'import.execute-approved':importHandler},{owner:'ask-import-worker'});
    assert.equal(completedImport.status,'COMPLETED');
    assert.equal((await database.query(`SELECT status FROM import_plans WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,importPlan.id])).rows[0].status,'SUCCEEDED');
    assert.equal(Number((await database.query(`SELECT SUM(b.on_hand) AS units FROM balances b
      JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id JOIN items i ON i.id=s.item_id
      WHERE b.workspace_id=$1 AND i.name='Ask Imported Clamp'`,
      [ctx.workspaceId])).rows[0].units),4);
    const discardedImport=await imports.analyse(database,ctx,{text:
      'Product,SKU,Location,Quantity\nDo Not Import,DNI-1,Main Warehouse,2\n',
    filename:'discard-this-preview.csv'});
    const cancelImport='Cancel the discard-this-preview.csv import preview without touching inventory';
    plans.set(cancelImport,step('import.cancel',{recordReference:'discard-this-preview.csv'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,cancelImport,'import.cancel');
    assert.equal((await database.query(`SELECT status FROM import_plans WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,discardedImport.id])).rows[0].status,'CANCELLED');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM items
      WHERE workspace_id=$1 AND name='Do Not Import'`,[ctx.workspaceId])).rows[0].count,0);
    const shippingMode='Show shipping rates for approval instead of handling postage automatically';
    plans.set(shippingMode,step('shipping.operation_mode',{mode:'RECOMMEND'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,shippingMode,'shipping.operation_mode');
    assert.equal((await database.query(`SELECT mode FROM shipping_operation_policy WHERE workspace_id=$1`,
      [ctx.workspaceId])).rows[0].mode,'RECOMMEND');
    const rule='Only consider UPS Ground if postage is no more than $15 and delivery takes at most 5 days';
    plans.set(rule,step('shipping.rule.create',{carrier:'UPS',service:'Ground',maxCost:15,maxDeliveryDays:5}));
    const createdRule=await prepareAndApprove(page,base,database,ctx.workspaceId,rule,'shipping.rule.create');
    const ruleRow=(await database.query(`SELECT name,max_cost_minor,max_delivery_days,is_active
      FROM shipping_rules WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,createdRule.result.id])).rows[0];
    assert.equal(Number(ruleRow.max_cost_minor),1500);
    assert.equal(Number(ruleRow.max_delivery_days),5);
    assert.equal(Number(ruleRow.is_active),1);
    const disableRule=`Turn off shipping rule ${ruleRow.name}`;
    plans.set(disableRule,step('shipping.rule.disable',{recordReference:ruleRow.name}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,disableRule,'shipping.rule.disable');
    assert.equal(Number((await database.query(`SELECT is_active FROM shipping_rules WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,createdRule.result.id])).rows[0].is_active),0);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM shipping_rules
      WHERE workspace_id=$1`,[two.workspace_id])).rows[0].count,0);
    const updateProduct='Rename Work Boot to Work Boot Classic and keep its other details';
    plans.set(updateProduct,step('catalog.update_item',{recordReference:'Work Boot',
      itemName:'Work Boot Classic'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,updateProduct,'catalog.update_item');
    assert.equal((await database.query('SELECT name FROM items WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,item.itemId])).rows[0].name,'Work Boot Classic');
    const customerUpdate='Change Builder Co email to purchasing@builder.example';
    plans.set(customerUpdate,step('customer.update',{recordReference:'Builder Co',
      recipientEmail:'purchasing@builder.example'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,customerUpdate,'customer.update');
    assert.equal((await database.query('SELECT email FROM customers WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,customer.id])).rows[0].email,'purchasing@builder.example');
    const supplierUpdate='Update Safety Supply contact name to Dana';
    plans.set(supplierUpdate,step('supplier.update',{recordReference:'Safety Supply',contactName:'Dana'}));
    await prepareAndApprove(page,base,database,ctx.workspaceId,supplierUpdate,'supplier.update');
    assert.equal((await database.query('SELECT contact_name FROM suppliers WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,supplier.id])).rows[0].contact_name,'Dana');
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM customer_returns WHERE workspace_id=$1`,
      [two.workspace_id])).rows[0].count,0);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM sales_orders WHERE workspace_id=$1`,
      [two.workspace_id])).rows[0].count,0);
  });
