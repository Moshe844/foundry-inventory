'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');const {migratePostgres}=require('../../src/db/migrate-postgres');
const auth=require('../../src/domain/postgres-auth-service');
const store=require('../../src/assistant/postgres-goal-store');
const controller=require('../../src/assistant/postgres-goal-controller');
const assistant=require('../../src/assistant/postgres-service');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
function decision(action,extra={}){return {action,progress:'Checking the business records.',query:'',steps:[],answer:'',evidence:[],...extra};}
function step(capability,args={},dependsOn=[]){return {capability,arguments:Object.entries(args).map(([name,value])=>({name,value:String(value)})),dependsOn};}
function provider(queue,verify={complete:true,grounded:true,reason:''}){let calls=0;return {name:'anthropic',model:PRICED_MODEL,
 get calls(){return calls;},async complete(request){calls++;return {usage:pricedUsage(),data:['stockchief_adaptive_verification','stockchief_goal_authority_fit'].includes(request.schemaName)
 ?verify:queue.shift()||decision('ask',{answer:'What should I prioritize?'})};}};}
test('adaptive goal ownership, cost bounds, approvals, tenant isolation and recovery',{timeout:240000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);await migratePostgres(db);
 const previous={flag:process.env.STOCKCHIEF_ADAPTIVE_ASK,workspaces:process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES};
 t.after(async()=>{await db.close();cluster.stop();
  for(const [key,value]of [['STOCKCHIEF_ADAPTIVE_ASK',previous.flag],['STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES',previous.workspaces]])
   if(value===undefined)delete process.env[key];else process.env[key]=value;});
 const first=await auth.createBusiness(db,{businessName:'Adaptive Certification',name:'Owner',email:'adaptive@example.test',password:'certification-password'});
 const ctx={workspaceId:first.workspaceId,actorId:first.userId};
 const second=await auth.createBusiness(db,{businessName:'Other Business',name:'Owner',email:'other-adaptive@example.test',password:'certification-password'});
 const other={workspaceId:second.workspaceId,actorId:second.userId};
 process.env.STOCKCHIEF_ADAPTIVE_ASK='1';process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES=ctx.workspaceId;
 await t.test('discovers, investigates, verifies and meters a goal',async()=>{
  const model=provider([decision('discover',{query:'inventory_summary'}),decision('operate',{steps:[step('read.inventory_summary')]}),
   decision('finish',{answer:'There are no active products or units on hand.',evidence:[0]})]);
  const result=await assistant.ask(db,ctx,'How much stock is recorded?',{provider:model});assert.equal(result.goalStatus,'COMPLETED');
  const goal=await store.get(db,ctx,result.goalId);assert.equal(goal.turns,3);assert.equal(goal.tool_calls,3);
  assert.equal(await store.get(db,other,result.goalId),null);
  const costs=(await db.query('SELECT status,actual_minor FROM commercial_model_cost_holds WHERE goal_id=$1',[goal.id])).rows;
  assert.equal(costs.length,4);assert.ok(costs.every(c=>c.status==='SETTLED'&&Number(c.actual_minor)>0));
  assert.equal((await controller.run(db,ctx,goal.id,{provider:model})).goalStatus,'COMPLETED');assert.equal(model.calls,4);
 });
 await t.test('unknown tools cannot execute and strategy can recover',async()=>{
  const model=provider([decision('operate',{steps:[step('sql.execute',{query:'DELETE FROM items'})]}),
   decision('discover',{query:'inventory_summary'}),decision('operate',{steps:[step('read.inventory_summary')]}),
   decision('finish',{answer:'No units on hand are recorded.',evidence:[0]})]);
  const result=await assistant.ask(db,ctx,'Check recorded stock.',{provider:model});assert.equal(result.goalStatus,'COMPLETED');
  assert.equal((await store.get(db,ctx,result.goalId)).recoveries,1);
 });
 await t.test('an unsupported completion is rejected',async()=>{
  const model=provider([decision('discover',{query:'inventory_summary'}),decision('operate',{steps:[step('read.inventory_summary')]}),
   decision('finish',{answer:'I sent all supplier orders.',evidence:[0]})],{complete:false,grounded:false,reason:'No supplier order was sent.'});
  const result=await assistant.ask(db,ctx,'Send supplier orders.',{provider:model});assert.equal(result.goalStatus,'WAITING_USER');
  assert.ok((await store.get(db,ctx,result.goalId)).recoveries>0);
 });
 await t.test('invalid argument feedback names the actual contract and enables recovery',async()=>{
  const base=provider([decision('discover',{query:'read.inventory_positions'}),
   decision('operate',{steps:[step('read.inventory_positions',{skuId:'invented'})]}),
   decision('operate',{steps:[step('read.inventory_positions')]}),
   decision('finish',{answer:'No recorded inventory positions exist.',evidence:[0]})]);
  let repaired=false;const model={...base,async complete(request){
   if(request.schemaName==='stockchief_adaptive_goal'){
    const prompt=JSON.parse(request.prompt);if(prompt.feedback?.includes('invalidOrDuplicateField')){
     assert.match(prompt.feedback,/skuId/);assert.ok(prompt.tools.some(t=>t.name==='read.inventory_positions'));repaired=true;}}
   return base.complete(request);
  }};
  const result=await assistant.ask(db,ctx,'Inspect recorded inventory positions.',{provider:model});
  assert.equal(result.goalStatus,'COMPLETED');assert.equal(repaired,true);
  assert.equal((await store.get(db,ctx,result.goalId)).recoveries,1);
 });
 await t.test('the parent cost ceiling rejects before provider execution',async()=>{
  const model=provider([]);const result=await assistant.ask(db,ctx,'Check the stock.',{provider:model,budgetMinor:0.000001});
  assert.equal(result.goalStatus,'BLOCKED');assert.equal(model.calls,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM commercial_model_cost_holds WHERE goal_id=$1',[result.goalId])).rows[0].n,0);
 });
 await t.test('prepared business writes wait for explicit canonical approval',async()=>{
  const model=provider([decision('discover',{query:'catalog.create_item'}),decision('operate',{
   steps:[step('catalog.create_item',{search:'Copper Collar',baseCode:'COPPER-COLLAR'})]})]);
  const result=await assistant.ask(db,ctx,'Add Copper Collar with SKU COPPER-COLLAR.',{provider:model});
  assert.equal(result.goalStatus,'WAITING_APPROVAL');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM items WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
  const goal=await store.get(db,ctx,result.goalId);const proposal=goal.checkpoint.waiting.proposalIds[0];assert.ok(proposal);
  await assistant.executeProposal(db,ctx,proposal);
  const ready=await require('../../src/assistant/postgres-goal-resume').refresh(db,ctx,goal.id);assert.equal(ready.status,'READY');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM items WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
  assert.equal(ready.checkpoint.observations[0].result.proposalId,proposal);
 });
 await t.test('browser prepares a mission, approves once, resumes and verifies PostgreSQL state',async()=>{
  await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Browser Depot',kind:'warehouse'});
  const model=provider([decision('discover',{query:'catalog.create_item inventory.receive'}),decision('operate',{steps:[
   step('catalog.create_item',{search:'Browser Part',baseCode:'BR-8'}),
   step('inventory.receive',{sku:'BR-8',location:'Browser Depot',quantity:3,reference:'BROWSER-ARRIVAL'},[0])]}),
   decision('discover',{query:'inventory_summary'}),decision('operate',{steps:[step('read.inventory_summary')]}),
   decision('finish',{answer:'Browser Part is recorded and the three received units are on hand. There are two products in this business.',evidence:[0,1,2]})]);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'adaptive-certification-session-secret',aiProvider:model});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const browser=await require('playwright').chromium.launch({headless:true});
  try{
   const page=await browser.newPage();page.setDefaultTimeout(20000);const base=`http://127.0.0.1:${server.address().port}`;
   await page.goto(`${base}/login`);await page.locator('input[name="email"]').fill('adaptive@example.test');
   await page.locator('input[name="password"]').fill('certification-password');
   await Promise.all([page.waitForNavigation(),page.locator('button[type="submit"]').click()]);
   await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief',{exact:true}).fill(
    'Create Browser Part with SKU BR-8 and record three physically delivered units at Browser Depot against BROWSER-ARRIVAL.');
   await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue',exact:true}).click()]);
   const goal=await store.latest(db,ctx);assert.equal(goal.status,'READY');
   await require('../../src/operations/postgres-runtime-handlers').create(undefined,{aiProvider:model})['assistant.run-goal'](
    {workspaceId:ctx.workspaceId,payload:{actorId:ctx.actorId,goalId:goal.id}},db);
   await page.reload();await page.getByRole('link',{name:'Review prepared operation'}).first().click();
   await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve the whole mission'}).click()]);
   const mission=(await db.query('SELECT * FROM stockchief_runtime.assistant_capability_plans WHERE goal_id=$1',[goal.id])).rows[0];
   assert.equal(mission.status,'DONE');assert.equal(mission.metrics.approvalInteractions,1);
   assert.equal(Number((await db.query('SELECT sum(on_hand) AS n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),3);
   await require('../../src/assistant/postgres-goal-resume').refresh(db,ctx,goal.id);
   const result=await controller.run(db,ctx,goal.id,{provider:model});assert.equal(result.goalStatus,'COMPLETED');
   await page.reload();assert.match(await page.getByRole('region',{name:'Goal progress'}).innerText(),/Verified/);
   const status=await page.request.get(`${base}/ask/goals/${goal.id}`);assert.equal((await status.json()).status,'COMPLETED');
   const otherGoal=await store.create(db,other,'Private other business goal.');
   assert.equal((await page.request.get(`${base}/ask/goals/${otherGoal.id}`)).status(),404);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
 });
 await t.test('standing authority executes once and policy revocation prevents a second operation',async()=>{
  const autonomy=require('../../src/autopilot/postgres-service');const authority=require('../../src/assistant/postgres-goal-authority');
  const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  const sku=(await db.query("SELECT id FROM skus WHERE workspace_id=$1 AND code='BR-8'",[ctx.workspaceId])).rows[0];
  const {newId,nowIso}=require('../../src/lib/util');
  async function demand(name){const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name,kind:'store'});
   await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,0,1,0,'manual',$5,$5)`,[newId('rpol'),ctx.workspaceId,sku.id,location.id,nowIso()]);return location;}
  await autonomy.ensure(db,ctx.workspaceId);await demand('Standing Counter A');
  await autonomy.configureRoutine(db,ctx,actor,{transferEnabled:true,purchaseEnabled:false,maximumQuantity:2});
  let work=(await autonomy.plan(db,ctx.workspaceId)).created.find(w=>w.approval_requirement==='NONE');assert.ok(work);
  const goal=await store.create(db,ctx,'Carry out the recorded authorized stock transfer, without dispatch or receipt.');
  const claimed=await store.claim(db,ctx,goal.id);const scope={...ctx,goalId:goal.id,goalRunToken:claimed.run_token};
  const verify={verifyComplete:async()=>({data:{complete:true,grounded:true,reason:''}})};
  const result=await authority.execute(db,scope,{recordReference:work.id},{provider:verify,sourceMessage:goal.original_request});
  assert.equal(result.status,'ANSWERED');assert.equal(result.rows[0].outcome.physicalExecutionPending,true);
  await authority.execute(db,scope,{recordReference:work.id},{provider:verify,sourceMessage:goal.original_request});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM inventory_transfers WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
  await demand('Standing Counter B');work=(await autonomy.plan(db,ctx.workspaceId)).created.find(w=>w.approval_requirement==='NONE');assert.ok(work);
  const revoked=await authority.execute(db,scope,{recordReference:work.id},{sourceMessage:goal.original_request,provider:{verifyComplete:async()=>{
   await db.query('UPDATE automation_policies SET enabled=0 WHERE workspace_id=$1',[ctx.workspaceId]);
   return {data:{complete:true,grounded:true,reason:''}};}}});
  assert.equal(revoked.reason,'authority_changed');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM inventory_transfers WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
  assert.equal(Number((await db.query('SELECT sum(on_hand) AS n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),3);
  await store.cancel(db,ctx,goal.id);
 });
 await t.test('permission revocation during reasoning stops before a tool runs',async()=>{
  const raw=provider([]);const model={...raw,async complete(){
   await db.query("UPDATE users SET role='staff',permissions='[]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
   return {usage:pricedUsage(),data:decision('discover',{query:'connections'})};
  }};
  try{const result=await assistant.ask(db,ctx,'Inspect connected systems.',{provider:model});assert.equal(result.goalStatus,'BLOCKED');
   assert.equal((await store.get(db,ctx,result.goalId)).tool_calls,0);
  }finally{await db.query("UPDATE users SET role='owner',permissions='[]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);}
 });
 await t.test('parallel resumes acquire one durable lease',async()=>{
  const goal=await store.create(db,ctx,'Check current inventory.');const model=provider([decision('ask',{answer:'What outcome matters most?'})]);
  await Promise.all([controller.run(db,ctx,goal.id,{provider:model}),controller.run(db,ctx,goal.id,{provider:model})]);
  assert.equal(model.calls,1);assert.equal((await store.get(db,ctx,goal.id)).status,'WAITING_USER');
 });
 await t.test('goal-wide reservations serialize concurrent calls and retain uncertain exposure',async()=>{
  const goal=await store.create(db,ctx,'Check inventory within a small budget.',{budgetMinor:15});
  const scope=await require('../../src/commercial/entitlements').ownerScopeForWorkspace(db,ctx.workspaceId);
  const budget=require('../../src/commercial/model-cost-budget');const commercial=require('../../src/commercial/model');
  const request={system:'Check records.',prompt:'Inventory.',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false}};
  const outcomes=await Promise.allSettled(Array.from({length:8},(_,i)=>budget.reserve(db,scope,
   {name:'anthropic',model:PRICED_MODEL},request,commercial.POLICIES.ask,'ask',`${ctx.workspaceId}:concurrent-goal-${i}`,
   `${ctx.workspaceId}:concurrent-goal-${i}`,{goalId:goal.id,actorId:ctx.actorId})));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  const hold=outcomes.find(r=>r.status==='fulfilled').value;
  await budget.settle(db,scope,hold.idempotency_key);
  assert.equal((await db.query('SELECT status FROM commercial_model_cost_holds WHERE id=$1',[hold.id])).rows[0].status,'UNKNOWN');
  await assert.rejects(()=>budget.reserve(db,scope,{name:'anthropic',model:PRICED_MODEL},request,commercial.POLICIES.ask,'ask',
   `${ctx.workspaceId}:after-unknown`,`${ctx.workspaceId}:after-unknown`,{goalId:goal.id,actorId:ctx.actorId}),/cumulative model-cost ceiling/);
  await assert.rejects(()=>budget.reserve(db,scope,{name:'anthropic',model:PRICED_MODEL},request,commercial.POLICIES.ask,'ask',
   `${ctx.workspaceId}:cross-actor`,`${ctx.workspaceId}:cross-actor`,{goalId:goal.id,actorId:other.actorId}),/no longer authorized/);
 });
 await t.test('cancellation and kill switch prevent model calls',async()=>{
  const goal=await store.create(db,ctx,'Investigate replenishment.');await store.cancel(db,ctx,goal.id);
  const model=provider([]);assert.equal((await controller.run(db,ctx,goal.id,{provider:model})).goalStatus,'CANCELLED');
  process.env.STOCKCHIEF_ADAPTIVE_ASK='0';await controller.run(db,ctx,goal.id,{provider:model});assert.equal(model.calls,0);
 });
});
