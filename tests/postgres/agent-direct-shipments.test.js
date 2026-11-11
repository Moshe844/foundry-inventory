'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const direct=require('../../src/purchasing/agent-direct-shipments');

test('a supplier-direct draft uses the exact customer order and supplier terms, with all plan and replay boundaries',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await f.subscribe('pro');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const skuId=f.item.skuIds[0];
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{
    supplierId:'fixture-supplier',skuId,lastUnitCost:'7.5',purchaseUnit:'box',unitsPerPurchaseUnit:2,
    minimumOrderQuantity:1,orderMultiple:1,isPreferred:true
  });
  const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',fulfillmentLocationId:f.location.id,
    deliveryMethod:'SHIP',idempotencyKey:randomUUID(),lines:[{skuId,quantity:6,unitPriceMinor:1500}]});
  const input={salesOrderId:order.salesOrderId,supplierId:'fixture-supplier',requestKey:randomUUID(),confirmed:'yes',
    lines:[{lineId:order.lineIds[0],quantity:'6'}]};
  await f.subscribe('starter');
  const locked=await f.browser.get(direct.path);
  assert.equal(locked.status,200);
  assert.match(locked.text,/New supplier-direct purchases require Growth/);
  assert.doesNotMatch(locked.text,/Prepare exact supplier purchase draft/);
  await assert.rejects(direct.prepare(db,ctx,{}),error=>error.code==='entitlement_required'&&/Growth/.test(error.message));
  for(const plan of ['growth','pro','enterprise']){
    await f.subscribe(plan);
    const createInput={...input,requestKey:randomUUID()};
    const attempts=await Promise.all([direct.prepare(db,ctx,createInput),direct.prepare(db,ctx,createInput)]);
    assert.equal(attempts[0].id,attempts[1].id);
    const saved=attempts[0];
    assert.equal(saved.purchase_status,'DRAFT');
    assert.equal(saved.delivery_kind,'CUSTOMER_DIRECT');
    assert.equal(saved.facts.customer.address,'10 Jobsite Rd, Albany, NY 12207');
    assert.equal(saved.facts.products[0].quantity,6);
    assert.equal(saved.facts.products[0].purchaseUnits,'3');
    assert.equal(saved.facts.products[0].unitCostMinor,750);
    assert.equal((await db.query('SELECT has_supplier_direct_orders FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0].has_supplier_direct_orders,true);
    let inboxQueries=0;
    const decisions=await direct.inbox({query:(...args)=>{inboxQueries++;return db.query(...args);}},ctx.workspaceId,{installed:true});
    assert.equal(inboxQueries,1);
    assert(decisions.some(decision=>decision.href===direct.path+'/'+saved.id));
    await assert.rejects(db.query("UPDATE purchase_orders SET status='APPROVED' WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId,saved.purchase_order_id]),error=>error.code==='23514'&&/supplier-direct/.test(error.message));
    const detail=await f.browser.get(direct.path+'/'+saved.id);
    assert.equal(detail.status,200,detail.text.slice(-2000));
    assert.match(detail.text,/Approve this exact purchase and destination/);
    const orderPage=await f.browser.get('/purchasing/orders/'+saved.purchase_order_id);
    assert.equal(orderPage.status,303);
    assert.equal(orderPage.headers.location,direct.path+'/'+saved.id);
    const document=await f.browser.get('/purchasing/orders/'+saved.purchase_order_id+'/document');
    assert.equal(document.status,200);
    assert.match(document.text,/10 Jobsite Rd/);
    const po=(await db.query('SELECT destination_location_id,direct_sales_order_id FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,saved.purchase_order_id])).rows[0];
    assert.equal(po.destination_location_id,null);
    assert.equal(po.direct_sales_order_id,order.salesOrderId);
    assert.equal((await db.query('SELECT count(*)::int n FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2 AND destination_location_id IS NOT NULL',
      [ctx.workspaceId,saved.purchase_order_id])).rows[0].n,0);
  }
  const once=await direct.prepare(db,ctx,input);
  const twice=await direct.prepare(db,ctx,input);
  assert.equal(twice.id,once.id);
  assert.equal(twice.replayed,true);
  await assert.rejects(f.workflows.approvePurchaseOrder(db,ctx,once.purchase_order_id,{idempotencyKey:randomUUID()}),/supplier-direct delivery to approve/);
  await assert.rejects(direct.prepare(db,ctx,{...input,lines:[{lineId:order.lineIds[0],quantity:'4'}]}),/different direct-delivery details/);
  await assert.rejects(direct.prepare(db,ctx,{...input,requestKey:randomUUID(),lines:[{lineId:order.lineIds[0],quantity:'5'}]}),/packs, minimum or multiple/);
  await assert.rejects(direct.prepare(db,ctx,{...input,requestKey:randomUUID(),lines:[{lineId:order.lineIds[0],quantity:'8'}]}),/customer quantity still unpromised/);
  await f.subscribe('growth');
  const approval={confirmed:'yes',revision:once.revision,sourceHash:once.source_hash};
  await assert.rejects(direct.approve(db,ctx,once.id,{...approval,routine:'yes'}),error=>error.code==='entitlement_required'&&/Pro/.test(error.message));
  const approved=await direct.approve(db,ctx,once.id,approval);
  assert.equal(approved.purchase_status,'APPROVED');
  assert.equal((await db.query('SELECT direct_committed_quantity::text FROM sales_order_lines WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,order.lineIds[0]])).rows[0].direct_committed_quantity,'6');
  await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
  assert.equal((await db.query('SELECT count(*)::int n FROM sales_order_allocations WHERE workspace_id=$1 AND sales_order_line_id=$2',
    [ctx.workspaceId,order.lineIds[0]])).rows[0].n,0);
  const customerPage=await f.browser.get('/orders/'+order.salesOrderId);
  assert.equal(customerPage.status,200,customerPage.text.slice(-2000));
  assert.match(customerPage.text,/6 ordered units are promised for delivery directly from suppliers/);
  assert.doesNotMatch(customerPage.text,/id="stock-shortage"/);
  await assert.rejects(direct.prepare(db,ctx,{...input,requestKey:randomUUID()}),/customer quantity still unpromised/);
  assert.equal(await f.balance(),20);
  assert.equal((await db.query("SELECT count(*)::int n FROM accounting_customer_invoices WHERE workspace_id=$1",[ctx.workspaceId])).rows[0].n,0);
  assert.equal((await db.query("SELECT direct_committed_quantity::text FROM sales_order_lines WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,order.lineIds[0]])).rows[0].direct_committed_quantity,'6');
  await assert.rejects(db.query(`INSERT INTO sales_order_allocations(id,workspace_id,sales_order_line_id,location_id,quantity,created_at,updated_at)
    VALUES($1,$2,$3,$4,1,now(),now())`,[randomUUID(),ctx.workspaceId,order.lineIds[0],f.location.id]),
    error=>error.code==='23514'&&/supplier-direct/.test(error.message));
  await assert.rejects(db.query("UPDATE sales_orders SET status='CANCELLED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,order.salesOrderId]),
    error=>error.code==='23514'&&/supplier delivery/.test(error.message));
  await assert.rejects(db.query('DELETE FROM sales_order_lines WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,order.lineIds[0]]),
    error=>error.code==='23514'&&/supplier delivery/.test(error.message));
  await assert.rejects(db.query("UPDATE purchase_orders SET status='CANCELLED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,once.purchase_order_id]),
    error=>error.code==='23514'&&/customer promises/.test(error.message));
  await assert.rejects(f.workflows.cancelSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),reason:'Changed mind'}),/goods promised by a supplier/);
  await assert.rejects(f.workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:order.lineIds[0],quantity:1,locationId:f.location.id}]}),/quantity available for this delivery method/);
  const placed=await direct.place(db,ctx,once.id,{revision:approved.revision,sourceHash:approved.source_hash,confirmed:'yes',
    sentExternally:'yes',externalReference:'Supplier accepted exact PO and customer destination by phone, reference CALL-1'});
  assert.equal(placed.purchase_status,'ORDERED');
  await f.subscribe('starter');
  await assert.rejects(direct.prepare(db,ctx,{...input,requestKey:randomUUID()}),error=>error.code==='entitlement_required'&&/Growth/.test(error.message));
  const completionPage=await f.browser.get(direct.path+'/'+once.id);
  assert.equal(completionPage.status,200);
  assert.match(completionPage.text,/manually record its existing supplier delivery/);
  assert.match(completionPage.text,/Prepare dispatch review/);
  assert.doesNotMatch(completionPage.text,/Send exact supplier purchase and dispatch link/);
  const directLine=(await db.query('SELECT id FROM stockchief_runtime.agent_direct_order_lines WHERE workspace_id=$1 AND direct_order_id=$2',
    [ctx.workspaceId,once.id])).rows[0];
  const movementCount=Number((await db.query('SELECT count(*) n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
  for(const [index,quantity] of [2,4].entries()){
    const input={actualShipment:'yes',supplierReference:'SUPPLIER-DISPATCH-'+index,shippedAt:new Date(Date.now()-1000).toISOString(),
      carrier:'UPS',trackingNumber:'1Z999AA10123456784',lines:[{lineId:directLine.id,quantity}]};
    const captured=await direct.capture(db,ctx,once.id,input);
    await assert.rejects(direct.applyDispatch(db,ctx,captured.id,{}, {automatic:true}),error=>error.code==='entitlement_required'&&/Pro/.test(error.message));
    const decision={confirmed:'yes',revision:captured.revision,evidenceHash:require('../../src/pricing/postgres-promotions').hash(captured.original)};
    const applied=await direct.applyDispatch(db,ctx,captured.id,decision);
    assert.equal(applied.status,index===0?'PARTIALLY_FULFILLED':'FULFILLED');
    assert.equal(applied.fulfillmentTotalMinor,quantity*1500);
    assert.equal(applied.lines[0].costMinor,quantity*750);
    assert.equal(applied.lines[0].movementId,null);
    assert.equal((await direct.applyDispatch(db,ctx,captured.id,decision)).replayed,true);
    assert.equal((await direct.capture(db,ctx,once.id,input)).id,captured.id);
    assert.equal(await f.balance(),20);
    const shipment=(await db.query('SELECT * FROM sales_shipments WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,applied.shipments[0].shipmentId])).rows[0];
    assert.equal(shipment.delivery_kind,'CUSTOMER_DIRECT');
    assert.equal(shipment.ship_from_location_id,null);
    assert.equal(shipment.tracking_number,input.trackingNumber);
    const trackingPage=await f.browser.get('/fulfilment/'+shipment.id);
    assert.equal(trackingPage.status,200,trackingPage.text.slice(-2000));
    assert(trackingPage.text.includes(once.facts.products[0].code));
  }
  assert.equal(Number((await db.query('SELECT count(*) n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),movementCount);
  const invoice=(await db.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2',
    [ctx.workspaceId,order.salesOrderId])).rows[0];
  assert.equal(Number(invoice.total_minor),9000);
  assert.equal((await db.query("SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,once.purchase_order_id])).rows[0].status,'RECEIVED');
  const ledger=(await db.query(`SELECT a.system_key,sum(l.debit_minor-l.credit_minor)::int value FROM accounting_journal_lines l
    JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
    JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id
    WHERE e.workspace_id=$1 AND e.source_type='sale_fulfillment' AND e.source_record_id=$2 GROUP BY a.system_key`,
    [ctx.workspaceId,order.salesOrderId])).rows;
  assert.equal(ledger.find(line=>line.system_key==='COST_OF_GOODS_SOLD').value,4500);
  assert.equal(ledger.find(line=>line.system_key==='RECEIVED_NOT_INVOICED').value,-4500);
  assert.equal(ledger.find(line=>line.system_key==='INVENTORY_ASSET'),undefined);
  const receiptEvidence=await require('../../src/purchasing/supplier-invoice-match').receiptEvidence(db,ctx.workspaceId,once.purchase_order_id);
  const received=[...receiptEvidence.values()][0];
  assert.equal(received.proven,true);
  assert.equal(received.quantity,'6');
  assert.equal(received.value,4500);
  const purchaseLine=(await db.query('SELECT id FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2',
    [ctx.workspaceId,once.purchase_order_id])).rows[0];
  const bill=await f.workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:once.purchase_order_id,
    invoiceNumber:'DIRECT-BILL-1',issueDate:await require('../../src/lib/business-time').today(db,ctx.workspaceId),idempotencyKey:randomUUID(),
    lines:[{purchaseOrderLineId:purchaseLine.id,skuId,quantity:6,unitCostMinor:750}],documentTotalMinor:4500});
  assert.equal(bill.status,'OPEN');
  assert.equal(bill.matchStatus,'MATCHED');
  assert.equal(bill.totalMinor,4500);
  assert.equal(await f.balance(),20);
});

test('connected purchase mail, private supplier submissions and the real dispatch worker preserve each plan and current authority',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f;
  const origin=process.env.FOUNDRY_PUBLIC_URL;
  process.env.FOUNDRY_PUBLIC_URL='https://stockchief.example.test';
  t.after(()=>{if(origin===undefined)delete process.env.FOUNDRY_PUBLIC_URL;else process.env.FOUNDRY_PUBLIC_URL=origin;});
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await f.subscribe('pro');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query("UPDATE suppliers SET email='direct-supplier@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,
    status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Direct purchase mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'direct-mailbox',now(),now())`,
    [connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'synthetic-token'}));
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:f.item.skuIds[0],lastUnitCost:'7.50',
    purchaseUnit:'unit',unitsPerPurchaseUnit:1,minimumOrderQuantity:1,orderMultiple:1});
  const outbound=require('../../src/connections/postgres-outbound-mail'),sender=require('../../src/purchasing/direct-shipment-mail');
  const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
  for(const plan of ['growth','pro','enterprise']){
    await f.subscribe(plan);
    const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',fulfillmentLocationId:f.location.id,
      deliveryMethod:'SHIP',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:2,unitPriceMinor:1500}]});
    const draft=await direct.prepare(db,ctx,{salesOrderId:order.salesOrderId,supplierId:'fixture-supplier',requestKey:randomUUID(),confirmed:'yes',
      lines:[{lineId:order.lineIds[0],quantity:2}]});
    const approved=await direct.approve(db,ctx,draft.id,{confirmed:'yes',revision:draft.revision,sourceHash:draft.source_hash,
      routine:plan==='growth'?'no':'yes'});
    const queued=await sender.send(db,ctx,draft.id,{confirmed:'yes',revision:approved.revision,sourceHash:approved.source_hash,connectorId:connector});
    assert.equal((await sender.send(db,ctx,draft.id,{confirmed:'yes',revision:approved.revision,sourceHash:approved.source_hash,connectorId:connector})).replayed,true);
    assert.equal((await db.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,draft.purchase_order_id])).rows[0].status,'APPROVED');
    const mailJobs=require('../../src/operations/postgres-job-queue'),mailKind='agent.mail.supplier_direct_purchase.v1';
    const mailHandler=require('../../src/operations/postgres-runtime-handlers').create({get:()=>provider})[mailKind];
    const sentJob=await mailJobs.processOne(db,{[mailKind]:mailHandler},{owner:'direct-purchase-mail-test'});
    assert.equal(sentJob.status,'COMPLETED',JSON.stringify(sentJob.lastError));
    assert.equal((await db.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,draft.purchase_order_id])).rows[0].status,'ORDERED');
    const sentMessage=sent.at(-1);
    assert.match(sentMessage.body,/Deliver directly to/);
    assert.match(sentMessage.body,/10 Jobsite Rd/);
    assert.match(sentMessage.body,/\$7\.50/);
    const token=/\/supplier\/order\/([A-Za-z0-9_-]{43})/.exec(sentMessage.body)[1];
    const supplierPage=await f.browser.get('/supplier/order/'+token+'/direct-shipment');
    assert.equal(supplierPage.status,200,supplierPage.text.slice(-2000));
    assert.match(supplierPage.text,/Deliver to/);
    const source=(await db.query('SELECT id FROM stockchief_runtime.agent_direct_order_lines WHERE workspace_id=$1 AND direct_order_id=$2',
      [ctx.workspaceId,draft.id])).rows[0];
    const evidence={actualShipment:'yes',supplierReference:'DISPATCH-'+plan,shippedAt:new Date(Date.now()-1000).toISOString(),carrier:'UPS',
      trackingNumber:'1Z999AA10123456784',lines:[{lineId:source.id,quantity:2}]};
    const {lines:submittedLines,...shipmentFields}=evidence;
    const submitted=await f.browser.post('/supplier/order/'+token+'/direct-shipment').type('form').send({
      _csrf:f.csrf(supplierPage.text),...shipmentFields,'lines[0][lineId]':submittedLines[0].lineId,'lines[0][quantity]':submittedLines[0].quantity});
    assert.equal(submitted.status,303,submitted.text.slice(-2000));
    assert.equal(submitted.headers.location,'/supplier/order/'+token+'/direct-shipment?saved=1');
    const dispatch=(await db.query('SELECT * FROM stockchief_runtime.agent_direct_dispatches WHERE workspace_id=$1 AND direct_order_id=$2',
      [ctx.workspaceId,draft.id])).rows[0];
    assert(dispatch,'The supplier submission must persist exact dispatch evidence.');
    const jobs=require('../../src/operations/postgres-job-queue');
    const kind='agent.supplier_direct.dispatch.v1';
    const handler=require('../../src/operations/postgres-runtime-handlers').create()[kind];
    if(plan==='growth'){
      assert.equal(await jobs.claim(db,{owner:'direct-test',kinds:[kind]}),null);
      await assert.rejects(direct.applyDispatch(db,ctx,dispatch.id,{}, {automatic:true}),error=>error.code==='entitlement_required'&&/Pro/.test(error.message));
      await direct.applyDispatch(db,ctx,dispatch.id,{confirmed:'yes',revision:dispatch.revision,
        evidenceHash:require('../../src/pricing/postgres-promotions').hash(dispatch.original)});
    }else{
      const completed=await jobs.processOne(db,{[kind]:handler},{owner:'direct-test'});
      assert.equal(completed.status,'COMPLETED',JSON.stringify(completed.lastError));
      assert.equal(await jobs.processOne(db,{[kind]:handler},{owner:'direct-test'}),null);
    }
    assert.equal((await db.query('SELECT state FROM stockchief_runtime.agent_direct_dispatches WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,dispatch.id])).rows[0].state,'APPLIED');
    assert.equal((await f.browser.get('/supplier/order/'+token+'/direct-shipment')).status,200);
    assert.equal(await f.balance(),20);
  }
  assert.equal(sent.length,3);
  const source=(await db.query(`SELECT * FROM stockchief_runtime.agent_direct_orders WHERE workspace_id=$1
    ORDER BY created_at DESC,id LIMIT 1`,[ctx.workspaceId])).rows[0];
  const routines=require('../../src/purchasing/direct-shipment-routines');
  const ruleInput={confirmed:'yes',revision:0,sourceHash:source.source_hash,maximum:'50.00',connectorId:connector};
  for(const plan of ['starter','growth']){
    await f.subscribe(plan);
    await assert.rejects(routines.configure(db,ctx,source.id,ruleInput),error=>error.code==='entitlement_required'&&/Pro/.test(error.message));
  }
  await f.subscribe('pro');
  const savedRule=await routines.configure(db,ctx,source.id,ruleInput);
  const newOrder=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',fulfillmentLocationId:f.location.id,
    deliveryMethod:'SHIP',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:4,unitPriceMinor:1500}]});
  await f.workflows.confirmSalesOrder(db,ctx,newOrder.salesOrderId,{idempotencyKey:randomUUID()});
  const evaluation=await require('../../src/autopilot/postgres-service').run(db,ctx);
  assert.equal(evaluation.directShipments.queued,1);
  const jobs=require('../../src/operations/postgres-job-queue'),kind=routines.kind;
  const handler=require('../../src/operations/postgres-runtime-handlers').create()[kind];
  const completed=await jobs.processOne(db,{[kind]:handler},{owner:'direct-order-test'});
  assert.equal(completed.status,'COMPLETED',JSON.stringify(completed.lastError));
  const automatic=(await db.query(`SELECT d.*,p.status FROM stockchief_runtime.agent_direct_orders d
    JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
    WHERE d.workspace_id=$1 AND d.sales_order_id=$2`,[ctx.workspaceId,newOrder.salesOrderId])).rows[0];
  assert(automatic,JSON.stringify(completed.result));
  assert.equal(automatic.status,'APPROVED');
  assert.equal(automatic.automatic_purchase,true);
  assert.equal(automatic.rule_id,savedRule.id);
  assert.equal(Number((await db.query(`SELECT count(*) n FROM work_items WHERE workspace_id=$1 AND source='postgres_autopilot'
    AND approval_requirement='NONE' AND purchase_order_id=$2`,[ctx.workspaceId,automatic.purchase_order_id])).rows[0].n),1);
  const effect=(await db.query(`SELECT e.id FROM stockchief_runtime.provider_effects e JOIN supplier_communications m
    ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id WHERE e.workspace_id=$1 AND m.purchase_order_id=$2`,
    [ctx.workspaceId,automatic.purchase_order_id])).rows[0];
  await assert.rejects(outbound.executeSendEffect(db,ctx.workspaceId,effect.id,{provider,beforeSend:()=>f.subscribe('growth')}),
    error=>error.code==='entitlement_required'&&/Pro/.test(error.message));
  assert.equal(sent.length,3);
  assert.equal((await db.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,automatic.purchase_order_id])).rows[0].status,'APPROVED');
  await f.subscribe('starter');
  await direct.stop(db,ctx,automatic.id,{confirmed:'yes',supplierStopped:'yes',revision:automatic.revision,reason:'Supplier confirms pending order stopped, reference STOP-1'});
  assert.equal((await db.query('SELECT direct_committed_quantity::text FROM sales_order_lines WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,newOrder.lineIds[0]])).rows[0].direct_committed_quantity,'0');
  const currentRule=await routines.rule(db,ctx,savedRule.id);
  await routines.configure(db,ctx,source.id,{revision:currentRule.revision,stop:'yes'});
  assert.equal((await routines.rule(db,ctx,savedRule.id)).enabled,false);
  assert.equal(await f.balance(),20);
});
