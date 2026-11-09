'use strict';
process.env.NODE_ENV='test';
process.env.FOUNDRY_PUBLIC_URL='https://fixture.example.test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const autonomy=require('../../src/autopilot/postgres-service');
const terms=require('../../src/purchasing/agent-order-quantities');
const reviews=require('../../src/autopilot/job-reviews');

test('a stock issue or sales reservation queues a ready PO before the next catalog check',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:12}),{db,ctx,subscribe,browser,workflows}=f;
  const sku=f.item.skuIds[0],supplierId='fixture-supplier',locationId=f.location.id;
  const priorEmail=process.env.RESEND_API_KEY,priorFrom=process.env.FOUNDRY_FROM_EMAIL;
  process.env.RESEND_API_KEY='fixture-only';process.env.FOUNDRY_FROM_EMAIL='test@example.test';
  t.after(()=>{if(priorEmail===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=priorEmail;
    if(priorFrom===undefined)delete process.env.FOUNDRY_FROM_EMAIL;else process.env.FOUNDRY_FROM_EMAIL=priorFrom;});
  await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '16 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query("UPDATE suppliers SET email='reorders@example.test' WHERE id=$1",[supplierId]);
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId,skuId:sku,lastUnitCost:2,unitsPerPurchaseUnit:1,orderMultiple:1,minimumOrderQuantity:1,isPreferred:true});
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at)
    VALUES($1,$2,$1,'Reorder mailbox','gmail','[]','{}','connected','[]',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId]);
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,8,20,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,sku,locationId]);
  const runtime=require('../../src/operations/postgres-runtime-handlers').create(),queue=require('../../src/operations/postgres-job-queue');
  const signalWorker=()=>queue.processOne(db,runtime,{owner:'threshold-test',kinds:['agent.reorder-signal']});
  const settings=await browser.get('/settings?section=notifications').expect(200);
  const alerts=(enabled,recipients='')=>browser.post('/settings/email-alerts').type('form')
    .send({_csrf:f.csrf(settings.text),enabled:enabled?'1':'0',minimumSeverity:'important',recipients}).expect(303);
  await alerts(true);
  const messages=[];
  const mailHandlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{emailSender:async message=>{
    messages.push(message);return {provider:'test',externalId:'mail-'+messages.length};}});
  const deliver=()=>queue.processOne(db,mailHandlers,{owner:'approval-email-test',kinds:['system.email-send']});
  const pending=()=>db.query("SELECT id FROM work_items WHERE workspace_id=$1 AND execution_status='WAITING_FOR_APPROVAL' AND recommended_action::jsonb->>'skuId'=$2",[ctx.workspaceId,sku]);
  const issue=()=>require('../../src/domain/postgres-inventory-engine').issue(db,ctx,{skuId:sku,locationId,quantity:4,reasonCode:'sold',idempotencyKey:randomUUID()});
  await issue();await subscribe('starter');assert.equal((await signalWorker()).status,'COMPLETED');
  let id=(await pending()).rows[0].id;
  const remaining=()=>db.query("SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1 AND source='foundry_recommendation'",[ctx.workspaceId]);
  assert.equal((await remaining()).rows[0].n,0);
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);const detail=await browser.get('/autopilot/work/'+id).expect(200);
    assert.match(detail.text,/Send to supplier/);assert.match(detail.text,/Confidence: high/);
  }
  const signal=(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='agent.reorder-signal'",[ctx.workspaceId])).rows[0].payload;
  assert.equal((await db.transaction(c=>runtime['agent.reorder-signal']({workspaceId:ctx.workspaceId,payload:signal},c))).prepared,0);
  // A reservation changes available stock from eight to six even though the shelf still holds eight.
  const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:locationId,
    idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:2,unitPriceMinor:500}]});
  await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});assert.equal((await signalWorker()).status,'COMPLETED');
  const fresh=(await pending()).rows[0].id;assert.notEqual(fresh,id);id=fresh;
  const obsolete=await deliver();assert.equal(obsolete.status,'COMPLETED');assert(obsolete.result.skipped);assert.equal(messages.length,0);
  const notice=await deliver();assert.equal(notice.status,'COMPLETED');assert.equal(messages.length,1);assert.equal(messages[0].to,f.email);
  const emailPath=new URL(messages[0].text.match(/https:\/\/\S+$/)[0]).pathname;
  assert.equal(emailPath,'/autopilot/approval-email/'+ctx.workspaceId+'/'+id);
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);await browser.get(emailPath).expect(302).expect('Location','/autopilot/work/'+id);
    await browser.get('/autopilot/work/'+id).set('User-Agent','Mobile link preview').expect(200);
  }
  assert.equal((await remaining()).rows[0].n,0);
  assert.equal((await require('../../src/operations/postgres-runtime-handlers').systemEmail(notice,db,{emailSender:()=>assert.fail('duplicate email')})).replayed,true);
  const guard=require('../../src/autopilot/approval-email').stillWanted;
  await alerts(true,'elsewhere@example.test');assert.equal(await guard(db,notice,f.email),false);
  await alerts(false);assert.equal(await guard(db,notice,f.email),false);
  await alerts(true);
  const alternate=await require('../../src/domain/postgres-auth-service').createWorkspace(db,f.owner.accountId,{name:'Alternate inventory'});
  await browser.post('/inventories/switch').type('form').send({_csrf:f.csrf(settings.text),workspaceId:alternate.workspaceId}).expect(303);
  const picker=await browser.get(emailPath).expect(200);assert.match(picker.text,/Open this inventory/);
  await browser.get(emailPath.replace(ctx.workspaceId,randomUUID())).expect(404);
  await browser.post('/inventories/switch').type('form').send({_csrf:f.csrf(picker.text),workspaceId:ctx.workspaceId,next:'/autopilot/work/'+id}).expect(303);
  await subscribe('starter');const page=await browser.get('/autopilot/work/'+id).expect(200);
  const send=()=>browser.post('/autopilot/work/'+id+'/approve').type('form').send({_csrf:f.csrf(page.text)});
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  f.cleanup(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const chrome=await require('playwright').chromium.launch();f.cleanup(()=>chrome.close());
  const mobile=await chrome.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await mobile.goto('http://127.0.0.1:'+server.address().port+emailPath);
  await mobile.locator('[name=email]').fill(f.email);await mobile.locator('[name=password]').fill(f.password);
  await Promise.all([mobile.waitForNavigation(),mobile.getByRole('button',{name:'Sign in',exact:true}).click()]);
  assert.equal(await mobile.getByRole('button',{name:'Send to supplier'}).isVisible(),true);
  assert.equal((await remaining()).rows[0].n,0);
  await Promise.all([mobile.waitForNavigation(),mobile.getByRole('button',{name:'Send to supplier'}).click()]);
  await send().expect(303);
  assert.equal(await guard(db,notice,f.email),false);
  assert.equal((await remaining()).rows[0].n,1);
  const stored=(await db.query("SELECT w.outcome::jsonb outcome,l.quantity_units FROM work_items w JOIN purchase_order_lines l ON l.purchase_order_id=w.purchase_order_id WHERE w.workspace_id=$1 AND w.id=$2",[ctx.workspaceId,id])).rows[0];
  assert.equal(Number(stored.quantity_units),14);assert.ok(stored.outcome.effectId);
  const unknown=(await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Unpriced replacement',baseCode:'NO-COST',trackingMode:'quantity'})).skuIds[0];
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId,skuId:unknown,unitsPerPurchaseUnit:1,orderMultiple:1,minimumOrderQuantity:1});
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,5,10,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,unknown,locationId]);
  const missing=(await autonomy.plan(db,ctx.workspaceId,{onlySkuIds:[unknown]})).created[0];
  assert.equal(missing.confidence,'low');
  const check=await browser.get('/autopilot/work/'+missing.id).expect(200);
  assert.match(check.text,/Confidence: low/);assert.match(check.text,/Review supplier prices/);assert.doesNotMatch(check.text,/>Send to supplier</);
  await assert.rejects(autonomy.approve(db,ctx,{role:'owner'},missing.id),/unit cost/);
});

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
