'use strict';
process.env.NODE_ENV='test';
process.env.FOUNDRY_PUBLIC_URL='https://fixture.example.test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const autonomy=require('../../src/autopilot/postgres-service');
const terms=require('../../src/purchasing/agent-order-quantities');
const reviews=require('../../src/autopilot/job-reviews');

test('partner patterns and supplier negotiation drafts use dated evidence and current authority',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:50}),{db,ctx,subscribe,browser,workflows}=f;
  const vendor='fixture-supplier',sku=f.item.skuIds[0],today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const day=n=>require('../../src/accounting/customer-money').addDays(today,-n);
  await db.query("UPDATE accounts SET created_at=(now()-interval '18 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query("UPDATE suppliers SET email='vendor@example.test' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,vendor]);
  await subscribe('pro');
  async function delivery(placed,expected,received){
    const order=await workflows.createPurchaseOrder(db,ctx,{supplierId:vendor,destinationLocationId:f.location.id,expectedDate:day(expected),
      idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:1,unitCost:2}]});
    await workflows.approvePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.receivePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],quantity:1,locationId:f.location.id}]});
    await db.query('UPDATE purchase_orders SET ordered_at=$2,expected_date=$3 WHERE id=$1',[order.purchaseOrderId,day(placed)+'T12:00:00Z',day(expected)]);
    await db.query('UPDATE purchase_order_receipts SET received_at=$2 WHERE purchase_order_id=$1',[order.purchaseOrderId,day(received)+'T12:00:00Z']);
    return order;
  }
  await delivery(40,35,32);await delivery(24,18,16);await delivery(12,5,5);
  for(const ago of [32,18,4,4]){
    const x=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',orderDate:day(ago),deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,
      idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:700}]});
    await workflows.confirmSalesOrder(db,ctx,x.salesOrderId,{idempotencyKey:randomUUID()});
  }
  const key='supplier-negotiation',address='/autopilot/reviews/'+key,service=require('../../src/purchasing/negotiation-drafts');
  const review=()=>reviews.run(db,ctx,key,{filter:vendor});
  const habits=()=>reviews.run(db,ctx,'partner-habits');
  await subscribe('starter');await assert.rejects(habits(),/Growth/);
  for(const tier of ['starter','growth']){
    await subscribe(tier);await browser.get(address).query({filter:vendor}).expect(402);
    await assert.rejects(service.prepare(db,ctx,{supplier:vendor}),/Pro/);
  }
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);const result=(await habits()).rows;
    const customer=result.find(r=>r.Type==='Customer'),supplier=result.find(r=>r.Type==='Supplier');
    assert.equal(customer.Pattern,'Orders about every 14 days');assert.equal(customer['Estimated next order'],day(-10));
    assert.equal(supplier.Pattern,'Delivers in about 7 days');
    await browser.get(supplier.link).expect(200);
  }
  await subscribe('pro');const old=(await review()).negotiationForm;
  await delivery(8,5,4);await assert.rejects(service.prepare(db,ctx,old),/evidence changed/);
  const current=await review(),form=current.negotiationForm,page=await browser.get(address).query({filter:vendor}).expect(200);
  assert.equal(current.rows[0]['Late deliveries'],3);assert.match(page.text,/Recurring negotiation drafts require Custom/);
  await assert.rejects(service.configure(db,ctx,form),/Custom/);
  const saved=await browser.post('/autopilot/negotiation-draft').type('form').send({...form,_csrf:f.csrf(page.text)}).expect(303);
  const detail=await browser.get(saved.headers.location).expect(200);assert.match(detail.text,/Unsent draft/);assert.match(detail.text,/3 of 4 completed orders/);
  assert.equal(saved.headers.location,'/messages/supplier/'+await service.prepare(db,ctx,form));
  await subscribe('enterprise');await autonomy.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await service.configure(db,ctx,form);
  await db.transaction(c=>service.queue(c,ctx.workspaceId,today));
  const job=(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='agent.supplier-negotiation'",[ctx.workspaceId])).rows[0];
  const run=()=>db.transaction(c=>require('../../src/operations/postgres-runtime-handlers').create()['agent.supplier-negotiation']({workspaceId:ctx.workspaceId,payload:job.payload},c));
  await delivery(6,4,3);await subscribe('growth');assert.ok((await run()).skipped);await browser.get(saved.headers.location).expect(402);
  await subscribe('enterprise');const newer=await run();assert.ok(newer.draft);assert.equal((await run()).draft,newer.draft);
  const all=(await db.query("SELECT status,body FROM supplier_communications WHERE workspace_id=$1 AND message_kind='agent_negotiation'",[ctx.workspaceId])).rows;
  assert.equal(all.length,2);assert.ok(all.every(m=>m.status==='PREPARED'));assert.ok(all.some(m=>m.body.includes('4 of 5 completed orders')));
  await service.configure(db,ctx,{supplier:vendor,revision:job.payload.revision,remove:'1'});assert.ok((await run()).skipped);
});

test('supplier terms round a real order to cases and add goods only within the freight saving or supplier minimum',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:4});
  const {db,ctx,subscribe,browser}=f,sku=f.item.skuIds[0],vendor='fixture-supplier';
  await subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '16 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query("UPDATE suppliers SET email='orders@example.test' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,vendor]);
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:vendor,skuId:sku,lastUnitCost:1,
    unitsPerPurchaseUnit:3,orderMultiple:2,minimumOrderQuantity:1,isPreferred:true});
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at)
    VALUES($1,$2,$1,'Test mailbox','gmail','[]','{}','connected','[]',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId]);
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,5,11,0,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,sku,f.location.id]);
  const input={supplierId:vendor,currency:'USD',threshold:'18',freight:'7',mode:'save'};
  const plan=()=>autonomy.plan(db,ctx.workspaceId);
  const href='/purchasing/freight/'+vendor;
  const form=await browser.get(href).expect(200);
  await browser.post(href).type('form').send({...input,_csrf:f.csrf(form.text)}).expect(303);
  const initial=await plan(),held=initial.created.find(r=>r.recommendedAction.skuId===sku);
  assert.equal(held.recommendedAction.quantity,18);assert.equal(held.recommendedAction.purchaseUnits,6);
  assert.ok(held.sourceEvidence.some(e=>e.value==='Free shipping'));
  await subscribe('starter');
  await assert.rejects(terms.saveFreight(db,ctx,input),e=>e.code==='entitlement_required');
  await assert.rejects(reviews.run(db,ctx,'supplier-packs'),e=>e.code==='entitlement_required');
  assert.match((await reviews.run(db,ctx,'supplier-minimums')).rows[0].Suggestion,/Fixture parts/);
  assert.match((await plan()).considered.find(r=>r.skuId===sku).reason,/Growth/);
  await assert.rejects(autonomy.approve(db,ctx,{role:'owner'},held.id),/Growth/);
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);
    assert.equal(Number((await reviews.run(db,ctx,'supplier-packs')).rows[0]['Units per pack']),3);
    assert.equal((await reviews.run(db,ctx,'supplier-minimums')).rows[0]['Free shipping threshold'],'$18.00');
    assert.equal((await plan()).considered.find(r=>r.skuId===sku).quantity,18);
  }
  await terms.saveFreight(db,ctx,{...input,freight:'5'});
  const smaller=(await plan()).considered.find(r=>r.skuId===sku);
  assert.equal(smaller.quantity,12);
  await assert.rejects(autonomy.approve(db,ctx,{role:'owner'},held.id),/terms, price or the required quantity changed/);
  await db.query('UPDATE suppliers SET minimum_order_amount=16 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,vendor]);
  const bigger=await plan(),min=bigger.created.find(r=>r.recommendedAction.skuId===sku);
  assert.ok(min.sourceEvidence.some(e=>e.value==='Minimum order value'));
  const executed=await autonomy.approve(db,ctx,{role:'owner'},min.id);
  const {rows:[line]}=await db.query('SELECT * FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2',[ctx.workspaceId,executed.purchase_order_id]);
  assert.equal(Number(line.quantity_units),18);assert.equal(Number(line.quantity_purchase_units),6);assert.equal(Number(line.units_per_purchase_unit),3);
});
