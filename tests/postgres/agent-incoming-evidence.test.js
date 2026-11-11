'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('original supplier unavailability removes false incoming across plans and a newer confirmation restores it',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-po-date-fixture').fixture(t);
  const {db,ctx,po}=f;
  const backup=require('../../src/purchasing/agent-backup-suppliers');
  const planning=require('../../src/forecasting/postgres-planning-service');
  const reviews=require('../../src/autopilot/job-reviews');
  const catalogue=require('../../src/domain/postgres-catalog-service');
  const mrp=require('../../src/manufacturing/postgres-mrp');
  const materialPlan=()=>mrp.plan(db,ctx,{demands:[{skuId:f.item.skuIds[0],quantity:12,neededBy:f.date(2)}]});
  const incoming=async()=>(await planning.position(db,ctx.workspaceId,{onlySkuIds:f.item.skuIds})).reduce((sum,row)=>sum+Number(row.incoming),0);
  assert.equal(await incoming(),12);
  assert.equal((await catalogue.getItem(db,ctx.workspaceId,f.item.itemId)).onOrder,12);
  assert.equal((await materialPlan()).supplyUsed.find(row=>row.sourceId===po.purchaseOrderId).quantity,8);
  await f.subscribe('starter');
  assert.equal((await backup.linkLines(db,{workspace_id:ctx.workspaceId,id:po.purchaseOrderId})).length,0);
  await f.subscribe('growth');
  const supplier=await f.browser.get('/supplier/order/'+f.token).expect(200);
  assert.match(supplier.text,/Report an unavailable item/);
  const notice=await backup.supplierReply(db,f.token,{lineId:po.lineIds[0],validThrough:f.date(3),
    reason:'This purchase line cannot be supplied through the stated date.',confirmed:'yes'});
  assert.equal(await incoming(),0);
  assert.equal((await catalogue.getItem(db,ctx.workspaceId,f.item.itemId)).onOrder,0);
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,10,16,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,f.item.skuIds[0],f.location.id]);
  const next=await require('../../src/autopilot/postgres-service').plan(db,ctx.workspaceId,{onlySkuIds:f.item.skuIds});
  assert.equal(next.created.length,0);
  assert(next.considered.some(row=>row.reason==='supplier_availability_needs_review'));
  const shortages=await materialPlan();
  assert(!shortages.supplyUsed.some(row=>row.sourceId===po.purchaseOrderId));
  assert.equal(shortages.orders.find(row=>row.kind==='BUY').quantity,8);
  const review=await reviews.run(db,ctx,'overdue-incoming');
  const row=review.rows.find(row=>row.Order===po.poNumber);
  assert.equal(row.Reason,'Supplier reported unavailable');
  assert.equal(Number(row['Still due']),12);
  assert.equal(row['Dependable incoming'],'No');
  const page=await f.browser.get('/purchasing/orders/'+po.purchaseOrderId).expect(200);
  assert.match(page.text,/Supplier availability needs confirmation/);
  assert.match(page.text,/cannot be supplied/);
  assert.doesNotMatch(page.text,new RegExp('/supplier-files/'+notice.id));
  await f.subscribe('starter');
  assert.equal(await incoming(),0);
  assert.match((await reviews.run(db,ctx,'overdue-incoming')).rows[0].Suggestion,/unavailable/);
  await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:po.lineIds[0],quantity:4,locationId:f.location.id}]});
  assert.equal(await incoming(),0);
  assert.equal(await f.balance(),8);
  await f.links.submit(db,f.token,'confirm',null);
  assert.equal(await incoming(),8);
  assert.equal((await reviews.run(db,ctx,'overdue-incoming')).rows.length,0);
  await f.subscribe('growth');
  const again=await backup.supplierReply(db,f.token,{lineId:po.lineIds[0],validThrough:f.date(3),
    reason:'A newer availability problem affects the remaining eight units.',confirmed:'yes'});
  assert.equal(await incoming(),0);
  const correction=await f.browser.get('/purchasing/orders/'+po.purchaseOrderId).expect(200);
  assert.match(correction.text,/Withdraw report/);
  const withdraw='/purchasing/orders/'+po.purchaseOrderId+'/supplier-availability/'+again.id+'/withdraw';
  const unconfirmed=await f.browser.post(withdraw).type('form').send({_csrf:f.csrf(correction.text)}).expect(303);
  assert.match((await f.browser.get(unconfirmed.headers.location).expect(200)).text,/Confirm that this supplier report was entered in error/);
  assert.equal(await incoming(),0);
  await f.browser.post(withdraw).type('form').send({_csrf:f.csrf(correction.text),confirmed:'yes'}).expect(303);
  assert.equal(await incoming(),8);
});

test('price-only amendments preserve supplier holds and reviewed remaining quantities restore the exact supply',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-po-date-fixture').fixture(t),{db,ctx,po}=f;
  const backup=require('../../src/purchasing/agent-backup-suppliers');
  const link=require('../../src/purchasing/po-amendment-link');
  await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:po.lineIds[0],quantity:4,locationId:f.location.id}]});
  await backup.supplierReply(db,f.token,{lineId:po.lineIds[0],validThrough:f.date(4),
    reason:'The remaining goods need new availability confirmation.',confirmed:'yes'});
  const before=await link.page(db,f.token);
  const priced=await link.submit(db,f.token,{confirmed:'yes',revision:before.revision,terms:[{lineId:po.lineIds[0],price:'1.25'}]});
  await f.approve(priced.id);
  const replacement=(await db.query(`SELECT id,supplier_supply_hold_id FROM purchase_order_lines
    WHERE workspace_id=$1 AND purchase_order_id=$2 AND quantity_units>quantity_received_units`,[ctx.workspaceId,po.purchaseOrderId])).rows[0];
  assert(replacement.supplier_supply_hold_id);
  const incoming=async()=>(await require('../../src/forecasting/postgres-planning-service').position(db,ctx.workspaceId,{onlySkuIds:f.item.skuIds}))[0].incoming;
  assert.equal(Number(await incoming()),0);
  const newer=await backup.supplierReply(db,f.token,{lineId:replacement.id,validThrough:f.date(5),
    reason:'A second supplier notice applies to this revised line.',confirmed:'yes'});
  await backup.withdrawNotice(db,ctx,newer.id,po.purchaseOrderId);
  const previousHold=(await db.query('SELECT supplier_supply_hold_id FROM purchase_order_lines WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,replacement.id])).rows[0];
  assert.equal(previousHold.supplier_supply_hold_id,replacement.supplier_supply_hold_id);
  assert.equal(Number(await incoming()),0);
  const current=await link.page(db,f.token);
  const confirmed=await link.submit(db,f.token,{confirmed:'yes',revision:current.revision,
    terms:[{lineId:replacement.id,quantity:'8'}]});
  await f.approve(confirmed.id);
  assert.equal(Number(await incoming()),8);
  assert.equal(await f.balance(),8);
});

test('the incoming-evidence upgrade preserves previous migration identities, stock, money and measured business bytes',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{through:'346-agent-po-amendment-mail.sql'});
  const {db,ctx,workflows}=f;
  await f.subscribe('growth');
  await db.query("UPDATE suppliers SET email='availability@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const future=require('../../src/accounting/customer-money').addDays(today,4);
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    expectedDate:future,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:8,unitCost:1}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  const links=require('../../src/purchasing/supplier-order-link');
  const url=await db.transaction(c=>links.issue(c,ctx.workspaceId,po.purchaseOrderId,'availability@example.test','https://stockchief.example.test'));
  await require('../../src/purchasing/agent-backup-suppliers').supplierReply(db,new URL(url).pathname.split('/').at(-1),{
    lineId:po.lineIds[0],validThrough:future,reason:'Original supplier cannot supply these units.',confirmed:'yes'});
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const pending=[];
  for(const kind of ['date','amendment']){
    const order=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
      expectedDate:future,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:2,unitCost:1}]});
    await workflows.approvePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
    const sourceUrl=await db.transaction(c=>links.issue(c,ctx.workspaceId,order.purchaseOrderId,'availability@example.test','https://stockchief.example.test'));
    const token=new URL(sourceUrl).pathname.split('/').at(-1);
    let id;
    if(kind==='date'){
      await links.submit(db,token,'date',require('../../src/accounting/customer-money').addDays(future,1));
      id=(await db.query(`SELECT s.id FROM stockchief_runtime.supplier_link_submissions s
        JOIN stockchief_runtime.supplier_order_links l USING(workspace_id,token_hash)
        WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 AND s.kind='date'`,[ctx.workspaceId,order.purchaseOrderId])).rows[0].id;
    }else{
      const amendments=require('../../src/purchasing/po-amendment-link');
      const page=await amendments.page(db,token);
      id=(await amendments.submit(db,token,{confirmed:'yes',revision:page.revision,
        terms:[{lineId:order.lineIds[0],quantity:'3',price:'1.10'}]})).id;
    }
    pending.push({id,order,kind});
  }
  const storage=require('../../src/commercial/storage-capacity');
  await storage.refresh(db,ctx.workspaceId);
  const bytes=await storage.state(db,f.owner.accountId);
  const previous=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;
  const cost=(await db.query('SELECT * FROM accounting_inventory_cost_balances WHERE workspace_id=$1 ORDER BY sku_id,location_id',[ctx.workspaceId])).rows;
  const migrate=require('../../src/db/migrate-postgres').migratePostgres;
  assert.deepEqual(await migrate(db),['347-agent-incoming-evidence.sql']);
  assert.deepEqual((await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows.slice(0,previous.length),previous);
  await storage.refresh(db,ctx.workspaceId);
  assert.equal(await storage.state(db,f.owner.accountId),bytes);
  assert.equal(await f.balance(),4);
  assert.deepEqual((await db.query('SELECT * FROM accounting_inventory_cost_balances WHERE workspace_id=$1 ORDER BY sku_id,location_id',[ctx.workspaceId])).rows,cost);
  assert((await db.query('SELECT supplier_supply_hold_id FROM purchase_order_lines WHERE id=$1',[po.lineIds[0]])).rows[0].supplier_supply_hold_id);
  const service=require('../../src/purchasing/agent-po-delivery-dates');
  for(const source of pending){
    const review=await service.preview(db,ctx,source.id);
    await service.apply(db,ctx,source.id,{confirmed:'yes',expectedFingerprint:review.facts.sourceFingerprint});
    const actual=(await db.query(`SELECT p.expected_date::text,l.quantity_units::text,l.unit_cost::text
      FROM purchase_orders p JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
      WHERE p.workspace_id=$1 AND p.id=$2`,[ctx.workspaceId,source.order.purchaseOrderId])).rows[0];
    if(source.kind==='date')assert.equal(actual.expected_date,require('../../src/accounting/customer-money').addDays(future,1));
    else{
      assert.equal(Number(actual.quantity_units),3);
      assert.equal(Number(actual.unit_cost),1.10);
    }
  }
  assert.deepEqual(await migrate(db),[]);
});

test('unavailable incoming stops new preorders while actual receipts can finish existing customer requests',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-customer-order-page-fixture').fixture(t);
  const {db,ctx,workflows,skuId}=f;
  await f.subscribe('growth');
  await db.query("UPDATE suppliers SET email='preorder-supply@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const future=require('../../src/accounting/customer-money').addDays(today,4);
  const order=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    expectedDate:future,idempotencyKey:randomUUID(),lines:[{skuId,quantityUnits:12,unitCost:1}]});
  await workflows.approvePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
  const page=await f.publish({preorderOrder:order.poNumber});
  const accepted=await f.send(page,{quantity:3});
  const links=require('../../src/purchasing/supplier-order-link');
  const url=await db.transaction(c=>links.issue(c,ctx.workspaceId,order.purchaseOrderId,'preorder-supply@example.test','https://stockchief.example.test'));
  await require('../../src/purchasing/agent-backup-suppliers').supplierReply(db,new URL(url).pathname.split('/').at(-1),{
    lineId:order.lineIds[0],validThrough:future,reason:'Remaining products cannot currently be supplied.',confirmed:'yes'});
  await assert.rejects(f.send(page,{quantity:1}),/supplier reported that these goods are unavailable/i);
  await assert.rejects(f.manual(accepted.id),/original incoming stock changed/);
  await workflows.receivePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:order.lineIds[0],quantity:3,locationId:f.location.id}]});
  const drafted=await f.manual(accepted.id);
  assert(drafted.salesOrderId);
  assert.equal(await require('../../src/sales/preorder-supply').hasArrived(db,ctx,accepted.id),true);
  assert.equal(await f.balance(),103);
  const incoming=(await require('../../src/forecasting/postgres-planning-service').position(db,ctx.workspaceId,{onlySkuIds:[skuId]}))[0].incoming;
  assert.equal(Number(incoming),0);
  await assert.rejects(f.send(page,{quantity:1}),/supplier reported that these goods are unavailable/i);
});
