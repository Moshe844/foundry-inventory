'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const recorded=require('../fixtures/policy-effect-fit-lifecycle.json');

// This exercises the REAL SDK with a synthetic provider, not autonomous model
// reasoning. The recorded negative reply must still fail closed. The positive
// fixture verifies the stage contract and the real durable approval/PG path;
// only a separately authorized live call can establish model interpretation.
test('policy fit reviews lasting effects without consuming the goal verification stage',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await db.close();cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,
  {name:'Offline owner',businessName:'Testing',email,password:'Fake!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';
 Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Testing',emails:[email]})).environment);
 process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;
 await db.query(`UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=500000,
  approval_reference='OFFLINE FAKE PROVIDER ONLY' WHERE workspace_id=$1`,[ctx.workspaceId]);
 await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'shoes',baseCode:'SHOES',trackingMode:'quantity'});
 const place=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Offline shelf',kind:'warehouse'});
 await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:item.skuIds[0],locationId:place.id,quantity:10,reference:'FIXTURE',idempotencyKey:'fixture-receipt'});
 // Independent fixture setup, never an operation available to the agent.
 await db.query(`INSERT INTO reorder_policies (id,workspace_id,sku_id,reorder_point,source,created_at,updated_at)
  VALUES($1,$2,$3,10,'manual',now(),now())`,['fixture-reorder',ctx.workspaceId,item.skuIds[0]]);
 const beforeReorder=(await db.query('SELECT * FROM reorder_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 const instructions=require('../../src/manager/postgres-operating-instructions');
 const countProposals=async()=>Number((await db.query('SELECT count(*) AS n FROM operating_instruction_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 function assertScope(input){
  assert.equal(input.ownerInstruction,recorded.ownerInstruction,'The full original goal, prohibitions and verification request remain intact');
  assert.equal(input.proposalLifecycle,'PENDING_UNTIL_SEPARATE_OWNER_APPROVAL');
  assert.equal(input.assessmentScope.kind,'ALL_REQUESTED_PERSISTENT_POLICY_EFFECTS');
  assert.equal(input.assessmentScope.stage,'PREPARATION');
  assert.equal(input.assessmentScope.lifecycleWorkComplete,false,'Deferring verification does not claim it happened');
  assert.equal(input.assessmentScope.requiresSeparateOwnerApproval,true);
  assert.match(input.assessmentScope.constraints,/channels, prohibitions and authority/);
 }
 await t.test('the exact recorded rejection still blocks all writes, rather than being ignored or relabeled safe',async()=>{
  let calls=0;
  const provider=require('../../src/commercial/relay-provider').register({name:'openai',model:'gpt-6.1-sol',complete:async request=>{
   calls++;assert.equal(request.schemaName,recorded.schemaName);assertScope(JSON.parse(request.prompt));
   return {data:recorded.recordedRejection};
  }});
  await assert.rejects(instructions.interpret(db,ctx,recorded.ownerInstruction,{provider,proposedChanges:recorded.changes}),
   e=>e.effectMayHaveOccurred===false&&e.message.includes(recorded.recordedRejection.difference));
  assert.equal(calls,1,'No helper retry hides a negative assessment');assert.equal(await countProposals(),0);
  assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.stock_threshold_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 });

 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store');
 const started=await pilot.start(db,ctx,recorded.ownerInstruction);
 let sdkCalls=0,checks=0,counted=0;
 const fake=async(_url,init)=>{
  const body=JSON.parse(init.body);
  if(body.text?.format?.type==='json_schema'&&!body.stream){
   checks++;assert.equal(body.text.format.name,recorded.schemaName);assertScope(JSON.parse(body.input[0].content));
   assert.match(body.instructions||'',/post-approval verification/);
   return Response.json({id:'offline-fit-'+checks,object:'response',status:'completed',model:body.model,
    output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({equivalent:true,difference:''})}]}],
    usage:{input_tokens:200,output_tokens:40,total_tokens:240}});
  }
  sdkCalls++;
  const response=require('../helpers/codex-offline-response');
  if(sdkCalls===1)return response(body,1,'text(await tools.mcp__stockchief__environment_interfaces({search:"",offset:0,names:["policy.propose"]}));text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:"read.operating_rules",arguments:[{name:"search",value:"shoes"}],dependsOn:[]},{capability:"read.inventory",arguments:[{name:"search",value:"shoes"}],dependsOn:[]}])}));');
  if(sdkCalls===2)return response(body,2,
   `text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:'policy.propose',arguments:[{name:'ruleChanges',value:${JSON.stringify(JSON.stringify(recorded.changes))}}],dependsOn:[]}])}));`);
  if(sdkCalls===3){
   const saved=await store.get(db,ctx,started.goalId);
   assert.equal(saved.original_request,recorded.ownerInstruction);
   assert.equal(saved.checkpoint.lifecycleStage,'verification');
   assert.match(saved.checkpoint.feedback,/verify the full original goal/);
   return response(body,3,'text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:"read.operating_rules",arguments:[{name:"search",value:"shoes"}],dependsOn:[]},{capability:"read.needs_you",arguments:[],dependsOn:[]}])}));');
  }
  assert.equal(sdkCalls,4,'One prepare and one verification continuation, no SDK retry');
  const saved=await store.get(db,ctx,started.goalId),entry=Object.values(saved.checkpoint.harness.evidence).findLast(e=>e.name==='business_operations');
  const evidence=JSON.parse(entry.text),rules=evidence.outcomes[0].result.rows,alerts=evidence.outcomes[1].result.rows;
  const ruleIndex=rules.findIndex(r=>r.kind==='stock_warning'&&r.sku==='SHOES');assert(ruleIndex>=0);
  const alertIndex=alerts.findIndex(r=>r.decision.includes('shoes')&&r.decision.includes('10 on hand'));assert(alertIndex>=0);
  return response.final(body,4,JSON.stringify({status:'completed',outcome:'answer',
   answer:'The approved warning is active, and its Needs You warning is present for the 10 physical units. The reorder setting is unchanged. No purchase or email was made.',
   claims:[{evidenceId:entry.id,path:`/outcomes/0/result/rows/${ruleIndex}/threshold`,value:10},
    {evidenceId:entry.id,path:`/outcomes/1/result/rows/${alertIndex}/decision`,value:alerts[alertIndex].decision}]}));
 };
 const options={image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE||JSON.parse(require('node:fs').readFileSync('data/environment-agent-demo/codex-operator-context-20261015/runtime.json')).image,
  apiKey:'FAKE',fetchImpl:fake,countInput:async()=>{counted++;return {object:'response.input_tokens',input_tokens:200};}};
 const first=await pilot.run(db,ctx,started.goalId,options);
 assert.equal(first.status,'WAITING_APPROVAL',JSON.stringify({status:first.status,answer:first.answer,failure:first.checkpoint.harness?.failure}));
 assert.equal(checks,1);assert.equal(sdkCalls,2);assert.equal(await countProposals(),1);
 const card=(await pilot.inbox(db,ctx,started.goalId)).approvals[0];assert(card);
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.stock_threshold_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 await pilot.decide(db,ctx,started.goalId,card.id,card.sha256,true,{responseReference:'OFFLINE simulated owner approval'});
 const ready=await store.get(db,ctx,started.goalId);assert.equal(ready.status,'READY');
 assert.equal(sdkCalls,2,'Delivering and executing approval needs no model response');
 const readAlerts=async()=>(await db.query("SELECT * FROM attention_items WHERE workspace_id=$1 AND category='stock_threshold' AND status='OPEN'",[ctx.workspaceId])).rows;
 const alerts=await readAlerts();assert.equal(alerts.length,1);assert.equal(JSON.parse(alerts[0].metrics).observed,10);
 const evaluation=await db.transaction(client=>require('../../src/manager/postgres-stock-threshold-alerts').evaluate(client,{workspaceId:ctx.workspaceId}));
 assert.equal(evaluation.alerted,0);assert.equal((await readAlerts()).length,1,'A later worker evaluation cannot duplicate the warning');
 await pilot.decide(db,ctx,started.goalId,card.id,card.sha256,true,{responseReference:'OFFLINE replay of same approved decision'});
 assert.equal((await readAlerts()).length,1,'Replayed approval has no duplicate effects');
 const final=await pilot.run(db,ctx,started.goalId,options);
 assert.equal(final.status,'COMPLETED',JSON.stringify({status:final.status,answer:final.answer,failure:final.checkpoint.harness?.failure}));
 assert.equal(checks,1);assert.equal(sdkCalls,4);assert.equal(counted,5);
 assert.deepEqual((await db.query('SELECT * FROM reorder_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows,beforeReorder);
 assert.equal(Number((await db.query('SELECT sum(on_hand) AS n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),10);
 for(const table of ['purchase_orders','customer_communications','supplier_communications'])
  assert.equal((await db.query(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].n,'0');
 assert.equal((await db.query('SELECT count(*) AS n FROM operating_instruction_proposals WHERE workspace_id=$1 AND status=\'APPROVED\'',[ctx.workspaceId])).rows[0].n,'1');
 assert(final.checkpoint.harness.native.codex,'The actual native thread survived the approval interruption');
 t.diagnostic(JSON.stringify({actualSdk:true,syntheticProvider:true,nativeCalls:sdkCalls,intentChecks:checks,approvalDeliveries:1,verifiedWarnings:1,duplicateWarnings:0,originalGoalRetained:true,paidCalls:0}));
});
