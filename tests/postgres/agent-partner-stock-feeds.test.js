'use strict';

process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const request=require('supertest');

test('job 123: 3PL and consignment counts from ShipBob, a feed link and uploaded files are compared with the records and never counted as owned stock',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,csrf,subscribe}=f,ws=ctx.workspaceId;
  const partnerStock=require('../../src/autopilot/partner-stock'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const inv=require('../../src/domain/postgres-inventory-engine'),catalog=require('../../src/domain/postgres-catalog-service'),locations=require('../../src/domain/postgres-location-service');
  const custody=require('../../src/custody/postgres-service'),shipbob=require('../../src/connections/postgres-shipbob-sandbox');
  const time=require('../../src/lib/business-time'),clock=await time.forWorkspace(db,ws),today=clock.calendarDate;
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  f.cleanup(()=>app.locals.sessionStore.close());
  const partner=request(app),path=partnerStock.path;
  const needs=async()=>require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
  const ago=minutes=>new Date(Date.now()-minutes*60000).toISOString();
  const local=ms=>{const p=time.parts(new Date(ms),clock.timeZone),z=n=>String(n).padStart(2,'0');return p.day+'T'+z(p.hour)+':'+z(p.minute);};
  const position=async(locationId,skuId)=>(await db.query(`SELECT reported::text,expected::text,available::text,status,report_id,observed_at
    FROM stockchief_runtime.agent_partner_stock_positions WHERE workspace_id=$1 AND location_id=$2 AND sku_id=$3`,[ws,locationId,skuId])).rows[0];
  const reports=async()=>(await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_partner_stock_reports WHERE workspace_id=$1',[ws])).rows[0].n;
  const fingerprint=async()=>JSON.stringify((await db.query(`SELECT (SELECT jsonb_agg(b ORDER BY sku_id,location_id) FROM balances b WHERE workspace_id=$1) balances,
    (SELECT jsonb_agg(v ORDER BY sku_id,location_id) FROM accounting_inventory_cost_balances v WHERE workspace_id=$1) costs,
    (SELECT count(*) FROM movements WHERE workspace_id=$1) moves`,[ws])).rows);

  // An account on its older terms sees the plan card; Starter is locked.
  assert.match((await browser.get(path).expect(200)).text,/data-agent-plan-locked/);
  await subscribe('starter');
  await browser.get(path).expect(402);
  await assert.rejects(partnerStock.savePartner(db,ctx,{locationId:f.location.id,kind:'three_pl',source:'feed',partner:'Nobody',revision:0,confirmed:'yes'}),e=>e.code==='entitlement_required');

  // Growth, still in its first 14 days: reading and comparing only record, so they run.
  await subscribe('growth');
  assert.equal((await require('../../src/commercial/agent-plan').accountState(db,ws)).shadow,true);
  // A consignment agreement puts 3 of the fixture product at the customer's store.
  const fixtureSku=f.item.skuIds[0],fixtureCode=(await db.query('SELECT code FROM skus WHERE id=$1',[fixtureSku])).rows[0].code;
  const agreement=await custody.create(db,ctx,{kind:'CONSIGN_OUT',customerId:'fixture-customer',startDate:today,dueDate:today,requestKey:randomUUID(),
    inspectionParentLocationId:f.location.id,lines:[{skuId:fixtureSku,quantity:4,unitPriceMinor:900,unitCostMinor:175}]});
  await custody.operate(db,ctx,agreement.id,'dispatch',{confirmed:'yes',requestKey:randomUUID(),lineId:agreement.lines[0].id,quantity:3,locationId:f.location.id,issueDate:today,dueDate:today,taxMinor:0});
  const east=await locations.createLocation(db,ctx,{name:'East 3PL',kind:'warehouse'});
  const productA=await catalog.createItem(db,ctx,{name:'Partner product A',baseCode:'PARTNER-A',trackingMode:'quantity'}),A=productA.skuIds[0];
  const productB=await catalog.createItem(db,ctx,{name:'Partner product B',baseCode:'PARTNER-B',trackingMode:'quantity'}),B=productB.skuIds[0];
  await inv.receive(db,ctx,{skuId:A,locationId:east.id,quantity:10,occurredAt:ago(60),idempotencyKey:randomUUID()});

  // Set up the 3PL location and give its system a private feed link.
  let page=await browser.get(path).expect(200);
  assert.match(page.text,/Add a partner location/);
  await assert.rejects(partnerStock.savePartner(db,ctx,{locationId:east.id,kind:'consignment',source:'feed',partner:'East Fulfilment',revision:0,confirmed:'yes'}),/consignment agreement/);
  await assert.rejects(partnerStock.savePartner(db,ctx,{locationId:agreement.external_location_id,kind:'three_pl',source:'feed',partner:'Store',revision:0,confirmed:'yes'}),/not a consignment location/);
  await browser.post(path).type('form').send({_csrf:csrf(page.text),locationId:east.id,kind:'three_pl',source:'feed',partner:'East Fulfilment',tolerance:'0',revision:0,confirmed:'yes'}).expect(303);
  await assert.rejects(partnerStock.savePartner(db,ctx,{locationId:east.id,kind:'three_pl',source:'feed',partner:'East Fulfilment',revision:0,confirmed:'yes'}),/Reload/);
  page=await browser.get(path).expect(200);
  const issued=await browser.post(path+'/'+east.id+'/feed').type('form').send({_csrf:csrf(page.text),confirmed:'yes'}).expect(200);
  const link=issued.text.match(/\/partner-stock\/feed\/[A-Za-z0-9_-]{43}/)[0];
  const before=await fingerprint();

  // The partner reports 8 where the records held 10: flagged, nothing changes.
  const first={reference:'east-1',countedAt:ago(10),lines:[{sku:'partner-a',quantity:8,available:7}]};
  let sent=await partner.post(link).send(first).expect(201);
  assert.deepEqual(sent.body,{reference:'east-1',saved:true,replayed:false,lines:1,differences:1});
  assert.equal(sent.headers['cache-control'],'no-store');
  let a=await position(east.id,A);
  assert.equal(a.status,'DIFFERS');assert.equal(a.reported,'8');assert.equal(a.expected,'10');assert.equal(a.available,'7');
  assert.equal((await partner.post(link).send(first).expect(200)).body.replayed,true);
  const count=await reports();
  assert.match((await partner.post(link).send({...first,lines:[{sku:'PARTNER-A',quantity:9}]}).expect(400)).body.error.message,/already used/);
  assert.match((await partner.post(link).send({reference:'east-x',countedAt:ago(9),lines:[{sku:'PARTNER-A',quantity:9},{sku:'NOT-A-SKU',quantity:1}]}).expect(400)).body.error.message,/NOT-A-SKU.*Nothing was saved/);
  assert.match((await partner.post(link).send({reference:'east-y',countedAt:'2026-11-13T09:00',lines:[{sku:'PARTNER-A',quantity:9}]}).expect(400)).body.error.message,/time zone/);
  assert.match((await partner.post(link).send({reference:'east-z',countedAt:new Date(Date.now()+86400000).toISOString(),lines:[{sku:'PARTNER-A',quantity:9}]}).expect(400)).body.error.message,/future/);
  assert.match((await partner.post(link).send({reference:'east-w',countedAt:ago(9),lines:[{sku:'PARTNER-A',quantity:-1}]}).expect(400)).body.error.message,/negative/);
  assert.equal(await reports(),count,'Refused reports save nothing.');
  assert.equal(await fingerprint(),before,'A partner count never changes stock or its value.');
  assert.ok((await needs()).some(n=>n.title==='East Fulfilment counted a different amount of PARTNER-A'));

  // Planning counts on the lower number, and never on more than the records.
  assert.equal((await partnerStock.planningShortfalls(db,ws,[A],[east.id])).get(A).units,'2');
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:A,purchaseUnit:'unit',unitsPerPurchaseUnit:1,lastUnitCost:2,orderMultiple:1,minimumOrderQuantity:1,isPreferred:true});
  const facts=await require('../../src/purchasing/planning-stock-source').inventoryFacts(db,ctx,{supplierId:'fixture-supplier',locationId:east.id,skuIds:[A]},{jobId:123,incomingBy:require('../../src/accounting/customer-money').addDays(today,30)});
  assert.equal(facts.rows[0].onHand,'8');
  assert.ok(facts.warnings.some(w=>/East Fulfilment counted 8 at East 3PL where StockChief expected 10/.test(w.reason)));

  // A count is compared with the records at its own time: moves after it are taken out.
  await inv.receive(db,ctx,{skuId:A,locationId:east.id,quantity:5,occurredAt:ago(4),idempotencyKey:randomUUID()});
  const moved=await fingerprint();
  await partner.post(link).send({reference:'east-2',countedAt:ago(5),lines:[{sku:'PARTNER-A',quantity:10}]}).expect(201);
  a=await position(east.id,A);
  assert.equal(a.status,'AGREES');assert.equal(a.expected,'10');
  assert.equal((await partnerStock.planningShortfalls(db,ws,[A],[east.id])).size,0);
  // An older count is kept but cannot replace a newer one.
  await partner.post(link).send({reference:'east-0',countedAt:ago(20),lines:[{sku:'PARTNER-A',quantity:1}]}).expect(201);
  assert.equal((await position(east.id,A)).reported,'10');
  // CSV from the partner's system works the same way.
  await partner.post(link+'?reference=east-csv&countedAt='+encodeURIComponent(ago(3))).set('content-type','text/csv').send('SKU,Quantity\nPARTNER-A,15\n').expect(201);
  assert.equal((await position(east.id,A)).status,'AGREES');

  // The owner uploads a complete file: products left out count as none.
  page=await browser.get(path).expect(200);
  await browser.post(path+'/'+east.id+'/upload').field('_csrf',csrf(page.text)).field('observedAt',local(Date.now()-60000)).field('complete','yes').field('confirmed','yes')
    .attach('counts',Buffer.from('SKU,Quantity\nPARTNER-B,3\n'),'east-count.csv').expect(303);
  a=await position(east.id,A);const b=await position(east.id,B);
  assert.equal(a.status,'DIFFERS');assert.equal(a.reported,'0');assert.equal(a.expected,'15');
  assert.equal(b.status,'DIFFERS');assert.equal(b.reported,'3');assert.equal(b.expected,'0');
  const shortfalls=await partnerStock.planningShortfalls(db,ws,[A,B],[east.id]);
  assert.equal(shortfalls.get(A).units,'15');assert.equal(shortfalls.has(B),false,'A partner count above the records is never added.');
  assert.equal(await fingerprint(),moved);
  const item=await browser.get('/inventory/'+productB.itemId).expect(200);
  assert.match(item.text,/Counted by partners/);assert.match(item.text,/East Fulfilment/);
  // The owner checks and explains one difference; stock stays as recorded.
  page=await browser.get(path).expect(200);
  assert.match(page.text,/They counted/);
  await browser.post(path+'/'+east.id+'/explain').type('form').send({_csrf:csrf(page.text),skuId:A,reportId:a.report_id,note:'Stock was in their returns area',confirmed:'yes'}).expect(303);
  assert.equal((await position(east.id,A)).status,'EXPLAINED');
  assert.deepEqual(await partnerStock.explain(db,ctx,east.id,{skuId:A,reportId:a.report_id,note:'Again',confirmed:'yes'}),{replayed:true});
  await assert.rejects(partnerStock.explain(db,ctx,east.id,{skuId:B,reportId:'old-report',note:'Checked',confirmed:'yes'}),/newer partner count/);
  assert.equal((await partnerStock.planningShortfalls(db,ws,[A],[east.id])).size,0);
  let titles=(await needs()).map(n=>n.title);
  assert.ok(titles.includes('East Fulfilment counted a different amount of PARTNER-B'));assert.ok(!titles.includes('East Fulfilment counted a different amount of PARTNER-A'));
  assert.equal(await fingerprint(),moved);

  // ShipBob readings are compared at the ShipBob location as they are saved.
  let onHand=15,fulfillable=12;
  const transport=async(url)=>{const p=new URL(url).pathname;return new Response(JSON.stringify(p.endsWith('/channel')?[{id:581}]:
    {inventory_id:7,sku:'PARTNER-A',total_on_hand_quantity:onHand,total_fulfillable_quantity:fulfillable}),{status:200});};
  await shipbob.connect(db,ctx,{apiKey:'fake-sandbox-token',channelId:'581'},transport);
  await shipbob.stock(db,ctx,{inventoryId:7,sku:'PARTNER-A'},transport);
  const nj=await locations.createLocation(db,ctx,{name:'ShipBob NJ',kind:'warehouse'});
  page=await browser.get(path).expect(200);
  assert.match(page.text,/ShipBob readings/);
  await assert.rejects(partnerStock.savePartner(db,ctx,{locationId:nj.id,kind:'consignment',source:'shipbob',partner:'ShipBob',revision:0,confirmed:'yes'}),/consignment agreement/);
  await browser.post(path).type('form').send({_csrf:csrf(page.text),locationId:nj.id,kind:'three_pl',source:'shipbob',partner:'ShipBob',tolerance:'0',revision:0,confirmed:'yes'}).expect(303);
  let s=await position(nj.id,A);
  assert.equal(s.status,'DIFFERS');assert.equal(s.reported,'15');assert.equal(s.available,'12');assert.equal(s.expected,'0');
  await assert.rejects(partnerStock.savePartner(db,ctx,{locationId:f.location.id,kind:'three_pl',source:'shipbob',partner:'ShipBob again',revision:0,confirmed:'yes'}),/already go to another location/);
  onHand=0;fulfillable=0;
  await shipbob.stock(db,ctx,{inventoryId:7,sku:'PARTNER-A'},transport);
  s=await position(nj.id,A);
  assert.equal(s.status,'AGREES');assert.equal(s.reported,'0');

  // Consignment: the customer's store reports what it holds of ours.
  page=await browser.get(path).expect(200);
  await browser.post(path).type('form').send({_csrf:csrf(page.text),locationId:agreement.external_location_id,kind:'consignment',source:'feed',partner:'Receiver store',tolerance:'0',revision:0,confirmed:'yes'}).expect(303);
  page=await browser.get(path).expect(200);
  const storeLink=(await browser.post(path+'/'+agreement.external_location_id+'/feed').type('form').send({_csrf:csrf(page.text),confirmed:'yes'}).expect(200))
    .text.match(/\/partner-stock\/feed\/[A-Za-z0-9_-]{43}/)[0];
  await partner.post(storeLink+'?reference=store-1&countedAt='+encodeURIComponent(new Date().toISOString())).set('content-type','text/csv')
    .send('Item code,Qty\n'+fixtureCode+',3\n').expect(201);
  assert.equal((await position(agreement.external_location_id,fixtureSku)).status,'AGREES');
  assert.equal(await fingerprint(),moved);

  // Pause and Watch only still record partner counts; nothing changes either way.
  await autopilot.pause(db,ctx,{role:'owner'},'Pause partner counts');
  await partner.post(link).send({reference:'east-paused',countedAt:ago(1),lines:[{sku:'PARTNER-B',quantity:0}]}).expect(201);
  await autopilot.resume(db,ctx,{role:'owner'});
  await modes.save(db,ctx,123,{mode:'watch',revision:0});
  await partner.post(link).send({reference:'east-watch',countedAt:new Date().toISOString(),lines:[{sku:'PARTNER-B',quantity:0}]}).expect(201);
  assert.equal((await position(east.id,B)).status,'AGREES','A later count that agrees clears the flag.');
  await modes.save(db,ctx,123,{mode:'inherit',revision:1});

  // Only the owner manages partner locations.
  await db.query("UPDATE users SET role='clerk' WHERE workspace_id=$1 AND id=$2",[ws,ctx.actorId]);
  await assert.rejects(partnerStock.savePartner(db,ctx,{locationId:east.id,kind:'three_pl',source:'feed',partner:'Clerk',revision:1,confirmed:'yes'}),/Only the business owner/);
  await db.query("UPDATE users SET role='owner' WHERE workspace_id=$1 AND id=$2",[ws,ctx.actorId]);

  // Pro and Custom work the same way.
  for(const tier of ['pro','enterprise']){
    await subscribe(tier);
    await partner.post(link).send({reference:'east-'+tier,countedAt:new Date().toISOString(),lines:[{sku:'PARTNER-B',quantity:0}]}).expect(201);
    await browser.get(path).expect(200);
  }

  // Back on Starter the link stops, and nothing is shown or used.
  await subscribe('starter');
  await partner.post(link).send({reference:'east-starter',countedAt:new Date().toISOString(),lines:[{sku:'PARTNER-B',quantity:0}]}).expect(404);
  await browser.get(path).expect(402);
  assert.deepEqual(await partnerStock.forItem(db,ctx,[A,B]),[]);
  assert.deepEqual(await partnerStock.inbox(db,ws),[]);
  assert.equal((await partnerStock.planningShortfalls(db,ws,[A],[east.id])).size,0);
  await subscribe('growth');
  page=await browser.get(path).expect(200);
  await browser.post(path+'/'+east.id+'/feed/stop').type('form').send({_csrf:csrf(page.text)}).expect(303);
  await partner.post(link).send({reference:'east-revoked',countedAt:new Date().toISOString(),lines:[{sku:'PARTNER-B',quantity:0}]}).expect(404);
  assert.equal(await fingerprint(),moved);

  // The page reads well on a desktop and a phone.
  const server=await new Promise(resolve=>{const v=app.listen(0,'127.0.0.1',()=>resolve(v));}),chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const origin='http://127.0.0.1:'+server.address().port,fs=require('node:fs'),folder=require('node:path').join(process.cwd(),'output','agent-plan-review');
  fs.mkdirSync(folder,{recursive:true});
  for(const [width,height,name] of [[1440,900,'desktop'],[390,844,'phone']]){
    const tab=await chrome.newPage({viewport:{width,height}});
    await tab.goto(origin+'/login');await tab.locator('input[name="email"]').fill(f.email);await tab.locator('input[name="password"]').fill(f.password);
    await tab.locator('button[type="submit"]').click();await tab.waitForURL(url=>!url.pathname.startsWith('/login'));
    await tab.goto(origin+path);
    assert.match(await tab.locator('body').innerText(),/Stock at partners/);
    assert.ok(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' width');
    await tab.screenshot({path:require('node:path').join(folder,'partner-stock-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
