'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib'),{randomUUID,createHash}=require('node:crypto');
test('the actual recorded native compaction limit stays funded, reports its cause, and resumes the same journal through native compaction',{timeout:240000},async t=>{
 const recordedPath=process.env.STOCKCHIEF_RECORDED_COMPACTION_GOAL;
 assert(recordedPath,'This integration regression requires the private recorded native goal; never substitute a small invented history.');
 const recorded=JSON.parse(fs.readFileSync(recordedPath)),original=recorded.checkpoint.harness,fixture=require('../fixtures/codex-compaction-output-limit.json');
 assert.equal(original.lastCodexResponse.stopReason,fixture.reason);assert.equal(original.codexRequests,fixture.priorModelRequests);assert.equal(recorded.tool_calls,fixture.priorToolCalls);
 assert.equal(original.codexDelivery.hash,fixture.nativeRequestSha256);assert.equal(original.codexDelivery.state,'SETTLED');
 const responseBody=zlib.gunzipSync(Buffer.from(original.codexDelivery.packet.bodyGzip,'base64')).toString('utf8');
 const terminal=responseBody.split('\n').filter(l=>l.startsWith('data:')).map(l=>{try{return JSON.parse(l.slice(5));}catch{return null;}}).find(e=>e?.type==='response.incomplete');
 assert.equal(terminal.response.usage.input_tokens,fixture.inputTokens);assert.equal(terminal.response.usage.output_tokens,fixture.outputTokens);
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-native-compaction-'));
 const previousDemo=process.env.STOCKCHIEF_CODEX_SDK_DEMO;process.env.STOCKCHIEF_CODEX_SDK_DEMO='1';let relay,budget;
 t.after(async()=>{if(relay)await relay.close();if(budget)budget.close();await db.close();cluster.stop();fs.rmSync(tmp,{recursive:true,force:true});if(previousDemo===undefined)delete process.env.STOCKCHIEF_CODEX_SDK_DEMO;else process.env.STOCKCHIEF_CODEX_SDK_DEMO=previousDemo;});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Compaction regression owner',businessName:'Compaction regression '+randomUUID(),email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},base='../../scripts/environment-agent-demo/';
 const store=require('../../src/assistant/postgres-goal-store'),request='Retrieve the original saved observation after native context compaction without changing business records.';
 let held=await store.claim(db,ctx,(await store.create(db,ctx,request,{budgetMinor:100})).id),session,gateway;
 const journalEntry=Object.values(original.evidence).findLast(e=>e.name==='environment_browser');assert(journalEntry&&journalEntry.text.length);
 let retrieved=false;
 function attach(){gateway=require(base+'gateway').createGateway({database:db,ctx,goal:request,goalId:held.id,runToken:held.run_token});
  session=require(base+'session').createSession({database:db,ctx,goalId:held.id,runToken:held.run_token,candidate:'codex',authorize:gateway.authorize,
   verifyOutcome:async()=>retrieved?{complete:true,answer:'The original saved observation is durably retrievable after native compaction. No business records changed.',evidence:[{id:journalEntry.id,sha256:journalEntry.sha256}]}:{complete:false}});}
 attach();await session.load();await session.checkpoint({codex:original.native.codex});
 await db.query(`UPDATE stockchief_runtime.assistant_goals SET tool_calls=$2,checkpoint=jsonb_set(checkpoint,'{harness}',(checkpoint->'harness')||$3::jsonb) WHERE id=$1`,[held.id,fixture.priorToolCalls,JSON.stringify({sequence:original.sequence,evidence:original.evidence,codexRequests:fixture.priorModelRequests})]);
 const policy=require(base+'codex-wire').forProfile(original.native.codex.profile);
 for(const[operation,dollars]of Object.entries(policy.PROFILE.rates))await db.query(`INSERT INTO commercial_cost_rates(id,provider,model,provider_version,operation,unit,cost_per_unit_minor,currency,effective_from,source,pricing_basis,confidence)
 VALUES($1,'openai',$2,'responses-2026-10-11',$3,'token',$4,'USD',now(),$5,'VERIFIED_PUBLIC','HIGH')`,['compact-'+operation,policy.MODEL,operation,dollars/10000,policy.source]);
 const ent=require('../../src/commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(db,ctx.workspaceId);await ent.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:ctx.workspaceId+':offline-compact'});
 budget=new(require(base+'budget').ExperimentBudget)(path.join(tmp,'budget.db'),'OFFLINE RECORDED COMPACTION ONLY');budget.approve({ceilingMicroUsd:1000000,approvalReference:'FAKE PROVIDER ONLY',expiresAt:new Date(Date.now()+240000).toISOString()});
 const requests=[],audits=[];let compactions=0;
 relay=await require(base+'relay').createRelay({budget,credentials:{openai:'FAKE'},commercial:require(base+'commercial').createCommercialAccounting(db),countCodexInput:async()=>({object:'response.input_tokens',input_tokens:fixture.inputTokens}),audit:e=>audits.push(e),fetchImpl:async(_url,init)=>{
  const body=JSON.parse(init.body);requests.push(body);assert.equal(body.model,policy.MODEL);assert.equal(body.max_output_tokens,3000);
  if(requests.length<=2){compactions++;const last=JSON.stringify(body.input.at(-1));assert(last.includes('CONTEXT CHECKPOINT COMPACTION'));
   if(requests.length===1)assert(!last.includes('at most 1,000 tokens'),'Reproduce the original image/default compaction prompt before applying the repair');
   else{assert(last.includes('at most 1,000 tokens'));assert(last.includes('environment_evidence'));assert(last.includes('Do not copy document bodies'));}
   if(requests.length===1)return new Response(responseBody,{headers:{'content-type':'text/event-stream'}});
   return require('../helpers/codex-offline-response').final(body,2,'Original goal: retrieve the saved observation without business changes. Full prior facts and field references remain in environment_evidence. Next: retrieve evidence '+journalEntry.id+'. Nothing has been approved or executed.');
  }
  assert.equal(requests.length,3);
  assert(JSON.stringify(body.input).includes('Full prior facts and field references remain in environment_evidence'));
  return require('../helpers/codex-offline-response')(body,3,`const result=await tools.mcp__stockchief__environment_evidence({id:${JSON.stringify(journalEntry.id)},offset:0});text(result);`);
 }});
 function transport(){const tr=relay.grant({candidate:'codex',provider:'openai',task:held.id,ctx,goalId:held.id,fundingKey:'offline-compact',authorize:()=>gateway.authorize(),wireProfile:'codex',codexPolicy:policy,requestGate:()=>session.codexRequest()});tr.setNativeSession(session);return tr;}
 const browser={get started(){return false;}},image=process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE,oldImage=process.env.STOCKCHIEF_OFFLINE_CODEX_BASE_IMAGE;assert(image&&oldImage&&image!==oldImage);
 const run=(tr,codexImage)=>require(base+'worker').run({candidate:'codex',session,gateway,browser,transport:tr,budget,codexPolicy:policy,codexImage,offlineOnly:true,offlineCompact:true,credentials:{openai:'FAKE'},audit:e=>audits.push(e)});
 const tr1=transport(),stopped=await run(tr1,oldImage);assert.equal(stopped.interruption.code,'CODEX_OUTPUT_TOKEN_LIMIT');assert.equal(requests.length,1,'No automatic paid continuation after an incomplete response');assert.equal((await store.get(db,ctx,held.id)).status,'BLOCKED');
 const before=await store.get(db,ctx,held.id),thread=before.checkpoint.harness.native.codex.threadId,budgetBefore=before.budget_minor;assert.equal(before.checkpoint.harness.codexRequests,fixture.priorModelRequests+1);assert.equal(before.checkpoint.harness.interruption.code,'CODEX_OUTPUT_TOKEN_LIMIT');
 // Explicit offline operator resumption: preserve every counter and journal.
 await db.query("UPDATE stockchief_runtime.assistant_goals SET status='READY',run_token=NULL,lease_until=NULL WHERE id=$1 AND status='BLOCKED'",[held.id]);held=await store.claim(db,ctx,held.id);attach();
 const evidenceBefore=await session.evidence({id:journalEntry.id,offset:0}),originalEvidence=session.evidence;
 session.evidence=async input=>{const result=await originalEvidence(input);if(input.id===journalEntry.id){assert.equal(result.sha256,evidenceBefore.sha256);retrieved=true;}return result;};
 const tr2=transport(),replay=await fetch(tr2.openaiBaseURL+'/responses',{method:'POST',headers:{authorization:'Bearer '+tr2.token,'content-type':'application/json'},body:JSON.stringify(requests[0])});
 assert.equal(replay.status,200);assert.equal(await replay.text(),responseBody);assert.equal(requests.length,1);assert.equal((await store.get(db,ctx,held.id)).checkpoint.harness.codexRequests,fixture.priorModelRequests+1);assert(audits.some(e=>e.kind==='codex_response_replayed'));
 const finished=await run(tr2,image),after=await store.get(db,ctx,held.id);
 assert(retrieved,JSON.stringify({result:finished,requests:requests.length,tools:audits.filter(e=>/agent_tool_(started|failed)/.test(e.kind))}));assert.equal(after.status,'COMPLETED',JSON.stringify(finished));assert.equal(finished.completionSource,'host_verified_receipt');assert.equal(after.checkpoint.harness.native.codex.threadId,thread);assert.equal(after.budget_minor,budgetBefore);
 assert.equal(requests.length,3);assert.equal(compactions,2);assert.equal(after.checkpoint.harness.codexRequests,fixture.priorModelRequests+3);assert.equal(after.tool_calls,fixture.priorToolCalls+1);assert.equal(after.checkpoint.harness.evidence[journalEntry.id].sha256,evidenceBefore.sha256);
 await assert.rejects(session.evidence({id:journalEntry.id,offset:0}),/Goal is not held by this agent run/,'Completion must revoke the old run’s tool authority');
 const holds=(await db.query('SELECT status,maximum_minor FROM commercial_model_cost_holds WHERE goal_id=$1',[held.id])).rows;assert.equal(holds.length,3);assert(holds.every(h=>h.status==='SETTLED'&&Number(h.maximum_minor)<=30));
 for(const table of ['movements','accounting_supplier_bills','accounting_payments','stockchief_runtime.assistant_action_proposals'])assert.equal(Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].n),0);
 t.diagnostic(JSON.stringify({actualSdk:true,actualRecordedNativeHistory:true,actualRecordedIncompleteResponse:true,nativeCompactionPromptVerified:true,originalFailureClassified:true,automaticRetry:false,resumedSameThread:true,preservedJournalSha256:evidenceBefore.sha256,modelRequests:3,limitsRaised:false,paidCalls:0}));
});
