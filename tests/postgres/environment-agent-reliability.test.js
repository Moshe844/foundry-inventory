'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const goals=require('../../src/assistant/postgres-goal-store');
const {createGateway}=require('../../scripts/environment-agent-demo/gateway');
const {createSession}=require('../../scripts/environment-agent-demo/session');
const waits=require('../../scripts/environment-agent-demo/waits');
const worker=require('../../scripts/environment-agent-demo/worker');
test('durable receipts, scope-safe recovery and final verification work without a provider',async t=>{
 const cluster=await startCluster(),db=openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Reliability owner',businessName:'Offline reliability',
  email:`${randomUUID()}@example.test`,password:`Fixture!${randomUUID()}`});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};let paid=0;
 const provider={complete:async()=>{paid++;throw new Error('Provider unavailable in offline verification.');}};
 async function attach(held,verifyOutcome){
  const gateway=createGateway({database:db,ctx,goal:held.original_request,goalId:held.id,runToken:held.run_token,provider});
  return {held,gateway,session:createSession({database:db,ctx,goalId:held.id,runToken:held.run_token,candidate:'openai',authorize:gateway.authorize,verifyOutcome})};
 }
 async function create(text,verifyOutcome){return attach(await goals.claim(db,ctx,(await goals.create(db,ctx,text)).id),verifyOutcome);}
 async function prepare(code){
  const run=await create(`Create a quantity-tracked product named ${code} with SKU ${code}.`);
  const steps=[{capability:'catalog.create_item',arguments:[{name:'search',value:code},{name:'baseCode',value:code}],dependsOn:[]}];
  const result=await run.session.execute('business_operations',{steps},callId=>run.gateway.operate({steps,callId}));
  await run.session.finish({answer:'Prepared for approval.',verified:false});
  assert.equal((await goals.get(db,ctx,run.held.id)).status,'WAITING_APPROVAL');
  await require('../../src/assistant/postgres-service').executeProposal(db,ctx,result.outcomes[0].result.proposal.id,{provider});
  await waits.refresh(db,ctx,run.held.id);
  return attach(await goals.claim(db,ctx,run.held.id));
 }
 await t.test('a cost stop reports committed effects and does not claim the unverified whole goal',async()=>{
  const run=await prepare('RECEIPT-PART');
  const steps=[{capability:'catalog.create_item',arguments:[{name:'search',value:'RECEIPT-PART'},{name:'baseCode',value:'RECEIPT-PART'}],dependsOn:[]}];
  const replay=await run.session.execute('business_operations',{steps},()=>{throw new Error('Must not duplicate a committed effect');});
  assert.equal(replay.replayed,true);assert.equal(replay.canonicalReceipt.operations[0].status,'EXECUTED');
  const result=await worker.run({...run,candidate:'openai',goal:run.held.original_request,budget:{status:()=>({stopped:true})},browser:{}});
  assert.match(result.answer,/catalog.create_item/);assert.match(result.answer,/RECEIPT-PART/);
  assert.match(result.answer,/every part.*not been established/);
  const durable=await goals.get(db,ctx,run.held.id);
  assert.equal(durable.status,'BLOCKED');assert.equal(durable.checkpoint.harness.completionSource,'partial_verified_receipt');
  assert.equal(durable.checkpoint.harness.receipt.operations[0].verified,true);
  assert.equal(durable.run_token,null);assert.equal(paid,0);
 });
 await t.test('host verification persists full completion before any model or budget access',async()=>{
  const run=await prepare('COMPLETE-PART');
  const verified=await attach(run.held,async(client,{goal,receipt})=>{
   // Independent host acceptance check, intentionally not an agent tool.
   assert.equal(goal.original_request,run.held.original_request);
   const row=(await client.query('SELECT id,name FROM items WHERE workspace_id=$1 AND base_code=$2',[ctx.workspaceId,'COMPLETE-PART'])).rows[0];
   return {complete:Boolean(row&&receipt.operations.every(o=>o.verified)),answer:`Verified product ${row.name}: ${row.id}.`,evidence:[{itemId:row.id}]};
  });
  const result=await worker.run({...verified,candidate:'openai',budget:{status(){paid++;throw new Error('Must not need a paid call');}}});
  assert.match(result.answer,/Verified product COMPLETE-PART/);assert.equal(result.completionSource,'host_verified_receipt');
  const durable=await goals.get(db,ctx,run.held.id);
  assert.equal(durable.status,'COMPLETED');assert.equal(durable.answer,result.answer);
  assert.equal(durable.checkpoint.harness.receipt.wholeGoalVerification.length,1);assert.equal(paid,0);
  const restarted=await attach(run.held); // Old lease has already been released.
  const again=await worker.run({...restarted,candidate:'openai',budget:{status(){paid++;throw new Error('No second completion call');}}});
  assert.equal(again.answer,result.answer);assert.equal(paid,0);
 });
 await t.test('large observations remain retrievable and survive process/session recreation',async()=>{
  const run=await create('Investigate a large unfamiliar report.');
  const output={rows:[{name:'Untrusted report text '.repeat(700)}]};
  await run.session.execute('environment_dataset',{specJson:'{}'},async()=>output);
  const visible=await run.session.present(output);assert.equal(visible.truncated,true);
  const fresh=await attach(run.held);let text='',offset=0;
  do{const page=await fresh.session.evidence({id:visible.evidenceId,offset});
   assert.equal(page.offsetUnit,'record');for(const record of page.records){
    assert.equal(record.path,'/rows/0/name');assert.equal(record.start,text.length);text+=record.text;
   }offset=page.nextOffset;}while(offset!==null);
  assert.equal(text,output.rows[0].name);
  await assert.rejects(()=>run.gateway.dataset({spec:{dataset:'inventory',filters:{sku:'ignored'}}}),/must be an array/);
  await goals.cancel(db,ctx,run.held.id);
  await assert.rejects(()=>fresh.session.evidence({id:visible.evidenceId}),/not held/);
 });
 await t.test('pending external work prevents full completion and wakes only after canonical confirmation',async()=>{
  const run=await prepare('EXTERNAL-WAIT-PART'),queue=require('../../src/operations/postgres-job-queue');
  const queued=await queue.enqueue(db,{workspaceId:ctx.workspaceId,kind:'offline.external.wait',idempotencyKey:randomUUID()});
  const h=await run.session.load(),proposalId=waits.dependencies(h).proposalIds[0];
  // Evaluator injects an external dependency into the isolated fixture only.
  await db.query('UPDATE stockchief_runtime.assistant_action_proposals SET result=result||$3::jsonb WHERE workspace_id=$1 AND id=$2',
   [ctx.workspaceId,proposalId,JSON.stringify({jobId:queued.job.id})]);
  let verifierCalls=0;const checking=await attach(run.held,async()=>{verifierCalls++;return {complete:true,answer:'Too early',evidence:[{}]};});
  assert.equal(await checking.session.completeIfVerified(),null);assert.equal(verifierCalls,0);
  await checking.session.stop({code:'PROVIDER_UNAVAILABLE'});
  assert.equal((await goals.get(db,ctx,run.held.id)).status,'WAITING_EVENT');
  assert.equal((await waits.refresh(db,ctx,run.held.id)).status,'WAITING_EVENT');
  const job=await queue.claim(db,{owner:'offline-verifier',kinds:['offline.external.wait']});
  await queue.complete(db,job.id,job.leaseToken,{confirmed:true});
  assert.equal((await waits.refresh(db,ctx,run.held.id)).status,'READY');
  await goals.cancel(db,ctx,run.held.id);assert.equal(paid,0);
 });
 await t.test('consolidated facts and loop state survive recreation; a final request forbids further model/tool calls',async()=>{
  const run=await create('Investigate observed quantities without changing anything.');
  await run.session.execute('environment_dataset',{specJson:'{}'},async()=>({rows:[{sku:'OFFLINE',onHand:17}]}));
  for(let i=0;i<5;i++)await run.session.execute('environment_browser',{action:'inspect'},async()=>({text:'Unchanged screen',controls:[{ref:`r${i}`,text:'Stock'}]}));
  const fresh=await attach(run.held),h=await fresh.session.load();
  assert.equal(h.progress.stagnant,4);assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE');
  assert.equal((await fresh.session.workingMemory()).facts[0].data.rows[0].onHand,17);
  const control=await fresh.session.modelControl();assert.equal(control.final,true);assert.equal(control.request,1);
  const resumed=await attach(run.held);
  await assert.rejects(()=>resumed.session.modelControl(),/FINAL_REQUEST_EXHAUSTED/);
  let effects=0;
  await assert.rejects(()=>resumed.session.execute('business_operations',{steps:[]},async()=>{effects++;}),/FINAL_TOOLS_DISABLED/);
  assert.equal(effects,0);
  const stopped=await resumed.session.stop({code:'SHARED_SPENDING_CEILING'});
  assert.match(stopped.answer,/OFFLINE/);assert.match(stopped.answer,/17/);assert.match(stopped.answer,/full coverage.*not been established/);
  assert.equal(stopped.completionSource,'partial_observation_report');assert.equal(stopped.status,'BLOCKED');assert.equal(paid,0);
 });
 await t.test('durable model count reserves request 24 for reporting across process recreation',async()=>{
  const run=await create('Investigate a changing environment.');
  for(let i=1;i<=23;i++){const c=await run.session.modelControl();assert.equal(c.request,i);assert.equal(c.final,false);}
  const fresh=await attach(run.held),final=await fresh.session.modelControl();
  assert.deepEqual(final,{request:24,final:true,reason:'FINAL_TURN_RESERVED'});
  await assert.rejects(()=>fresh.session.modelControl(),/FINAL_REQUEST_EXHAUSTED/);
  assert.equal((await fresh.session.load()).modelRequests,24);await goals.cancel(db,ctx,run.held.id);
 });
 await t.test('empty final metadata survives restart and blocks SDK continuation before another request or tool',async()=>{
  const run=await create('Investigate an unfamiliar changing record.');
  await run.session.execute('environment_dataset',{specJson:'{}'},async()=>({rows:[{name:'Observed record',quantity:8}]}));
  const final=await run.session.modelControl({budgetFinal:true});assert.equal(final.request,1);
  await run.session.modelResponse({request:1,final:true,terminal:true,visible:false,tool:false,empty:true,stopReason:'end_turn',usageSettled:true});
  const fresh=await attach(run.held),saved=await fresh.session.load();
  assert.equal(saved.lastModelResponse.empty,true);assert.equal(saved.lastModelResponse.usageSettled,true);
  await assert.rejects(()=>fresh.session.modelControl(),error=>error.code==='EMPTY_MODEL_FINAL');
  let executions=0;
  await assert.rejects(()=>fresh.session.execute('environment_browser',{},async()=>{executions++;}),/FINAL_TOOLS_DISABLED/);
  assert.equal(executions,0);assert.equal((await fresh.session.load()).modelRequests,1);
  const stopped=await fresh.session.stop({code:'EMPTY_MODEL_FINAL'});
  assert.equal(stopped.status,'BLOCKED');assert.match(stopped.answer,/Observed record/);
  const record=await goals.get(db,ctx,run.held.id);assert.equal(record.checkpoint.harness.interruption.code,'EMPTY_MODEL_FINAL');
  assert.equal(record.checkpoint.harness.completionSource,'partial_observation_report');assert.equal(paid,0);
 });
 await t.test('interleaved repetition state survives restart, while new live state permits a recheck',async()=>{
  const run=await create('Compare current observations across changing screens.');
  const screen={url:'http://local/unknown',text:'Current value',controls:[]};
  await run.session.execute('environment_browser',{},async()=>screen);
  for(let i=0;i<3;i++){
   await run.session.execute('environment_interfaces',{search:`new source ${i}`},async()=>({operations:[{name:`contract${i}`}]}));
   await run.session.execute('environment_browser',{},async()=>screen);
  }
  const fresh=await attach(run.held);assert.equal((await fresh.session.load()).progress.stagnant,3);
  await fresh.session.execute('environment_browser',{action:'refresh'},async()=>({...screen,text:'Changed externally'}));
  assert.equal((await fresh.session.load()).progress.stagnant,0);
  assert.equal((await fresh.session.modelControl()).final,false);
  await goals.cancel(db,ctx,run.held.id);assert.equal(paid,0);
 });
 await t.test('canonical reads are fresh on retry and read failures do not become uncertain writes',async()=>{
  const run=await create('Recheck current business facts after a read error.');
  const read=require('../../src/assistant/postgres-capability-registry').registry.list().find(c=>c.kind==='read');
  const input={steps:[{capability:read.name,arguments:[],dependsOn:[]}]};let observations=0;
  await assert.rejects(()=>run.session.execute('business_operations',input,async()=>{throw new Error('Transient read failure');}),/Transient/);
  assert.equal((await goals.get(db,ctx,run.held.id)).status,'RUNNING');
  const operation=async()=>({value:++observations});
  assert.deepEqual(await run.session.execute('business_operations',input,operation),{value:1});
  assert.deepEqual(await run.session.execute('business_operations',input,operation),{value:2});
  await goals.cancel(db,ctx,run.held.id);
 });
 await t.test('expired read leases recover once, preserve counters and reject the old lease',async()=>{
  const run=await create('Inspect current records after an interruption.');
  await run.session.execute('environment_browser',{},async()=>({url:'http://127.0.0.1:1234/inventory',text:'observed',controls:[]}));
  const before=await goals.get(db,ctx,run.held.id);
  await db.query(`UPDATE stockchief_runtime.assistant_goals SET lease_until=now()-interval '1 second',
   checkpoint=jsonb_set(checkpoint,'{harness,inflight}',$2::jsonb) WHERE id=$1`,[run.held.id,JSON.stringify({name:'environment_browser',consequential:false})]);
  await Promise.all([waits.recover(db,ctx,run.held.id),waits.recover(db,ctx,run.held.id)]);
  const recovered=await goals.get(db,ctx,run.held.id);assert.equal(recovered.status,'READY');
  assert.equal(recovered.tool_calls,before.tool_calls);assert.equal(recovered.budget_minor,before.budget_minor);
  assert.equal(recovered.checkpoint.harness.inflight,null);assert.ok(recovered.checkpoint.harness.native.browserUrl);
  const held=await goals.claim(db,ctx,run.held.id);assert.notEqual(held.run_token,run.held.run_token);
  await assert.rejects(()=>run.session.checkpoint({wrongLease:true}),/not held/);
  await goals.cancel(db,ctx,held.id);
 });
 await t.test('uncertain business effects cannot be replayed by recovery',async()=>{
  const run=await create('Recover an interrupted business operation.');await run.session.load();
  await db.query(`UPDATE stockchief_runtime.assistant_goals SET lease_until=now()-interval '1 second',
   checkpoint=jsonb_set(checkpoint,'{harness,inflight}',$2::jsonb) WHERE id=$1`,[run.held.id,JSON.stringify({name:'business_operations',consequential:true})]);
  const recovered=await waits.recover(db,ctx,run.held.id);assert.equal(recovered.status,'BLOCKED');
  assert.equal(recovered.checkpoint.harness.recovery.requiresReconciliation,true);
  assert.equal(await goals.claim(db,ctx,run.held.id),null);assert.equal(paid,0);
 });
 await t.test('changed permissions prevent retrieval, resumption and verified completion',async()=>{
  const run=await create('Read business records.',async()=>({complete:true,answer:'Unsafe stale answer',evidence:[{}]}));
  await run.session.execute('environment_dataset',{},async()=>({private:'OLD AUTHORITY DATA'}));
  const index=await run.session.evidenceIndex();
  const old=(await db.query('SELECT permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0].permissions;
  await db.query('UPDATE users SET permissions=$3::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId,JSON.stringify({reliabilityRevocation:true})]);
  await assert.rejects(()=>run.session.evidence({id:index[0].id}),/AUTHORITY_CHANGED/);
  await assert.rejects(()=>run.session.completeIfVerified(),/AUTHORITY_CHANGED/);
  await run.session.stop();const stopped=await goals.get(db,ctx,run.held.id);assert.doesNotMatch(stopped.answer,/OLD AUTHORITY DATA|Unsafe/);
  await db.query('UPDATE users SET permissions=$3::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId,JSON.stringify(old)]);
 });
 assert.equal(paid,0);
});
