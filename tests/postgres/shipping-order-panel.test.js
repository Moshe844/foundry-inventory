'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),playwright=require('playwright');

const fakeCarrier={
  async quote(){return {providerShipmentIds:['ps-1'],rates:[{rateId:'r-usps',carrier:'usps',service:'Ground Advantage',amountMinor:742,currency:'USD',deliveryDays:4},
    {rateId:'r-ups',carrier:'ups',service:'Ground',amountMinor:1299,currency:'USD',deliveryDays:3}]};},
  async buy(){throw new Error('not used');},async track(){return {status:'IN_TRANSIT',events:[]};},async verifyEvent(raw){return JSON.parse(raw);},readEvent(e){return e;},
};

test('shipping: link Shippo, no new EasyPost, weight to rates from the order, and address boxes that fill from a ZIP',{timeout:240000},async t=>{
  const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);let app,server,browser;
  t.after(async()=>{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(app)await app.locals.sessionStore.close();await db.close();await cluster.stop();});
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  const password='Ship-'+randomUUID(),owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Panel shop',email:randomUUID()+'@example.test',password});
  const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},wf=require('../../src/operations/postgres-business-workflows');
  const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Main Warehouse',kind:'warehouse',address:'1 Main St, Monroe, NY 10950',phone:'845-555-0100'});
  const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Boot',baseCode:'BOOT-1',trackingMode:'quantity',unitLabel:'pair'});
  const at=new Date().toISOString();
  await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('sup',$1,'Supply','active','USD',$2,$2)",[ctx.workspaceId,at]);
  const po=await wf.createPurchaseOrder(db,ctx,{supplierId:'sup',destinationLocationId:location.id,idempotencyKey:'po',lines:[{skuId:item.skuIds[0],quantityUnits:5,unitCost:10}]});
  await wf.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'poa'});await wf.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'pop'});
  await wf.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'por',reference:'R',lines:[{lineId:po.lineIds[0],quantity:5,locationId:location.id}]});
  await db.query("INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at) VALUES('cust',$1,'Sarah','s@example.test','718-555-0101','245 Bedford Ave, Brooklyn, NY 11211','ACTIVE',$2,$3,$3)",[ctx.workspaceId,ctx.actorId,at]);
  const order=await wf.createSalesOrder(db,ctx,{customerId:'cust',deliveryMethod:'SHIP',fulfillmentLocationId:location.id,idempotencyKey:'so',lines:[{skuId:item.skuIds[0],quantity:1,unitPriceMinor:9900}]});
  await wf.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'sok'});
  const realFetch=global.fetch;const addressFetch=async(url,init)=>String(url).startsWith('https://api.zippopotam.us/us/10952')?new Response(JSON.stringify({places:[{'place name':'Monsey','state abbreviation':'NY'}]}),{status:200,headers:{'content-type':'application/json'}}):realFetch(url,init);global.fetch=addressFetch;
  t.after(()=>{global.fetch=realFetch;});
  app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),shippingOptions:{providerResolver:()=>fakeCarrier,
    shippoLink:{configured:()=>true,start:redirect=>({url:redirect+'?code=c&state=s1',saved:{state:'s1',at:Date.now()}}),exchange:async code=>{assert.equal(code,'c');return 'oauth.linked-token';}}}});
  server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});const base='http://127.0.0.1:'+server.address().port;
  browser=await playwright.chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/login');await page.getByLabel('Work email').fill(owner.email);await page.locator('[name=password]').fill(password);
  await Promise.all([page.waitForURL(base+'/'),page.getByRole('button',{name:'Sign in',exact:true}).click()]);

  // Without an account, the order offers to connect one and still allows shipping without a label.
  await page.goto(base+'/orders/'+order.salesOrderId);
  assert(await page.getByRole('link',{name:'Connect a shipping account'}).isVisible());assert(await page.getByRole('link',{name:'Ship without a label'}).isVisible());

  // The connect page: ShipEngine first, no EasyPost choice, and a refused EasyPost post.
  await page.goto(base+'/settings/shipping');
  const providers=await page.locator('select[name=provider] option').evaluateAll(o=>o.map(x=>x.value));assert.deepEqual(providers,['shipengine','shippo','shipstation']);
  const token=await page.locator('[name=_csrf]').first().inputValue(),refused=await page.request.post(base+'/settings/shipping/account',{form:{_csrf:token,provider:'easypost',apiKey:'EZTK_x'},maxRedirects:0});
  assert.equal(refused.status(),303);assert.equal((await require('../../src/shipping/postgres-accounts').describeAll(db,ctx.workspaceId)).length,0);

  // Link Shippo: sign in and approve at Shippo (simulated), come back connected with a Bearer token.
  await Promise.all([page.waitForURL(base+'/settings/shipping'),page.getByRole('link',{name:'Link Shippo account'}).click()]);
  assert.match(await page.locator('main').innerText(),/Your Shippo account is linked/);
  const linked=await require('../../src/shipping/postgres-accounts').forWorkspace(db,ctx.workspaceId,{provider:'shippo'});assert.equal(linked.apiKey,'oauth.linked-token');
  const sent=[];global.fetch=async(url,init)=>{sent.push(init?.headers?.authorization);return new Response('{}',{status:200,headers:{'content-type':'application/json'}});};
  await require('../../src/shipping/providers/shippo').call({shippoApiKey:linked.apiKey},'/carrier_accounts/').catch(()=>{});global.fetch=addressFetch;
  assert.equal(sent[0],'Bearer oauth.linked-token');
  const replay=await page.request.get(base+'/settings/shipping/shippo/callback?code=c&state=s1',{maxRedirects:0});assert.equal(replay.status(),303,'a used link cannot be replayed');

  // Ship this order: weight in, packed parcel with rates out, nothing bought.
  await page.goto(base+'/orders/'+order.salesOrderId);
  await page.getByLabel('Parcel weight').fill('2.5');
  await Promise.all([page.waitForURL(/\/fulfilment\/.+#carrier/),page.getByRole('button',{name:'Get shipping rates'}).click()]);
  assert.match(await page.locator('main').innerText(),/Rates are ready/);assert(await page.getByRole('button',{name:'Buy label'}).isVisible());
  const shipment=(await db.query('SELECT status,weight_grams FROM sales_shipments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  assert.equal(shipment.status,'PACKED');assert.equal(Number(shipment.weight_grams),1134);
  assert.equal((await db.query("SELECT count(*)::int n FROM shipping_label_transactions WHERE workspace_id=$1",[ctx.workspaceId])).rows[0].n,0);

  // Address boxes: a ZIP fills city and state, and the customer is saved with the full address.
  await page.goto(base+'/sales/customers/new');await page.locator('[name=name]').fill('Moshe');
  await page.getByLabel('Street address').fill('18 Forshay Rd');await page.getByLabel('ZIP code').fill('10952');
  await page.waitForFunction(()=>document.querySelector('[data-part=city]').value==='Monsey');
  assert.equal(await page.locator('select[data-part=state]').inputValue(),'NY');
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Create customer',exact:true}).click()]);
  assert.match((await db.query("SELECT shipping_address FROM customers WHERE workspace_id=$1 AND name='Moshe'",[ctx.workspaceId])).rows[0].shipping_address,/18 Forshay Rd[\s\S]*Monsey, NY 10952/);
  assert.deepEqual(errors,[]);
});
