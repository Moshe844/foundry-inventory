'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto'),base='../../scripts/environment-agent-demo/';
const goals=require('../../src/assistant/postgres-goal-store'),wire=require(base+'codex-wire');
test('actual Codex SDK in network-none Docker: governed MCP, native restart, and compaction gate', {timeout:180000},async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-codex-integration-'));
 const out=path.resolve(process.env.STOCKCHIEF_CODEX_ARTIFACT_DIR||'data/environment-agent-demo/codex-sdk-sol-high');fs.mkdirSync(out,{recursive:true});
 const cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Offline runtime',businessName:'Codex transport',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const held=await goals.claim(db,ctx,(await goals.create(db,ctx,'Inspect the current application and report what is present.',{budgetMinor:75})).id);
 const gateway=require(base+'gateway').createGateway({database:db,ctx,goal:held.original_request,goalId:held.id,runToken:held.run_token,provider:{complete:async()=>{throw Error('NO_PAID_CALLS');}}});
 const session=require(base+'session').createSession({database:db,ctx,goalId:held.id,runToken:held.run_token,candidate:'codex',authorize:gateway.authorize});
 const budget=new (require(base+'budget').ExperimentBudget)(path.join(tmp,'budget.db'),'OFFLINE SDK CONTRACT');
 // Rates are seeded ONLY in this disposable database. No customer pricing,
 // operation cap, goal allowance or real experiment ledger is modified.
 for(const [operation,dollars]of Object.entries(wire.PROFILE.rates))
  await db.query(`INSERT INTO commercial_cost_rates(id,provider,model,provider_version,operation,unit,cost_per_unit_minor,currency,effective_from,source,pricing_basis,confidence)
   VALUES($1,'openai',$2,'responses-2026-10-11',$3,'token',$4,'USD',now(),$5,'VERIFIED_PUBLIC','HIGH')`,
   ['offline-codex-'+operation,wire.MODEL,operation,dollars/10000,wire.source]);
 const entitlements=require('../../src/commercial/entitlements'),scope=await entitlements.ownerScopeForWorkspace(db,ctx.workspaceId);
 await entitlements.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:ctx.workspaceId+':fake'});
 budget.approve({ceilingMicroUsd:5000000,approvalReference:'FAKE PROVIDER ONLY',expiresAt:new Date(Date.now()+180000).toISOString()});
 const events=[],requests=[];let resumed=false,countTokens=10000;const counts=[];
 const audit=e=>{events.push(e);fs.appendFileSync(path.join(out,'offline-trace.jsonl'),JSON.stringify(e)+'\n');};
 fs.writeFileSync(path.join(out,'offline-trace.jsonl'),'');
 const relay=await require(base+'relay').createRelay({budget,credentials:{openai:'FAKE'},audit,
  countCodexInput:async body=>{counts.push(body);return {object:'response.input_tokens',input_tokens:countTokens};},
  commercial:require(base+'commercial').createCommercialAccounting(db),
  fetchImpl:async(_url,init)=>{
   const body=JSON.parse(init.body);requests.push(body);fs.writeFileSync(path.join(out,'offline-native-requests.json'),JSON.stringify(requests,null,2));
   assert.equal(body.model,wire.MODEL);assert.equal(body.reasoning.effort,wire.EFFORT);
   const n=requests.length;const response=(_body,_n,_name,_input,answer)=>require('../helpers/codex-offline-response').final(_body,_n,answer);
   if(n===1){
    assert(body.input.some(i=>i.type==='additional_tools'));
    return require('../helpers/codex-offline-response')(body,n,`const e=ALL_TOOLS.find(t=>t.name.endsWith('__environment_evidence'));text(await tools[e.name]({id:'absent-offline-evidence',offset:0}));const t=ALL_TOOLS.find(t=>t.name.endsWith('__environment_browser'));if(!t)throw Error('Browser unavailable');text(await tools[t.name]({action:'click',ref:'expired-offline-handle',value:null}));text(await tools[t.name]({action:'inspect',ref:null,value:null}));`);
   }
   if(!resumed){
    assert(body.input.some(i=>i.type==='custom_tool_call_output'));
    const h=(await goals.get(db,ctx,held.id)).checkpoint.harness,entry=Object.values(h.evidence).findLast(e=>e.name==='environment_browser'),observation=JSON.parse(entry.text);assert(observation.url);
    // Synthetic provider tests only the real SDK's new lossless wire contract;
    // it is never reported as evidence of live-model business intelligence.
    const report={version:2,status:'completed',outcome:'answer',answer:'Offline SDK transport observed the application.',question:null,missingInformation:[],tier:null,reason:null,
     claims:[{evidenceId:entry.id,historical:false,values:[{path:'/url',value:observation.url}]}],navigation:null,workProducts:[],nextActions:[]};
    assert(new(require('ajv'))({strict:false}).compile(require(base+'codex-report').schema)(report));
    return response(body,n,null,null,JSON.stringify(report));
   }
   if(n===3)assert(JSON.stringify(body.input).includes('Offline SDK transport observed the application.'),'native JSONL history survives a new container');
   if(n===4){assert(JSON.stringify(body.input).includes('CONTEXT CHECKPOINT COMPACTION'));return response(body,n,null,null,'Offline native compaction summary: the application was observed; durable evidence is available from environment_evidence.');}
   if(n===5)assert(JSON.stringify(body.input).includes('Offline native compaction summary:'),'native compacted history must reach the next inference');
   return response(body,n,null,null,'Offline SDK native continuation retained the earlier observation.');
  }});
 const transport=relay.grant({candidate:'codex',provider:'openai',task:'offline',goalId:held.id,ctx,fundingKey:'fake',authorize:gateway.authorize,
  wireProfile:'codex',requestGate:()=>session.codexRequest()});
 const inspection=await require(base+'inspection').createInspectionServer({cluster,database:db,ctx});
 const chromium=await require('playwright').chromium.launch({headless:true});
 const browser=await require(base+'browser').createBrowserTools(chromium,{origin:inspection.origin,audit});
 t.after(async()=>{await browser.close();await chromium.close();await inspection.close();await relay.close();budget.close();await db.close();await cluster.stop();fs.rmSync(tmp,{recursive:true,force:true});});
 const image=JSON.parse(fs.readFileSync(path.join(out,'runtime.json'))).image;
 const options={session,transport,budget,gateway,browser,codexImage:image,audit,offlineOnly:true,credentials:{openai:'FAKE'}};
 process.env.STOCKCHIEF_CODEX_SDK_DEMO='1';t.after(()=>{delete process.env.STOCKCHIEF_CODEX_SDK_DEMO;});
 const first=await require(base+'codex-runtime').run(options);
 assert(first.answer.includes('observed'));assert.equal(requests.length,2);
 assert.equal(JSON.parse(first.answer).version,1);assert.equal(JSON.parse(first.answer).claims.length,1);assert.equal(typeof JSON.parse(first.answer).claims[0].value,'string');
 const cp=(await goals.get(db,ctx,held.id)).checkpoint.harness;
 assert(cp.native.codex.threadId);assert(Object.keys(cp.native.codex.files).length);assert.equal(cp.codexRequests,2);
 assert.equal(Object.values(cp.evidence).length,2);assert(Object.values(cp.evidence)[0].text.includes('STALE_BROWSER_REFERENCE'));
 assert(!cp.progress,'bespoke repeat controller is absent');assert(!cp.native.openaiHistory);
 resumed=true;
 const second=await require(base+'codex-runtime').run({...options,resumeContext:'Describe the observation already made.'});
 assert.equal(second.threadId,first.threadId);assert.equal(requests.length,3);
 // Trigger Codex's OWN compactor on its native restored history. No made-up
 // compact HTTP packet and no replacement summary algorithm in StockChief.
 const compacted=await require(base+'codex-runtime').run({...options,offlineCompact:true});
 assert.equal(compacted.threadId,first.threadId);assert.equal(requests.length,5);assert.equal(counts.length,5);
 for(let i=0;i<requests.length;i++)assert.deepEqual(wire.countRequest(requests[i]),counts[i]);
 const charges=(await db.query('SELECT model,status,maximum_minor,actual_minor FROM commercial_model_cost_holds WHERE goal_id=$1',[held.id])).rows;
 assert.equal(charges.length,5);assert(charges.every(h=>h.model===wire.MODEL&&h.status==='SETTLED'&&Number(h.maximum_minor)<=30));
 assert.equal((await goals.get(db,ctx,held.id)).checkpoint.harness.codexRequests,5,'native compaction counts as a model request');
 const journalAfterCompaction=await session.evidenceIndex();assert.equal(journalAfterCompaction.length,2);
 assert.equal((await session.evidence({id:journalAfterCompaction[0].id,offset:0})).sha256,journalAfterCompaction[0].sha256);
 // The real commercial layer must refuse an over-cap count before generation.
 countTokens=(300000-3000*wire.PRICES.output)/wire.PRICES.input+1;
 await assert.rejects(()=>require(base+'codex-runtime').run(options));
 assert.equal(transport.lastBlock().limitKind,'operation_cost');assert.equal(requests.length,5);
 for(let i=7;i<=24;i++)assert.equal((await session.codexRequest()).request,i);
 await assert.rejects(()=>session.codexRequest(),/DURABLE_MODEL_REQUEST_LIMIT/);
 // Tenant / actor resumption is checked by the durable store, not by thread ID.
 const other=require(base+'session').createSession({database:db,ctx:{...ctx,workspaceId:'other-tenant'},goalId:held.id,runToken:held.run_token,candidate:'codex',authorize:async()=>({})});
 await assert.rejects(()=>other.load(),/LEASE/);
 const reports={mode:'OFFLINE_SYNTHETIC_PROVIDER',paidCalls:0,nativeSdk:wire.VERSION,requestedModel:wire.MODEL,effort:wire.EFFORT,
  actualPaidModel:null,providerCalls:requests.length,nativeThreadResumed:first.threadId===second.threadId,
  browserToolCalls:events.filter(e=>e.kind==='agent_tool_completed'&&e.name==='environment_browser').length,
  durableEvidenceCount:Object.keys(cp.evidence).length,nativeCompactionMetered:true,countEndpointMode:'FAKE_OFFLINE',
  commercialHolds:charges,commercialOversizeBlocked:true,tenantResumeBlocked:true,
  firstRequestBound:wire.normalize(requests[0]),commercialCapUsd:require('../../src/commercial/model-cost-budget').operationLimit('ask')};
 delete reports.firstRequestBound.body;
 fs.writeFileSync(path.join(out,'offline-result.json'),JSON.stringify(reports,null,2));
 // Requests include exact native instructions/history; report only hashes/bounds
 // in the summary. The artifact above is local, isolated test data only.
 assert.equal(events.filter(e=>e.kind==='agent_tool_failed').length,1,'an evidence retrieval error is recoverable inside native code mode');
 assert.equal((await goals.get(db,ctx,held.id)).tool_calls,3);
 await goals.cancel(db,ctx,held.id);
});
