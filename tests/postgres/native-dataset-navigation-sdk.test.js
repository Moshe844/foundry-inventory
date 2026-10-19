'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('actual Codex SDK opens a governed report link absent from its starting screen through the restricted browser',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Report reader',businessName:'Testing',email,password:'Fixture!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Testing',emails:[email]})).environment);process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;
 await db.query("UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=500000,approval_reference='OFFLINE FAKE PROVIDER ONLY' WHERE workspace_id=$1",[ctx.workspaceId]);await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const product=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Report-only product '+randomUUID(),baseCode:randomUUID(),trackingMode:'quantity'});
 await db.query('UPDATE items SET is_active=0 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,product.itemId]);
 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store'),started=await pilot.start(db,ctx,'Inspect the reported record without changing anything.');let calls=0,proof;
 function find(v){if(typeof v==='string'){try{const hit=find(JSON.parse(v));if(hit)return hit;}catch{}const match=v.match(/LINK_PROOF=(\{[^\r\n]*\})/);if(match)return JSON.parse(match[1]);}else if(v&&typeof v==='object')for(const child of Object.values(v)){const hit=find(child);if(hit)return hit;}return null;}
 const fake=async(_url,init)=>{const body=JSON.parse(init.body);
  if(body.text?.format?.name==='native_answer_scope_fit'){
   const input=JSON.parse(body.input[0].content);assert.equal(input.proposedAnswer,'The reported product is '+proof.product+'.');assert(input.evidence.some(e=>e.observation.rows?.some(r=>r.product===proof.product)));
   return Response.json({id:'offline-report-review',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({grounded:true,reason:''})}]}],usage:{input_tokens:200,output_tokens:40,total_tokens:240}});
  }
  calls++;
  if(calls===1)return require('../helpers/codex-offline-response')(body,calls,
   `const envelope=await tools.mcp__stockchief__environment_dataset({specJson:JSON.stringify({dataset:'catalogue',columns:['product','status','product_status','variant_status']}),offset:0});if(envelope.isError)throw Error('READ_FAILED');const report=JSON.parse(envelope.content[0].text);const row=report.rows[0];const opened=await tools.mcp__stockchief__environment_browser({action:'open',ref:null,value:row.href});const screen=JSON.parse(opened.content[0].text);text('LINK_PROOF='+JSON.stringify({evidenceId:report._stockchiefEvidence.evidenceId,product:row.product,url:screen.url,httpStatus:screen.httpStatus,error:screen.error}));`);
  assert.equal(calls,2);proof=find(body.input);assert(proof);assert(!proof.error,JSON.stringify(proof.error));assert.equal(new URL(proof.url).pathname,'/inventory/'+product.itemId);assert.equal(proof.httpStatus,200);
  return require('../helpers/codex-offline-response').final(body,calls,JSON.stringify({version:1,status:'completed',outcome:'answer',answer:'The reported product is '+proof.product+'.',claims:[{evidenceId:proof.evidenceId,path:'/rows/0/product',value:proof.product}]}));
 };
 assert(process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE);await pilot.run(db,ctx,started.goalId,{image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE,apiKey:'FAKE',fetchImpl:fake,countInput:async()=>({object:'response.input_tokens',input_tokens:200})});
 const done=await store.get(db,ctx,started.goalId);assert.equal(done.status,'COMPLETED',JSON.stringify({answer:done.answer,failure:done.checkpoint.harness?.failure}));assert.equal(calls,2);
 const observation=Object.values(done.checkpoint.harness.evidence).find(e=>e.name==='environment_browser');assert.equal(new URL(JSON.parse(observation.text).url).pathname,'/inventory/'+product.itemId);
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 t.diagnostic(JSON.stringify({actualSdkAndMcp:true,realRestrictedBrowser:true,fakeProviderCalls:calls,paidCalls:0,notModelIntelligenceCertification:true,exactReportLinkAdmitted:true}));
});
