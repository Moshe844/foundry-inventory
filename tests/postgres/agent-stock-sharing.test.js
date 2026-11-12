'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const backorders=require('../../src/sales/agent-backorders');
const sharing=require('../../src/sales/agent-stock-sharing');
const modes=require('../../src/autopilot/job-modes');

async function setup(t,{plan='pro',units=10}={}){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units}),{db,ctx}=f;
  await f.subscribe(plan);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const ws=ctx.workspaceId,sku=f.item.skuIds[0],at=new Date().toISOString();
  for(const [id,name] of [['wholesale','Wholesale buyer'],['shop','Corner shop'],['vip','Priority account']])
    await db.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'5185550100','10 Jobsite Rd, Albany, NY 12207','ACTIVE',$5,$6,$6)`,[id,ws,name,id+'@example.test',ctx.actorId,at]);
  const order=async(customerId,quantity,{orderDate,neededBy}={})=>{
    const o=await f.workflows.createSalesOrder(db,ctx,{customerId,deliveryMethod:'SHIP',shipToAddress:'10 Jobsite Rd, Albany, NY 12207',fulfillmentLocationId:f.location.id,
      orderDate,neededBy,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity,unitPriceMinor:1000}]});
    await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
    return o;
  };
  const reserved=async o=>Number((await db.query(`SELECT coalesce(sum(a.quantity),0) n FROM sales_order_allocations a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2`,[ws,o.salesOrderId])).rows[0].n);
  const all=async(...orders)=>Promise.all(orders.map(reserved));
  const status=async o=>(await db.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ws,o.salesOrderId])).rows[0].status;
  const runs=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_backorder_runs WHERE workspace_id=$1 AND job_id=65 AND ${where} ORDER BY created_at,id`,[ws])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const mode=async(job,value)=>{const row=(await db.query('SELECT revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2',[ws,job])).rows[0];await modes.save(db,ctx,job,{mode:value,revision:row?.revision||0});};
  const approve=r=>backorders.approve(db,ctx,r.id,{confirmed:'yes',fingerprint:r.fingerprint});
  const rules=async()=>sharing.read(db,ws);
  return {...f,ws,sku,order,reserved,all,status,runs,audits,mode,approve,rules};
}

test('Starter and Growth are excluded; Pro proposes each split by the owner rules until taught, then shares alone within its limit and never touches picked orders',{timeout:400000},async t=>{
  const f=await setup(t),{db,ctx,browser}=f;
  const old=await f.order('fixture-customer',6),first=await f.order('wholesale',5),late=await f.order('shop',3);
  assert.deepEqual(await f.all(old,first,late),[6,4,0]);

  for(const tier of ['starter','growth']){
    await f.subscribe(tier);
    const locked=await browser.get(sharing.href).expect(200);
    assert.match(locked.text,/Pro/);assert.doesNotMatch(locked.text,/Save rules/);
    await assert.rejects(sharing.configure(db,ctx,{revision:0,first:'tier',fill:'complete',maxUnits:'3',confirmed:'yes'}),e=>e.code==='entitlement_required');
    await assert.rejects(sharing.setTier(db,ctx,{customerId:'wholesale',tier:'1'}),e=>e.code==='entitlement_required');
  }
  await f.subscribe('pro');
  await sharing.setTier(db,ctx,{customerId:'wholesale',tier:'1'});
  await sharing.setTier(db,ctx,{customerId:'vip',tier:'1'});
  assert.equal(await f.audits('Changed a customer tier'),2);
  await assert.rejects(sharing.configure(db,ctx,{revision:0,first:'tier',second:'tier',fill:'complete',maxUnits:'3',confirmed:'yes'}),/each rule once/);
  await sharing.configure(db,ctx,{revision:0,first:'tier',second:'ordered',fill:'complete',maxUnits:'3',confirmed:'yes',automatic:'yes'});
  assert.equal((await f.rules()).automatic,false,'Pro cannot switch on sharing alone without teaching.');
  assert.equal(await f.audits('Saved scarce stock sharing rules'),1);

  // Pro proposes: the tier 1 order is completed first, then the late order is completed, and the oldest order keeps what is left.
  const result=await backorders.run(db,f.ws);
  assert.equal(result.shared,0);assert.equal(result.drafted,1);
  let [draft]=await f.runs("status='DRAFT'");
  assert.match(draft.reason,/teach/);
  assert.deepEqual(draft.plan.changes.map(ch=>[ch.orderNumber,ch.gives-ch.takes]),[[first.orderNumber,1],[old.orderNumber,-4],[late.orderNumber,3]]);
  assert.deepEqual(await f.all(old,first,late),[6,4,0],'A proposal moves nothing.');
  const page=await browser.get(sharing.href).expect(200);
  assert.match(page.text,/Waiting for your approval/);assert.match(page.text,/Approve this split/);assert.match(page.text,/gives up 4 ×/);
  const needs=await require('../../src/projections/postgres-service').needs(db,f.ws,ctx.actorId);
  assert.equal(needs.find(n=>n.title==='Approve how scarce stock is shared at Dispatch')?.href,sharing.href+'?location='+encodeURIComponent(f.location.id));
  assert.match((await browser.get('/autopilot/reviews/customer-stock-priorities').expect(200)).text,/Share scarce stock by your rules/);
  const shown=await browser.get(backorders.href).expect(200);
  assert.match(shown.text,/Shared by your priority rules\./,'Job 64 leaves scarce stock to the rules.');

  await f.approve(draft);
  assert.deepEqual(await f.all(old,first,late),[2,5,3]);
  assert.deepEqual([await f.status(old),await f.status(first),await f.status(late)],['BACKORDERED','CONFIRMED','CONFIRMED']);
  assert.equal((await f.approve(draft)).replayed,true);
  assert.equal(await f.audits('Approved a scarce stock split'),1);
  assert.equal(await f.balance(),10,'Sharing moves no physical stock.');
  await backorders.undo(db,ctx,draft.id,{confirmed:'yes'});
  assert.deepEqual(await f.all(old,first,late),[6,4,0],'Undo gives the stock back to the orders it came from.');
  await assert.rejects(sharing.teach(db,ctx,{revision:(await f.rules()).revision,runId:draft.id,confirmed:'yes'}),/Approve one split/);

  assert.equal((await backorders.run(db,f.ws)).drafted,1);
  [draft]=await f.runs("status='DRAFT'");
  await f.approve(draft);
  await assert.rejects(sharing.teach(db,ctx,{revision:0,runId:draft.id,confirmed:'yes'}),/Reload/);
  await sharing.teach(db,ctx,{revision:(await f.rules()).revision,runId:draft.id,confirmed:'yes'});
  assert.equal((await f.rules()).automatic,true);
  assert.equal(await f.audits('Taught StockChief to share scarce stock on its own'),1);

  // Over the taught limit of 3 units, it still asks.
  const big=await f.order('wholesale',4);
  assert.equal(await f.reserved(big),0);
  assert.equal((await backorders.run(db,f.ws)).shared,0);
  [draft]=await f.runs("status='DRAFT'");
  assert.match(draft.reason,/more than your limit of 3/);
  await f.approve(draft);
  assert.deepEqual(await f.all(first,big,old,late),[5,4,1,0]);

  // Within the limit it shares on its own, and that can be undone.
  const small=await f.order('wholesale',1);
  const alone=await backorders.run(db,f.ws);
  assert.equal(alone.shared,1);
  assert.deepEqual(await f.all(small,old),[1,0]);
  const [auto]=await f.runs("status='APPLIED' AND authorization_kind='AUTOMATIC'");
  assert.equal(auto.rule_revision,(await f.rules()).revision);
  assert.equal(await f.audits('StockChief shared scarce stock by your rules'),1);
  assert.equal((await backorders.run(db,f.ws)).shared,0,'A replay finds the stock already shared.');
  await backorders.undo(db,ctx,auto.id,{confirmed:'yes'});
  assert.deepEqual(await f.all(small,old),[0,1]);
  await f.mode(65,'ask');
  assert.equal((await backorders.run(db,f.ws)).shared,0,'Ask me first proposes instead.');
  await f.mode(65,'inherit');
  assert.equal((await backorders.run(db,f.ws)).shared,1);
  assert.deepEqual(await f.all(small,old),[1,0]);

  // Stock in an open pick is never taken, even by a higher-ranked order.
  await require('../../src/operations/postgres-fulfillment-waves').create(db,ctx,{orderIds:[first.salesOrderId],strategy:'BATCH',idempotencyKey:randomUUID()});
  const vip=await f.order('vip',5,{orderDate:'2020-01-01'});
  await backorders.run(db,f.ws);
  [draft]=await f.runs("status='DRAFT'");
  assert(!draft.plan.changes.some(ch=>ch.orderId===first.salesOrderId),'The order being picked keeps its stock.');
  await f.approve(draft);
  assert.deepEqual(await f.all(vip,first,big,small),[5,5,0,0]);

  // A changed rule needs fresh teaching.
  await sharing.configure(db,ctx,{revision:(await f.rules()).revision,first:'ordered',fill:'share',maxUnits:'3',confirmed:'yes'});
  assert.equal((await f.rules()).automatic,false);

  // The pages read well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await view.goto(base+sharing.href);
    assert(await view.getByRole('heading',{name:'Share scarce stock',exact:true}).isVisible());
    assert(await view.getByRole('button',{name:'Save rules'}).isVisible());
    assert(await view.getByRole('heading',{name:'Customer tiers'}).isVisible());
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await view.screenshot({path:path.join(folder,'stock-sharing-'+name+'.png'),fullPage:true});
    await view.close();
  }
});

test('Custom shares on its own without teaching, by share-across rules, and respects Watch, Ask me first, pause and shadow',{timeout:300000},async t=>{
  const f=await setup(t,{plan:'enterprise'}),{db,ctx}=f;
  const early=await f.order('fixture-customer',6),valued=await f.order('wholesale',6),shop=await f.order('shop',2,{neededBy:'2027-01-01'});
  assert.deepEqual(await f.all(early,valued,shop),[6,4,0]);
  await sharing.setTier(db,ctx,{customerId:'wholesale',tier:'1'});
  await sharing.configure(db,ctx,{revision:0,first:'tier',second:'promised',fill:'share',maxUnits:'10',confirmed:'yes',automatic:'yes'});
  assert.equal((await f.rules()).automatic,true,'Custom can share alone without teaching.');

  await f.mode(65,'watch');
  const watched=await backorders.run(db,f.ws);
  assert.equal(watched.shared,0);assert.equal((await f.runs()).length,0,'Watch only proposes nothing.');
  await f.mode(65,'ask');
  assert.equal((await backorders.run(db,f.ws)).shared,0);
  let [draft]=await f.runs("status='DRAFT'");assert.match(draft.reason,/Ask me first/);
  await f.mode(65,'inherit');
  const autopilot=require('../../src/autopilot/postgres-service');
  await autopilot.pause(db,ctx,{role:'owner'},'Stock count');
  assert.equal((await backorders.run(db,f.ws)).shared,0);
  [draft]=await f.runs("status='DRAFT'");assert.match(draft.reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');

  // Tier 1 first, then the earliest promised date; orders without a promise come last.
  assert.equal((await backorders.run(db,f.ws)).shared,1);
  assert.deepEqual(await f.all(valued,shop,early),[6,2,2]);
  assert.equal((await f.runs("status='DRAFT'")).length,0,'The applied split replaces the waiting proposal.');
  assert.equal((await backorders.run(db,f.ws)).shared,0,'Replaying finds nothing to move.');

  // Bad data stops and asks: an order with unclear delivery keeps its stock, gets none and gives none.
  await db.query('UPDATE sales_orders SET delivery_decision_required=1 WHERE workspace_id=$1 AND id=$2',[f.ws,early.salesOrderId]);
  const vip=await f.order('vip',3);
  await sharing.setTier(db,ctx,{customerId:'vip',tier:'1'});
  assert.equal((await backorders.run(db,f.ws)).shared,1);
  assert.deepEqual(await f.all(early,vip,shop,valued),[2,2,0,6]);
  const page=await sharing.page(db,ctx,{});
  assert.deepEqual(page.preview.held.map(h=>h.orderNumber),[early.orderNumber]);

  // Shadow mode only watches.
  await db.query('UPDATE sales_orders SET delivery_decision_required=0 WHERE workspace_id=$1 AND id=$2',[f.ws,early.salesOrderId]);
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  assert.equal((await backorders.run(db,f.ws)).watching,true);
  assert.deepEqual(await f.all(early,vip),[2,2]);
  await assert.rejects(sharing.prepare(db,ctx,{locationId:f.location.id}),/watching during the first 14 days/);
});
