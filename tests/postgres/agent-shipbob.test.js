'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
const {randomUUID}=require('node:crypto');
const provider=require('../../src/connections/postgres-shipbob-sandbox');

test('ShipBob sandbox order approval, network recovery, split tracking and matching stock', {timeout:240000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t);
  const {db,ctx,owner,workflows}=f,code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
  async function plan(id){await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES($1,$2,$3,
    (SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE'),'ACTIVE')
    ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,[randomUUID(),owner.accountId,id]);}
  const calls=[],credentials={apiKey:'fake-sandbox-token',channelId:'581'};
  let remote=null,posts=0,responseLost=true;
  const transport=async(url,opts)=>{
    calls.push(url);
    assert.ok(url.startsWith('https://sandbox-api.shipbob.com/2026-07/'));
    assert.equal(opts.headers.Authorization,'Bearer fake-sandbox-token');assert.equal(opts.headers.shipbob_channel_id,'581');
    const u=new URL(url),response=v=>new Response(JSON.stringify(v),{status:200});
    if(u.pathname.endsWith('/channel'))return response(u.searchParams.has('Cursor')?
      {items:[{id:581,scopes:['orders_read','orders_write','inventory_read']}],next:null}:
      {items:[{id:572,scopes:['orders_read']}],next:'/2026-07/channel?cursor=next-page'});
    if(u.pathname.endsWith('/inventory-level/7'))return response({inventory_id:7,sku:code,total_on_hand_quantity:15,total_fulfillable_quantity:12});
    if(u.pathname.endsWith('/inventory-level/8'))return response({inventory_id:8,sku:'WRONG',total_on_hand_quantity:8,total_fulfillable_quantity:8});
    if(u.pathname.endsWith('/order/20'))return response({...remote,status:'Partially Fulfilled',shipments:[
      {id:60,status:'Completed',tracking:{tracking_number:'TEST-A',carrier:'UPS'}},{id:61,status:'Processing',tracking:null}]});
    if(opts.method==='POST'){
      posts++;assert.equal(remote,null);
      const payload=JSON.parse(opts.body);assert.equal(payload.products[0].quantity,2);assert.equal(payload.products[0].reference_id,code);
      assert.equal(payload.recipient.address.city,'Albany');
      remote={...payload,id:20,channel:{id:581},status:'Processing',shipments:[]};
      if(responseLost){responseLost=false;throw new Error('simulated network disconnect after provider accepted');}
      return response(remote);
    }
    assert.ok(u.searchParams.get('ReferenceIds'));return response(remote?[remote]:[]);
  };
  await plan('starter');
  await assert.rejects(provider.connect(db,ctx,credentials,transport),e=>e.code==='entitlement_required');assert.equal(calls.length,0);
  await plan('growth');
  await assert.rejects(provider.connect(db,ctx,{...credentials,channelId:'572'},async()=>new Response(
    JSON.stringify({items:[{id:572,scopes:['orders_read']}]}),{status:200})),/permission to read and send orders/);
  await provider.connect(db,ctx,credentials,transport);
  const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,
    idempotencyKey:'sandbox-order',lines:[{skuId:f.item.skuIds[0],quantity:2,unitPriceMinor:100}]});
  await assert.rejects(provider.draft(db,ctx,order.salesOrderId),/confirmed/);
  await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'confirmed-sandbox'});
  const before=await f.balance(),review=await provider.draft(db,ctx,order.salesOrderId);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});f.cleanup(()=>app.locals.sessionStore.close());
  const browser=request.agent(app),login=await browser.get('/login');await browser.post('/login').type('form').send({_csrf:/name="_csrf" value="([^"]+)"/.exec(login.text)[1],email:f.email,password:f.password});
  const preview=await browser.get('/autopilot/shipbob?order='+order.salesOrderId).expect(200);
  assert.match(preview.text,/Approve and send to sandbox/);assert.ok(!preview.text.includes(credentials.apiKey));
  await assert.rejects(provider.send(db,ctx,order.salesOrderId,'stale',transport),/changed/);assert.equal(posts,0);
  await plan('starter');
  await assert.rejects(provider.send(db,ctx,order.salesOrderId,review.hash,transport),e=>e.code==='entitlement_required');
  await plan('growth');
  await assert.rejects(provider.send(db,ctx,order.salesOrderId,review.hash,transport),/did not respond/);
  await provider.send(db,ctx,order.salesOrderId,review.hash,transport);
  await provider.send(db,ctx,order.salesOrderId,review.hash,transport);assert.equal(posts,1);
  await provider.refresh(db,ctx,order.salesOrderId,transport);
  await assert.rejects(provider.stock(db,ctx,{inventoryId:8,sku:code},transport),/does not match/);
  await provider.stock(db,ctx,{inventoryId:7,sku:code},transport);
  const results=await provider.dashboard(db,ctx);assert.equal(results.orders[0].provider_order_id,'20');
  assert.equal(results.orders[0].shipments[0].tracking,'TEST-A');assert.equal(results.orders[0].shipments[1].tracking,null);
  assert.equal(results.stock[0].on_hand,15);assert.equal(results.stock[0].fulfillable,12);assert.equal(await f.balance(),before);
  // The warehouse rule is a job 186 route: Growth cannot let it send on its own.
  await assert.rejects(provider.configureRule(db,ctx,{action:'enable',locationId:f.location.id}),e=>e.code==='entitlement_required');
  await plan('pro');
  await provider.configureRule(db,ctx,{action:'enable',locationId:f.location.id});
  const next=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,
    idempotencyKey:'auto-shipbob',lines:[{skuId:f.item.skuIds[0],quantity:2,unitPriceMinor:120}]});
  await workflows.confirmSalesOrder(db,ctx,next.salesOrderId,{idempotencyKey:'confirmed-auto-shipbob'});
  const routes=require('../../src/connections/agent-3pl-orders');
  assert.equal((await routes.run(db,ctx.workspaceId,{transport})).drafted,1,'The first 14 days only draft.');assert.equal(posts,1);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await plan('growth');
  assert.equal((await routes.run(db,ctx.workspaceId,{transport})).sent,0);assert.equal(posts,1);
  await plan('pro');remote=null;
  assert.equal((await routes.run(db,ctx.workspaceId,{transport})).sent,1);assert.equal(posts,2);
  assert.equal((await routes.run(db,ctx.workspaceId,{transport})).sent,0,'A replay sends nothing.');assert.equal(posts,2);
  await provider.configureRule(db,ctx,{action:'disable'});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM stockchief_runtime.agent_3pl_routes WHERE workspace_id=$1 AND enabled',[ctx.workspaceId])).rows[0].n,0);
  await plan('starter');
  assert.equal((await provider.dashboard(db,ctx)).stock.length,0);
  await provider.disconnect(db,ctx);
  await plan('pro');
  await assert.rejects(provider.refresh(db,ctx,order.salesOrderId,transport),/Connect/);
});
