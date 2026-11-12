'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 86: Starter only suggests. Growth, Pro and Custom build a draft plan per
// item with markdown steps, expected units, cash back and timing from recorded
// sales and cost. A person approves every price; the approved price goes
// through the normal price path and the plan tracks posted sales against it.
test('clearance plans suggest steps with expected cash and change prices only after a person approves',{timeout:600000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe,location,workflows}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
  const prices=require('../../src/pricing/postgres-service'),plans=require('../../src/pricing/agent-clearance-plans');
  const reviews=require('../../src/autopilot/job-reviews'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await subscribe('enterprise');
  const today=await require('../../src/lib/business-time').today(db,ws);
  const old=require('../../src/accounting/customer-money').addDays(today,-210);
  const seed=async(code,quantity,at=old+'T12:00:00Z')=>{
    const sku=(await catalog.createItem(db,ctx,{name:'Clearance '+code,baseCode:code,trackingMode:'quantity',purchaseCost:'2'})).skuIds[0];
    await receipt.receive(db,ctx,{skuId:sku,locationId:location.id,quantity,occurredAt:at,idempotencyKey:randomUUID()});
    return sku;
  };
  const A=await seed('CLR-A',10);
  await prices.setPrice(db,ctx,{skuId:A,amountMinor:999,currency:'USD'});
  const price=async sku=>(await prices.currentPrice(db,ws,sku)).amount_minor;
  let n=0;
  const save=input=>plans.prepare(db,ctx,{requestKey:'plan-'+(++n),stepDays:'30',...input});
  const approve=async(id,step)=>plans.approve(db,ctx,id,{step,confirmed:'yes',evidenceHash:(await plans.load(db,ctx,id)).evidence_hash});
  const audits=async action=>Number((await db.query('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].count);

  // Starter: one suggestion, the plan page is locked and nothing can be drafted.
  await subscribe('starter');
  assert.deepEqual(Object.keys((await reviews.run(db,ctx,'clearance-plan',{filter:'CLR-A',change:20})).rows[0]),['Suggestion']);
  assert.match((await browser.get(plans.path).expect(200)).text,/data-agent-plan-locked/);
  await assert.rejects(save({sku:'CLR-A',markdown:'20'}),e=>e.code==='entitlement_required');
  assert.deepEqual(await plans.inbox(db,ws),[]);

  // Growth, Pro and Custom: the same draft. Three suggested steps, never below the
  // $2.00 stock cost; ten never-sold units spread over them; no price changes.
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);
    const shown=await plans.preview(db,ctx,{sku:'CLR-A',markdown:'20',stepDays:'30'});
    assert.equal(shown.facts.unitCost,200);assert.equal(shown.facts.sold,0);
    assert.deepEqual(shown.steps.map(s=>[s.points,s.priceMinor,s.expectedUnits,s.expectedCashMinor,s.days]),
      [[2000,799,'3',2397,30],[4000,599,'3',1797,30],[6000,400,'4',1600,30]],tier);
    assert.equal(shown.expectedCash,5794);
    const {id}=await save({sku:'CLR-A',markdown:'20'});
    assert.equal(await price(A),999,tier+': a draft changes no price');
    const [waiting]=await plans.inbox(db,ws);
    assert.match(waiting.title,/A clearance price waits for you/);
    assert.equal(waiting.href,plans.path+'/'+id);
    await assert.rejects(save({sku:'CLR-A',markdown:'25'}),/already has an open clearance plan/);
    assert.equal((await plans.end(db,ctx,id,{confirmed:'yes'})).cancelled,true);
    assert.equal((await plans.load(db,ctx,id)).status,'CANCELLED');
    assert.deepEqual((await modes.page(db,ctx)).find(r=>r.id===86).allowed,['inherit','watch','ask'],tier+' never handles prices alone');
  }
  await assert.rejects(reviews.run(db,ctx,'clearance-plan',{scheduled:true,trained:true,change:20}),e=>e.code==='entitlement_required');

  // Missing or mismatched facts stop and ask.
  await assert.rejects(save({sku:'CLR-A',markdown:'85'}),/sells below the recorded cost of \$2\.00/);
  await assert.rejects(save({sku:'CLR-A',markdown:'0'}),/from 0.01% to 99%/);
  await assert.rejects(save({sku:'CLR-A',markdown:'20',stepDays:'0'}),/from 1 to 365/);
  const B=await seed('CLR-B',4);
  assert.match((await plans.preview(db,ctx,{sku:'CLR-B',markdown:'20',stepDays:'30'})).problem,/Set a selling price/);
  await assert.rejects(save({sku:'CLR-B',markdown:'20'}),/Set a selling price/);
  await prices.setPrice(db,ctx,{skuId:B,amountMinor:500,currency:'USD'});
  await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:B,locationId:location.id,quantity:1,idempotencyKey:randomUUID()});
  assert.match((await plans.preview(db,ctx,{sku:'CLR-B',markdown:'20',stepDays:'30'})).problem,/Complete the stock cost/);
  const C=await seed('CLR-C',3,new Date().toISOString());
  await prices.setPrice(db,ctx,{skuId:C,amountMinor:500,currency:'USD'});
  assert.match((await plans.preview(db,ctx,{sku:'CLR-C',markdown:'20',stepDays:'30'})).problem,/Nothing here needs clearing/);

  // Shadow mode, Watch only, watch mode: no price approval.
  const plan=(await save({sku:'CLR-A',markdown:'20'})).id;
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  await assert.rejects(approve(plan,1),/watching during the first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await modes.save(db,ctx,86,{mode:'watch',revision:0});
  await assert.rejects(approve(plan,1),/Watch only/);
  await assert.rejects(save({sku:'CLR-B',markdown:'20'}),/Watch only/);
  await modes.save(db,ctx,86,{mode:'ask',revision:1});
  await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
  await assert.rejects(approve(plan,1),/watch-only mode/);
  await autopilot.setMode(db,ctx,{role:'owner'},'SUPERVISED');
  assert.equal(await price(A),999);

  // New stock after the plan was built: it stops and asks for a fresh plan.
  await receipt.receive(db,ctx,{skuId:A,locationId:location.id,quantity:2,idempotencyKey:randomUUID()});
  await assert.rejects(approve(plan,1),/changed since this plan was built/);
  assert.match((await browser.get(plans.path+'/'+plan).expect(200)).text,/data-clearance-hold/);
  await plans.end(db,ctx,plan,{confirmed:'yes'});

  // The builder page, saving and approving through the pages.
  const builder=await browser.get(plans.path+'/new?sku=CLR-A&markdown=20&stepDays=30').expect(200);
  assert.match(builder.text,/data-clearance-preview/);assert.match(builder.text,/Expected cash back before tax: <strong>\$71\.92/);
  const requestKey=/name="requestKey" value="([^"]+)"/.exec(builder.text)[1];
  const created=await browser.post(plans.path).type('form').send({_csrf:f.csrf(builder.text),requestKey,sku:'CLR-A',markdown:'20',stepDays:'30'}).expect(303);
  const id=created.headers.location.split('/').pop();
  const replay=await browser.post(plans.path).type('form').send({_csrf:f.csrf(builder.text),requestKey,sku:'CLR-A',markdown:'20',stepDays:'30'}).expect(303);
  assert.equal(replay.headers.location,created.headers.location,'the same form saves one plan');
  const detail=await browser.get(plans.path+'/'+id).expect(200);
  assert.match(detail.text,/data-clearance-approve/);assert.match(detail.text,/Approve \$7\.99/);
  await browser.post(plans.path+'/'+id+'/approve').type('form').send({_csrf:f.csrf(detail.text),step:1,confirmed:'yes',
    evidenceHash:/name="evidenceHash" value="([^"]+)"/.exec(detail.text)[1]}).expect(303);
  const live=await prices.currentPrice(db,ws,A);
  const detailOf=d=>typeof d==='string'?JSON.parse(d):d;
  assert.deepEqual([live.amount_minor,live.source,detailOf(live.source_detail).planId],[799,'agent_clearance_plan',id]);
  assert.deepEqual(await approve(id,1),{replayed:true,step:1});
  assert.equal(await audits('Clearance price approved'),1);

  // Tracking: posted sales and revenue since the price went live.
  const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:A,quantity:2,unitPriceMinor:799}]});
  await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
  await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],locationId:location.id,quantity:2}]});
  let screen=await plans.page(db,ctx,{id});
  assert.equal(screen.tracking.units,'2');assert.equal(screen.tracking.cashMinor,1598);
  assert.equal(screen.tracking.label,'On plan');
  assert.deepEqual([screen.plan.steps[0].actualUnits,screen.plan.steps[0].actualCashMinor],['2',1598]);
  assert.equal((await plans.inbox(db,ws)).length,0,'nothing is due yet');

  // A month later the plan is behind: the next step waits for a person.
  await db.query(`UPDATE stockchief_runtime.agent_clearance_plans SET steps=jsonb_set(steps,'{0,startedAt}',to_jsonb((now()-interval '31 days')::text))
    WHERE workspace_id=$1 AND id=$2`,[ws,id]);
  const [due]=await plans.inbox(db,ws);
  assert.match(due.title,/next clearance step for CLR-A is due/);assert.match(due.happened,/2 of 4 planned units/);
  screen=await plans.page(db,ctx,{id});
  assert.equal(screen.tracking.label,'Behind plan. The next step is due.');assert.equal(screen.next,2);
  await assert.rejects(approve(id,3),/Approve the next step/);
  await approve(id,2);
  assert.equal(await price(A),599);
  // Ending puts the starting price back while nobody changed it since.
  assert.deepEqual(await plans.end(db,ctx,id,{confirmed:'yes',restore:'yes'}),{ended:true,restored:true});
  assert.equal(await price(A),999);
  assert.deepEqual(await plans.end(db,ctx,id,{confirmed:'yes',restore:'yes'}),{replayed:true});

  // A price changed outside the plan stops the next step and the restore.
  const next=(await save({sku:'CLR-A',markdown:'10'})).id;
  await approve(next,1);
  assert.equal(await price(A),899);
  await prices.setPrice(db,ctx,{skuId:A,amountMinor:850,currency:'USD'});
  await assert.rejects(approve(next,2),/changed outside this plan/);
  await assert.rejects(plans.end(db,ctx,next,{confirmed:'yes',restore:'yes'}),/changed outside this plan/);
  assert.equal((await plans.end(db,ctx,next,{confirmed:'yes'})).ended,true);
  assert.equal(await price(A),850);

  // The review links to the plans; the list and plan pages render.
  const review=await browser.get('/autopilot/reviews/clearance-plan?filter=CLR-A&change=20').expect(200);
  assert.match(review.text,/Open clearance plans/);assert.match(review.text,/Build a plan/);
  const list=await browser.get(plans.path).expect(200);
  assert.match(list.text,new RegExp('data-clearance-plan="'+id+'"'));
  assert.match((await browser.get(plans.path+'/'+id).expect(200)).text,/data-clearance-step="2"/);
});
