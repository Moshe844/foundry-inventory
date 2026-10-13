'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('recorded zero-argument rule call completes through budgeted helpers, approval and real warning evaluation offline',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await db.close();cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'SDK Staging owner',businessName:'Testing',email,password:'Fake!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};process.env.STOCKCHIEF_RUNTIME_ENV='staging';
 Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Testing',emails:[email]})).environment);
 process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;
 await db.query(`UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=500000,
  approval_reference='OFFLINE FAKE PROVIDER ONLY' WHERE workspace_id=$1`,[ctx.workspaceId]);
 await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const codes=['ALPHA-'+randomUUID().slice(0,6),'BETA-'+randomUUID().slice(0,6)];
 const items=[];for(const code of codes)items.push(await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:code,baseCode:code,trackingMode:'quantity'}));
 const place=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Test shelf',kind:'warehouse'});
 const inventory=require('../../src/domain/postgres-inventory-engine');
 for(const item of items)await inventory.receive(db,ctx,{skuId:item.skuIds[0],locationId:place.id,quantity:10,reference:'FIXTURE',idempotencyKey:item.itemId});
 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store');
 const original='Set up a warning whenever one of my products falls below 10 units, and make sure the warning actually works.';
 const response=await pilot.start(db,ctx,original);
 let sdkCalls=0,helperCalls=0,counted=0;
 const change=code=>({domain:'stock_alert',operation:'set',sku:code,supplier:'',location:'',sourceLocation:'',reorderPoint:-1,targetStock:-1,safetyStock:-1,leadTimeDays:-1,unitsPerPurchaseUnit:-1,minimumOrderQuantity:-1,orderMultiple:-1,maximumQuantity:-1,maximumValue:-1,weeklyValue:-1,daysOfStock:-1,preferTransferBeforePurchasing:false,guardMode:'',guardComparator:'',guardThreshold:-1,guardReleaseCondition:'',notificationThreshold:10,notificationMetric:'on_hand',notificationComparator:'below',capabilityName:''});
 const fake=async(_url,init)=>{
  const body=JSON.parse(init.body);assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.reasoning.effort,'high');
  if(body.text?.format?.type==='json_schema'){
   helperCalls++;assert.equal(body.max_output_tokens,3000);
   const input=JSON.parse(body.input[0].content);let data;
   if(body.text.format.name==='postgres_operating_instruction'){
    assert.equal(input.instruction,original);assert.equal(input.realSkus.length,2);
    data={understood:true,summary:'Stock warnings',changes:codes.map(change),clarifyingQuestion:'',unsupportedReason:''};
   }else {assert.equal(body.text.format.name,'postgres_operating_instruction_effect_fit');assert.equal(input.ownerInstruction,original);assert.equal(input.enforcedEffects.length,2);assert(input.enforcedEffects.every(e=>e.includes('below 10 physically on hand')));data={equivalent:true,difference:''};}
   return Response.json({id:'helper-'+helperCalls,object:'response',status:'completed',model:body.model,
    output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(data)}]}],usage:{input_tokens:200,output_tokens:40,total_tokens:240}});
  }
  sdkCalls++;
  if(sdkCalls===1)return require('../helpers/codex-offline-response')(body,sdkCalls,
   'text(await tools.mcp__stockchief__environment_browser({action:"inspect",ref:null,value:null}));text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:"policy.propose",arguments:[],dependsOn:[]}])}));');
  if(sdkCalls===2)return require('../helpers/codex-offline-response')(body,sdkCalls,
   'text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:"read.operating_rules",arguments:[],dependsOn:[]}])}));');
  assert.equal(sdkCalls,3);
  const current=await store.get(db,ctx,response.goalId),entry=Object.values(current.checkpoint.harness.evidence).findLast(e=>e.name==='business_operations');
  const evidence=JSON.parse(entry.text);
  return require('../helpers/codex-offline-response').final(body,sdkCalls,JSON.stringify({status:'completed',answer:'The approved stock warnings are active for both existing products.',claims:[{evidenceId:entry.id,path:'/outcomes/0/result/status',value:evidence.outcomes[0].result.status}]}));
 };
 const options={image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE||JSON.parse(require('node:fs').readFileSync('data/environment-agent-demo/codex-sdk-approval-handoff/runtime.json')).image,
  apiKey:'FAKE',fetchImpl:fake,countInput:async()=>{counted++;return {object:'response.input_tokens',input_tokens:200};}};
 const first=await pilot.run(db,ctx,response.goalId,options);
 assert.equal(first.status,'WAITING_APPROVAL',JSON.stringify(first));assert.equal(helperCalls,2);assert.equal(sdkCalls,1);
 const saved=await store.get(db,ctx,response.goalId);
 assert.equal(saved.checkpoint.harness.codexDelivery.packet.outcome.tool,true,'Helper did not overwrite native SDK delivery');
 assert.equal(saved.checkpoint.harness.helperDelivery.state,'SETTLED');
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.stock_threshold_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 const cards=(await pilot.inbox(db,ctx,response.goalId)).approvals;assert.equal(cards.length,1);
 const card=cards[0];await pilot.decide(db,ctx,response.goalId,card.id,card.sha256,true,{responseReference:'OFFLINE simulated owner approval'});
 const rules=(await db.query('SELECT * FROM stockchief_runtime.stock_threshold_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 assert.equal(rules.length,2);assert(rules.every(r=>Number(r.threshold)===10&&r.comparator==='below'&&r.metric==='on_hand'&&r.armed));
 const alerts=require('../../src/manager/postgres-stock-threshold-alerts');
 assert.equal((await alerts.evaluate(db,{workspaceId:ctx.workspaceId})).alerted,0,'Exactly ten does not trigger below ten');
 await inventory.issue(db,ctx,{skuId:items[0].skuIds[0],locationId:place.id,quantity:1,reasonCode:'other',reference:'OFFLINE-BOUNDARY',idempotencyKey:'offline-rule-crossing'});
 assert.equal((await alerts.evaluate(db,{workspaceId:ctx.workspaceId})).alerted,1);
 assert.equal((await alerts.evaluate(db,{workspaceId:ctx.workspaceId})).alerted,0,'Repeated evaluation does not duplicate warning');
 assert.equal((await db.query("SELECT count(*) AS n FROM attention_items WHERE workspace_id=$1 AND category='stock_threshold' AND status='OPEN'",[ctx.workspaceId])).rows[0].n,'1');
 const completed=await pilot.run(db,ctx,response.goalId,options);
 assert.equal(completed.status,'COMPLETED',JSON.stringify(completed));assert.equal(sdkCalls,3);assert.equal(helperCalls,2);assert.equal(counted,5);
 const ledger=(await db.query('SELECT state,charged FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 assert.equal(ledger.length,5);assert(ledger.every(c=>c.state==='SETTLED'));
 assert.equal(completed.checkpoint.harness.codexRequests,5,'Helpers share the unchanged native turn ceiling');
 assert.equal((await db.query('SELECT count(*) AS n FROM commercial_model_cost_holds WHERE goal_id=$1',[response.goalId])).rows[0].n,'5','One hold per request, no double reservation');
 t.diagnostic(JSON.stringify({sdkCalls,helperCalls,counted,proposals:1,approvedRules:2,warningCount:1,actualProviderSpend:0,syntheticLedgerMicroUsd:ledger.reduce((n,c)=>n+Number(c.charged),0)}));
 await t.test('exact live clarification is delivered as a question without a helper retry or uncertain write',async()=>{
  const recorded=require('../fixtures/staging-rule-clarification.json');
  const pending=await pilot.start(db,ctx,original);let native=0,helpers=0;
  const fakeClarification=async(_url,init)=>{const body=JSON.parse(init.body);
   if(body.text?.format?.type==='json_schema'){
    helpers++;assert.equal(helpers,1,'A valid missing-information response must not buy a retry');
    return Response.json({id:'recorded-helper',object:'response',status:'completed',model:body.model,
     output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(recorded.data)}]}],usage:{input_tokens:200,output_tokens:40,total_tokens:240}});
   }
   if(++native===1)return require('../helpers/codex-offline-response')(body,1,'text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:"policy.propose",arguments:[],dependsOn:[]}])}));');
   assert.equal(native,2);return require('../helpers/codex-offline-response').final(body,2,JSON.stringify({status:'needs_user',question:recorded.data.clarifyingQuestion,missingInformation:'Product scope and stock measure'}));
  };
  const result=await pilot.run(db,ctx,pending.goalId,{...options,fetchImpl:fakeClarification});
  assert.equal(result.status,'WAITING_USER',JSON.stringify(result));assert.equal(result.answer,recorded.data.clarifyingQuestion);
  assert.equal(helpers,1);assert.equal(result.checkpoint.harness.inflight,null);
  assert.equal((await pilot.inbox(db,ctx,pending.goalId)).approvals.length,0);
  assert.equal((await db.query('SELECT count(*) AS n FROM operating_instruction_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'1','Only the earlier complete approved proposal exists');
  const reply='Cover '+codes.join(' and ')+' using physical on-hand units.';
  await store.reply(db,ctx,pending.goalId,reply);
  let resumeHelpers=0;
  const resume=async(_url,init)=>{const body=JSON.parse(init.body);
   if(body.text?.format?.type==='json_schema'){
    resumeHelpers++;const input=JSON.parse(body.input[0].content);
    assert((input.instruction||input.ownerInstruction).includes(reply),'Canonical interpretation receives the authenticated owner clarification');
    const data=body.text.format.name==='postgres_operating_instruction'?{understood:true,summary:'Stock warnings',changes:codes.map(change),clarifyingQuestion:'',unsupportedReason:''}:{equivalent:true,difference:''};
    return Response.json({id:'clarified-'+resumeHelpers,object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(data)}]}],usage:{input_tokens:200,output_tokens:40,total_tokens:240}});
   }
   return require('../helpers/codex-offline-response')(body,3,'text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:"policy.propose",arguments:[],dependsOn:[]}])}));');
  };
  const resumed=await pilot.run(db,ctx,pending.goalId,{...options,fetchImpl:resume});
  assert.equal(resumed.status,'WAITING_APPROVAL',JSON.stringify(resumed));assert.equal(resumeHelpers,2);
  assert.equal((await pilot.inbox(db,ctx,pending.goalId)).approvals.length,1,'A real clarification resumes to approval without replaying the old question');
 });
});
