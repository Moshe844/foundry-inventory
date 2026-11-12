'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const backorders=require('../../src/sales/agent-backorders');
const modes=require('../../src/autopilot/job-modes');

async function setup(t,{units=10}={}){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units}),{db,ctx}=f;
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const sku=f.item.skuIds[0],ws=ctx.workspaceId;
  const order=async({quantity=2,priority=100,neededBy=null,ship=true,location=f.location.id}={})=>{
    const o=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:ship?'SHIP':'PICKUP',
      ...(ship?{shipToAddress:'10 Jobsite Rd, Albany, NY 12207'}:{}),fulfillmentLocationId:location,neededBy,idempotencyKey:randomUUID(),
      lines:[{skuId:sku,quantity,unitPriceMinor:1000}]});
    if(priority!==100)await db.query('UPDATE sales_orders SET allocation_priority=$2 WHERE workspace_id=$1 AND id=$3',[ws,priority,o.salesOrderId]);
    await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
    return o;
  };
  const receive=async quantity=>{
    const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:quantity,unitCost:1}]});
    await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity,locationId:f.location.id}]});
  };
  const reserved=async o=>Number((await db.query(`SELECT coalesce(sum(a.quantity),0) n FROM sales_order_allocations a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2`,[ws,o.salesOrderId])).rows[0].n);
  const status=async o=>(await db.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ws,o.salesOrderId])).rows[0].status;
  const runs=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_backorder_runs WHERE workspace_id=$1 AND ${where} ORDER BY created_at,id`,[ws])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const mode=async(job,value)=>{const row=(await db.query('SELECT revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2',[ws,job])).rows[0];await modes.save(db,ctx,job,{mode:value,revision:row?.revision||0});};
  const approve=async r=>backorders.approve(db,ctx,r.id,{confirmed:'yes',fingerprint:r.fingerprint});
  // Put a confirmed order back in the queue as if nothing had arrived for it yet.
  const waitAgain=async o=>{
    await db.query('DELETE FROM sales_order_allocations WHERE workspace_id=$1 AND sales_order_line_id IN (SELECT id FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2)',[ws,o.salesOrderId]);
    await db.query("UPDATE sales_orders SET status='BACKORDERED',version=version+1 WHERE workspace_id=$1 AND id=$2",[ws,o.salesOrderId]);
  };
  return {...f,sku,ws,order,receive,reserved,status,runs,audits,mode,approve,waitAgain};
}

test('Starter sees who waits and what ships first; Growth drafts in saved priority and nothing moves until approval',{timeout:300000},async t=>{
  const f=await setup(t,{units:10}),{db,ctx,browser}=f;
  const first=await f.order({quantity:6}),later=await f.order({quantity:6}),urgent=await f.order({quantity:3,priority:10});
  assert.deepEqual([await f.reserved(first),await f.reserved(later),await f.reserved(urgent)],[6,4,0]);
  await f.receive(4);

  await f.subscribe('starter');
  assert.deepEqual(await backorders.run(db,f.ws),{applied:0,drafted:0,released:0,held:0,watching:false});
  const plain=await browser.get('/autopilot/backorders').expect(200);
  assert.match(plain.text,/Who is waiting at Dispatch/);assert.match(plain.text,new RegExp(urgent.orderNumber));
  assert.match(plain.text,/Gets 3 × [^<]+ now\. Complete\./);assert.match(plain.text,/On Growth, StockChief prepares this stock/);
  assert.doesNotMatch(plain.text,/Prepare this for approval|Approve and set aside/);
  await assert.rejects(backorders.prepare(db,ctx,{locationId:f.location.id}),e=>e.code==='entitlement_required');
  assert.match((await browser.get('/autopilot/reviews/waiting-orders').expect(200)).text,/Open backorders/);
  assert.equal(await f.reserved(urgent),0);

  await f.subscribe('growth');
  await f.mode(64,'watch');
  assert.equal((await backorders.run(db,f.ws)).watching,true);
  assert.equal((await f.runs()).length,0,'Watch only prepares nothing.');
  await f.mode(64,'inherit');
  assert.equal((await backorders.run(db,f.ws)).drafted,1);
  assert.equal((await backorders.run(db,f.ws)).drafted,0,'A repeated check keeps the same open draft.');
  const [draft]=await f.runs("status='DRAFT'");
  assert.deepEqual(draft.plan.gives.map(g=>[g.orderNumber,g.units,g.complete]),[[urgent.orderNumber,3,true],[later.orderNumber,1,false]]);
  assert.deepEqual([await f.reserved(urgent),await f.reserved(later)],[0,4],'A draft sets nothing aside.');
  await assert.rejects(backorders.configure(db,ctx,{revision:0,maxUnits:'5',confirmed:'yes'}),e=>e.code==='entitlement_required');
  const page=await browser.get('/autopilot/backorders').expect(200);
  assert.match(page.text,/Waiting for your approval/);assert.match(page.text,/Approve and set aside/);assert.doesNotMatch(page.text,/Set stock aside on its own/);
  const needs=await require('../../src/projections/postgres-service').needs(db,f.ws,ctx.actorId);
  assert.equal(needs.find(n=>n.title==='Approve stock for waiting orders at Dispatch')?.href,'/autopilot/backorders?location='+encodeURIComponent(f.location.id));
  await browser.get('/needs-you').expect(200);

  const applied=await f.approve(draft);
  assert.equal(applied.applied,true);
  assert.deepEqual([await f.reserved(urgent),await f.reserved(later),await f.reserved(first)],[3,5,6]);
  assert.deepEqual([await f.status(urgent),await f.status(later)],['CONFIRMED','BACKORDERED']);
  assert.equal((await f.approve(draft)).replayed,true);
  assert.equal(await f.reserved(urgent),3,'Replaying an approval sets nothing aside twice.');
  assert.equal(await f.audits('Approved stock for waiting orders'),1);
  const events=(await db.query("SELECT detail FROM sales_order_events WHERE workspace_id=$1 AND sales_order_id=$2 AND event_type='stock_set_aside'",[f.ws,urgent.salesOrderId])).rows;
  assert.equal(events.length,1);
  assert.equal((await db.query("SELECT count(*)::int n FROM sales_shipments WHERE workspace_id=$1",[f.ws])).rows[0].n,0,'Growth approval sends nothing to picking.');

  await f.receive(2);
  assert.equal((await backorders.run(db,f.ws)).drafted,1);
  const [stale]=await f.runs("status='DRAFT'");
  await f.receive(1);
  const changed=await f.approve(stale);
  assert.equal(changed.stale,true,'Stock that changed after the draft needs a fresh review.');
  assert.equal(await f.reserved(later),5);
  const [fresh]=await f.runs("status='DRAFT'");
  assert.notEqual(fresh.id,stale.id);
  await f.approve(fresh);
  assert.equal(await f.reserved(later),6);assert.equal(await f.status(later),'CONFIRMED');

  const undone=await backorders.undo(db,ctx,fresh.id,{confirmed:'yes'});
  assert.equal(undone.id,fresh.id);
  assert.equal(await f.reserved(later),5);assert.equal(await f.status(later),'BACKORDERED');
  assert.equal((await backorders.undo(db,ctx,fresh.id,{confirmed:'yes'})).replayed,true);

  // Bad data stops and asks; it never holds up the orders behind it.
  const unclear=await f.order({quantity:1,priority:1});
  const nowhere=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',idempotencyKey:randomUUID(),lines:[{skuId:f.sku,quantity:50,unitPriceMinor:1000}]});
  await f.workflows.confirmSalesOrder(db,ctx,nowhere.salesOrderId,{idempotencyKey:randomUUID()});
  for(const o of [unclear,nowhere])await f.waitAgain(o);
  await db.query('UPDATE sales_orders SET customer_decision_required=1 WHERE workspace_id=$1 AND id=$2',[f.ws,unclear.salesOrderId]);
  assert.equal((await backorders.run(db,f.ws)).drafted,1);
  const [checked]=await f.runs("status='DRAFT'");
  assert.deepEqual(checked.plan.gives.map(g=>g.orderNumber),[later.orderNumber]);
  assert.deepEqual(checked.plan.held.map(h=>[h.orderNumber,h.reason]),[[unclear.orderNumber,'Confirm the customer and delivery details first.']]);
  const shown=await browser.get('/autopilot/backorders').expect(200);
  assert.match(shown.text,/Needs you/);assert.match(shown.text,/Choose where these ship from/);assert.match(shown.text,new RegExp(nowhere.orderNumber));
  await backorders.discard(db,ctx,checked.id);
  assert.equal((await f.runs("status='DRAFT'")).length,0);
});

test('Pro and Custom set stock aside alone inside the owner limit, send complete orders to picking and can be undone',{timeout:300000},async t=>{
  const f=await setup(t,{units:10}),{db,ctx}=f,ws=f.ws;
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(),queue=require('../../src/operations/postgres-job-queue');
  const work=()=>queue.processOne(db,handlers,{owner:'backorder-test',kinds:[backorders.KIND]});
  const big=await f.order({quantity:10}),slow=await f.order({quantity:4,priority:50}),urgent=await f.order({quantity:2,priority:10});
  assert.deepEqual([await f.reserved(big),await f.reserved(slow),await f.reserved(urgent)],[10,0,0]);

  // Without the owner's limit, Pro only prepares.
  assert.deepEqual(await backorders.run(db,ws),{applied:0,drafted:0,released:0,held:0,watching:false},'No free stock, nothing to do.');
  await f.workflows.cancelSalesOrder(db,ctx,big.salesOrderId,{idempotencyKey:randomUUID(),reason:'Customer changed plans'});
  const queued=(await db.query('SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2',[ws,backorders.KIND])).rows;
  assert.equal(queued.length,1,'Freed stock queues a backorder check.');assert.deepEqual(queued[0].payload.locationIds,[f.location.id]);
  const ran=await work();assert.equal(ran.status,'COMPLETED');
  const [unconfigured]=await f.runs("status='DRAFT'");
  assert.match(unconfigured.reason,/Turn on automatic backorder handling/);
  assert.equal(await f.reserved(urgent),0);

  await f.subscribe('growth');
  await assert.rejects(backorders.configure(db,ctx,{revision:0,maxUnits:'3',releaseReady:'yes',confirmed:'yes'}),e=>e.code==='entitlement_required');
  await f.subscribe('pro');
  await backorders.configure(db,ctx,{revision:0,maxUnits:'3',releaseReady:'yes',confirmed:'yes'});
  assert.equal(await f.audits('Authorized automatic backorder handling'),1);
  const over=await backorders.run(db,ws);
  assert.equal(over.applied,0);
  const [limited]=await f.runs("status='DRAFT'");
  assert.equal(limited.id,unconfigured.id,'The same plan stays one draft.');
  assert.match(limited.reason,/more than your limit of 3/);
  assert.equal(await f.reserved(urgent),0,'Over the limit, nothing is set aside, not even the smaller order ahead of it.');

  await backorders.configure(db,ctx,{revision:1,maxUnits:'4',releaseReady:'yes',confirmed:'yes'});
  await f.mode(64,'ask');
  assert.equal((await backorders.run(db,ws)).applied,0,'Ask me first prepares instead.');
  await f.mode(64,'inherit');
  const autopilot=require('../../src/autopilot/postgres-service');
  await autopilot.pause(db,ctx,{role:'owner'},'Checking the warehouse');
  assert.equal((await backorders.run(db,ws)).applied,0,'Paused work only prepares.');
  assert.equal(await f.reserved(urgent),0);
  await autopilot.resume(db,ctx,{role:'owner'});
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');

  const done=await backorders.run(db,ws);
  assert.deepEqual(done,{applied:1,drafted:0,released:2,held:0,watching:false});
  assert.deepEqual([await f.reserved(urgent),await f.reserved(slow)],[2,4]);
  const [auto]=await f.runs("status='APPLIED'");
  assert.equal(auto.authorization_kind,'AUTOMATIC');assert.equal(auto.rule_revision,2);
  assert.deepEqual(auto.plan.gives.map(g=>[g.orderNumber,g.units]),[[urgent.orderNumber,2],[slow.orderNumber,4]]);
  assert.equal(auto.released.orders.length,2);
  const boxes=(await db.query("SELECT sales_order_id,status FROM sales_shipments WHERE workspace_id=$1 ORDER BY sales_order_id",[ws])).rows;
  assert.deepEqual(boxes.map(b=>b.status),['PICKING','PICKING']);
  assert.equal((await f.runs("status='DRAFT'")).length,0,'The applied work replaces the waiting draft.');
  assert.equal(await f.audits('StockChief set stock aside for waiting orders'),1);
  assert.deepEqual(await backorders.run(db,ws),{applied:0,drafted:0,released:0,held:0,watching:false},'A replay finds nothing left to do.');
  assert.equal(await f.balance(),10,'Setting stock aside moves no physical stock.');

  // Undo cancels the unpicked picks and gives the stock back.
  await backorders.undo(db,ctx,auto.id,{confirmed:'yes'});
  assert.deepEqual([await f.reserved(urgent),await f.reserved(slow)],[0,0]);
  assert.deepEqual([await f.status(urgent),await f.status(slow)],['BACKORDERED','BACKORDERED']);
  assert.deepEqual((await db.query("SELECT DISTINCT status FROM sales_shipments WHERE workspace_id=$1",[ws])).rows.map(r=>r.status),['CANCELLED']);
  assert.equal(await f.audits('Undid stock set aside for waiting orders'),1);

  // Custom works the same way without any teaching, and picked work cannot be undone.
  await f.subscribe('enterprise');
  assert.equal((await backorders.run(db,ws)).applied,1);
  const [, again]=await f.runs("status='APPLIED' OR status='UNDONE'");
  assert.equal(again.status,'APPLIED');
  const box=again.released.orders.find(o=>o.orderId===urgent.salesOrderId);
  await db.query('UPDATE fulfillment_wave_lines SET picked_quantity=1 WHERE workspace_id=$1 AND shipment_id=$2',[ws,box.shipmentId]);
  await assert.rejects(backorders.undo(db,ctx,again.id,{confirmed:'yes'}),/Picking has started/);
  assert.equal(await f.reserved(urgent),2);

  // Shadow mode only watches.
  const waiting=await f.order({quantity:2,priority:5});
  await f.waitAgain(waiting);

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const page=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});page.setDefaultTimeout(15000);
    await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(base+backorders.href);
    assert(await page.getByRole('heading',{name:'Backorders',exact:true}).isVisible());
    assert(await page.getByRole('button',{name:'Prepare this for approval'}).isVisible());
    assert(await page.getByRole('heading',{name:'Set stock aside on its own'}).isVisible());
    assert(await page.getByRole('button',{name:'Undo'}).first().isVisible());
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await page.screenshot({path:require('node:path').join(folder,'backorders-'+name+'.png'),fullPage:true});
    await page.close();
  }
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  assert.equal((await backorders.run(db,ws)).watching,true);
  assert.equal(await f.reserved(waiting),0);
  await assert.rejects(backorders.prepare(db,ctx,{locationId:f.location.id}),/watching during the first 14 days/);
});
