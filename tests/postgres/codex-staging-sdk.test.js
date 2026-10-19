'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('actual Staging SDK lifecycle uses the real renderer, website approval and PostgreSQL verification with an offline provider',{timeout:240000},async t=>{
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
 const sku='STAGING-'+randomUUID().slice(0,8),location='SDK shelf '+randomUUID().slice(0,6);
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:sku,baseCode:sku,trackingMode:'quantity'});
 const loc=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:location,kind:'warehouse'});
 const variant=(await db.query('SELECT id,code FROM skus WHERE item_id=$1',[item.itemId])).rows[0];
 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store');
 await require('../../src/assistant/postgres-service').ask(db,ctx,'Open suppliers tab');
 const response=await pilot.start(db,ctx,`Receive 3 ${variant.code} at ${location}, reference OFFLINE-STAGING, after approval, then verify the current stock.`,{page:{path:'/inventory'}});
 const steps=[{capability:'inventory.receive',arguments:[{name:'sku',value:variant.code},{name:'location',value:location},{name:'quantity',value:3},{name:'reference',value:'OFFLINE-STAGING'}],dependsOn:[]}];
 let calls=0;
 const fake=async(_url,init)=>{const body=JSON.parse(init.body);calls++;
  if(calls===1){assert(JSON.stringify(body).includes('Open suppliers tab'),'Native SDK receives the preceding conversation');
   assert(JSON.stringify(body).includes('User application context'),'Native SDK receives the page context');
   assert(JSON.stringify(body).includes(require('../../scripts/environment-agent-demo/codex-operator-instructions').trim().split('\n')[0]),'Actual SDK loads the business operator base instructions');
   assert(!JSON.stringify(body).includes('### Writing PR descriptions'),'Repository/PR instructions are not injected into a new business session');
   return require('../helpers/codex-offline-response')(body,calls,
   `const b=ALL_TOOLS.find(t=>t.name.endsWith('__environment_browser'));text(await tools[b.name]({action:'inspect',ref:null,value:null}));const op=ALL_TOOLS.find(t=>t.name.endsWith('__business_operations'));text(await tools[op.name](${JSON.stringify({stepsJson:JSON.stringify(steps)})}));`);
  }
  if(calls===2)return require('../helpers/codex-offline-response')(body,calls,
   `const d=ALL_TOOLS.find(t=>t.name.endsWith('__environment_dataset'));text(await tools[d.name](${JSON.stringify({specJson:JSON.stringify({dataset:'stock',columns:['sku','location','on_hand']}),offset:0})}));`);
  assert.equal(calls,3,'No extra model continuation');
  const goal=await store.get(db,ctx,response.goalId),entry=Object.values(goal.checkpoint.harness.evidence).findLast(e=>e.name==='environment_dataset');
  const evidence=JSON.parse(entry.text);
  return require('../helpers/codex-offline-response').final(body,calls,JSON.stringify({status:'completed',outcome:'answer',answer:'The approved receipt is recorded. Current stock is 3 units.',
   claims:[{evidenceId:entry.id,path:'/rows/0/on_hand',value:evidence.rows[0].on_hand}]}));
 };
 const options={image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE||JSON.parse(require('node:fs').readFileSync('data/environment-agent-demo/codex-sdk-approval-handoff/runtime.json')).image,
  apiKey:'FAKE',fetchImpl:fake,countInput:async()=>({object:'response.input_tokens',input_tokens:200})};
 const reviewResponse=body=>Response.json({id:'offline-read-review',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({grounded:true,reason:''})}]}],usage:{input_tokens:200,output_tokens:40,total_tokens:240}});
 const firstResult=await pilot.run(db,ctx,response.goalId,options),first=await store.get(db,ctx,response.goalId);
 assert.equal(first.status,'WAITING_APPROVAL',JSON.stringify({failure:first.checkpoint.harness?.failure,interruption:first.checkpoint.harness?.interruption,calls,answer:first.answer,returned:firstResult}));assert.equal(calls,1);
 const browserEvidence=Object.values(first.checkpoint.harness.evidence).find(e=>e.name==='environment_browser');
 assert.equal(new URL(JSON.parse(browserEvidence.text).url).pathname,'/inventory','Agent starts on the user page');
 const ready=await pilot.inbox(db,ctx,response.goalId);assert.equal(ready.approvals.length,1);
 assert.equal(first.checkpoint.harness.native.codex.instructionsProfile,'stockchief-operator-v1');
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1 AND reference=$2',[ctx.workspaceId,'OFFLINE-STAGING'])).rows[0].n,'0');
 const card=ready.approvals[0];await pilot.decide(db,ctx,response.goalId,card.id,card.sha256,true,{responseReference:'OFFLINE simulated website human approval'});
 const completed=await pilot.run(db,ctx,response.goalId,options);
 assert.equal(completed.status,'COMPLETED',JSON.stringify(completed.checkpoint.harness.failure));assert.equal(calls,3);
 assert.equal((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,variant.id,loc.id])).rows[0].on_hand,'3');
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1 AND reference=$2',[ctx.workspaceId,'OFFLINE-STAGING'])).rows[0].n,'1');
 const ledger=(await db.query('SELECT state FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 assert.equal(ledger.length,3);assert(ledger.every(c=>c.state==='SETTLED'));
 assert.equal(completed.checkpoint.harness.codexRequests,3);
 assert.equal(completed.checkpoint.harness.native.codex.instructionsProfile,'stockchief-operator-v1','Approval resumption retains the original instruction profile');
 // Produce a real older SDK journal using the unchanged, previously certified
 // image and a fake provider. Its missing profile field is the exact legacy
 // persistence shape. The new image must resume it without changing its base.
 const legacy=await pilot.start(db,ctx,'Help identify which warehouse a private report should describe.');
 const legacyImage=process.env.STOCKCHIEF_OFFLINE_LEGACY_CODEX_IMAGE||'sha256:e07529d8e4052730eb42398b482a7b624f554f5164575eb0eb35ecdf4117cc1e';
 let legacyCalls=0;
 const oldQuestion=await pilot.run(db,ctx,legacy.goalId,{...options,image:legacyImage,fetchImpl:async(_url,init)=>{
  legacyCalls++;const body=JSON.parse(init.body);assert(JSON.stringify(body).includes('### Writing PR descriptions'));
  return require('../helpers/codex-offline-response').final(body,legacyCalls,JSON.stringify({status:'needs_user',question:'Which warehouse should the report describe?',missingInformation:['warehouse'],claims:[]}));
 }});
 assert.equal(oldQuestion.status,'WAITING_USER',JSON.stringify({failure:oldQuestion.checkpoint.harness?.failure,calls:legacyCalls,answer:oldQuestion.answer}));
 await db.query("UPDATE stockchief_runtime.assistant_goals SET checkpoint=checkpoint#-'{harness,native,codex,instructionsProfile}' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,legacy.goalId]);
 await store.reply(db,ctx,legacy.goalId,location);
 const legacyResumed=await pilot.run(db,ctx,legacy.goalId,{...options,fetchImpl:async(_url,init)=>{
  const body=JSON.parse(init.body);
  if(body.text?.format?.name==='native_answer_scope_fit'){const input=JSON.parse(body.input[0].content);assert(input.clarifications.includes(location));assert(input.proposedAnswer.includes(location));assert(input.proposedAnswer.includes('Testing'));return reviewResponse(body);}
  legacyCalls++;assert(JSON.stringify(body).includes('### Writing PR descriptions'),'An existing thread keeps its previously recorded base instructions');
  const current=await store.get(db,ctx,legacy.goalId),entry=Object.values(current.checkpoint.harness.evidence).findLast(e=>e.name==='authorized_environment');
  return require('../helpers/codex-offline-response').final(body,legacyCalls,JSON.stringify({status:'completed',outcome:'answer',answer:'The report for '+location+' belongs to Testing.',claims:[{evidenceId:entry.id,path:'/business/name',value:'Testing'}]}));
 }});
 assert.equal(legacyResumed.status,'COMPLETED',JSON.stringify(legacyResumed.checkpoint.harness.failure));
 assert.equal(legacyResumed.checkpoint.harness.native.codex.instructionsProfile,'codex-default');assert.equal(legacyCalls,2);
 // A later record-only goal uses the same native SDK but creates no browser or
 // read-only renderer. Verify the actual lazy boundary, not just its wrapper.
 const inspection=require('../../scripts/environment-agent-demo/inspection'),originalInspection=inspection.createInspectionServer;
 let opened=0,readCalls=0;
 inspection.createInspectionServer=async(...args)=>{opened++;return originalInspection(...args);};
 try{
  const reading=await pilot.start(db,ctx,'Report current physical stock from the business records.');
  const read=await pilot.run(db,ctx,reading.goalId,{...options,fetchImpl:async(_url,init)=>{
   const body=JSON.parse(init.body);
   if(body.text?.format?.name==='native_answer_scope_fit'){const input=JSON.parse(body.input[0].content);assert.equal(input.proposedAnswer,'Current physical stock is 3 units.');assert(input.evidence.some(e=>e.observation.rows?.some(r=>Number(r.on_hand)===3)));return reviewResponse(body);}
   readCalls++;
   if(readCalls===1)return require('../helpers/codex-offline-response')(body,readCalls,
    `const d=ALL_TOOLS.find(t=>t.name.endsWith('__environment_dataset'));text(await tools[d.name](${JSON.stringify({specJson:JSON.stringify({dataset:'stock',columns:['sku','location','on_hand']}),offset:0})}));`);
   assert.equal(readCalls,2);
   const saved=await store.get(db,ctx,reading.goalId),entry=Object.values(saved.checkpoint.harness.evidence).findLast(e=>e.name==='environment_dataset');
   return require('../helpers/codex-offline-response').final(body,readCalls,JSON.stringify({status:'completed',outcome:'answer',answer:'Current physical stock is 3 units.',
    claims:[{evidenceId:entry.id,path:'/rows/0/on_hand',value:JSON.parse(entry.text).rows[0].on_hand}]}));
  }});
  assert.equal(read.status,'COMPLETED',JSON.stringify({answer:read.answer,readCalls,interruption:read.checkpoint?.harness?.interruption}));assert.equal(opened,0);assert.equal(readCalls,2);
  // Actual SDK terminal files survive a host verification failure. A later
  // explicit website resume must reverify/deliver them even when reasoning
  // limits are exhausted, with no provider, counter or SDK sandbox startup.
  const native=require('../../scripts/environment-agent-demo/codex-runtime'),profile=require('../../src/assistant/codex-model-routing').selected(read,ctx);
  assert(native.savedFinal(read.checkpoint.harness,{profile,messages:[]}));
  assert.equal(native.savedFinal(read.checkpoint.harness,{profile,messages:['A new human decision']}),null);
  assert.equal(native.savedFinal({...read.checkpoint.harness,inflight:{name:'uncertain'}},{profile,messages:[]}),null);
  assert.equal(native.savedFinal({...read.checkpoint.harness,lastCodexResponse:{...read.checkpoint.harness.lastCodexResponse,terminal:false}},{profile,messages:[]}),null);
  assert.equal(native.savedFinal({...read.checkpoint.harness,codexDelivery:{...read.checkpoint.harness.codexDelivery,state:'PENDING'}},{profile,messages:[]}),null);
  assert.equal(native.savedFinal({...read.checkpoint.harness,native:{codex:{...read.checkpoint.harness.native.codex,digest:'tampered'}}},{profile,messages:[]}),null);
  const ledgerBefore=(await db.query('SELECT count(*) AS n,coalesce(sum(charged),0) AS charged FROM stockchief_runtime.codex_pilot_calls WHERE goal_id=$1',[reading.goalId])).rows[0];
  await db.query(`UPDATE stockchief_runtime.assistant_goals SET status='BLOCKED',tool_calls=30,
   checkpoint=jsonb_set(checkpoint,'{harness,codexRequests}','24') WHERE id=$1`,[reading.goalId]);
  await pilot.resume(db,ctx,reading.goalId);
  const delivered=await pilot.run(db,ctx,reading.goalId,{...options,
   fetchImpl:async()=>{throw Error('COMPLETED_REASONING_MUST_NOT_CALL_PROVIDER');},
   countInput:async()=>{throw Error('COMPLETED_REASONING_MUST_NOT_COUNT_AGAIN');},
   sandboxPool:{take:()=>{throw Error('COMPLETED_REASONING_MUST_NOT_START_SDK');}}});
  assert.equal(delivered.status,'COMPLETED',JSON.stringify(delivered.checkpoint.harness.failure));
  assert.equal(delivered.checkpoint.harness.codexRequests,24);assert.equal(delivered.tool_calls,30);assert.equal(opened,0);
  assert.deepEqual((await db.query('SELECT count(*) AS n,coalesce(sum(charged),0) AS charged FROM stockchief_runtime.codex_pilot_calls WHERE goal_id=$1',[reading.goalId])).rows[0],ledgerBefore);
  const recorded=require('../fixtures/codex-navigation-empty-claims.json');
  const opening=await pilot.start(db,ctx,recorded.request);let navigationCalls=0;
  const navigation=await pilot.run(db,ctx,opening.goalId,{...options,fetchImpl:async(_url,init)=>{
   const body=JSON.parse(init.body);navigationCalls++;
   if(navigationCalls===1)return require('../helpers/codex-offline-response')(body,navigationCalls,
    `const t=ALL_TOOLS.find(t=>t.name.endsWith('__environment_interfaces'));text(await tools[t.name]({search:'',names:['navigate.suppliers'],offset:0}));`);
   if(navigationCalls===2)return require('../helpers/codex-offline-response')(body,navigationCalls,
    `const t=ALL_TOOLS.find(t=>t.name.endsWith('__business_operations'));text(await tools[t.name](${JSON.stringify({stepsJson:JSON.stringify([{capability:'navigate.suppliers',arguments:[],dependsOn:[]}])})}));`);
   assert.equal(navigationCalls,3);
   const saved=await store.get(db,ctx,opening.goalId),entry=Object.values(saved.checkpoint.harness.evidence).findLast(e=>e.name==='business_operations');
   assert.equal(JSON.parse(entry.text).outcomes[0].result.navigation.href,'/suppliers');
   const report={...recorded.report,navigation:{...recorded.report.navigation,evidenceId:entry.id}};
   const verification=require('../../src/assistant/postgres-codex-verification');
   const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
   const catalogue=await require('../../src/assistant/postgres-control-plane').planningCatalogue(db,ctx,actor);
   assert.equal((await verification.verify(db,ctx,saved,JSON.stringify(report),catalogue)).verified,true,'The actual live final contains its own navigation evidence');
   assert.equal((await verification.verify(db,ctx,saved,JSON.stringify({...report,outcome:'answer'}),catalogue)).verified,false,'Factual answers still need claims');
   assert.equal((await verification.verify(db,ctx,saved,JSON.stringify({...report,navigation:{...report.navigation,evidenceId:'invented'}}),catalogue)).verified,false,'Navigation cannot invent evidence');
   assert.equal((await verification.verify(db,ctx,saved,JSON.stringify(report),{get:()=>null,list:()=>[]})).verified,false,'Current navigation authority is required even without factual claims');
   return require('../helpers/codex-offline-response').final(body,navigationCalls,JSON.stringify(report));
  }});
  assert.equal(navigation.status,'WAITING_EVENT',JSON.stringify(navigation.checkpoint.harness.failure));
  assert.equal(navigation.checkpoint.navigation.href,'/suppliers');assert.equal(opened,0);assert.equal(navigationCalls,3);
 }finally{inspection.createInspectionServer=originalInspection;}
 // A standard background mission worker must not inherit the configured
 // provider and spend outside this native goal's shared relay ledger.
 const missionId='offline-continuation-'+randomUUID();
 await db.query(`INSERT INTO stockchief_runtime.assistant_capability_plans
  (id,workspace_id,actor_user_id,batch_id,source_message,steps,status,goal_id)
  VALUES($1,$2,$3,$4,$5,'[]'::jsonb,'DONE',$6)`,[missionId,ctx.workspaceId,ctx.actorId,missionId,completed.original_request,completed.id]);
 const plans=require('../../src/assistant/postgres-capability-plans'),originalResume=plans.resume;
 let helperCalls=0;
 try{plans.resume=async(_db,_ctx,_proposal,options)=>{
   await assert.rejects(options.rawProvider.complete({}),/UNAPPROVED_HELPER_MODEL_CALL/);
   return {blocked:true};
  };
  await require('../../src/assistant/postgres-service').resumeMission(db,ctx,missionId,
   {provider:{name:'unfunded-helper',model:'unfunded',complete:async()=>{helperCalls++;}}});
 }finally{plans.resume=originalResume;}
 assert.equal(helperCalls,0,'Background continuations cannot bypass the native shared spending gate');
 assert.equal((await db.query("SELECT count(*) AS n FROM pg_roles WHERE rolname LIKE 'demo_read_%' OR rolname LIKE 'demo_metrics_%'")).rows[0].n,'0','Temporary renderer privileges are removed');
});
