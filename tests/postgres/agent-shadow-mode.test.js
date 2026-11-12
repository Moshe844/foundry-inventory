'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const shadow=require('../../src/autopilot/shadow-mode');
const autonomy=require('../../src/autopilot/postgres-service');
const policy=require('../../src/commercial/agent-plan');
const modes=require('../../src/autopilot/job-modes');

// Job 198 on every plan: for an account's first 14 days every job that would
// act on its own only watches. Reorders, transfers, count postings, count
// lists, credit holds and delivery QC holds record what they would have done,
// with amounts. The report shows the orders it would have placed, the
// stockouts it would have prevented (from the stock ledger) and the money it
// would have caught. When watching ends, Needs you asks the owner to switch on
// automatic work per area or for everything.
test('shadow mode watches every automatic job for 14 days, reports what it would have done and saved, then the owner switches areas on',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:4}),{db,ctx,browser,subscribe,workflows,shipping,location}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
  const inventory=require('../../src/domain/postgres-inventory-engine'),commerce=require('../../src/operations/postgres-commerce');
  const counts=require('../../src/operations/postgres-count-reviews'),countRules=require('../../src/autopilot/count-rules'),countTasks=require('../../src/operations/agent-count-tasks');
  const holds=require('../../src/sales/agent-credit-holds'),quality=require('../../src/operations/agent-quality-holds');
  const today=await require('../../src/lib/business-time').today(db,ws),addDays=require('../../src/accounting/customer-money').addDays;
  const records=async()=>(await db.query('SELECT * FROM stockchief_runtime.agent_shadow_actions WHERE workspace_id=$1 ORDER BY recorded_at,id',[ws])).rows;
  const kinds=async()=>(await records()).map(r=>r.kind).sort();
  const audits=async action=>(await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n;
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>n.sourceId==='shadow-report');
  const csrfFor=async path=>f.csrf((await browser.get(path).expect(200)).text);

  // An account still on its older terms sees the shared plan card, not an error.
  assert.match((await browser.get(shadow.path).expect(200)).text,/data-agent-plan-locked/);
  assert.deepEqual(await shadow.inbox(db,ws),[]);
  await subscribe('pro');
  const account=await policy.accountState(db,ws);
  assert.equal(account.shadow,true,'a new account starts in shadow mode');

  // Two products to watch: one to reorder from the supplier and one another location can spare.
  const destination=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Second warehouse',kind:'warehouse'});
  const product=async code=>(await catalog.createItem(db,ctx,{name:code,baseCode:code+'-'+randomUUID().slice(0,6),trackingMode:'quantity',purchaseCost:'2'})).skuIds[0];
  const target=(skuId,place,point,stock)=>db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,0,'manual',now()::text,now()::text)`,[randomUUID(),ws,skuId,place.id,point,stock]);
  const buy=await product('SHADOW-BUY'),move=await product('SHADOW-MOVE');
  await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:buy,purchaseUnit:'unit',unitsPerPurchaseUnit:1,lastUnitCost:3,orderMultiple:1,minimumOrderQuantity:1,isPreferred:true});
  await receipt.receive(db,ctx,{skuId:buy,locationId:location.id,quantity:2,occurredAt:new Date(Date.now()-3*86400000).toISOString(),idempotencyKey:randomUUID()});
  await target(buy,location,5,11);
  await receipt.receive(db,ctx,{skuId:move,locationId:location.id,quantity:10,idempotencyKey:randomUUID()});
  await target(move,location,2,2);await target(move,destination,5,5);

  // Reorders and transfers: the planner prepares them, nothing is ordered or moved, and both are recorded.
  const planned=await autonomy.plan(db,ws,{onlySkuIds:[buy,move]});
  const order=planned.created.find(w=>w.recommendedAction.type==='purchase'),transfer=planned.created.find(w=>w.recommendedAction.type==='transfer');
  assert.ok(order,JSON.stringify(planned.considered));assert.ok(transfer,JSON.stringify(planned.considered));
  assert.equal(order.approval_requirement,'REQUIRED');assert.match(order.policyEvaluation.reason,/watch only/);
  await assert.rejects(autonomy.approve(db,ctx,{role:'owner'},order.id),/only watches/);
  assert.equal((await db.query('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1',[ws])).rows[0].n,1,'only the fixture order exists');
  let rows=await records();
  const ordered=rows.find(r=>r.kind==='order');
  assert.deepEqual([ordered.job_id,ordered.area,ordered.sku_id,ordered.location_id,Number(ordered.quantity),Number(ordered.amount_minor),ordered.currency],[20,'purchasing',buy,location.id,9,2700,'USD']);
  assert.match(ordered.summary,/^Order 9 of SHADOW-BUY.* from Fixture parts for Dispatch$/);
  assert.equal(ordered.href,'/autopilot/work/'+order.id);
  assert.equal(ordered.lead_days,require('../../src/purchasing/replenishment-decision').DEFAULT_LEAD_DAYS,'the planner’s own lead time');
  const moved=rows.find(r=>r.kind==='transfer');
  assert.deepEqual([moved.job_id,moved.area,moved.location_id,Number(moved.quantity)],[119,'transfers',destination.id,5]);
  // Replays record nothing twice.
  await autonomy.plan(db,ws,{onlySkuIds:[buy,move]});
  assert.equal((await records()).length,2);

  // Counts: the owner's rule would have posted a small difference, and the schedule would have sent a count list.
  await countRules.configure(db,ctx,{mode:'automatic',limit:'50'});
  const counted=await counts.prepare(db,ctx,{locationId:location.id,submissionKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:'3'}]});
  assert.equal((await db.query('SELECT status FROM physical_count_reviews WHERE workspace_id=$1 AND id=$2',[ws,counted.id])).rows[0].status,'PENDING','nothing is posted');
  await countTasks.schedule(db,ctx,{locationId:location.id,counterId:ctx.actorId,days:'7',firstDay:today});
  await db.transaction(c=>countTasks.runSchedules(c,ws));
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_count_tasks WHERE workspace_id=$1',[ws])).rows[0].n,0,'no count list is sent');

  // Holds: an open order for an overdue customer, and a delivery under an automatic QC rule.
  await holds.configure(db,ctx,{mode:'on',days:'30'});
  const parcel=await f.parcel({quantity:1});await shipping.markPacked(db,ctx,parcel.shipmentId);
  await shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'TRACK-SHADOW-1'});
  await db.query('UPDATE accounting_customer_invoices SET due_date=$2 WHERE workspace_id=$1 AND sales_order_id=$3',[ws,addDays(today,-40),parcel.order.salesOrderId]);
  const open=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:2,unitPriceMinor:1500}]});
  const swept=await holds.sweep(db,ws);
  assert.deepEqual([swept.placed,swept.watching,swept.watched],[0,true,1]);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_order_credit_holds WHERE workspace_id=$1',[ws])).rows[0].n,0,'no order is held');
  assert.equal((await holds.sweep(db,ws)).watched,0,'a replay records nothing twice');
  const checked=await product('SHADOW-QC');
  const code=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ws,checked])).rows[0].code;
  await quality.save(db,ctx,{skuCode:code,checklist:['Check seals'],maxUnits:20,mode:'automatic',confirmed:'yes'});
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId:checked,quantityUnits:6,unitCost:2}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:6,locationId:location.id}]});
  assert.deepEqual((await db.query('SELECT status,automatic FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1 AND sku_id=$2',[ws,checked])).rows,[{status:'PROPOSED',automatic:false}]);

  rows=await records();
  assert.deepEqual(await kinds(),['count','count_list','hold','hold','order','transfer']);
  const post=rows.find(r=>r.kind==='count'),list=rows.find(r=>r.kind==='count_list');
  assert.deepEqual([post.job_id,post.area,Number(post.amount_minor)],[6,'counts',100]);assert.match(post.summary,/^Post count differences worth \$1\.00 at Dispatch under your \$50\.00 limit$/);
  assert.deepEqual([list.job_id,list.location_id],[7,location.id]);assert.match(list.summary,/count list for Dispatch due /);
  const credit=rows.find(r=>r.kind==='hold'&&r.job_id===55),qc=rows.find(r=>r.kind==='hold'&&r.job_id===51);
  assert.deepEqual([credit.area,Number(credit.caught_minor),credit.currency,credit.href],['holds',3000,'USD','/orders/'+open.salesOrderId]);
  assert.match(credit.summary,/^Hold order .* for Receiver: 1 invoice more than 30 days overdue/);
  assert.deepEqual([qc.area,Number(qc.quantity),qc.sku_id],['holds',6,checked]);
  assert.equal(await audits('StockChief only watched: it would have acted'),6,'each watched action is audited once');

  // A stockout it would have prevented: the order would have arrived before the item ran out.
  await db.query("UPDATE stockchief_runtime.agent_shadow_actions SET recorded_at=now()-make_interval(days=>lead_days+1) WHERE id=$1",[ordered.id]);
  await inventory.issue(db,ctx,{skuId:buy,locationId:location.id,quantity:2,reasonCode:'sold',occurredAt:new Date(Date.now()-3600000).toISOString(),idempotencyKey:randomUUID()});

  // During shadow the report is live on every plan; switching on waits for the 14 days.
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const page=await browser.get(shadow.path).expect(200);
    assert.match(page.text,/day 1 of 14/,tier);
    assert.match(page.text,/data-shadow-locked/,tier);assert.doesNotMatch(page.text,/data-shadow-form/,tier);
    assert.match(page.text,tier==='starter'?/>1<\/span><span class="stat-label">order it would have prepared for you to send/:/>1<\/span><span class="stat-label">order it would have placed/,tier);
    assert.match(page.text,/<span class="stat-value">\$27\.00<\/span>/,tier);
    assert.match(page.text,/<span class="stat-value">\$30\.00<\/span><span class="stat-label">money it would have caught/,tier);
    assert.match(page.text,/Ran out at Dispatch on .*after the order would have arrived/,tier);
    for(const area of ['purchasing','counts','transfers','holds'])assert.ok(page.text.includes('data-shadow-area="'+area+'"'),tier+' '+area);
    assert.deepEqual(await needs(),[],'no Needs you item while watching');
  }
  await subscribe('pro');
  const screen=await shadow.page(db,ctx);
  assert.deepEqual([screen.orders.count,screen.stockouts.length,screen.caught.amounts[0].text],[1,1,'$30.00']);
  await assert.rejects(shadow.decide(db,ctx,{choice:'all'}),/still watching/);
  const review=await require('../../src/autopilot/job-reviews').run(db,ctx,'shadow-report');
  assert.match(review.summary,/1 order it would have placed worth \$27\.00, 1 stockout it would have prevented and \$30\.00 it would have caught/);
  assert.equal(review.rows.length,6);

  // The 14 days end. Nothing more is recorded, and Needs you asks the owner to choose.
  await db.query("UPDATE accounts SET created_at=(now()-interval '336 hours 30 minutes')::text WHERE id=$1",[f.owner.accountId]);
  assert.equal(await shadow.record(db,ws,{job:20,kind:'order',key:'late',summary:'Too late'}),null);
  const [item]=await needs();
  assert.equal(item.href,shadow.path);assert.match(item.happened,/^It recorded 6 things it would have done, including 1 order\. Nothing was changed\.$/);
  assert.match((await browser.get('/needs-you/all').expect(200)).text,/StockChief’s 14 days of watching are over/);
  let page=await browser.get(shadow.path).expect(200);
  assert.match(page.text,/data-shadow-form/);assert.match(page.text,/Ran out at Dispatch/,'the stockout is inside the 14 days');

  // Bad input stops; only the owner decides.
  await assert.rejects(shadow.decide(db,ctx,{choice:'selected',areas:['nowhere']}),/Choose areas from the list/);
  await assert.rejects(shadow.decide(db,ctx,{choice:'selected'}),/Tick at least one area/);
  await assert.rejects(shadow.decide(db,{...ctx,actorId:'someone-else'},{choice:'all'}),/Only the business owner/);

  // Pro: switch on purchasing and counts only.
  await browser.post(shadow.path+'/decide').type('form').send('_csrf='+encodeURIComponent(f.csrf(page.text))+'&choice=selected&areas=purchasing&areas=counts').expect(303);
  const mode=async job=>(await db.query('SELECT mode,updated_by FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2',[ws,job])).rows[0]?.mode||'inherit';
  assert.deepEqual(await Promise.all([20,19,6,7,8,119,118,55,51,102,60].map(mode)),['routine','routine','routine','routine','routine','watch','watch','watch','watch','watch','watch']);
  const state=await autonomy.getState(db,ws);assert.equal(state.mode,'POLICY_AUTOMATED');
  const granted=(await autonomy.listCapabilities(db,ws)).filter(c=>c.granted).map(c=>c.capability).sort();
  assert.deepEqual(granted,['replenishment','supplier_emails']);
  const decision=(await db.query('SELECT * FROM stockchief_runtime.agent_shadow_decisions WHERE workspace_id=$1',[ws])).rows[0];
  assert.deepEqual([decision.areas,decision.mode,decision.decided_by],[['purchasing','counts'],'POLICY_AUTOMATED',ctx.actorId]);
  assert.equal(await audits('Automatic work switched on after shadow mode'),1);
  assert.deepEqual(await needs(),[],'the choice clears Needs you');
  page=await browser.get(shadow.path).expect(200);
  assert.match(page.text,/Switched on: Reorders and purchasing, Stock counts\./);assert.doesNotMatch(page.text,/data-shadow-form/);
  // A replay changes nothing.
  assert.equal((await shadow.decide(db,ctx,{choice:'all'})).replayed,true);
  assert.equal(await mode(119),'watch');assert.equal(await audits('Automatic work switched on after shadow mode'),1);

  // What was switched on now acts on its own; what was left off keeps watching.
  const live=await counts.prepare(db,ctx,{locationId:location.id,submissionKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:'2'}]});
  assert.equal((await db.query('SELECT status FROM physical_count_reviews WHERE workspace_id=$1 AND id=$2',[ws,live.id])).rows[0].status,'COMPLETED','the count posts under the limit');
  assert.equal((await holds.sweep(db,ws)).placed,0,'holds keep watching');
  assert.equal((await records()).length,6,'nothing is recorded after the 14 days');

  // Every plan: switching on gives each area the highest mode the plan allows; keeping watch keeps everything watching.
  const reset=async()=>{await db.query('DELETE FROM stockchief_runtime.agent_shadow_decisions WHERE workspace_id=$1',[ws]);
    await db.query('DELETE FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1',[ws]);
    await db.query("UPDATE autopilot_capabilities SET granted=0 WHERE workspace_id=$1",[ws]);
    await db.query("UPDATE workspace_autopilot SET mode='SUPERVISED' WHERE workspace_id=$1",[ws]);};
  for(const [tier,expected,routine] of [['starter','SUPERVISED',false],['growth','POLICY_AUTOMATED',true],['enterprise','POLICY_AUTOMATED',true]]){
    await subscribe(tier);await reset();
    page=await browser.get(shadow.path).expect(200);assert.match(page.text,/data-shadow-form/,tier);
    await browser.post(shadow.path+'/decide').type('form').send({_csrf:f.csrf(page.text),choice:'all'}).expect(303);
    assert.equal((await db.query('SELECT mode FROM workspace_autopilot WHERE workspace_id=$1',[ws])).rows[0].mode,expected,tier);
    assert.equal(await mode(20),policy.permits(tier,20,'automatic',{trained:true})?'routine':'inherit',tier);
    assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND mode='routine'",[ws])).rows[0].n>0,routine,tier);
    assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND mode='watch'",[ws])).rows[0].n,0,tier);
    const caps=(await autonomy.listCapabilities(db,ws)).filter(c=>c.granted).map(c=>c.capability).sort();
    if(tier==='starter')assert.deepEqual(caps,[],tier);
    if(tier==='growth')assert.deepEqual(caps,['replenishment','supplier_emails'],'Growth keeps its narrower automatic jobs');
  }
  await subscribe('pro');await reset();
  await shadow.decide(db,ctx,{choice:'watch'});
  assert.equal((await db.query('SELECT mode FROM workspace_autopilot WHERE workspace_id=$1',[ws])).rows[0].mode,'OBSERVE');
  assert.equal(await mode(20),'watch');assert.equal(await audits('StockChief kept watching after shadow mode'),1);
  assert.match((await browser.get(shadow.path).expect(200)).text,/You chose to keep StockChief watching/);
  await reset();

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await view.goto(base+shadow.path);
    assert(await view.getByRole('heading',{name:'Your first 14 days',exact:true}).isVisible());
    assert(await view.getByRole('heading',{name:'Stockouts it would have prevented'}).isVisible());
    assert(await view.getByRole('button',{name:'Switch on what I ticked'}).isVisible());
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await view.screenshot({path:require('node:path').join(folder,'shadow-report-'+name+'.png'),fullPage:true});
    await view.close();
  }
});
