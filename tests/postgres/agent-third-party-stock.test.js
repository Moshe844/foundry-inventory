'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('third-party stock review follows real consignment movements and saved ShipBob reads without adding foreign or overlapping stock',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,subscribe,browser}=f;
 const reviews=require('../../src/autopilot/job-reviews'),custody=require('../../src/custody/postgres-service'),provider=require('../../src/connections/postgres-shipbob-sandbox');
 const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code,today=new Date().toISOString().slice(0,10);
 const value=async()=>Number((await db.query('SELECT sum(total_cost_minor) n FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 const review=()=>reviews.run(db,ctx,'third-party-stock');
 await subscribe('starter');await assert.rejects(review(),e=>e.code==='entitlement_required');const locked=await browser.get('/autopilot/reviews').expect(200);assert.match(locked.text,/Stock with fulfilment partners and on consignment/);await browser.get('/autopilot/reviews/third-party-stock').expect(402);
 await subscribe('growth');
 const create=kind=>custody.create(db,ctx,{kind,customerId:kind==='CONSIGN_OUT'?'fixture-customer':null,supplierId:kind==='CONSIGN_IN'?'fixture-supplier':null,startDate:today,dueDate:today,requestKey:randomUUID(),lines:[{skuId:sku,quantity:4,unitPriceMinor:900,unitCostMinor:175}]});
 const out=await create('CONSIGN_OUT'),incoming=await create('CONSIGN_IN');
 const operate=(a,action,quantity,key=randomUUID())=>custody.operate(db,ctx,a.id,action,{confirmed:'yes',requestKey:key,lineId:a.lines[0].id,quantity,locationId:f.location.id,issueDate:today,dueDate:today,taxMinor:0});
 await operate(out,'dispatch',3);assert.equal(await f.balance(),20);assert.equal(await value(),2000);
 await operate(incoming,'receive_consigned',4);assert.equal(await f.balance(),24);assert.equal(await value(),2000,'Supplier-owned stock has no owned inventory value.');
 await operate(out,'return',1);await operate(incoming,'take_ownership',1);assert.equal(await f.balance(),24);assert.equal(await value(),2175);
 let calls=0;const transport=async(url,opts)=>{calls++;assert.equal(opts.headers.Authorization,'Bearer fake-sandbox-token');const path=new URL(url).pathname;return new Response(JSON.stringify(path.endsWith('/channel')?[{id:581}]:{inventory_id:7,sku:code,total_on_hand_quantity:15,total_fulfillable_quantity:12}),{status:200});};
 await provider.connect(db,ctx,{apiKey:'fake-sandbox-token',channelId:'581'},transport);await provider.stock(db,ctx,{inventoryId:7,sku:code},transport);assert.equal(calls,2);
 const fingerprint=async()=>JSON.stringify((await db.query(`SELECT (SELECT jsonb_agg(b ORDER BY sku_id,location_id) FROM balances b WHERE workspace_id=$1) balances,
 (SELECT jsonb_agg(v ORDER BY sku_id,location_id) FROM accounting_inventory_cost_balances v WHERE workspace_id=$1) costs,
 (SELECT count(*) FROM custody_events WHERE workspace_id=$1) movements,(SELECT count(*) FROM accounting_customer_invoices WHERE workspace_id=$1) invoices`,[ctx.workspaceId])).rows);
 const before=await fingerprint();let result=await review();assert.equal(result.rows.length,3);assert.equal(calls,2,'The review does not silently poll the provider.');assert.match(result.summary,/overlapping records are not added/);
 const outgoing=result.rows.find(r=>r.Source==='Customer consignment'),ownedBySupplier=result.rows.find(r=>r.Source==='Supplier consignment'),snapshot=result.rows.find(r=>r.Source.startsWith('ShipBob'));
 assert.equal(outgoing['Stock owner'],'Our business');assert.equal(outgoing['Recorded units'],'2');assert.equal(outgoing['In inspection'],'1');assert.equal(outgoing.Status,'Recorded positions agree');assert.equal(outgoing.link,'/custody/'+out.id);
 assert.equal(ownedBySupplier['Stock owner'],'Fixture parts');assert.equal(ownedBySupplier['Recorded units'],'3');assert.equal(snapshot['Recorded units'],'15');assert.equal(snapshot['3PL reported available'],'12');assert.equal(snapshot['Stock owner'],'Not established by the snapshot');assert.equal(await fingerprint(),before);
 for(const tier of ['growth','pro','enterprise']){await subscribe(tier);assert.deepEqual((await review()).rows,result.rows);await browser.get('/autopilot/reviews/third-party-stock').expect(200);}
 await browser.get(outgoing.link).expect(200);await browser.get(snapshot.link).expect(200);
 assert.equal((await reviews.run(db,ctx,'third-party-stock',{filter:out.agreement_number})).rows.length,1);assert.equal((await reviews.run(db,ctx,'third-party-stock',{filter:'Fixture parts'})).rows.length,1);assert.equal((await reviews.run(db,ctx,'third-party-stock',{filter:'missing'})).rows.length,0);
 const key=randomUUID(),sold=await operate(out,'sell',1,key);assert(sold.invoiceId);assert.equal(await f.balance(),23);assert.equal((await review()).rows.find(r=>r.Source==='Customer consignment')['Recorded units'],'1');assert((await operate(out,'sell',1,key)).replayed);assert.equal(await f.balance(),23);
 await db.query("UPDATE workspace_connectors SET paused_at=now() WHERE workspace_id=$1 AND connector_key='agent-shipbob-sandbox'",[ctx.workspaceId]);result=await review();assert.match(result.rows.find(r=>r.Source.startsWith('ShipBob')).Status,/paused or disconnected/);assert.equal(calls,2);
 await db.query("UPDATE balances SET on_hand=on_hand+1 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3",[ctx.workspaceId,sku,out.external_location_id]);assert.equal((await review()).rows.find(r=>r.Source==='Customer consignment').Status,'Recorded quantities differ','An inconsistency is flagged, not silently repaired.');
 await subscribe('growth');const locations=require('../../src/domain/postgres-location-service'),second=await locations.createLocation(db,ctx,{name:'Second return warehouse',kind:'warehouse'});
 const agreements=async()=>Number((await db.query('SELECT count(*) n FROM custody_agreements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),countBefore=await agreements();
 await assert.rejects(create('CONSIGN_OUT'),/Choose the active warehouse/);assert.equal(await agreements(),countBefore,'Ambiguous warehouse choices roll back the agreement and protected locations.');
 const form=await browser.get('/custody/new').expect(200);assert.match(form.text,/Warehouse for return inspection/);assert.match(form.text,/Second return warehouse/);
 const input={_csrf:f.csrf(form.text),kind:'RENTAL',customerId:'fixture-customer',startDate:today,dueDate:today,requestKey:randomUUID(),inspectionParentLocationId:second.id,lineSkuId:sku,lineQuantity:'1',linePrice:'1.00',lineCost:'1.00'};
 const saved=await browser.post('/custody').type('form').send(input).expect(303),agreementId=saved.headers.location.split('/').at(-1),agreement=await custody.get(db,ctx,agreementId);
 assert.equal((await db.query('SELECT parent_location_id FROM locations WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,agreement.inspection_location_id])).rows[0].parent_location_id,second.id);
 const replay=await browser.post('/custody').type('form').send(input).expect(303);assert.equal(replay.headers.location,saved.headers.location);assert.equal(await agreements(),countBefore+1);
 const wrongParent=await browser.post('/custody').type('form').send({...input,inspectionParentLocationId:f.location.id});assert.notEqual(wrongParent.headers.location,saved.headers.location);await assert.rejects(custody.create(db,ctx,{...input,inspectionParentLocationId:f.location.id,lines:[{skuId:sku,quantity:1,unitPriceMinor:100,unitCostMinor:100}]}),/different details/);assert.equal(await agreements(),countBefore+1);
 await subscribe('growth');const ent=require('../../src/commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(db,ctx.workspaceId),meter=await ent.meterState(db,scope,'locations');
 for(let i=meter.used;i<meter.hardLimit;i++)await locations.createLocation(db,ctx,{name:'Capacity warehouse '+i,kind:'warehouse'});
 const atCapacity=await agreements();await assert.rejects(custody.create(db,ctx,{kind:'CONSIGN_OUT',customerId:'fixture-customer',startDate:today,dueDate:today,requestKey:randomUUID(),inspectionParentLocationId:second.id,lines:[{skuId:sku,quantity:1,unitPriceMinor:1,unitCostMinor:1}]}),e=>e.code==='entitlement_required');assert.equal(await agreements(),atCapacity,'Protected external sites still consume the actual plan allowance.');
 await assert.rejects(reviews.run(db,{...ctx,workspaceId:'foreign'},'third-party-stock'));await db.query("UPDATE users SET role='clerk' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);await assert.rejects(review(),/Only the business owner/);await browser.get('/autopilot/reviews/third-party-stock').expect(403);
});

test('third-party stock review paginates complete agreements and stays readable on a phone',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;await f.subscribe('growth');
 const catalog=require('../../src/domain/postgres-catalog-service'),lines=[];
 for(let i=0;i<101;i++){const item=await catalog.createItem(db,ctx,{name:'Consignment review '+i,baseCode:'PARTNER-'+String(i).padStart(3,'0'),trackingMode:'quantity'});lines.push({skuId:item.skuIds[0],quantity:1,unitPriceMinor:1,unitCostMinor:1});}
 const today=new Date().toISOString().slice(0,10);await require('../../src/custody/postgres-service').create(db,ctx,{kind:'CONSIGN_OUT',customerId:'fixture-customer',startDate:today,dueDate:today,requestKey:randomUUID(),lines});
 const reviews=require('../../src/autopilot/job-reviews'),first=await reviews.run(db,ctx,'third-party-stock'),last=await reviews.run(db,ctx,'third-party-stock',{page:2});assert.equal(first.rows.length,100);assert.equal(first.more,true);assert.equal(last.rows.length,1);assert.equal(last.more,false);assert.equal(new Set([...first.rows,...last.rows].map(r=>r.SKU)).size,101);assert(first.rows.every(r=>r.Status==='No units currently held'));
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),browser=await require('playwright').chromium.launch();f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const page=await browser.newPage({viewport:{width:390,height:844}}),origin='http://127.0.0.1:'+server.address().port;await page.goto(origin+'/login');await page.locator('input[name="email"]').fill(f.email);await page.locator('input[name="password"]').fill(f.password);await page.locator('button[type="submit"]').click();await page.goto(origin+'/autopilot/reviews/third-party-stock');assert.match(await page.locator('body').innerText(),/Supplier-owned goods stay separate/);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const fs=require('node:fs'),path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');fs.mkdirSync(folder,{recursive:true});await page.screenshot({path:path.join(folder,'third-party-stock-phone.png')});
});
