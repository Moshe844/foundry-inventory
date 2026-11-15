'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// What a brand-new owner meets on day one: the current plan terms and the
// first 14 days of watching, which is how every new production account starts.
// Found by walking a fresh account in production mode; none of it showed on an
// older account.
test('a new account’s first import has no stray panel or refusal, keeps its costs, and gets no report for the day before it existed',
  {timeout:600000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe,location,item,workflows}=f,ws=ctx.workspaceId;
  const imports=require('../../src/imports/postgres-service'),policy=require('../../src/commercial/agent-plan');
  const receiving=require('../../src/purchasing/agent-receiving-documents');
  const health=require('../../src/autopilot/data-health'),reviews=require('../../src/autopilot/job-reviews');
  const briefs=require('../../src/autopilot/daily-briefs'),summary=require('../../src/autopilot/team-summary'),time=require('../../src/lib/business-time');
  const {addDays}=require('../../src/accounting/customer-money');
  await subscribe('pro');
  const account=await policy.accountState(db,ws);
  assert.equal(account.shadow,true,'a new account only watches');

  // The import review: the owner confirms the columns, in plain words, and can approve.
  const file=await imports.analyse(db,ctx,{text:'Product Name,SKU,Location,Qty On Hand,Unit Cost\nBlue Mug,MUG-BLU,Dispatch,48,3.25\nCarafe,CRF-1,Dispatch,0,6.15',allowModel:false});
  assert.equal(file.transformations.columnReview.state,'confirm');
  assert.equal(file.transformations.columnReview.reason,'In its first 14 days StockChief only watches, so you confirm the columns.');
  let page=(await browser.get('/imports/'+file.id).expect(200)).text;
  assert.match(page,/In its first 14 days StockChief only watches, so you confirm the columns\./);
  assert.doesNotMatch(page,/shadow mode|Record this action manually/);

  // No placed purchase order expects goods, so the delivery panel stays away.
  assert.equal(await receiving.expectsGoods(db,ws),false);
  assert.doesNotMatch(page,/id="receiving-form"/);
  // Once one does, the same preview offers it.
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,idempotencyKey:randomUUID(),
    lines:[{skuId:item.skuIds[0],quantityUnits:2,unitCost:1}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  assert.equal(await receiving.expectsGoods(db,ws),false,'an approved order that is not placed expects nothing yet');
  await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  assert.equal(await receiving.expectsGoods(db,ws),true);
  page=(await browser.get('/imports/'+file.id).expect(200)).text;
  assert.match(page,/id="receiving-form"/);assert.match(page,/Receive this delivery against its purchase order/);

  // The import brings the stock in at the costs in the file.
  await imports.approve(db,ctx,file.id,file.integrityHash);assert.ok((await imports.execute(db,ctx,file.id)).verified);
  const sku=async code=>(await db.query('SELECT id FROM skus WHERE workspace_id=$1 AND code=$2',[ws,code])).rows[0].id;
  const mug=await sku('MUG-BLU');
  assert.equal((await db.query('SELECT count(*)::int n FROM sku_purchase_costs WHERE workspace_id=$1 AND sku_id=$2',[ws,mug])).rows[0].n,0,
    'the stocked row’s cost is recorded with its stock');
  assert.equal((await require('../../src/pricing/postgres-service').purchaseCost(db,ws,mug)).amount_minor,325);

  // The health score counts that cost: nothing is reported as missing a purchase cost.
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const processed=await queue.processOne(db,handlers,{owner:'first-day-health',kinds:[health.kind]});
  assert.equal(processed.status,'COMPLETED',JSON.stringify(processed.lastError));
  const [score]=(await db.query('SELECT checks FROM stockchief_runtime.agent_data_health_scores WHERE workspace_id=$1 ORDER BY computed_at DESC,id DESC LIMIT 1',[ws])).rows;
  assert.equal(score.checks.find(c=>c.key==='cost_ok').failed,0);
  // The fix list offers the recorded cost ready to approve, and does not ask the owner to type it again.
  const listed=await reviews.run(db,ctx,'catalog-fixes',{filter:'MUG-BLU'});
  const line=listed.rows.find(r=>r.SKU==='MUG-BLU'&&/purchase cost/i.test(r['What to fix']));
  assert.match(line['What to fix'],/No purchase cost\. Fill \$3\.25 from the recorded cost of your stock on hand/);
  assert.doesNotMatch(line['What to fix'],/No receipt or supplier price records this cost/);

  // Daily reports: nothing for the day before the business existed.
  const today=await time.today(db,ws),yesterday=addDays(today,-1);
  assert.equal(await time.firstDay(db,ws),today);
  const digests=async()=>(await db.query('SELECT report_date::text AS day FROM workspace_daily_digests WHERE workspace_id=$1 ORDER BY report_date',[ws])).rows.map(r=>r.day);
  const summaries=async()=>(await db.query('SELECT report_date::text AS day FROM stockchief_runtime.agent_team_summaries WHERE workspace_id=$1 ORDER BY report_date',[ws])).rows.map(r=>r.day);
  await briefs.deliver(db,ws,account,{now:new Date()});
  assert.deepEqual(await digests(),[],'no briefing for the day before the business existed');
  assert.deepEqual(await summary.deliver(db,ws,{now:new Date()}),{skipped:'before_first_day',day:yesterday});
  assert.deepEqual(await summaries(),[]);
  // Tomorrow it gets its first reports, for today, with today's import in them.
  const tomorrow=new Date(Date.now()+86400000);
  await briefs.deliver(db,ws,account,{now:tomorrow});
  const expected=await time.today(db,ws,new Date(tomorrow.getTime()-86400000));
  assert.deepEqual(await digests(),[expected]);
  assert.equal((await summary.deliver(db,ws,{now:tomorrow})).day,expected);
  assert.deepEqual(await summaries(),[expected]);
});
