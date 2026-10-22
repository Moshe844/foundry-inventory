'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('actual SDK read-only delivery checks scope, preserves reference correction and resumes settled review without more spending',{timeout:180000},async t=>{
 assert.match(process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE||'',/^sha256:[a-f0-9]{64}$/,'The actual certified SDK image must be selected explicitly');
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL','STOCKCHIEF_CODEX_MODEL_POLICY'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Scope owner',businessName:'Testing',email,password:'Offline!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Testing',emails:[email]})).environment);process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;process.env.STOCKCHIEF_CODEX_MODEL_POLICY=JSON.stringify({default:{initialTier:'fast',profiles:{fast:'sol-low'}}});
 await db.query("UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=1000000,approval_reference='OFFLINE FAKE PROVIDER ONLY' WHERE workspace_id=$1",[ctx.workspaceId]);await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const place=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Unfamiliar shelf '+randomUUID().slice(0,6),kind:'warehouse'});
 const pilot=require('../../src/assistant/postgres-codex-pilot'),store=require('../../src/assistant/postgres-goal-store'),response=require('../helpers/codex-offline-response');
 // Exact diagnostic from the recorded paid failure. Length is presentation,
 // not a missing decision; its original wire response stays durably settled.
 const recordedReason='The complete attention list supports 27 approval items, 3 messages, 2 connection issues, and 2 stock alerts. All 11 provider-effect records succeeded, and the answer appropriately limits its interruption finding to those records. The evidence shows only read operations.';
 assert.equal(recordedReason.length,270);
 for(const invalidRef of [false,true]){
  const started=await pilot.start(db,ctx,'Name one currently recorded warehouse and make no changes.');let native=0,reviews=0;
  async function claim(){const g=await store.get(db,ctx,started.goalId),e=Object.values(g.checkpoint.harness.evidence).findLast(e=>e.name==='business_operations'),refs=require('../../scripts/environment-agent-demo/source-references'),wire=refs.present(e,JSON.parse(e.text)),row=wire.outcomes[0].result.rows.find(r=>r.name===place.name);assert(row);return {sourceRef:row[wire._stockchiefSources.valueField].name,historical:false,value:row.name};}
  const fake=async(_url,init)=>{const body=JSON.parse(init.body);
   if(body.text?.format?.name==='native_answer_scope_fit_v2'){
    reviews++;const input=JSON.parse(body.input[0].content);assert.equal(input.originalGoal,'Name one currently recorded warehouse and make no changes.');assert.equal(input.goalId,started.goalId);assert(input.evidence[0].source);assert.equal(body.max_output_tokens,500);
    const reject=!invalidRef&&reviews===1;assert.equal(native,reject?2:3,'Reference rejection must not purchase a semantic review');
    assert.equal(body.text.format.schema.properties.reason.maxLength,undefined,'The actual provider wire omits this constraint');
    return Response.json({id:'offline-review-'+reviews,object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({grounded:true,complete:!reject,missingOutcomes:reject?['A warehouse record does not establish that no interrupted requests remain.']:[],reason:recordedReason})}]}],usage:{input_tokens:200,output_tokens:40,total_tokens:240}});
   }
   native++;
   if(native===1)return response(body,native,`const e=await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:'read.locations',arguments:[],dependsOn:[]}])});if(e.isError)throw Error('READ_FAILED');text(JSON.parse(e.content[0].text));`);
   const fact=await claim();let answer='Recorded warehouse: '+place.name,claims=[fact];
   if(native===2){
    if(invalidRef){assert.equal(reviews,0);claims=[...Array.from({length:24},()=>fact),{...fact,sourceRef:'fv1:ABCDEFGHIJKLMNOP'}];}
    else answer+=' No interrupted requests remain.';
   }else{assert.equal(native,3);const serialized=JSON.stringify(body.input);assert(serialized.includes(invalidRef?'SOURCE_REFERENCE_NOT_FOUND':'ANSWER_SCOPE_UNVERIFIED'));if(!invalidRef)assert(serialized.includes('A warehouse record does not establish'));
   }
   return response.final(body,native,JSON.stringify({version:3,status:'completed',outcome:'answer',answer,question:null,missingInformation:[],tier:null,reason:null,claims,navigation:null,workProducts:[],nextActions:[]}));
  };
  const done=await pilot.run(db,ctx,started.goalId,{image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE,apiKey:'FAKE',fetchImpl:fake,countInput:async()=>({object:'response.input_tokens',input_tokens:200})});
  assert.equal(done.status,'COMPLETED',JSON.stringify({answer:done.answer,waitingForFunding:done.waitingForFunding,interruption:done.checkpoint?.harness?.interruption,failure:done.checkpoint?.harness?.verificationFailure,native,reviews}));assert.equal(native,3);assert.equal(reviews,invalidRef?1:2);assert.equal(done.checkpoint.harness.verificationCorrections,1);assert.equal(done.checkpoint.harness.codexRequests,native+reviews);assert(!done.answer.includes('interrupted'));
  assert.equal(done.checkpoint.harness.answerScopeReview.version,4);assert.equal(done.checkpoint.harness.answerScopeReview.verdict.reason.length,200);
  assert(require('../../scripts/environment-agent-demo/replay-packet').unpack(done.checkpoint.harness.helperDelivery.packet).body.includes(recordedReason),'Exact charged response survives normalization and restart');
  const before=(await db.query('SELECT count(*) AS n,sum(charged) AS charged FROM stockchief_runtime.codex_pilot_calls WHERE goal_id=$1',[started.goalId])).rows[0];
  await db.query("UPDATE stockchief_runtime.assistant_goals SET status='BLOCKED',tool_calls=30,checkpoint=jsonb_set(checkpoint,'{harness,codexRequests}','24') WHERE id=$1",[started.goalId]);await pilot.resume(db,ctx,started.goalId);
  const forbidden=async()=>{throw Error('NO_ADDITIONAL_MODEL_OR_TOKEN_CALL_ALLOWED');};
  const resumed=await pilot.run(db,ctx,started.goalId,{image:'sha256:'+'0'.repeat(64),apiKey:'FAKE',fetchImpl:forbidden,countInput:forbidden});
  assert.equal(resumed.status,'COMPLETED');assert.equal(resumed.answer,done.answer);assert.equal(resumed.checkpoint.harness.codexRequests,24);assert.equal(resumed.tool_calls,30);
  assert.deepEqual((await db.query('SELECT count(*) AS n,sum(charged) AS charged FROM stockchief_runtime.codex_pilot_calls WHERE goal_id=$1',[started.goalId])).rows[0],before);
  t.diagnostic(JSON.stringify({recordedFailureClass:invalidRef?'24-valid-plus-unissued-reference':'true-fact-unsupported-conclusion',nativeFakeResponses:native,scopeFakeResponses:reviews,sameThreadCorrections:1,settledReviewResumedAtLimits:true,additionalPaidCalls:0}));
 }
 await t.test('a crash after helper delivery replays that exact settled response before persisting the verdict',async()=>{
  const started=await pilot.start(db,ctx,'Name one currently recorded warehouse and make no changes.'),sessions=require('../../scripts/environment-agent-demo/session'),create=sessions.createSession;let native=0,reviews=0,injected=true;
  sessions.createSession=options=>{const s=create(options);if(options.goalId===started.goalId){const save=s.answerReviewed;s.answerReviewed=async(...args)=>{if(injected){injected=false;throw Object.assign(Error('OFFLINE_HOST_INTERRUPTION'),{code:'OFFLINE_HOST_INTERRUPTION'});}return save(...args);};}return s;};
  t.after(()=>{sessions.createSession=create;});
  const fake=async(_url,init)=>{const body=JSON.parse(init.body);if(body.text?.format?.name==='native_answer_scope_fit_v2'){
   reviews++;return Response.json({id:'offline-settled-review',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({grounded:true,complete:true,missingOutcomes:[],reason:''})}]}],usage:{input_tokens:200,output_tokens:40,total_tokens:240}});
  }
  native++;if(native===1)return response(body,native,`text(await tools.mcp__stockchief__business_operations({stepsJson:JSON.stringify([{capability:'read.locations',arguments:[],dependsOn:[]}])}));`);
  assert.equal(native,2);const g=await store.get(db,ctx,started.goalId),e=Object.values(g.checkpoint.harness.evidence).findLast(e=>e.name==='business_operations'),wire=require('../../scripts/environment-agent-demo/source-references').present(e,JSON.parse(e.text)),row=wire.outcomes[0].result.rows.find(r=>r.name===place.name);
  return response.final(body,native,JSON.stringify({version:3,status:'completed',outcome:'answer',answer:'Recorded warehouse: '+place.name,question:null,missingInformation:[],tier:null,reason:null,claims:[{sourceRef:row[wire._stockchiefSources.valueField].name,historical:false,value:row.name}],navigation:null,workProducts:[],nextActions:[]}));};
  const options={image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE,apiKey:'FAKE',fetchImpl:fake,countInput:async()=>({object:'response.input_tokens',input_tokens:200})};await pilot.run(db,ctx,started.goalId,options);const stopped=await store.get(db,ctx,started.goalId);
  sessions.createSession=create;assert.equal(stopped.status,'BLOCKED');assert.equal(stopped.checkpoint.harness.answerScopeReview.state,'PREPARED');assert.equal(stopped.checkpoint.harness.helperDelivery.state,'SETTLED');assert.equal(native,2);assert.equal(reviews,1);
  const before=(await db.query('SELECT count(*) AS n,sum(charged) AS charged FROM stockchief_runtime.codex_pilot_calls WHERE goal_id=$1',[started.goalId])).rows[0];await pilot.resume(db,ctx,started.goalId);
  let repeated=0;const forbidden=async()=>{repeated++;throw Error('SETTLED_REVIEW_MUST_REPLAY_WITHOUT_CALL');};const resumed=await pilot.run(db,ctx,started.goalId,{...options,fetchImpl:forbidden,countInput:forbidden,sandboxPool:{take:()=>{throw Error('REVIEW_REPLAY_MUST_NOT_START_SDK');}}});
  assert.equal(resumed.status,'COMPLETED',JSON.stringify({answer:resumed.answer,interruption:resumed.checkpoint.harness.interruption,repeated}));assert.equal(repeated,0);assert.equal(resumed.checkpoint.harness.answerScopeReview.state,'SETTLED');assert.equal(resumed.checkpoint.harness.codexRequests,3);
  assert.deepEqual((await db.query('SELECT count(*) AS n,sum(charged) AS charged FROM stockchief_runtime.codex_pilot_calls WHERE goal_id=$1',[started.goalId])).rows[0],before);
 });
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
});
