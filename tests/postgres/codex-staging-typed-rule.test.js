'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('embedded SDK prepares discovered typed rules with one intent check and canonical approval offline',{timeout:240000},async t=>{
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
 const codes=['ONE-'+randomUUID().slice(0,6),'TWO-'+randomUUID().slice(0,6)],items=[];
 for(const code of codes)items.push(await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:code,baseCode:code,trackingMode:'quantity'}));
 const place=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Typed shelf',kind:'warehouse'});
 const inventory=require('../../src/domain/postgres-inventory-engine');
 for(const item of items)await inventory.receive(db,ctx,{skuId:item.skuIds[0],locationId:place.id,quantity:10,reference:'FIXTURE',idempotencyKey:item.itemId});
 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store');
 const original='Set up a warning whenever one of my products falls below 10 units, and make sure the warning actually works.';
 const changes=codes.map(sku=>({domain:'stock_alert',operation:'set',sku,notificationThreshold:10,notificationMetric:'on_hand',notificationComparator:'below'}));
 assert(JSON.stringify(changes).length<2000,'Existing argument-size ceiling is unchanged');
 assert.deepEqual(require('../../src/assistant/postgres-capability-registry').registry.get('policy.propose').fields,[],'Existing Ask retains its original planner contract');
 const started=await pilot.start(db,ctx,original);let sdkCalls=0,checks=0,counted=0;
 const fake=async(_url,init)=>{const body=JSON.parse(init.body);
  if(body.text?.format?.type==='json_schema'){
   assert.equal(body.text.format.name,'postgres_operating_instruction_effect_fit','No second model reinterpretation of the goal');checks++;
   const input=JSON.parse(body.input[0].content);assert.equal(input.ownerInstruction,original);assert.equal(input.enforcedEffects.length,2);
   return Response.json({id:'fit-'+checks,object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({equivalent:true,difference:''})}]}],usage:{input_tokens:200,output_tokens:40,total_tokens:240}});
  }
  sdkCalls++;
  if(sdkCalls===1)return require('../helpers/codex-offline-response')(body,1,
   `text(await tools.mcp__stockchief__environment_interfaces({search:'',offset:0,names:['policy.propose']}));text(await tools.mcp__stockchief__environment_browser({action:'inspect',ref:null,value:null}));text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:'policy.propose',arguments:[{name:'ruleChanges',value:${JSON.stringify(JSON.stringify(changes))}}],dependsOn:[]}])}));`);
  if(sdkCalls===2)return require('../helpers/codex-offline-response')(body,2,'text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:"read.operating_rules",arguments:[],dependsOn:[]}])}));');
  assert.equal(sdkCalls,3);
  const goal=await store.get(db,ctx,started.goalId),entry=Object.values(goal.checkpoint.harness.evidence).findLast(e=>e.name==='business_operations'),evidence=JSON.parse(entry.text);
  return require('../helpers/codex-offline-response').final(body,3,JSON.stringify({status:'completed',answer:'The approved stock warnings are active for both existing products.',claims:[{evidenceId:entry.id,path:'/outcomes/0/result/status',value:evidence.outcomes[0].result.status}]}));
 };
 const options={image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE||JSON.parse(require('node:fs').readFileSync('data/environment-agent-demo/codex-sdk-approval-handoff/runtime.json')).image,apiKey:'FAKE',fetchImpl:fake,countInput:async()=>{counted++;return {object:'response.input_tokens',input_tokens:200};}};
 const first=await pilot.run(db,ctx,started.goalId,options);assert.equal(first.status,'WAITING_APPROVAL',JSON.stringify(first));assert.equal(checks,1);assert.equal(sdkCalls,1);
 const prepared=await store.get(db,ctx,started.goalId),discovery=Object.values(prepared.checkpoint.harness.evidence).find(e=>e.name==='environment_interfaces');
 const contract=JSON.parse(discovery.text).operations[0];assert(contract.fields.ruleChanges.jsonSchema.items.properties.domain.enum.includes('stock_alert'));
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.stock_threshold_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 const card=(await pilot.inbox(db,ctx,started.goalId)).approvals[0];await pilot.decide(db,ctx,started.goalId,card.id,card.sha256,true,{responseReference:'OFFLINE owner approval'});
 const rules=(await db.query('SELECT * FROM stockchief_runtime.stock_threshold_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows;assert.equal(rules.length,2);assert(rules.every(r=>Number(r.threshold)===10&&r.comparator==='below'&&r.metric==='on_hand'));
 const alerts=require('../../src/manager/postgres-stock-threshold-alerts');assert.equal((await alerts.evaluate(db,{workspaceId:ctx.workspaceId})).alerted,0);
 await inventory.issue(db,ctx,{skuId:items[0].skuIds[0],locationId:place.id,quantity:1,reasonCode:'other',reference:'BOUNDARY',idempotencyKey:'typed-boundary'});
 assert.equal((await alerts.evaluate(db,{workspaceId:ctx.workspaceId})).alerted,1);assert.equal((await alerts.evaluate(db,{workspaceId:ctx.workspaceId})).alerted,0);
 const completed=await pilot.run(db,ctx,started.goalId,options);assert.equal(completed.status,'COMPLETED',JSON.stringify(completed));assert.equal(checks,1);assert.equal(sdkCalls,3);assert.equal(counted,4);
 assert.equal((await db.query('SELECT count(*) AS n FROM commercial_model_cost_holds WHERE goal_id=$1',[started.goalId])).rows[0].n,'4');
 await t.test('typed proposals cannot inject a tenant, omit the stock measure or substitute purchasing authority',async()=>{
  const claim=await store.claim(db,ctx,(await store.create(db,ctx,original)).id);let fitCalls=0;
  const provider=require('../../src/commercial/relay-provider').register({name:'openai',model:'gpt-6.1-sol',complete:async request=>{assert.equal(request.schemaName,'postgres_operating_instruction_effect_fit');fitCalls++;return {data:{equivalent:false,difference:'Automatic purchasing was not requested.'}};}});
  await assert.rejects(require('../../src/manager/postgres-operating-instructions').interpret(db,ctx,original+' '.repeat(2000)+'Never grant purchasing authority.',{provider,proposedChanges:changes}),e=>e.effectMayHaveOccurred===false);assert.equal(fitCalls,0,'Owner constraints cannot be silently truncated');
  const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:original,goalId:claim.id,runToken:claim.run_token,provider});
  const invoke=value=>gateway.operate({steps:[{capability:'policy.propose',arguments:[{name:'ruleChanges',value:JSON.stringify(value)}],dependsOn:[]}]});
  await assert.rejects(invoke([{...changes[0],workspaceId:'foreign'}]),e=>e.effectMayHaveOccurred===false);assert.equal(fitCalls,0);
  await assert.rejects(invoke([{...changes[0],notificationMetric:undefined}]),e=>e.effectMayHaveOccurred===false);assert.equal(fitCalls,0);
  await require('../../src/operations/postgres-commerce').createSupplier(db,ctx,{name:'Test supplier'});
  await assert.rejects(invoke([{domain:'purchase_authority',operation:'set',supplier:'Test supplier',maximumValue:5000,weeklyValue:15000}]),e=>e.effectMayHaveOccurred===false);assert.equal(fitCalls,1);
  assert.equal((await db.query('SELECT count(*) AS n FROM operating_instruction_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'1');
 });
 t.diagnostic(JSON.stringify({sdkCalls,intentChecks:checks,extractionCalls:0,counted,approvedRules:2,warningAt10:0,warningAt9:1,duplicateWarnings:0,paidProviderSpend:0}));
});
