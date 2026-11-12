'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const routing=require('../../src/sales/agent-ship-from');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');

// Three warehouses: Dispatch (Monroe, NY), West shipping (Oakland, CA) and
// Jersey overflow (Newark, NJ), which the owner does not ship orders from.
// The fixture customer is in Albany, NY.
async function setup(t,{plan='growth'}={}){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx}=f;
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const ws=ctx.workspaceId,stock=require('../../src/domain/postgres-inventory-engine');
  const places=require('../../src/domain/postgres-location-service'),catalog=require('../../src/domain/postgres-catalog-service');
  const dispatch=f.location.id;
  const west=(await places.createLocation(db,ctx,{name:'West shipping',kind:'warehouse',address:'200 Harbor Blvd, Oakland, CA 94607'})).id;
  const jersey=(await places.createLocation(db,ctx,{name:'Jersey overflow',kind:'warehouse',address:'5 Port Rd, Newark, NJ 07114'})).id;
  const names={[dispatch]:'Dispatch',[west]:'West',[jersey]:'Jersey'};
  const sku=f.item.skuIds[0],code=()=>randomUUID().slice(0,8);
  const other=(await catalog.createItem(db,ctx,{name:'Second line',baseCode:'W2-'+code(),trackingMode:'quantity'})).skuIds[0];
  const part=(await catalog.createItem(db,ctx,{name:'Split part',baseCode:'SP-'+code(),trackingMode:'quantity'})).skuIds[0];
  const receive=(id,where,quantity)=>stock.receive(db,ctx,{skuId:id,locationId:where,quantity,idempotencyKey:randomUUID()});
  const issue=(id,where,quantity)=>stock.issue(db,ctx,{skuId:id,locationId:where,quantity,reasonCode:'sold',idempotencyKey:randomUUID()});
  await receive(other,dispatch,5);await receive(sku,west,50);await receive(other,west,20);
  await receive(part,dispatch,2);await receive(part,west,2);await receive(part,jersey,10);
  // Starter keeps the warehouses it had before choosing the plan.
  await f.subscribe(plan);
  const order=async({lines,shipToAddress,fulfillmentLocationId}={})=>(await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',
    shipToAddress,fulfillmentLocationId,idempotencyKey:randomUUID(),
    lines:lines||[{skuId:sku,quantity:2,unitPriceMinor:500},{skuId:other,quantity:1,unitPriceMinor:300}]})).salesOrderId;
  const confirm=id=>f.workflows.confirmSalesOrder(db,ctx,id,{idempotencyKey:randomUUID()});
  const held=async id=>Object.fromEntries((await db.query(`SELECT a.location_id,sum(a.quantity)::int n FROM sales_order_allocations a
    JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2
    GROUP BY a.location_id ORDER BY a.location_id`,[ws,id])).rows.map(r=>[names[r.location_id],r.n]).sort());
  const row=async id=>(await db.query('SELECT order_number,status,fulfillment_location_id,version FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ws,id])).rows[0];
  const where=async id=>(await row(id)).fulfillment_location_id;
  const runs=async(filter='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_warehouse_routings WHERE workspace_id=$1 AND ${filter} ORDER BY created_at,id`,[ws])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const mode=async value=>{const r=(await db.query('SELECT revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=121',[ws])).rows[0];
    await modes.save(db,ctx,121,{mode:value,revision:r?.revision||0});};
  const rules=async(extra={})=>routing.configure(db,ctx,{revision:(await routing.read(db,ws))?.revision||0,first:'nearest',second:'priority',third:'cheapest',
    split:'never',maxUnits:'5',confirmed:'yes',['ships_'+dispatch]:'yes',['ships_'+west]:'yes',['priority_'+dispatch]:'1',['priority_'+west]:'2',
    ['cost_'+dispatch]:'4.50',['cost_'+west]:'3.00',...extra});
  const jobs=async()=>Number((await db.query('SELECT count(*) n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2',[ws,routing.KIND])).rows[0].n);
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(),queue=require('../../src/operations/postgres-job-queue');
  const work=async()=>{let n=0;for(;;){const done=await queue.processOne(db,handlers,{owner:'routing-test',kinds:[routing.KIND]});if(!done)return n;assert.equal(done.status,'COMPLETED');n++;}};
  const needs=async()=>require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
  return {...f,ws,stock,dispatch,west,jersey,sku,other,part,receive,issue,order,confirm,held,row,where,runs,audits,mode,rules,jobs,work,needs};
}

async function screens(t,f,paths,prefix){
  const {db}=f,app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');
  require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    for(const [page,heading,check] of paths){
      await view.goto(base+page);
      assert(await view.getByRole('heading',{name:heading,exact:true}).isVisible(),heading+' at '+name);
      if(check)await check(view);
      await view.waitForTimeout(600);
      assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),page+' must not scroll sideways on '+name);
      await view.screenshot({path:path.join(folder,prefix+'-'+page.split('/').filter(Boolean).slice(-1)[0]+'-'+name+'.png'),fullPage:true});
    }
    await view.close();
  }
}

test('Starter is locked; Growth prepares each warehouse choice for approval, moves reserved stock when approved, undoes it, and asks about unclear orders',{timeout:400000},async t=>{
  const f=await setup(t,{plan:'starter'}),{db,ctx,browser}=f;
  const a=await f.order(),number=(await f.row(a)).order_number;

  // Starter: the job and its page are locked.
  const locked=await browser.get(routing.href).expect(200);
  assert.match(locked.text,/Growth/);assert.doesNotMatch(locked.text,/Save rules/);
  assert.match((await browser.get('/orders/'+a).expect(200)).text,/Shipping warehouse suggestions · Growth/);
  await browser.get('/orders/'+a+'/ship-from').expect(402);
  await assert.rejects(f.rules(),e=>e.code==='entitlement_required');
  await assert.rejects(routing.choose(db,ctx,a,{fingerprint:'x'}),e=>e.code==='entitlement_required');
  await f.confirm(a);
  assert.deepEqual(await f.held(a),{West:3},'Without a choice, confirmation reserves wherever stock is largest.');
  assert.deepEqual(await routing.run(db,f.ws),{applied:0,drafted:0,asked:0,kept:0,held:0,watching:false});
  assert.equal(await f.jobs(),0);

  // Growth: the owner's rules, then a draft for the order that has no warehouse.
  await f.subscribe('growth');
  await assert.rejects(f.rules({['ships_'+f.dispatch]:'',['ships_'+f.west]:''}),/at least one warehouse/);
  await assert.rejects(f.rules({first:'nearest',second:'nearest'}),/each one once/);
  await f.rules({automatic:'yes'});
  const saved=await routing.read(db,f.ws);
  assert.equal(saved.automatic,false,'Growth cannot choose warehouses on its own.');
  assert.deepEqual(saved.criteria,['nearest','priority','cheapest']);
  assert.equal(await f.audits('Saved warehouse routing rules'),1);
  const swept=await routing.run(db,f.ws);
  assert.equal(swept.drafted,1);assert.equal(swept.applied,0);
  let [draft]=await f.runs("status='DRAFT'");
  assert.equal(draft.plan.summary,'Ship all 3 from Dispatch.');
  assert.match(draft.reason,/approval/);
  assert.deepEqual(draft.plan.warehouses.map(w=>[w.name,w.units,w.distance.label]),[['Dispatch',3,'Same state']]);
  assert.match(draft.plan.options.find(o=>o.name==='West shipping').distance.label,/^About 2,\d{3} miles$/);
  assert.deepEqual(await f.held(a),{West:3},'A draft moves nothing.');
  assert.equal((await routing.run(db,f.ws)).drafted,0,'The same choice is not prepared twice.');
  const item=(await f.needs()).find(n=>n.title==='Approve the warehouse for '+number);
  assert.equal(item?.href,'/orders/'+a+'/ship-from');
  const review=await browser.get('/orders/'+a+'/ship-from').expect(200);
  assert.match(review.text,/Ship all 3 from Dispatch/);assert.match(review.text,/Same state/);assert.match(review.text,/About 2,\d{3} miles/);
  assert.match(review.text,/\$4\.50/);assert.match(review.text,/Use Dispatch/);
  assert.match((await browser.get('/orders/'+a).expect(200)).text,/Choose the shipping warehouse/);

  // Stock changes before approval: the old choice goes stale and a fresh one replaces it.
  await f.issue(f.other,f.dispatch,5);
  const stale=await routing.approve(db,ctx,draft.id,{confirmed:'yes',fingerprint:draft.fingerprint});
  assert.equal(stale.stale,true);
  [draft]=await f.runs("status='DRAFT'");
  assert.equal(draft.plan.summary,'Ship all 3 from West shipping.','Only West now has the whole order.');
  await f.receive(f.other,f.dispatch,5);
  await routing.run(db,f.ws);
  [draft]=await f.runs("status='DRAFT'");
  assert.equal(draft.plan.summary,'Ship all 3 from Dispatch.');
  assert.equal((await f.runs("status='DRAFT'")).length,1,'One open choice per order.');

  // Approval moves the reserved stock through the native set-aside service.
  const physical=await f.balance();
  const page=await browser.get('/orders/'+a+'/ship-from').expect(200);
  await browser.post('/orders/'+a+'/ship-from/runs/'+draft.id+'/approve').type('form')
    .send({_csrf:f.csrf(page.text),fingerprint:draft.fingerprint,confirmed:'yes'}).expect(303);
  assert.deepEqual(await f.held(a),{Dispatch:3});
  assert.equal(await f.where(a),f.dispatch);
  assert.equal((await f.row(a)).status,'CONFIRMED');
  assert.equal(await f.balance(),physical,'Choosing a warehouse moves no physical stock.');
  assert.equal(await f.audits('Shipping warehouse chosen'),1);
  const events=(await db.query(`SELECT event_type FROM sales_order_events WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY created_at,id`,[f.ws,a])).rows.map(r=>r.event_type);
  for(const e of ['stock_given_back','stock_set_aside','ship_from_chosen'])assert(events.includes(e),e);
  assert.equal((await routing.approve(db,ctx,draft.id,{confirmed:'yes',fingerprint:draft.fingerprint})).replayed,true);
  assert.match((await browser.get('/orders/'+a).expect(200)).text,/Shipping warehouse chosen · review or undo/);

  // Undo puts the stock and the order back; the order is then left to a person.
  await routing.undo(db,ctx,draft.id,{confirmed:'yes'});
  assert.deepEqual(await f.held(a),{West:3});
  assert.equal(await f.where(a),null);
  assert.equal((await routing.undo(db,ctx,draft.id,{confirmed:'yes'})).replayed,true);
  assert.equal(await f.audits('Undid a warehouse choice'),1);
  assert.equal((await routing.run(db,f.ws)).drafted,0,'An undone order is left to you.');

  // A new confirmation queues a check, and the worker prepares the choice.
  const b=await f.order();await f.confirm(b);
  assert.equal(await f.jobs(),1);
  assert.equal(await f.work(),1);
  const [forB]=await f.runs(`status='DRAFT' AND sales_order_id='${b}'`);
  assert.equal(forB.plan.summary,'Ship all 3 from Dispatch.');
  await routing.discard(db,ctx,forB.id);
  assert.equal((await routing.run(db,f.ws)).drafted,0,'A dismissed choice is not prepared again for the same order.');

  // A person can ship from any warehouse they pick.
  const picked=await browser.get('/orders/'+b+'/ship-from').expect(200);
  await browser.post('/orders/'+b+'/ship-from').type('form').send({_csrf:f.csrf(picked.text),locationId:f.west,version:(await f.row(b)).version}).expect(303);
  assert.equal(await f.where(b),f.west);assert.deepEqual(await f.held(b),{West:3});

  // An unclear address stops and asks; nothing changes.
  const c=await f.order({shipToAddress:'Behind the old mill'});await f.confirm(c);
  const cNumber=(await f.row(c)).order_number;
  assert.equal(await f.work(),1);
  const [ask]=await f.runs("status='ASK'");
  assert.match(ask.reason,/missing the street, state and postcode/);
  assert.equal((await f.needs()).find(n=>n.title==='Help StockChief choose the warehouse for '+cNumber)?.href,'/orders/'+c+'/ship-from');
  assert.match((await browser.get('/orders/'+c+'/ship-from').expect(200)).text,/StockChief needs something first/);
  await assert.rejects(routing.choose(db,ctx,c,{fingerprint:ask.fingerprint}),/missing the/);
  assert.equal(await f.where(c),null);
  await db.query(`UPDATE sales_orders SET ship_to_address='12 State St, Albany, NY 12207',version=version+1 WHERE workspace_id=$1 AND id=$2`,[f.ws,c]);
  await routing.run(db,f.ws);
  assert.equal((await f.runs(`id='${ask.id}'`))[0].status,'STALE');
  assert.equal((await f.runs(`status='DRAFT' AND sales_order_id='${c}'`)).length,1,'Once the address is clear, the choice is prepared.');

  // An order that has started picking is never re-assigned.
  const d=await f.order();await f.confirm(d);
  const [line]=(await db.query(`SELECT a.sales_order_line_id,a.location_id,a.quantity::int q FROM sales_order_allocations a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY a.id LIMIT 1`,[f.ws,d])).rows;
  await f.shipping.prepare(db,ctx,d,{idempotencyKey:randomUUID(),startPicking:true,shipFromLocationId:line.location_id,
    lines:[{lineId:line.sales_order_line_id,locationId:line.location_id,quantity:line.q}]});
  await f.work();await routing.run(db,f.ws);
  assert.equal((await f.runs(`sales_order_id='${d}'`)).length,0);
  assert.match((await browser.get('/orders/'+d+'/ship-from').expect(200)).text,/Picking or shipping has started/);
  await assert.rejects(routing.choose(db,ctx,d,{locationId:f.dispatch,version:(await f.row(d)).version}),/Picking or shipping has started/);

  // The agent review lists orders without a warehouse; the pages read well on a desktop and a phone.
  const listed=await require('../../src/autopilot/job-reviews').run(db,ctx,'warehouse-routing',{});
  assert.equal(listed.mode,'draft');assert(listed.rows.some(r=>r.Order===number));
  const routingPage=await browser.get(routing.href).expect(200);
  assert.match(routingPage.text,/Waiting for you/);assert.match(routingPage.text,/Save rules/);assert.doesNotMatch(routingPage.text,/Choose warehouses on its own/);
  await screens(t,f,[[routing.href,'Warehouse routing'],['/orders/'+c+'/ship-from','Shipping warehouse for '+cNumber]],'warehouse-routing-growth');
});

test('Pro chooses on its own within the owner rules, moves reserved stock, splits only when the rule allows, and respects limits, Ask me first, pause and Watch only',{timeout:400000},async t=>{
  const f=await setup(t,{plan:'pro'}),{db,ctx,browser}=f;
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const early=await f.order();await f.confirm(early);
  assert.deepEqual(await f.held(early),{West:3});
  assert.equal(await f.jobs(),0,'Without rules nothing is queued.');
  await f.rules({automatic:'yes'});
  assert.equal((await routing.read(db,f.ws)).automatic,true);

  // A new order is reserved at the chosen warehouse from the start.
  const fresh=await f.order(),confirmed=await f.confirm(fresh);
  assert.deepEqual([...new Set(confirmed.allocations.map(x=>x.locationId))],[f.dispatch]);
  assert.equal(await f.where(fresh),f.dispatch);
  const [auto]=await f.runs(`sales_order_id='${fresh}'`);
  assert.equal(auto.status,'APPLIED');assert.equal(auto.authorization_kind,'AUTOMATIC');assert.equal(auto.plan.phase,'confirmation');
  assert.equal(await f.audits('StockChief chose the shipping warehouse'),1);
  assert.equal(await f.jobs(),0,'An order with its warehouse needs no later check.');

  // The routine moves an older unassigned order's reserved stock to the best warehouse.
  const physical=await f.balance();
  assert.equal((await routing.run(db,f.ws)).applied,1);
  assert.deepEqual(await f.held(early),{Dispatch:3});
  assert.equal(await f.where(early),f.dispatch);
  assert.equal(await f.balance(),physical);
  assert.equal((await routing.run(db,f.ws)).applied,0,'Replaying changes nothing.');
  const digest=await require('../../src/autopilot/job-reviews').run(db,ctx,'daily-work',{});
  assert(digest.rows.some(r=>/^Chose the shipping warehouse for /.test(r.Action)),'Automatic choices appear in the work digest.');
  const [moved]=await f.runs(`sales_order_id='${early}' AND status='APPLIED'`);
  await routing.undo(db,ctx,moved.id,{confirmed:'yes'});
  assert.deepEqual(await f.held(early),{West:3});assert.equal(await f.where(early),null);

  // Over the owner's unit limit it asks.
  const big=await f.order({lines:[{skuId:f.sku,quantity:6,unitPriceMinor:500}]});await f.confirm(big);
  assert.equal(await f.where(big),null);
  assert.equal(await f.work(),1);
  const [over]=await f.runs(`status='DRAFT' AND sales_order_id='${big}'`);
  assert.match(over.reason,/6 units, more than your limit of 5/);
  assert.deepEqual(await f.held(big),{West:6});

  // Ask me first, pause and Watch only turn automatic choices into drafts or watching.
  await f.mode('ask');
  const asked=await f.order();await f.confirm(asked);
  assert.equal(await f.where(asked),null);await f.work();
  assert.match((await f.runs(`status='DRAFT' AND sales_order_id='${asked}'`))[0].reason,/Ask me first/);
  await f.mode('inherit');
  await autopilot.pause(db,ctx,{role:'owner'},'Stock count');
  const paused=await f.order();await f.confirm(paused);
  assert.equal(await f.where(paused),null);await f.work();
  assert.match((await f.runs(`status='DRAFT' AND sales_order_id='${paused}'`))[0].reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await f.mode('watch');
  assert.equal((await routing.run(db,f.ws)).watching,true);
  await assert.rejects(routing.choose(db,ctx,asked,{fingerprint:'x'}),/Watch only/);
  await f.mode('inherit');
  const resumed=await routing.run(db,f.ws);
  assert.equal(resumed.applied,2,'Once allowed, the waiting orders inside the limit are assigned.');
  assert.deepEqual([await f.where(asked),await f.where(paused),await f.where(big)],[f.dispatch,f.dispatch,null]);
  assert.equal((await f.runs(`status='DRAFT'`)).length,1,'Only the order over the limit still waits for approval.');

  // Never split: the order waits at the nearest warehouse with the most of it, and
  // stock at a warehouse that does not ship orders is never used.
  const whole=await f.order({lines:[{skuId:f.part,quantity:4,unitPriceMinor:100}]});await f.confirm(whole);
  assert.equal(await f.where(whole),f.dispatch);
  assert.deepEqual(await f.held(whole),{Dispatch:2});
  assert.equal((await f.row(whole)).status,'BACKORDERED');
  await f.workflows.cancelSalesOrder(db,ctx,whole,{idempotencyKey:randomUUID(),reason:'Customer changed plans'});

  // Split if it ships sooner: two warehouses ship it now instead of one waiting.
  await f.rules({automatic:'yes',split:'faster',maxWarehouses:'2'});
  const split=await f.order({lines:[{skuId:f.part,quantity:4,unitPriceMinor:100}]});await f.confirm(split);
  assert.deepEqual(await f.held(split),{Jersey:4},'Confirmation alone reserves from the largest stock, even at a warehouse that does not ship.');
  assert.equal(await f.work(),1);
  assert.deepEqual(await f.held(split),{Dispatch:2,West:2});
  assert.equal(await f.where(split),null);
  assert.equal((await f.row(split)).status,'CONFIRMED');
  const [splitRun]=await f.runs(`sales_order_id='${split}' AND status='APPLIED'`);
  assert.equal(splitRun.plan.summary,'Split it: 2 from Dispatch and 2 from West shipping.');
  const detail=await browser.get('/orders/'+split+'/ship-from').expect(200);
  assert.match(detail.text,/Ships from Dispatch and West shipping/);assert.match(detail.text,/Undo this choice/);
  const page=await browser.get(routing.href).expect(200);
  assert.match(page.text,/Choose warehouses on its own/);assert.match(page.text,/Recent choices/);
  assert.match(page.text,/Picking started or closed/,'A cancelled order offers no undo.');

  // A downgrade to Growth only prepares; Starter does nothing, and earlier choices can still be undone.
  await f.subscribe('growth');
  const later=await f.order();await f.confirm(later);
  assert.equal(await f.where(later),null);await f.work();
  assert.match((await f.runs(`status='DRAFT' AND sales_order_id='${later}'`))[0].reason,/approval/);
  await f.subscribe('starter');
  assert.deepEqual(await routing.run(db,f.ws),{applied:0,drafted:0,asked:0,kept:0,held:0,watching:false});
  await routing.undo(db,ctx,splitRun.id,{confirmed:'yes'});
  assert.deepEqual(await f.held(split),{Jersey:4});
  await f.subscribe('pro');
  await screens(t,f,[[routing.href,'Warehouse routing'],['/orders/'+big+'/ship-from','Shipping warehouse for '+(await f.row(big)).order_number]],'warehouse-routing-pro');
});

test('Custom chooses on its own without teaching, asks before leaving stock waiting or when facts are missing, and only watches in shadow mode',{timeout:400000},async t=>{
  const f=await setup(t,{plan:'enterprise'}),{db,ctx}=f;
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await f.issue(f.part,f.jersey,10);
  const spread=await f.order({lines:[{skuId:f.part,quantity:4,unitPriceMinor:100}]});await f.confirm(spread);
  assert.deepEqual(await f.held(spread),{Dispatch:2,West:2});
  await f.rules({automatic:'yes'});
  assert.equal((await routing.read(db,f.ws)).automatic,true,'Custom chooses on its own without teaching.');

  // Keeping it whole would leave 2 reserved units waiting, so it asks first.
  assert.equal((await routing.run(db,f.ws)).drafted,1);
  const [shrink]=await f.runs(`status='DRAFT' AND sales_order_id='${spread}'`);
  assert.match(shrink.reason,/2 units it holds now would wait/);
  assert.deepEqual(await f.held(spread),{Dispatch:2,West:2});
  await routing.approve(db,ctx,shrink.id,{confirmed:'yes',fingerprint:shrink.fingerprint});
  assert.deepEqual(await f.held(spread),{Dispatch:2});
  assert.equal(await f.where(spread),f.dispatch);
  assert.equal((await f.row(spread)).status,'BACKORDERED');

  // Whole orders go straight to the best warehouse.
  const fresh=await f.order();await f.confirm(fresh);
  assert.equal(await f.where(fresh),f.dispatch);

  // Missing facts stop and ask: no warehouse ships orders, or an archived customer.
  await db.query('UPDATE stockchief_runtime.agent_warehouse_routing_sites SET ships=false WHERE workspace_id=$1',[f.ws]);
  const nowhere=await f.order();await f.confirm(nowhere);
  assert.equal(await f.where(nowhere),null);await f.work();
  assert.match((await f.runs(`status='ASK' AND sales_order_id='${nowhere}'`))[0].reason,/No warehouse is set to ship orders/);
  await db.query('UPDATE stockchief_runtime.agent_warehouse_routing_sites SET ships=true WHERE workspace_id=$1 AND location_id=ANY($2::text[])',[f.ws,[f.dispatch,f.west]]);
  await db.query(`UPDATE customers SET record_state='ARCHIVED' WHERE workspace_id=$1 AND id='fixture-customer'`,[f.ws]);
  await routing.run(db,f.ws);
  assert.match((await f.runs(`status='ASK' AND sales_order_id='${nowhere}'`))[0].reason,/customer is archived/);
  assert.equal(await f.where(nowhere),null);
  await db.query(`UPDATE customers SET record_state='ACTIVE' WHERE workspace_id=$1 AND id='fixture-customer'`,[f.ws]);
  assert.equal((await routing.run(db,f.ws)).applied,1);
  assert.equal(await f.where(nowhere),f.dispatch);

  // Shadow mode only watches: nothing is chosen at confirmation or by the routine.
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  const shadow=await f.order();await f.confirm(shadow);
  assert.equal(await f.where(shadow),null);
  assert.equal((await routing.run(db,f.ws)).watching,true);
  assert.equal((await f.runs(`sales_order_id='${shadow}'`)).length,0);
  await assert.rejects(routing.choose(db,ctx,shadow,{fingerprint:'x'}),/watching during the first 14 days/);
});
