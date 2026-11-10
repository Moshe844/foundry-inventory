'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const supplierBackup=require('../../src/purchasing/agent-backup-suppliers');

test('overdue confirmations and exact unavailability switch only the saved preference under current plan authority',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f;
  const commerce=require('../../src/operations/postgres-commerce');
  const flow=require('../../src/operations/postgres-business-workflows');
  const skuId=f.item.skuIds[0];
  const backup=await commerce.createSupplier(db,ctx,{name:'Backup quote supplier',currency:'USD'});
  for(const [id,cost] of [['fixture-supplier',11],[backup.id,12]]){
    await commerce.linkSupplierItem(db,ctx,{skuId,supplierId:id,lastUnitCost:cost,purchaseUnit:'unit',
      unitsPerPurchaseUnit:1,minimumOrderQuantity:1,orderMultiple:1,leadTimeDays:4});
  }
  const request={skuId,locationId:f.location.id,primarySupplierId:'fixture-supplier',backupSupplierId:backup.id,
    confirmationDays:'3',maximumGoods:'100.00',revision:0,confirmed:'yes'};
  for(const plan of ['starter','growth']){
    await f.subscribe(plan);
    await assert.rejects(supplierBackup.configure(db,ctx,request),error=>error.code==='entitlement_required'&&error.message.includes('Pro'));
    const locked=await f.browser.get('/autopilot/backup-suppliers').expect(200);
    assert.match(locked.text,/available on Pro and Custom/);
    assert.doesNotMatch(locked.text,/name="backupName"/);
  }
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const autopilot=require('../../src/autopilot/postgres-service');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const skuCode=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,skuId])).rows[0].code;
  const primaryName=(await db.query("SELECT name FROM suppliers WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId])).rows[0].name;
  const page=await f.browser.get('/autopilot/backup-suppliers').expect(200);
  const created=await f.browser.post('/autopilot/backup-suppliers').type('form').send({
    _csrf:f.csrf(page.text),skuCode,primaryName,backupName:backup.name,locationId:f.location.id,
    confirmationDays:'3',maximumGoods:'100.00',revision:0,confirmed:'yes'
  }).expect(303);
  const href=created.headers.location;
  const id=href.split('/').at(-1);
  const preferred=async()=>(await db.query('SELECT preferred_supplier_id FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
    [ctx.workspaceId,skuId,f.location.id])).rows[0].preferred_supplier_id;
  const restore=async()=>{
    const rule=(await db.query('SELECT revision FROM stockchief_runtime.agent_backup_supplier_rules WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
    await supplierBackup.configure(db,ctx,{...request,id,revision:rule.revision,restorePrimary:'yes'});
  };
  const createOrder=async age=>{
    const order=await flow.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
      idempotencyKey:randomUUID(),lines:[{skuId,quantityUnits:2,unitCost:11}]});
    await flow.approvePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
    await flow.placePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
    await db.query("UPDATE purchase_orders SET ordered_at=(now()-($2::int*interval '1 day'))::text WHERE id=$1",[order.purchaseOrderId,age]);
    return order;
  };
  assert.equal(await preferred(),'fixture-supplier');
  const original=await createOrder(2);
  await assert.rejects(supplierBackup.preview(db,ctx,id),/no current/);
  await db.query("UPDATE purchase_orders SET ordered_at=(now()-interval '4 days')::text WHERE id=$1",[original.purchaseOrderId]);
  const first=await supplierBackup.preview(db,ctx,id);
  assert.equal(first.trigger.kind,'confirmation_overdue');
  assert.equal(first.terms.amount,2400);
  await assert.rejects(supplierBackup.execute(db,ctx,id,{}, {automatic:true}),e=>e.code==='entitlement_required');
  const review=await f.browser.get(href).expect(200);
  assert.match(review.text,/Review this switch/);
  await f.browser.post(href+'/execute').type('form').send({_csrf:f.csrf(review.text),fingerprint:first.fingerprint,confirmed:'yes'}).expect(303);
  const completed=(await db.query('SELECT id FROM stockchief_runtime.agent_backup_supplier_runs WHERE workspace_id=$1 AND rule_id=$2',[ctx.workspaceId,id])).rows[0];
  assert.equal(await preferred(),backup.id);
  assert.equal((await supplierBackup.execute(db,ctx,id,{fingerprint:first.fingerprint,confirmed:'yes'})).id,completed.id);
  await supplierBackup.teach(db,ctx,id,{runId:completed.id,revision:1,confirmed:'yes'});
  await restore();
  const older='2030-01-01';
  const notice=await supplierBackup.recordUnavailable(db,ctx,id,{evidence:'Supplier confirmed this exact product is sold out for the receiving location.',
    validThrough:older,referenceQuantity:'2',confirmed:'yes'});
  await assert.rejects(supplierBackup.execute(db,ctx,id,{}, {automatic:true}),e=>e.code==='entitlement_required');
  await supplierBackup.withdrawNotice(db,ctx,notice.id);
  const future=await createOrder(5);
  const repeat=await supplierBackup.preview(db,ctx,id);
  assert.equal(repeat.trigger.purchaseOrderId,future.purchaseOrderId);

  await commerce.linkSupplierItem(db,ctx,{skuId,supplierId:backup.id,lastUnitCost:13,purchaseUnit:'case',
    unitsPerPurchaseUnit:6,minimumOrderQuantity:1,orderMultiple:1,leadTimeDays:4});
  await assert.rejects(supplierBackup.execute(db,ctx,id,{}, {automatic:true}),/price, pack or terms changed/);
  await assert.rejects(supplierBackup.execute(db,ctx,id,{fingerprint:repeat.fingerprint,confirmed:'yes'}),/price, pack or terms changed/);
  assert.equal(await preferred(),'fixture-supplier');
  await commerce.linkSupplierItem(db,ctx,{skuId,supplierId:backup.id,lastUnitCost:12,purchaseUnit:'unit',
    unitsPerPurchaseUnit:1,minimumOrderQuantity:1,orderMultiple:1,leadTimeDays:4});

  await autopilot.pause(db,ctx,{role:'owner'},'Checking supplier terms');
  await assert.rejects(supplierBackup.execute(db,ctx,id,{}, {automatic:true}),/paused/i);
  await autopilot.resume(db,ctx,{role:'owner'});
  await f.subscribe('growth');
  assert.equal((await supplierBackup.schedule(db,ctx.workspaceId)).switched,0);
  await assert.rejects(supplierBackup.execute(db,ctx,id,{fingerprint:repeat.fingerprint,confirmed:'yes'}),e=>e.code==='entitlement_required');
  assert.equal(await preferred(),'fixture-supplier');
  await f.subscribe('pro');
  assert.equal((await supplierBackup.schedule(db,ctx.workspaceId)).switched,1);
  assert.equal(await preferred(),backup.id);

  await restore();
  await f.subscribe('enterprise');
  await db.query("UPDATE suppliers SET email='backup-source@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  const link=require('../../src/purchasing/supplier-order-link');
  const third=await createOrder(1);
  const tokenPath=new URL(await db.transaction(tx=>link.issue(tx,ctx.workspaceId,third.purchaseOrderId,'backup-source@example.test','https://example.test'))).pathname;
  const supplierView=await f.browser.get(tokenPath).expect(200);
  assert.match(supplierView.text,/Report an unavailable item/);
  const sourceInput={_csrf:f.csrf(supplierView.text),lineId:third.lineIds[0],validThrough:older,reason:'Supplier checked the original order. This product is unavailable.',confirmed:'yes'};
  await f.browser.post(tokenPath+'/unavailable').type('form').send(sourceInput).expect(303);
  const customNotice=(await db.query('SELECT id FROM stockchief_runtime.agent_backup_supplier_notices WHERE workspace_id=$1 AND purchase_order_id=$2',[ctx.workspaceId,third.purchaseOrderId])).rows[0];
  const refreshed=await supplierBackup.preview(db,ctx,id);
  assert.equal(refreshed.trigger.notice.id,customNotice.id);
  const confirmView=await f.browser.get(tokenPath).expect(200);
  await f.browser.post(tokenPath+'/respond').type('form').send({_csrf:f.csrf(confirmView.text),kind:'confirm'}).expect(303);
  await assert.rejects(supplierBackup.preview(db,ctx,id),/no current/);
  await f.browser.post(tokenPath+'/unavailable').type('form').send({...sourceInput,reason:'The new supplier statement confirms this line is now unavailable again.'}).expect(303);
  assert.equal((await supplierBackup.schedule(db,ctx.workspaceId)).switched,1);
  assert.equal(await preferred(),backup.id);
  assert.equal(await f.balance(),20);
  const orders=(await db.query("SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id",[ctx.workspaceId,[original.purchaseOrderId,future.purchaseOrderId]])).rows;
  assert(orders.every(row=>row.status==='ORDERED'));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM purchase_orders WHERE workspace_id=$1 AND supplier_id=$2",[ctx.workspaceId,backup.id])).rows[0].n,0);
  await db.query(`UPDATE reorder_policies SET reorder_point=35,target_stock=40
    WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,[ctx.workspaceId,skuId,f.location.id]);
  const nextDraft=await require('../../src/purchasing/agent-reorder-workflows').build(db,ctx,null,{skuCodes:skuCode});
  assert.deepEqual(nextDraft.payload.output.map(group=>group.supplierId),[backup.id]);
  assert.equal(nextDraft.payload.output[0].lines[0].destinationLocationId,f.location.id);
});
