'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('a changing read refreshes its evidence in the same native SDK thread once, within unchanged safety limits',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Changing read '+randomUUID(),email,password:randomUUID()+'!A'}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Before '+randomUUID(),kind:'warehouse'}),after='After '+randomUUID();
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:owner.businessName,emails:[email]})).environment);process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;
 await db.query("UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=1000000,approval_reference='OFFLINE FAKE PROVIDER ONLY' WHERE workspace_id=$1",[ctx.workspaceId]);await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store'),started=await pilot.start(db,ctx,'Tell me the current warehouse name without changing anything.');let calls=0,thread=null;
 const fake=async(_url,init)=>{const body=JSON.parse(init.body);
  if(body.text?.format?.name==='native_answer_scope_fit_v2')return Response.json({id:'offline-read-review',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({grounded:true,complete:true,missingOutcomes:[],reason:''})}]}],usage:{input_tokens:200,output_tokens:40,total_tokens:240}});
  calls++;assert(calls<=4);const goal=await store.get(db,ctx,started.goalId),h=goal.checkpoint.harness;
  if(!thread)thread=h.native.codex.threadId;else assert.equal(h.native.codex.threadId,thread);
  if(calls===3){assert.equal(h.verificationFailure.code,'CURRENT_RECORDS_CHANGED');assert.equal(h.verificationCorrections,1);assert(JSON.stringify(body).includes('host_verification_feedback'));}
  if(calls===1||calls===3)return require('../helpers/codex-offline-response')(body,calls,`text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:'read.locations',arguments:[],dependsOn:[]}])}));`);
  const entry=Object.values(h.evidence).findLast(e=>e.name==='business_operations'),observation=JSON.parse(entry.text),row=observation.outcomes[0].result.rows.find(r=>r.id===location.id);assert(row);
  if(calls===2)await db.query('UPDATE locations SET name=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,location.id,after]);
  return require('../helpers/codex-offline-response').final(body,calls,JSON.stringify({status:'completed',outcome:'answer',answer:'The warehouse is '+row.name+'.',claims:[{evidenceId:entry.id,path:'/outcomes/0/result/rows/0/name',value:row.name}]}));
 };
 assert(process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE);await pilot.run(db,ctx,started.goalId,{image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE,apiKey:'FAKE',fetchImpl:fake,countInput:async()=>({object:'response.input_tokens',input_tokens:200})});
 const done=await store.get(db,ctx,started.goalId);assert.equal(done.status,'COMPLETED',JSON.stringify({failure:done.checkpoint.harness.failure,verification:done.checkpoint.harness.verificationFailure}));assert.equal(done.answer,'The warehouse is '+after+'.');assert.equal(calls,4);assert.equal(done.checkpoint.harness.verificationCorrections,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);t.diagnostic(JSON.stringify({actualSdk:true,fakeProvider:true,currentReadRefreshed:true,sameThread:true,boundedCorrection:1,businessEffects:0,paidLiveCalls:0}));
});
