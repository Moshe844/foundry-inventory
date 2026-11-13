'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 186: sends orders to your 3PL and reads their stock and shipping back.
// Starter is excluded; Growth drafts each order (and each shipment to record)
// for a person; Pro and Custom do it on their own within the owner's route
// for the warehouse the 3PL runs. The 3PL here is a scripted one, reached
// through the same adapter shape as ShipBob. A shipment that does not match,
// a missing fact, pause, Ask me first and a lost answer stop or wait; nothing
// is sent or recorded twice.
test('orders routed to a 3PL go out, and its shipping, tracking and stock come back, per plan',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx,browser,subscribe,workflows}=f,ws=ctx.workspaceId;
  const tpl=require('../../src/connections/agent-3pl-orders'),adapters=require('../../src/connections/third-party-logistics');
  const needs=require('../../src/projections/postgres-service'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const acme=require('../helpers/fake-3pl').fake3pl();t.after(adapters.register(acme.key,acme.adapter));
  const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const run=(options={})=>tpl.run(db,ws,{fresh:true,...options});
  const audits=async(action,automatic)=>Number((await db.query(`SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2 AND ($3::text IS NULL OR after_state->>'automatic'=$3)`,[ws,action,automatic==null?null:String(automatic)])).rows[0].count);
  const row=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_3pl_orders WHERE workspace_id=$1 AND sales_order_id=$2',[ws,id])).rows[0];
  const waiting=async()=>(await needs.needs(db,ws,ctx.actorId)).filter(n=>n.sourceId==='3pl-orders').map(n=>n.title);
  const page=async()=>(await browser.get(tpl.href).expect(200)).text;
  const post=async(path,body={})=>{const r=await browser.post(tpl.href+path).type('form').send({_csrf:f.csrf(await page()),...body});assert.equal(r.status,303,r.text.slice(0,300));return r;};
  let n=0;
  const sale=async({quantity=2,address}={})=>{
    const o=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,idempotencyKey:'3pl-order-'+(++n),
      ...(address?{shipToAddress:address}:{}),lines:[{skuId:sku,quantity,unitPriceMinor:1500}]});
    await workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:'3pl-confirm-'+n});return o.salesOrderId;
  };

  // An account on its older terms sees the plan card; Starter is excluded.
  await db.query('DELETE FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId]);
  assert.match(await page(),/data-agent-plan-locked/);
  await subscribe('starter');
  assert.equal((await browser.get(tpl.href).expect(402)).status,402);
  await assert.rejects(tpl.connect(db,ctx,{provider:acme.key,apiKey:acme.apiKey,account:acme.account}),e=>e.code==='entitlement_required');
  assert.deepEqual(await run(),{skipped:'plan'});

  // Growth: connect the 3PL and say which warehouse it runs. Each order is drafted for a person.
  await subscribe('growth');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await assert.rejects(tpl.connect(db,ctx,{provider:acme.key,apiKey:'wrong',account:acme.account}),/refused/);
  await post('/connect',{provider:acme.key,apiKey:acme.apiKey,account:acme.account});
  const connectorId=(await tpl.connections(db,ws)).find(c=>c.adapter.key===acme.key).id;
  await assert.rejects(tpl.saveRoute(db,ctx,{locationId:f.location.id,connectorId,automatic:'yes'}),e=>e.code==='entitlement_required');
  await post('/routes',{locationId:f.location.id,connectorId});
  const one=await sale({quantity:3});
  assert.deepEqual(await run(),{sent:0,drafted:1,held:0,adopted:0,refreshed:0,recorded:0,waiting:0,stock:0,skipped:0});
  assert.equal((await run()).drafted,0,'A replay drafts nothing new.');
  assert.equal(acme.created,0);assert.equal((await row(one)).status,'DRAFT');
  assert.deepEqual(await waiting(),['1 order waits to go to your 3PL']);
  await post('/orders/'+one+'/approve');
  assert.equal(acme.created,1);assert.equal((await row(one)).status,'SENT');assert.equal(await audits(tpl.SENT_ACTION,false),1);
  assert.deepEqual(acme.orders.get(one).request.items,[{sku:code,qty:3}]);
  // Local picking stays away from an order the 3PL has.
  const line=(await db.query('SELECT id FROM sales_order_lines WHERE sales_order_id=$1',[one])).rows[0];
  await assert.rejects(f.shipping.prepare(db,ctx,one,{idempotencyKey:'local-box',lines:[{lineId:line.id,locationId:f.location.id,quantity:3}]}),/before preparing a local box/);
  // The 3PL ships it: on Growth the shipment waits to be recorded with one tap.
  acme.ship(one,{id:'S1',lines:[{sku:code,quantity:3}],tracking:'1Z-ACME-1'});
  let before=await f.balance(),result=await run();assert.equal(result.waiting,1);assert.equal(result.recorded,0);assert.equal(await f.balance(),before);
  assert.deepEqual(await waiting(),['1 3PL shipment waits to be recorded']);
  await post('/shipments/'+connectorId+'/S1/record');
  const recorded=(await db.query("SELECT * FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2",[ws,one])).rows;
  assert.equal(recorded.length,1);assert.equal(recorded[0].status,'SHIPPED');assert.equal(recorded[0].tracking_number,'1Z-ACME-1');assert.equal(recorded[0].ship_from_location_id,f.location.id);
  assert.equal(await f.balance(),before-3,'The stock left the 3PL warehouse once.');
  assert.equal((await db.query('SELECT status FROM sales_orders WHERE id=$1',[one])).rows[0].status,'FULFILLED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM accounting_customer_invoices WHERE sales_order_id=$1',[one])).rows[0].n,1);
  assert.equal((await tpl.recordParcel(db,ctx,connectorId,'S1',{automatic:false})).replayed,true);assert.equal(await f.balance(),before-3);

  // Pro: the owner lets the route send on its own.
  await subscribe('pro');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const revision=/name="locationId" value="[^"]+"><input type="hidden" name="revision" value="(\d+)"/.exec(await page())[1];
  await post('/routes',{locationId:f.location.id,connectorId,revision,automatic:'yes'});
  const two=await sale();
  result=await run();assert.equal(result.sent,1);assert.equal(acme.created,2);assert.equal(await audits(tpl.SENT_ACTION,true),1);
  assert.equal((await run()).sent,0,'A replay sends nothing twice.');assert.equal(acme.created,2);
  // Split shipments come back as two StockChief shipments, each with its tracking.
  acme.ship(two,{id:'S2',lines:[{sku:code,quantity:1}],tracking:'1Z-ACME-2'});acme.ship(two,{id:'S3',lines:[{sku:code,quantity:1}],carrier:'FedEx',tracking:'7777-ACME-3'});
  before=await f.balance();result=await run();assert.equal(result.recorded,2);assert.equal(await f.balance(),before-2);
  assert.deepEqual((await db.query("SELECT tracking_number FROM sales_shipments WHERE sales_order_id=$1 ORDER BY tracking_number",[two])).rows.map(r=>r.tracking_number),['1Z-ACME-2','7777-ACME-3']);
  assert.equal(await audits(tpl.RECORDED_ACTION,true),2);

  // Facts that do not match stop and ask: more than reserved, no tracking, an address that is not complete.
  const three=await sale(),four=await sale(),five=await sale({address:'Somewhere'});
  result=await run();assert.equal(result.sent,2);assert.equal(result.held,1);
  assert.match((await row(five)).reason,/Complete the order’s delivery address/);assert.equal(acme.created,4);
  acme.ship(three,{id:'S4',lines:[{sku:code,quantity:5}],tracking:'1Z-ACME-4'});acme.ship(four,{id:'S5',lines:[{sku:code,quantity:2}],tracking:''});
  before=await f.balance();result=await run();assert.equal(result.recorded,0);assert.equal(result.held,2);assert.equal(await f.balance(),before);
  const held=(await db.query("SELECT provider_shipment_id,reason FROM stockchief_runtime.agent_3pl_parcels WHERE workspace_id=$1 AND status='HELD' ORDER BY provider_shipment_id",[ws])).rows;
  assert.match(held[0].reason,/shipped 5 of .*more than this order has reserved/);assert.match(held[1].reason,/tracking number/);
  assert.deepEqual(await waiting(),['3 3PL orders need you']);
  await assert.rejects(tpl.record(db,ctx,connectorId,'S4'),/more than this order has reserved/);

  // A lost answer: the order is checked again under the same reference and never placed twice.
  acme.lose();const six=await sale();
  result=await run();assert.equal(result.sent,0);assert.equal((await row(six)).status,'SENDING');assert.equal(acme.created,5);
  await db.query("UPDATE stockchief_runtime.agent_3pl_orders SET updated_at=now()-interval '5 minutes' WHERE sales_order_id=$1",[six]);
  result=await run();assert.equal(result.sent,1);assert.equal(acme.created,5,'The 3PL already had it.');assert.equal((await row(six)).status,'SENT');

  // Ask me first and pause leave orders as drafts; once allowed again they go on their own.
  await modes.save(db,ctx,186,{mode:'ask',revision:0});
  const seven=await sale();await run();
  assert.equal((await row(seven)).status,'DRAFT');assert.match((await row(seven)).reason,/Ask me first/);assert.equal(acme.created,5);
  await modes.save(db,ctx,186,{mode:'inherit',revision:1});
  await run();assert.equal((await row(seven)).status,'SENT');assert.equal(acme.created,6);
  await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ws]);
  const eight=await sale();await run();assert.match((await row(eight)).reason,/paused/);assert.equal(acme.created,6);
  await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ws]);
  await run();assert.equal((await row(eight)).status,'SENT');

  // Stock the 3PL reports shows with partner stock (job 123) and is read again hourly.
  acme.stock.set('INV-9',{sku:code,onHand:7,available:5});
  await post('/stock',{connectorId,sku:code,inventoryRef:'INV-9'});
  let partner=(await require('../../src/autopilot/third-party-stock').review(db,ctx,{})).rows.find(r=>r.Source==='Acme 3PL saved read');
  assert.equal(partner['Recorded units'],'7');assert.equal(partner['3PL reported available'],'5');
  acme.stock.set('INV-9',{sku:code,onHand:9,available:9});
  await db.query("UPDATE stockchief_runtime.agent_3pl_stock SET observed_at=now()-interval '2 hours' WHERE workspace_id=$1",[ws]);
  assert.equal((await run()).stock,1);
  partner=(await require('../../src/autopilot/third-party-stock').review(db,ctx,{})).rows.find(r=>r.Source==='Acme 3PL saved read');
  assert.equal(partner['Recorded units'],'9');

  // The route counts as a saved rule; the activity log shows what StockChief did on its own.
  assert.ok(await require('../../src/commercial/agent-rule-quota').count(db,f.owner.accountId)>=1);
  const title=require('../../src/commercial/agent-plan-v3.json').find(r=>r.id===186).job;
  assert.ok((await require('../../src/autopilot/agent-activity').report(db,ctx)).rows.filter(r=>r.Job===title).length>=4);

  // Custom does the same; Starter stops and shows nothing.
  await subscribe('enterprise');const nine=await sale();await run();assert.equal((await row(nine)).status,'SENT');
  await subscribe('starter');assert.deepEqual(await run(),{skipped:'plan'});assert.deepEqual(await waiting(),[]);
  await subscribe('pro');

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+tpl.href);
    assert(await tab.getByRole('heading',{name:'Which warehouse each 3PL runs',exact:true}).isVisible());
    assert(await tab.getByRole('heading',{name:'Shipments from the 3PL',exact:true}).isVisible());
    assert.match(await tab.locator('main').innerText(),/Sends on its own/);
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'3pl-orders-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
