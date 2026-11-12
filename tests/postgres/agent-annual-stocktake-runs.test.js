'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const annual=require('../../src/operations/agent-annual-stocktakes'),runs=require('../../src/operations/agent-annual-stocktake-runs'),tasks=require('../../src/operations/agent-count-tasks');
const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
const time=require('../../src/lib/business-time'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service'),{addDays}=require('../../src/accounting/customer-money');
const applyKind='agent.annual-stocktake.apply.v1';

async function setup(t,plan,{aged=true}={}){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});await f.subscribe(plan);
 if(aged)await f.db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 return {...f,today:await time.today(f.db,f.ctx.workspaceId)};
}
async function staff(f,name){
 const rights=require('../../src/actions/permissions'),account=await require('../../src/domain/postgres-auth-service').createBusiness(f.db,{email:randomUUID()+'@example.test',password:f.password,name,businessName:name+' business'}),id=randomUUID();
 await f.db.query("INSERT INTO users(id,name,workspace_id,account_id,role,permissions,warehouse_location_ids,created_at) VALUES($1,$2,$3,$4,'staff',$5,$6::jsonb,now()::text)",[id,name,f.ctx.workspaceId,account.accountId,rights.encodeGrant([rights.VIEW,rights.COUNT_STOCK]),JSON.stringify([f.location.id])]);
 return {workspaceId:f.ctx.workspaceId,actorId:id};
}
// A bin inside the warehouse with its own product, received at $1.00 a unit.
async function shelf(f,units){
 const {db,ctx,workflows}=f,bin=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Shelf B',kind:'bin',parentLocationId:f.location.id});
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Shelf product',baseCode:'SHELF-'+randomUUID().slice(0,8),trackingMode:'quantity'});
 const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:item.skuIds[0],quantityUnits:units,unitCost:1}]});
 await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
 await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:units,locationId:bin.id}]});
 return {bin,sku:item.skuIds[0]};
}
const rule=(f,input={})=>runs.configure(f.db,f.ctx,{title:'Year-end count',countDate:f.today,countDays:'2',noticeDays:'0',ruleLocationIds:[f.location.id],ruleCounterIds:[f.ctx.actorId],recountUnits:'3',confirmed:'yes',revision:0,...input});
const onHand=async(f,sku,location)=>Number((await f.db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[f.ctx.workspaceId,sku,location])).rows[0]?.on_hand);
const frozen=async(f,location)=>(await f.db.query('SELECT annual_count_freeze_id FROM locations WHERE id=$1',[location])).rows[0].annual_count_freeze_id;
const plans=async f=>(await f.db.query('SELECT id,status,automatic,request_key,problem FROM stockchief_runtime.agent_annual_stocktakes WHERE workspace_id=$1 ORDER BY created_at,id',[f.ctx.workspaceId])).rows;
const teamsOf=async(f,id)=>(await f.db.query('SELECT location_id,campaign_id,counter_id,agent_decision FROM stockchief_runtime.agent_annual_count_teams WHERE workspace_id=$1 AND stocktake_id=$2 ORDER BY location_id',[f.ctx.workspaceId,id])).rows;
const recounts=async f=>(await f.db.query('SELECT campaign_id,first_quantity::text first_quantity,first_counter_id,recounter_id,automatic FROM stockchief_runtime.agent_annual_recounts WHERE workspace_id=$1 ORDER BY requested_at',[f.ctx.workspaceId])).rows;
const audits=async f=>(await f.db.query('SELECT action FROM security_event_history WHERE workspace_id=$1',[f.ctx.workspaceId])).rows.map(r=>r.action);
async function drain(f){for(let i=0;i<20;i++){const done=await jobs.processOne(f.db,{[applyKind]:handlers[applyKind]},{owner:'annual-stocktake-test'});if(!done)return;assert.equal(done.status,'COMPLETED',JSON.stringify(done));}}
async function signoff(f,id){const plan=await annual.header(f.db,f.ctx,id),review=await runs.differences(f.db,f.ctx,plan);await runs.approve(f.db,f.ctx,id,{revision:plan.revision,confirmed:'yes',reviewHash:review.hash});await drain(f);return review;}
// Render pages in a real browser at desktop width and at 390 px, with no sideways scroll.
async function render(f,paths){
 const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),browser=await require('playwright').chromium.launch();
 try{const origin='http://127.0.0.1:'+server.address().port,texts=[];
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){const page=await browser.newPage({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500});page.setDefaultTimeout(12000);
   await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
   for(const path of paths){const response=await page.goto(origin+path);assert.equal(response.status(),200,path);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scroll on '+path+' at '+viewport.width);texts.push(await page.locator('main').innerText());
    require('node:fs').mkdirSync('output',{recursive:true});await page.screenshot({path:'output/annual-stocktake-'+(path.split('/')[3]?'plan':'index')+'-'+viewport.width+'.png',fullPage:true});}
   await page.close();}
  return texts;
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
}

test('Pro runs the yearly stocktake from the owner rule: freeze on the count date, shared areas, a second counter for big differences, small areas posted under the count limit and reopened, big differences signed off',{timeout:420000},async t=>{
 const f=await setup(t,'pro'),{db,ctx}=f,skuA=f.item.skuIds[0],helper=await staff(f,'Second counter'),back=await shelf(f,4),who=id=>({workspaceId:ctx.workspaceId,actorId:id});
 await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await require('../../src/autopilot/count-rules').configure(db,ctx,{mode:'automatic',limit:'5.00'});
 await assert.rejects(rule(f,{recountUnits:''}),/recount/);await assert.rejects(rule(f,{countDate:addDays(f.today,-1)}),/from today/);
 await rule(f,{ruleCounterIds:[ctx.actorId,helper.actorId]});await assert.rejects(rule(f,{revision:0}),/changed/);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_annual_stocktake_rules WHERE workspace_id=$1 AND enabled',[ctx.workspaceId])).rows[0].n,1,'The yearly rule is one saved rule');
 // The routine runs from the worker queue: it plans and, on the count date, freezes and sends the lists.
 assert.equal(await runs.enqueue(db,ctx.workspaceId,'cycle-1'),1);const ran=await jobs.processOne(db,{[runs.jobKind]:handlers[runs.jobKind]},{owner:'annual-stocktake-routine'});assert.equal(ran.status,'COMPLETED',JSON.stringify(ran));
 let [p]=await plans(f);assert.equal(p.status,'FROZEN');assert.equal(p.automatic,true);assert.equal(p.request_key,'annual-rule:'+f.today);
 await runs.routine(db,ctx.workspaceId);assert.equal((await plans(f)).length,1,'Replaying the routine adds no second plan');assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_count_tasks WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,2);
 const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:skuA,quantity:1,unitPriceMinor:1000}]});
 await assert.rejects(f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()}),/frozen.*annual stocktake/i,'The freeze stops sales at the counted locations');
 assert((await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).some(r=>r.sourceId==='annual-stocktake-freezes'));
 const teams=await teamsOf(f,p.id),main=teams.find(x=>x.location_id===f.location.id),bin=teams.find(x=>x.location_id===back.bin.id);assert.notEqual(main.counter_id,bin.counter_id,'Areas are shared across the count team');
 // A small difference in the bin posts under the owner's $5.00 count limit and the bin reopens.
 await tasks.record(db,who(bin.counter_id),bin.campaign_id,{skuId:back.sku,locationId:back.bin.id,quantity:3});await drain(f);
 assert.equal(await onHand(f,back.sku,back.bin.id),3);assert.equal(await frozen(f,back.bin.id),null,'A posted area reopens');assert.equal(await frozen(f,f.location.id),p.id);
 assert.equal((await teamsOf(f,p.id)).find(x=>x.location_id===back.bin.id).agent_decision.action,'posted');
 // A big difference (5 units, more than 3) goes to the other counter for a blind recount and never posts on its own.
 const first=main.counter_id,second=first===ctx.actorId?helper.actorId:ctx.actorId;
 await tasks.record(db,who(first),main.campaign_id,{skuId:skuA,locationId:f.location.id,quantity:15});
 assert.deepEqual(await recounts(f),[{campaign_id:main.campaign_id,first_quantity:'15',first_counter_id:first,recounter_id:second,automatic:true}]);
 const blind=await tasks.page(db,who(second),main.campaign_id);assert.equal(blind.rows.length,1);assert(!JSON.stringify(blind.rows).match(/before|first_quantity|cost/));
 await assert.rejects(tasks.page(db,who(first),main.campaign_id),/not assigned/);
 await tasks.record(db,who(second),main.campaign_id,{skuId:skuA,locationId:f.location.id,quantity:15});await runs.routine(db,ctx.workspaceId);await drain(f);
 assert.equal(await onHand(f,skuA,f.location.id),20,'A big difference waits for the owner');assert.equal((await recounts(f)).length,1,'Only one recount per position');assert.equal(await frozen(f,f.location.id),p.id);
 const plan=await annual.header(db,ctx,p.id),review=await runs.differences(db,ctx,plan),rowA=review.rows.find(r=>r.sku_id===skuA),rowB=review.rows.find(r=>r.sku_id===back.sku);
 assert.equal(rowA.status,'Needs your sign-off');assert.equal(rowA.valueMinor,-500);assert.equal(rowA.first_quantity,'15');assert.equal(rowB.status,'Posted');assert.equal(rowB.valueMinor,-100);assert.equal(review.totals.needsYou,1);assert.equal(review.totals.waitingMinor,-500);
 const [desk]=await render(f,['/autopilot/annual-stocktakes/'+p.id]);assert.match(desk,/Differences at cost/);assert.match(desk,/Needs your sign-off/);assert.match(desk,/Runs on its own/);assert.match(desk,/Approve differences and sign off/);
 // The owner's sign-off posts the big difference through the ledger and the books, then the freeze lifts.
 await assert.rejects(runs.approve(db,ctx,p.id,{revision:plan.revision,confirmed:'yes',reviewHash:'stale'}),/changed/);
 await runs.approve(db,ctx,p.id,{revision:plan.revision,confirmed:'yes',reviewHash:review.hash});assert.equal((await runs.approve(db,ctx,p.id,{revision:plan.revision,confirmed:'yes',reviewHash:review.hash})).replayed,true);await drain(f);
 const done=await annual.header(db,ctx,p.id);assert.equal(done.status,'SIGNED_OFF');assert.equal(done.signoff.ownerId,ctx.actorId);assert.equal(await onHand(f,skuA,f.location.id),15);assert.equal(await frozen(f,f.location.id),null);
 assert.equal(Number((await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,skuA,f.location.id])).rows[0].total_cost_minor),1500);
 assert.equal((await db.query("SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1 AND source_type='physical_count_review' AND source_record_id=ANY($2::text[])",[ctx.workspaceId,[main.campaign_id,bin.campaign_id]])).rows[0].n,2,'Both differences post to the books');
 const actions=await audits(f);for(const action of ['Yearly stocktake rule saved','Annual stocktake planned from the yearly rule','Annual stocktake freeze started on schedule','Annual stocktake recount requested on its own','Phone count posted under the count limit','Annual stocktake area reopened after its counts posted','Annual stocktake differences approved for posting','Annual stocktake signed off'])assert(actions.includes(action),action);
 // The next routine moves the rule to the same date next year.
 await runs.routine(db,ctx.workspaceId);assert.equal((await runs.rule(db,ctx.workspaceId)).count_day,(Number(f.today.slice(0,4))+1)+f.today.slice(4).replace('-02-29','-02-28'));assert.equal((await plans(f)).length,1);
 const [index,phone]=await render(f,['/autopilot/annual-stocktakes']);assert.match(index,/Next count/);assert.match(phone,/Save yearly stocktake/);
});

test('Starter is excluded; Growth gets a draft and runs each step itself; Custom plans ahead on its own and Ask me first holds the scheduled freeze',{timeout:420000},async t=>{
 const f=await setup(t,'starter'),{db,ctx}=f,skuA=f.item.skuIds[0];
 await assert.rejects(rule(f),/Growth/);assert.match((await render(f,['/autopilot/annual-stocktakes']))[0],/requires Growth/);
 await f.subscribe('growth');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await rule(f);await runs.routine(db,ctx.workspaceId);
 const [draft]=await plans(f);assert.equal(draft.status,'DRAFT');assert.equal(draft.automatic,false,'Growth prepares the plan for approval');
 assert((await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).some(r=>r.sourceId==='annual-stocktake-drafts'));
 await runs.routine(db,ctx.workspaceId);assert.equal((await annual.header(db,ctx,draft.id)).status,'DRAFT','Growth never freezes on its own');
 const h=await annual.header(db,ctx,draft.id);await annual.freeze(db,ctx,draft.id,{revision:h.revision,planHash:h.plan_hash,confirmed:'yes'});
 const [team]=await teamsOf(f,draft.id);await tasks.record(db,ctx,team.campaign_id,{skuId:skuA,locationId:f.location.id,quantity:15});
 assert.equal((await recounts(f)).length,0,'Growth never asks for a recount on its own');assert.equal(await onHand(f,skuA,f.location.id),20);
 let plan=await annual.header(db,ctx,draft.id);await runs.requestRecount(db,ctx,draft.id,{revision:plan.revision,locationId:f.location.id,confirmed:'yes'});
 assert.deepEqual((await recounts(f)).map(r=>[r.first_quantity,r.recounter_id,r.automatic]),[['15',ctx.actorId,false]],'The only counter recounts when nobody else can');
 await assert.rejects(runs.requestRecount(db,ctx,draft.id,{revision:plan.revision+1,locationId:f.location.id,confirmed:'yes'}),/fully counted/);
 await tasks.record(db,ctx,team.campaign_id,{skuId:skuA,locationId:f.location.id,quantity:16});
 const [text]=await render(f,['/autopilot/annual-stocktakes/'+draft.id]);assert.match(text,/Needs your sign-off/);assert.doesNotMatch(text,/Runs on its own/);
 const review=await signoff(f,draft.id);assert.equal(review.rows[0].delta,-4);assert.equal(review.rows[0].valueMinor,-400);
 assert.equal((await annual.header(db,ctx,draft.id)).status,'SIGNED_OFF');assert.equal(await onHand(f,skuA,f.location.id),16);assert.equal(await frozen(f,f.location.id),null);
 // Custom: the plan is prepared a day ahead to run on its own, and starts only on the count date.
 await f.subscribe('enterprise');const tomorrow=addDays(f.today,1);await rule(f,{countDate:tomorrow,noticeDays:'1',revision:(await runs.rule(db,ctx.workspaceId)).revision});await runs.routine(db,ctx.workspaceId);
 const custom=(await plans(f)).find(x=>x.request_key==='annual-rule:'+tomorrow);assert.equal(custom.automatic,true);assert.equal(custom.status,'DRAFT');
 await db.query('UPDATE stockchief_runtime.agent_annual_stocktakes SET count_date=$2::date WHERE id=$1',[custom.id,f.today]);
 await modes.save(db,ctx,16,{mode:'ask',revision:0});await runs.routine(db,ctx.workspaceId);
 let held=await annual.header(db,ctx,custom.id);assert.equal(held.status,'DRAFT');assert.match(held.problem,/Ask me first/);assert.equal(await frozen(f,f.location.id),null);
 await modes.save(db,ctx,16,{mode:'inherit',revision:1});await runs.routine(db,ctx.workspaceId);held=await annual.header(db,ctx,custom.id);assert.equal(held.status,'FROZEN');assert.equal(held.problem,null);
 assert((await audits(f)).includes('Annual stocktake freeze started on schedule'));
});

test('Shadow, pause, Watch, a counter without access, the count limit and a passed date stop the automatic stocktake and leave it to the owner',{timeout:420000},async t=>{
 const f=await setup(t,'pro',{aged:false}),{db,ctx}=f,skuA=f.item.skuIds[0],helper=await staff(f,'Only counter');
 await rule(f,{ruleCounterIds:[helper.actorId]});await runs.routine(db,ctx.workspaceId);
 assert.equal((await plans(f)).length,0);assert.match((await runs.rule(db,ctx.workspaceId)).last_issue,/14 days/,'Shadow mode only watches');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 await autopilot.pause(db,ctx,{role:'owner'},'Year-end check');assert.deepEqual(await runs.routine(db,ctx.workspaceId),{skipped:'paused'});assert.equal((await plans(f)).length,0);await autopilot.resume(db,ctx,{role:'owner'});
 await modes.save(db,ctx,16,{mode:'watch',revision:0});await runs.routine(db,ctx.workspaceId);assert.equal((await plans(f)).length,0);assert.match((await runs.rule(db,ctx.workspaceId)).last_issue,/Watch only/);
 await modes.save(db,ctx,16,{mode:'inherit',revision:1});
 await db.query("UPDATE users SET warehouse_location_ids='[]'::jsonb WHERE id=$1",[helper.actorId]);await runs.routine(db,ctx.workspaceId);
 assert.equal((await plans(f)).length,0);assert.match((await runs.rule(db,ctx.workspaceId)).last_issue,/access/,'A counter who cannot reach the area stops the plan');
 await db.query('UPDATE users SET warehouse_location_ids=$2::jsonb WHERE id=$1',[helper.actorId,JSON.stringify([f.location.id])]);await runs.routine(db,ctx.workspaceId);
 const [p]=await plans(f);assert.equal(p.status,'FROZEN');assert.equal((await runs.rule(db,ctx.workspaceId)).last_issue,null);
 // One unit short is not big, but $1.00 is over the owner's $0.50 count limit: it waits for sign-off.
 await require('../../src/autopilot/count-rules').configure(db,ctx,{mode:'automatic',limit:'0.50'});const [team]=await teamsOf(f,p.id);
 await tasks.record(db,{workspaceId:ctx.workspaceId,actorId:helper.actorId},team.campaign_id,{skuId:skuA,locationId:f.location.id,quantity:19});await drain(f);await runs.routine(db,ctx.workspaceId);await drain(f);
 assert.equal((await recounts(f)).length,0);assert.equal((await teamsOf(f,p.id))[0].agent_decision,null);assert.equal(await onHand(f,skuA,f.location.id),20);assert.equal(await frozen(f,f.location.id),p.id);
 const review=await signoff(f,p.id);assert.equal(review.rows[0].status,'Ready to post');assert.equal(review.rows[0].valueMinor,-100);
 assert.equal((await annual.header(db,ctx,p.id)).status,'SIGNED_OFF');assert.equal(await onHand(f,skuA,f.location.id),19);
 // A count date whose counting days passed before the plan existed stops and asks for a new date.
 await db.query("UPDATE stockchief_runtime.agent_annual_stocktake_rules SET count_date=$2::date,count_days=1 WHERE workspace_id=$1",[ctx.workspaceId,addDays(f.today,-10)]);await runs.routine(db,ctx.workspaceId);
 assert.equal((await plans(f)).length,1);assert.match((await runs.rule(db,ctx.workspaceId)).last_issue,/passed/);
});
