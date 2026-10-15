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
 const firstResult=await pilot.run(db,ctx,response.goalId,options),first=await store.get(db,ctx,response.goalId);
 assert.equal(first.status,'WAITING_APPROVAL',JSON.stringify({failure:first.checkpoint.harness?.failure,interruption:first.checkpoint.harness?.interruption,calls,answer:first.answer,returned:firstResult}));assert.equal(calls,1);
 const browserEvidence=Object.values(first.checkpoint.harness.evidence).find(e=>e.name==='environment_browser');
 assert.equal(new URL(JSON.parse(browserEvidence.text).url).pathname,'/inventory','Agent starts on the user page');
 const ready=await pilot.inbox(db,ctx,response.goalId);assert.equal(ready.approvals.length,1);
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1 AND reference=$2',[ctx.workspaceId,'OFFLINE-STAGING'])).rows[0].n,'0');
 const card=ready.approvals[0];await pilot.decide(db,ctx,response.goalId,card.id,card.sha256,true,{responseReference:'OFFLINE simulated website human approval'});
 const completed=await pilot.run(db,ctx,response.goalId,options);
 assert.equal(completed.status,'COMPLETED',JSON.stringify(completed.checkpoint.harness.failure));assert.equal(calls,3);
 assert.equal((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,variant.id,loc.id])).rows[0].on_hand,'3');
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1 AND reference=$2',[ctx.workspaceId,'OFFLINE-STAGING'])).rows[0].n,'1');
 const ledger=(await db.query('SELECT state FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 assert.equal(ledger.length,3);assert(ledger.every(c=>c.state==='SETTLED'));
 assert.equal(completed.checkpoint.harness.codexRequests,3);
 // A later record-only goal uses the same native SDK but creates no browser or
 // read-only renderer. Verify the actual lazy boundary, not just its wrapper.
 const inspection=require('../../scripts/environment-agent-demo/inspection'),originalInspection=inspection.createInspectionServer;
 let opened=0,readCalls=0;
 inspection.createInspectionServer=async(...args)=>{opened++;return originalInspection(...args);};
 try{
  const reading=await pilot.start(db,ctx,'Report current physical stock from the business records.');
  const read=await pilot.run(db,ctx,reading.goalId,{...options,fetchImpl:async(_url,init)=>{
   const body=JSON.parse(init.body);readCalls++;
   if(readCalls===1)return require('../helpers/codex-offline-response')(body,readCalls,
    `const d=ALL_TOOLS.find(t=>t.name.endsWith('__environment_dataset'));text(await tools[d.name](${JSON.stringify({specJson:JSON.stringify({dataset:'stock',columns:['sku','location','on_hand']}),offset:0})}));`);
   assert.equal(readCalls,2);
   const saved=await store.get(db,ctx,reading.goalId),entry=Object.values(saved.checkpoint.harness.evidence).findLast(e=>e.name==='environment_dataset');
   return require('../helpers/codex-offline-response').final(body,readCalls,JSON.stringify({status:'completed',outcome:'answer',answer:'Current physical stock is 3 units.',
    claims:[{evidenceId:entry.id,path:'/rows/0/on_hand',value:JSON.parse(entry.text).rows[0].on_hand}]}));
  }});
  assert.equal(read.status,'COMPLETED');assert.equal(opened,0);assert.equal(readCalls,2);
  const opening=await pilot.start(db,ctx,'Please bring me to the stock directory.');let navigationCalls=0;
  const navigation=await pilot.run(db,ctx,opening.goalId,{...options,fetchImpl:async(_url,init)=>{
   const body=JSON.parse(init.body);navigationCalls++;
   if(navigationCalls===1)return require('../helpers/codex-offline-response')(body,navigationCalls,
    `const t=ALL_TOOLS.find(t=>t.name.endsWith('__business_operations'));text(await tools[t.name](${JSON.stringify({stepsJson:JSON.stringify([{capability:'navigate.inventory',arguments:[],dependsOn:[]}])})}));`);
   assert.equal(navigationCalls,2);
   const saved=await store.get(db,ctx,opening.goalId),entry=Object.values(saved.checkpoint.harness.evidence).findLast(e=>e.name==='business_operations');
   const target=JSON.parse(entry.text).outcomes[0].result.navigation;
   return require('../helpers/codex-offline-response').final(body,navigationCalls,JSON.stringify({status:'completed',outcome:'navigation',answer:'Ready to open Inventory.',
    navigation:{evidenceId:entry.id,path:'/outcomes/0/result/navigation/href'},claims:[{evidenceId:entry.id,path:'/outcomes/0/result/navigation/href',value:target.href}]}));
  }});
  assert.equal(navigation.status,'WAITING_EVENT',JSON.stringify(navigation.checkpoint.harness.failure));
  assert.equal(navigation.checkpoint.navigation.href,'/inventory');assert.equal(opened,0);assert.equal(navigationCalls,2);
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
