'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const request=require('supertest');
const freight=require('../../src/purchasing/agent-inbound-freight');

test('ocean and air freight uses private exact status updates and tracks confirmed deposit payments in each plan',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx,workflows,browser,csrf}=f;
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const later=n=>require('../../src/accounting/customer-money').addDays(today,n);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  f.cleanup(()=>app.locals.sessionStore.close());
  const forwarder=request.agent(app);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await f.subscribe('growth');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const original=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,expectedDate:later(30),
    idempotencyKey:'ocean-order',lines:[{skuId:f.item.skuIds[0],quantityUnits:40,unitCost:'1.00'}]});
  await workflows.approvePurchaseOrder(db,ctx,original.purchaseOrderId,{idempotencyKey:'ocean-approval'});
  await workflows.placePurchaseOrder(db,ctx,original.purchaseOrderId,{idempotencyKey:'ocean-place'});
  const order=(await db.query('SELECT id,po_number,expected_date::text FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,original.purchaseOrderId])).rows[0];
  const base={mode:'ocean',referenceType:'container',reference:'TEST1234567',forwarder:'Synthetic forwarder',destination:'New York',
    eta:later(14),orders:order.po_number,maximumShiftDays:'5',routine:'yes',confirmed:'yes'};
  const snapshot=async id=>freight.page(db,ctx,id);
  await f.subscribe('starter');
  const locked=await browser.get(freight.path).expect(200);
  assert.match(locked.text,/tracking starts at Growth/);
  assert.doesNotMatch(locked.text,/name="reference"/);
  await assert.rejects(freight.create(db,ctx,base),e=>e.code==='entitlement_required'&&/Growth/.test(e.message));

  await f.subscribe('growth');
  const form=await browser.get(freight.path).expect(200);
  const created=await browser.post(freight.path).type('form').send({...base,_csrf:csrf(form.text)}).expect(303);
  const id=created.headers.location.split('/').at(-1);
  const ownerPage=await browser.get(created.headers.location).expect(200);
  const issued=await browser.post(created.headers.location+'/link').type('form').send({_csrf:csrf(ownerPage.text),confirmed:'yes'}).expect(200);
  const link=issued.text.match(/\/freight\/update\/[A-Za-z0-9_-]{43}/)[0],token=link.split('/').at(-1);
  const view=await forwarder.get(link).expect(200);
  assert.equal(view.headers['referrer-policy'],'no-referrer');
  assert.equal(view.headers['cache-control'],'no-store');
  assert.match(view.text,/TEST1234567/);
  assert.doesNotMatch(view.text,/Deposit|purchase order|Synthetic forwarder/i);
  await forwarder.post(link).type('form').send({_csrf:csrf(view.text),revision:1,status:'in_transit',eta:later(16),
    note:'Vessel schedule corrected at origin',confirmed:'yes'}).expect(303);
  assert.equal((await snapshot(id)).freight.eta,later(16));
  assert.equal((await snapshot(id)).history[0].disposition,'APPLIED');
  await assert.rejects(freight.submit(db,token,{revision:1,status:'arrived',eta:later(16),confirmed:'yes'}),/Reload/);
  await freight.submit(db,token,{revision:2,status:'arrived',eta:later(28),confirmed:'yes'});
  const pending=await snapshot(id);
  assert.equal(pending.freight.eta,later(16));
  assert.equal(pending.history[0].disposition,'REVIEW');
  await freight.reviewUpdate(db,ctx,id,{revision:pending.freight.revision,updateId:pending.history[0].id,confirmed:'yes'});
  assert.equal((await snapshot(id)).freight.eta,later(28));
  assert.equal((await snapshot(id)).orders[0].expected_date,order.expected_date);

  const stockBefore=await f.balance();
  await freight.saveDeposit(db,ctx,id,{orderId:order.id,amount:'125.00',dueDate:later(2),revision:0,confirmed:'yes'});
  assert.equal((await snapshot(id)).deposits[0].paid,'0');
  const billId='synthetic-freight-deposit';
  await db.transaction(async c=>{
    // Seed the posted supplier deposit invoice from the supplier's exact documentation.
    const journal=await require('../../src/accounting/postgres-ledger').postInTransaction(c,ctx,{sourceKey:'freight-deposit-bill',sourceType:'supplier_bill',
      sourceRecordType:'supplier_bill',sourceRecordId:billId,description:'Recorded supplier freight deposit',postingDate:today,currency:'USD',
      lines:[{accountKey:'SUPPLIER_ADVANCES',supplierId:'fixture-supplier',debitMinor:12500},
        {accountKey:'ACCOUNTS_PAYABLE',supplierId:'fixture-supplier',creditMinor:12500}]});
    await c.query(`INSERT INTO accounting_supplier_bills(id,workspace_id,bill_number,supplier_id,purchase_order_id,issue_date,due_date,status,currency,
      subtotal_minor,total_minor,balance_minor,journal_entry_id,source_key,created_at,updated_at)
      VALUES($1,$2,'DEP-001','fixture-supplier',$3,$4,$5,'OPEN','USD',12500,12500,12500,$6,'freight-deposit-bill',$7,$7)`,
    [billId,ctx.workspaceId,order.id,today,later(2),journal.entry.id,new Date().toISOString()]);
  });
  await assert.rejects(freight.saveDeposit(db,ctx,id,{orderId:order.id,amount:'124.99',dueDate:later(2),revision:1,billNumber:'DEP-001',confirmed:'yes'}),/exact deposit amount/);
  await freight.saveDeposit(db,ctx,id,{orderId:order.id,amount:'125.00',dueDate:later(2),revision:1,billNumber:'DEP-001',confirmed:'yes'});
  const payment=await workflows.recordSupplierPayment(db,ctx,{supplierId:'fixture-supplier',supplierBillId:billId,amountMinor:2500,idempotencyKey:'pay-deposit'});
  assert.equal((await snapshot(id)).deposits[0].paid,'2500');
  assert.match((await browser.get(created.headers.location).expect(200)).text,/Recorded payments \$25\.00/);
  await workflows.voidPayment(db,ctx,payment.paymentId,{reason:'Synthetic payment correction'});
  assert.equal((await snapshot(id)).deposits[0].paid,'0');
  assert.equal(await f.balance(),stockBefore);

  for(const [tier,reference] of [['pro','001-27868153'],['enterprise','777-12345678']]){
    await f.subscribe(tier);
    const air=await freight.create(db,ctx,{...base,mode:'air',referenceType:'waybill',reference,destination:'JFK'});
    const privateLink=await freight.issueLink(db,ctx,air.id,{confirmed:'yes'});
    await freight.submit(db,privateLink.split('/').at(-1),{revision:1,status:'in_transit',eta:later(15),confirmed:'yes'});
    assert.equal((await snapshot(air.id)).freight.eta,later(15));
    await freight.stopLink(db,ctx,air.id);
    await forwarder.get(privateLink).expect(404);
  }
  await f.subscribe('starter');
  await forwarder.get(link).expect(404);
  await assert.rejects(freight.submit(db,token,{revision:4,status:'released',eta:later(29),confirmed:'yes'}),/inactive/);
});
