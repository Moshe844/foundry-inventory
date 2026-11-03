'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),playwright=require('playwright');

const fakeCarrier={async quote(){return {providerShipmentIds:['ps-1'],rates:[{rateId:'r-usps',carrier:'usps',service:'Ground Advantage',amountMinor:742,currency:'USD',deliveryDays:4}]};},
 async buy(){throw new Error('not used');},async track(){return {status:'IN_TRANSIT',events:[]};},async verifyEvent(raw){return JSON.parse(raw);},readEvent(e){return e;}};

test('first shipped order from a bare start: connect and come back, every missing detail asked once on the order',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);let app,server,browser;
 t.after(async()=>{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(app)await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const password='Ship-'+randomUUID(),owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Bare shop',email:randomUUID()+'@example.test',password});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},wf=require('../../src/operations/postgres-business-workflows'),catalog=require('../../src/domain/postgres-catalog-service');
 const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Back Stockroom',kind:'stockroom'});
 const boots=await catalog.createItem(db,ctx,{name:'Boots',baseCode:'BOOT-1',trackingMode:'quantity',unitLabel:'pair'}),flour=await catalog.createItem(db,ctx,{name:'Flour',baseCode:'FLOUR-1',trackingMode:'quantity',unitLabel:'kg',quantityPrecision:2,quantityIncrement:'0.01'});
 const at=new Date().toISOString();
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('sup',$1,'Supply','active','USD',$2,$2)",[ctx.workspaceId,at]);
 const po=await wf.createPurchaseOrder(db,ctx,{supplierId:'sup',destinationLocationId:location.id,idempotencyKey:'po',lines:[{skuId:boots.skuIds[0],quantityUnits:40,unitCost:10},{skuId:flour.skuIds[0],quantityUnits:12.75,unitCost:1}]});
 await wf.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'poa'});await wf.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'pop'});
 await wf.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'por',reference:'R',lines:[{lineId:po.lineIds[0],quantity:40,locationId:location.id},{lineId:po.lineIds[1],quantity:12.75,locationId:location.id}]});
 await db.query("INSERT INTO customers(id,workspace_id,name,email,shipping_address,record_state,created_by_user_id,created_at,updated_at) VALUES('cust',$1,'Sarah','s@example.test','245 Bedford Ave, Brooklyn, NY 11211','ACTIVE',$2,$3,$3)",[ctx.workspaceId,ctx.actorId,at]);
 const order=await wf.createSalesOrder(db,ctx,{customerId:'cust',deliveryMethod:'SHIP',shipToAddress:'245 Bedford Ave, Brooklyn, NY 11211',fulfillmentLocationId:location.id,idempotencyKey:'so',lines:[{skuId:boots.skuIds[0],quantity:1,unitPriceMinor:9900}]});
 await wf.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'sok'});
 const realFetch=global.fetch;global.fetch=async(url,init)=>String(url).startsWith('https://api.zippopotam.us/us/10952')?new Response(JSON.stringify({places:[{'place name':'Monsey','state abbreviation':'NY'}]}),{status:200,headers:{'content-type':'application/json'}}):realFetch(url,init);
 t.after(()=>{global.fetch=realFetch;});
 app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),shippingOptions:{providerResolver:()=>fakeCarrier,verifyAccount:async()=>({ok:true})}});
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});const base='http://127.0.0.1:'+server.address().port;
 browser=await playwright.chromium.launch();const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/login');await page.getByLabel('Work email').fill(owner.email);await page.locator('[name=password]').fill(password);
 await Promise.all([page.waitForURL(base+'/'),page.getByRole('button',{name:'Sign in',exact:true}).click()]);

 // New order offers to connect.
 await page.goto(base+'/orders/new');assert(await page.getByRole('button',{name:'Save and connect shipping'}).isVisible());

 // From the order: connect, then straight back to that order.
 const orderUrl=base+'/orders/'+order.salesOrderId;
 await page.goto(orderUrl);
 await Promise.all([page.waitForURL(/\/settings\/shipping\?returnTo=/),page.getByRole('link',{name:'Connect a shipping account'}).click()]);
 assert(await page.getByLabel('API key',{exact:true}).isVisible(),'the key form is already open');
 await page.getByLabel('API key',{exact:true}).fill('TEST_local');
 await Promise.all([page.waitForURL(orderUrl+'#ship-now'),page.getByRole('button',{name:'Verify and connect',exact:true}).click()]);

 // Everything missing is on one form on the order, marked required, and blank stays here.
 const card=page.locator('#ship-now');
 assert.match(await card.innerText(),/Carriers need these before they can quote/);
 await page.getByRole('button',{name:'Get shipping rates'}).click();
 assert.equal(page.url(),orderUrl+'#ship-now');assert.equal(await card.locator('input[name=customerPhone]:invalid').count(),1);
 assert.equal(await card.locator('.addr.is-required').count(),1,'address boxes are marked required');
 await card.getByLabel('Customer phone').fill('718-555-0101');
 await card.getByLabel('Street address').fill('18 Forshay Rd');await card.getByLabel('ZIP code').fill('10952');
 await page.waitForFunction(()=>document.querySelector('[data-address-target=ship-from-address] [data-part=city]').value==='Monsey');
 await card.getByLabel('Ship-from phone').fill('845-555-0100');await card.getByLabel('Parcel weight').fill('2.5');
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Get shipping rates'}).click()]);

 // One press: details saved, rates on the order, nothing pointing at another page.
 assert.equal(page.url(),orderUrl+'#ship-now');assert(await page.getByRole('button',{name:'Buy label'}).isVisible());
 const body=await page.locator('main').innerText();assert.doesNotMatch(body,/Do this next/);assert.doesNotMatch(body,/Carriers need these/);
 const saved=(await db.query('SELECT address,phone FROM locations WHERE id=$1',[location.id])).rows[0];assert.equal(saved.address,'18 Forshay Rd, Monsey, NY 10952');assert.equal(saved.phone,'845-555-0100');
 assert.equal((await db.query("SELECT phone FROM customers WHERE id='cust'")).rows[0].phone,'718-555-0101');

 // A location link opens that location, in boxes, and saving goes back where you came from.
 const parcel=(await db.query('SELECT id FROM sales_shipments WHERE sales_order_id=$1',[order.salesOrderId])).rows[0].id,back='/fulfilment/'+parcel+'#carrier';
 await page.goto(base+'/locations?edit='+location.id+'&returnTo='+encodeURIComponent(back));
 const dialog=page.locator('#modal-location-'+location.id);await dialog.waitFor({state:'visible'});
 assert.equal(await dialog.getByLabel('Street address').inputValue(),'18 Forshay Rd');assert.equal(await dialog.getByLabel('ZIP code').inputValue(),'10952');
 await Promise.all([page.waitForURL(base+back),dialog.getByRole('button',{name:'Save',exact:true}).click()]);
 await page.goto(base+'/locations?returnTo=https%3A%2F%2Fevil.example%2F');assert.equal(await page.locator('[name=returnTo]').count(),0,'only a path inside the app can be returned to');

 // Whole units and measured stock are not added together.
 const row=page.locator('tr',{hasText:'Back Stockroom'});assert.match(await row.innerText(),/\b39|\b40/);assert.match(await row.locator('[data-measured-stock]').innerText(),/\+ 12\.75 kg/);
 assert.doesNotMatch(await row.locator('.cell-end strong').innerText(),/\./);
 assert.deepEqual(errors,[]);
});
