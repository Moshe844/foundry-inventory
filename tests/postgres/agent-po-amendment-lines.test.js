'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
test('a supplier can submit exact quantity, price and date changes for owner review while earlier receipts and invoices keep their original cost',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-po-date-fixture').fixture(t);
  const {db,ctx,po,location,workflows}=f;
  const originalLineId=po.lineIds[0],skuId=f.item.skuIds[0];
  const receive=(lineId,quantity)=>workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{
    idempotencyKey:randomUUID(),lines:[{lineId,quantity,locationId:location.id}]});
  const invoice=(lineId,quantity,unitCostMinor)=>workflows.recordSupplierInvoice(db,ctx,{
    supplierId:'fixture-supplier',purchaseOrderId:po.purchaseOrderId,supplierInvoiceNumber:randomUUID(),
    issueDate:f.today,idempotencyKey:randomUUID(),documentTotalMinor:quantity*unitCostMinor,
    lines:[{purchaseOrderLineId:lineId,skuId,quantity,unitCostMinor}]});
  await receive(originalLineId,4);
  const oldBill=await invoice(originalLineId,4,100);
  assert.equal(oldBill.matchStatus,'MATCHED');

  const portal='/supplier/order/'+f.token;
  for(const plan of ['starter','growth']){
    await f.subscribe(plan);
    const page=await f.browser.get(portal).expect(200);
    assert.doesNotMatch(page.text,/Propose a quantity or price change/);
    await f.browser.get(portal+'/amendment').expect(402);
  }
  await f.subscribe('pro');
  const supplier=await f.browser.get(portal+'/amendment').expect(200);
  assert.match(supplier.text,/Still due 8/);
  const revision=/name="revision" value="([^"]+)"/.exec(supplier.text)[1];
  const submission={_csrf:f.csrf(supplier.text),confirmed:'yes',revision,date:f.date(2),
    'terms[0][lineId]':originalLineId,'terms[0][quantity]':'6','terms[0][price]':'1.25'};
  await f.browser.post(portal+'/amendment').type('form').send(submission).expect(303);
  const source=(await db.query("SELECT id FROM stockchief_runtime.supplier_link_submissions WHERE workspace_id=$1 AND kind='amendment'",[ctx.workspaceId])).rows[0];
  assert(source);
  assert.equal((await f.order()).expected_date,f.date(1));
  assert.equal((await f.service.onArrival(db,ctx.workspaceId,source.id)).held,true);
  const path='/autopilot/po-delivery-dates/'+source.id;
  const owner=await f.browser.get(path).expect(200);
  assert.match(owner.text,/Proposed changes to goods still due/);
  assert.match(owner.text,/\$1\.25/);
  const approval={_csrf:f.csrf(owner.text),confirmed:'yes',
    expectedFingerprint:/name="expectedFingerprint" value="([^"]+)"/.exec(owner.text)[1]};
  await f.subscribe('growth');
  const refused=await f.browser.post(path).set('Accept','application/json').type('form').send(approval).expect(402);
  assert.equal(refused.body.error.code,'entitlement_required');
  await f.subscribe('pro');
  await f.browser.post(path).type('form').send(approval).expect(303);
  await f.browser.post(path).type('form').send(approval).expect(303);
  await f.browser.post(portal+'/amendment').type('form').send(submission).expect(303);
  assert.equal((await f.order()).expected_date,f.date(2));
  const events=(await db.query(`SELECT detail FROM purchase_order_events WHERE workspace_id=$1 AND purchase_order_id=$2
    AND event='supplier_purchase_amended'`,[ctx.workspaceId,po.purchaseOrderId])).rows;
  assert.equal(events.length,1);
  const saved=(typeof events[0].detail==='string'?JSON.parse(events[0].detail):events[0].detail).revisions;
  assert.equal(saved[0].retained.totalMinor,400);
  assert.equal(saved[0].replacement.totalMinor,750);
  const newLineId=saved[0].replacementLineId;
  assert(newLineId);
  assert.notEqual(newLineId,originalLineId);
  const native=(await db.query(`SELECT id,quantity_units::text,quantity_received_units::text,unit_cost
    FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY line_number`,
  [ctx.workspaceId,po.purchaseOrderId])).rows;
  assert.deepEqual(native.map(row=>[row.id,Number(row.quantity_units),Number(row.quantity_received_units),Number(row.unit_cost)]),
    [[originalLineId,4,4,1],[newLineId,6,0,1.25]]);
  assert.equal(await f.balance(),8);
  await assert.rejects(workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),
    overReceiptApproved:true,lines:[{lineId:originalLineId,quantity:1,locationId:location.id}]}),/closed by a supplier change/);
  await receive(newLineId,6);
  const newBill=await invoice(newLineId,6,125);
  assert.equal(newBill.matchStatus,'MATCHED');
  assert.equal(await f.balance(),14);
  const evidence=await require('../../src/purchasing/supplier-invoice-match').receiptEvidence(db,ctx.workspaceId,po.purchaseOrderId);
  assert.deepEqual([...evidence.values()].map(row=>[row.purchase_order_line_id,row.quantity,row.value,row.proven]).sort(),
    [[originalLineId,'4',400,true],[newLineId,'6',750,true]].sort());
  const report=await require('../../src/autopilot/time-saved').report(db,ctx,'week');
  assert.equal(report.rows.find(row=>row.key==='po-supplier-amendment').count,1);
  assert.equal(report.rows.find(row=>row.key==='po-supplier-amendment').minutes,null);
});

test('Pro needs an approved example, Custom can authorize a routine scope, and above-limit sources stay pending',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-po-date-fixture').fixture(t);
  const {db,ctx,po,service}=f;
  const link=require('../../src/purchasing/po-amendment-link');
  const policy=require('../../src/commercial/agent-plan');
  const source=async (quantity,price)=>{
    const {revision}=await link.page(db,f.token);
    return (await link.submit(db,f.token,{confirmed:'yes',revision,terms:[{lineId:po.lineIds[0],quantity,price}]})).id;
  };
  const limits={...f.caps,maximumQuantityPercent:'25',maximumPricePercent:'25',maximumOrderIncrease:'10.00',confirmed:'yes',revision:0};
  const automatic=id=>service.onArrival(db,ctx.workspaceId,id);
  const current=async()=>{
    const row=(await db.query('SELECT quantity_units,unit_cost FROM purchase_order_lines WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,po.lineIds[0]])).rows[0];
    return [Number(row.quantity_units),Number(row.unit_cost)];
  };
  await f.subscribe('enterprise');
  const example=await source('12','0.95');
  await service.configure(db,ctx,example,limits);
  const handler=require('../../src/operations/postgres-runtime-handlers').create()[service.jobKind];
  const worker=()=>require('../../src/operations/postgres-job-queue').processOne(db,{[service.jobKind]:handler},{owner:'po-amendment-test'});
  assert.equal((await worker()).result.held,true,'A response before authority stays pending');
  const custom=await source('12','0.93');
  const completed=await worker();
  assert.equal(completed.status,'COMPLETED');
  assert.equal(completed.result.automatic,true);
  assert.equal((await service.saved(db,ctx.workspaceId,custom)).changed,true);
  assert.deepEqual(await current(),[12,0.93]);
  await f.subscribe('pro');
  const exampleForPro=await source('12','1.05');
  assert.match((await automatic(exampleForPro)).reason,/teach its scope/);
  await f.approve(exampleForPro);
  await service.teach(db,ctx,exampleForPro,limits);
  const routine=await source('13','1.10');
  const results=await Promise.all([automatic(routine),automatic(routine)]);
  assert.equal(results.filter(result=>result.automatic&&!result.replayed).length,1);
  assert.deepEqual(await current(),[13,1.10]);
  assert.deepEqual(await policy.automaticPurchaseCommitments(db,await policy.accountState(db,ctx.workspaceId),'USD'),
    {committed:170,unknown:false});
  const outside=await source('30','1.10');
  assert.match((await automatic(outside)).reason,/quantity or weight change/);
  assert.deepEqual(await current(),[13,1.10]);
  await f.subscribe('enterprise');
  await db.query(`UPDATE commercial_plan_versions SET configuration=jsonb_set(configuration,'{agentPurchaseLimits}',
    '{"currency":"USD","perOrder":30,"perWeek":2}'::jsonb)
    WHERE plan_id='enterprise' AND status='ACTIVE'`);
  const overBudget=await source('13','1.15');
  assert.match((await automatic(overBudget)).reason,/weekly automatic purchasing limit/);
  assert.deepEqual(await current(),[13,1.10]);
  assert.equal(await f.balance(),4);
});

test('a confirmed zero-quantity response closes incoming stock with the native cancellation and retains the source',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-po-date-fixture').fixture(t);
  const {db,ctx,po,service}=f,link=require('../../src/purchasing/po-amendment-link');
  const {revision}=await link.page(db,f.token);
  const stale=await link.submit(db,f.token,{confirmed:'yes',revision,
    terms:[{lineId:po.lineIds[0],price:'1.30'}]});
  await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:po.lineIds[0],quantity:1,locationId:f.location.id}]});
  await assert.rejects(service.preview(db,ctx,stale.id),/changed after this supplier response/);
  const another=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:12,unitCost:1}]});
  await f.workflows.approvePurchaseOrder(db,ctx,another.purchaseOrderId,{idempotencyKey:randomUUID()});
  await f.workflows.placePurchaseOrder(db,ctx,another.purchaseOrderId,{idempotencyKey:randomUUID()});
  const url=await db.transaction(c=>f.links.issue(c,ctx.workspaceId,another.purchaseOrderId,'delivery@example.test','https://stockchief.example.test'));
  const token=new URL(url).pathname.split('/').at(-1),current=await link.page(db,token);
  const terms={confirmed:'yes',revision:current.revision,terms:[{lineId:another.lineIds[0],quantity:'0'}]};
  const source=await link.submit(db,token,terms);
  const approval=await f.approve(source.id);
  assert.equal(approval.changed,true);
  const status=(await db.query('SELECT status FROM purchase_orders WHERE id=$1',[another.purchaseOrderId])).rows[0].status;
  assert.equal(status,'CANCELLED');
  assert.equal((await service.apply(db,ctx,source.id)).replayed,true);
  assert.deepEqual(await link.submit(db,token,terms),{id:source.id,replayed:true});
  const line=(await db.query('SELECT quantity_units,quantity_received_units,supplier_amendment_closed_at FROM purchase_order_lines WHERE id=$1',[another.lineIds[0]])).rows[0];
  assert.equal(Number(line.quantity_units),0);
  assert.equal(Number(line.quantity_received_units),0);
  assert(line.supplier_amendment_closed_at);
  assert.equal(await f.balance(),5);
});

test('a serial and weight amendment keeps the original batches, identities and exact cost at both receipt prices',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-po-date-fixture').fixture(t);
  const {db,ctx,workflows}=f;
  const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{
    name:'Measured serial stock',baseCode:'PO-WEIGHED',trackingMode:'serial',unitLabel:'piece',
    secondaryUnitLabel:'kg',secondaryPrecision:3});
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:item.skuIds[0],quantityUnits:4,secondaryQuantity:'12.500',unitCost:'4.00'}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  const receive=(lineId,quantity,secondaryQuantity,lotCode,serialWeights)=>workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{
    idempotencyKey:randomUUID(),lines:[{lineId,locationId:f.location.id,quantity,secondaryQuantity,lotCode,
      serials:Object.keys(serialWeights),serialWeights}]});
  await receive(po.lineIds[0],2,'5.125','ORIGINAL-BATCH',{'ORIGINAL-1':'2.125','ORIGINAL-2':'3.000'});
  const url=await db.transaction(c=>f.links.issue(c,ctx.workspaceId,po.purchaseOrderId,'delivery@example.test','https://stockchief.example.test'));
  const token=new URL(url).pathname.split('/').at(-1),link=require('../../src/purchasing/po-amendment-link');
  const {revision}=await link.page(db,token);
  const saved=await link.submit(db,token,{confirmed:'yes',revision,
    terms:[{lineId:po.lineIds[0],quantity:'3',secondary:'9.375',price:'4.25'}]});
  assert.equal((await f.approve(saved.id)).changed,true);
  const newLine=(await db.query(`SELECT id FROM purchase_order_lines
    WHERE workspace_id=$1 AND purchase_order_id=$2 AND id<>$3`,[ctx.workspaceId,po.purchaseOrderId,po.lineIds[0]])).rows[0];
  await receive(newLine.id,3,'9.375','REVISED-BATCH',{'REVISED-1':'2.875','REVISED-2':'3.125','REVISED-3':'3.375'});
  const evidence=await require('../../src/purchasing/supplier-invoice-match').receiptEvidence(db,ctx.workspaceId,po.purchaseOrderId);
  const original=evidence.get(po.lineIds[0]),revised=evidence.get(newLine.id);
  assert.deepEqual([original.quantity,original.secondary,original.value,original.proven],['2','5.125',2050,true]);
  assert.deepEqual([revised.quantity,revised.secondary,revised.value,revised.proven],['3','9.375',3984,true]);
  assert(original.tracking.every(row=>row.lot_code==='ORIGINAL-BATCH'));
  assert(revised.tracking.every(row=>row.lot_code==='REVISED-BATCH'));
  assert.equal(new Set(revised.tracking.flatMap(row=>row.serials.map(serial=>serial.serial))).size,3);
});
