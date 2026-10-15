'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const base='../../scripts/environment-agent-demo/',goals=require('../../src/assistant/postgres-goal-store');
const recordedDirectory='data/environment-agent-demo/codex-sdk-sol-high-lifecycle-live-2026-10-12';
const artifactDirectory='data/environment-agent-demo/codex-sdk-approval-handoff';
test('actual recorded live boundary: SDK pauses at persisted approval despite 24 requests/30 tools, disconnection and stopped spending; approval/execution/resumption is idempotent',{timeout:180000},async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-approval-boundary-')),cleanup=[];
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();await cluster.stop();fs.rmSync(temp,{recursive:true,force:true});delete process.env.STOCKCHIEF_CODEX_SDK_DEMO;});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const recorded=JSON.parse(fs.readFileSync(path.join(recordedDirectory,'attempt/goal.json')));
 const live=JSON.parse(fs.readFileSync(path.join(recordedDirectory,'summary.json'))).result;
 const task=JSON.parse(fs.readFileSync(path.join(recordedDirectory,'proposed-live-task.json'))).task;
 const events=fs.readFileSync(path.join(recordedDirectory,'attempt/trace.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
 const lastTool=events.findLast(e=>e.kind==='agent_tool_started'&&e.name==='business_operations');assert(lastTool);
 assert.equal(live.error.name,'DURABLE_MODEL_REQUEST_LIMIT');assert.equal(recorded.tool_calls,30);
 assert.equal(recorded.checkpoint.harness.codexRequests,24);assert(live.verdict.discovery.previewCompleted);
 const fixtures=require(base+'embedded-certification-fixtures'),f=await fixtures.seed(db,task),ctx=f.ctx;
 // Reuse the actually verified live preview as recorded evidence of the
 // already-completed investigation; do not perform another browser demo.
 assert.deepEqual(Object.fromEntries(f.novel.family.keys.map(k=>[k,f.novel.facts[k]])),live.verdict.discovery.expectedFacts);
 f.novel.material=live.verdict.discovery.material;f.novel.capacity=live.verdict.discovery.capacity;
 f.novel.changes=live.verdict.discovery.formChanges;f.novel.previews=[{correct:true,beforeEffects:true,source:'RECORDED_LIVE_VERIFIED_PREVIEW'}];
 let held=await goals.claim(db,ctx,(await goals.create(db,ctx,task.prompt,{budgetMinor:100})).id);
 let notifications=0,disconnect=true,providerCalls=0,counterCalls=0,executions=0;
 const budget=new(require(base+'budget').ExperimentBudget)(path.join(temp,'budget.sqlite'),'OFFLINE RECORDED APPROVAL');cleanup.push(()=>budget.close());
 budget.approve({ceilingMicroUsd:3000000,approvalReference:'OFFLINE FAKE PROVIDER ONLY',expiresAt:new Date(Date.now()+120000).toISOString()});
 const notify=async card=>{
  notifications++;
  require(base+'human-review').publish({task,candidate:'codex',proposal:card.proposal,outputDirectory:temp,deliveryId:card.id});
  budget.stop(); // Model funds can end independently of approval delivery.
  if(disconnect)throw Error('SIMULATED_DISCONNECT_BEFORE_ACK');
 };
 function attach(verifier){const gateway=require(base+'gateway').createGateway({database:db,ctx,goal:task.prompt,goalId:held.id,runToken:held.run_token,
  provider:{complete:async()=>{throw Error('NO_PAID_MODELS');}}});
  return {gateway,session:require(base+'session').createSession({database:db,ctx,goalId:held.id,runToken:held.run_token,candidate:'codex',authorize:gateway.authorize,
   verifyOutcome:verifier,onApprovalReady:notify})};}
 let {session,gateway}=attach();await session.load();
 const fresh=(await goals.get(db,ctx,held.id)).checkpoint.harness;
 const h=structuredClone(recorded.checkpoint.harness);
 h.calls={};h.inflight=null;h.sequence=29;h.codexRequests=23;h.authorityStamp=fresh.authorityStamp;
 delete h.receipt;delete h.dependencies;delete h.interruption;delete h.completionSource;delete h.approvalDeliveries;
 h.evidence=Object.fromEntries(Object.entries(h.evidence).filter(([,e])=>e.name!=='business_operations'));
 await db.query("UPDATE stockchief_runtime.assistant_goals SET checkpoint=jsonb_set(checkpoint,'{harness}',$2::jsonb),tool_calls=29 WHERE id=$1",[held.id,JSON.stringify(h)]);
 // One synthetic response re-emits the EXACT final recorded tool input at
 // the final available request. All native history is the real failed thread.
 const relay=await require(base+'relay').createRelay({budget,credentials:{openai:'FAKE'},commercial:{begin:async c=>c,complete:async()=>{},unknown:async()=>{},release:async()=>{}},
  countCodexInput:async body=>{counterCalls++;assert(Buffer.byteLength(JSON.stringify(body))>180000);return {object:'response.input_tokens',input_tokens:52782};},
  fetchImpl:async(_url,init)=>{providerCalls++;assert.equal(providerCalls,1,'no extra model response for handoff');
   return require('../helpers/codex-offline-response')(JSON.parse(init.body),1,
    `const t=ALL_TOOLS.find(t=>t.name.endsWith('__business_operations'));text(await tools[t.name](${JSON.stringify(lastTool.input)}));`);}});cleanup.push(()=>relay.close());
 const transport=relay.grant({candidate:'codex',provider:'openai',task:task.id,goalId:held.id,ctx,fundingKey:'fake',authorize:gateway.authorize,
  wireProfile:'codex',requestGate:()=>session.codexRequest()});
 process.env.STOCKCHIEF_CODEX_SDK_DEMO='1';
 const sdkEvents=[],options={candidate:'codex',session,gateway,transport,budget,credentials:{openai:'FAKE'},offlineOnly:true,
  codexImage:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE||JSON.parse(fs.readFileSync('data/environment-agent-demo/codex-sdk-lifecycle-audit/runtime.json')).image,
  browser:{act:async()=>{throw Error('NO_BROWSER_REPLAY');}},audit:e=>sdkEvents.push(e)};
 const result=await require(base+'worker').run(options);
 assert.equal(result.completionSource,'durable_approval_handoff',JSON.stringify(result));assert.equal(result.status,'WAITING_APPROVAL');
 assert.equal(providerCalls,1);assert.equal(counterCalls,1);assert.equal(result.approvals.length,1);
 assert(!sdkEvents.some(e=>e.kind==='codex_event'&&e.event.type==='turn.completed'),'successful SDK completion must not be required');
 const stopped=await goals.get(db,ctx,held.id);assert.equal(stopped.tool_calls,30);assert.equal(stopped.checkpoint.harness.codexRequests,24);
 assert.equal((await fixtures.snapshot(db,f)).movements.length,f.before.movements.length);
 const card=result.approvals[0],handoff=require(base+'approval-handoff');
 assert.equal(fs.readdirSync(temp).filter(n=>n.startsWith('review-')).length,1,'one stable visible approval card even without transport ack');
 assert.equal(Number((await db.query("SELECT count(*) AS n FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$1 AND kind='approval_ready'",[held.id])).rows[0].n),1);
 // A genuinely new host process can recover the same PostgreSQL outbox after
 // the SDK and transport are gone, with no lease or available model budget.
 const child=`const db=require('./src/db/postgres').openPostgres(process.argv[1]);require('./scripts/environment-agent-demo/approval-handoff').inbox(db,JSON.parse(process.argv[2]),process.argv[3]).then(r=>process.stdout.write(r.approvals[0].id)).finally(()=>db.close()).catch(e=>{process.stderr.write(e.message);process.exitCode=1});`;
 assert.equal(require('node:child_process').execFileSync(process.execPath,['-e',child,cluster.connectionString,JSON.stringify(ctx),held.id],{encoding:'utf8',windowsHide:true}),card.id);
 disconnect=false;({session,gateway}=attach());
 const recovered=await require(base+'worker').run({...options,session,gateway});assert.equal(recovered.approvals[0].id,card.id);
 assert.equal(fs.readdirSync(temp).filter(n=>n.startsWith('review-')).length,1);assert(providerCalls===1&&counterCalls===1);
 assert((await goals.get(db,ctx,held.id)).checkpoint.harness.approvalDeliveries[card.id].deliveredAt);
 await assert.rejects(handoff.inbox(db,{...ctx,workspaceId:f.foreign.workspaceId},held.id),/UNAVAILABLE/);
 await assert.rejects(handoff.decide({database:db,ctx,goalId:held.id,id:card.id,sha256:'wrong',decision:{source:'human_user',approved:true,responseReference:'OFFLINE_EXACT_APPROVAL'},execute:async()=>{throw Error('UNAUTHORIZED');}}),/CHANGED/);
 await assert.rejects(handoff.resumeApproved({database:db,ctx,goalId:held.id,id:card.id,execute:async()=>{throw Error('SELF_APPROVAL');}}),/HUMAN_APPROVAL/);
 // Crash after persisting the exact human decision, before canonical execution.
 await assert.rejects(handoff.decide({database:db,ctx,goalId:held.id,id:card.id,sha256:card.sha256,
  decision:{source:'human_user',approved:true,responseReference:'OFFLINE_EXACT_APPROVAL'},execute:async()=>{throw Error('DISCONNECTED_BEFORE_EXECUTION');}}),/DISCONNECTED/);
 assert.equal((await fixtures.snapshot(db,f)).movements.length,f.before.movements.length);
 // Even an edit after the human decision but before execution cannot change
 // what was approved. The canonical transaction must lock/check that revision.
 await assert.rejects(handoff.resumeApproved({database:db,ctx,goalId:held.id,id:card.id,execute:async(proposal,executionDb)=>{
  await db.query("UPDATE stockchief_runtime.assistant_action_proposals SET payload=jsonb_set(payload,'{quantity}','6'::jsonb) WHERE id=$1",[proposal.id]);
  await fixtures.approvalPolicy.execute(executionDb,{...ctx,goalId:held.id},proposal,{provider:{complete:async()=>{throw Error('NO_PAID_MODELS');}}});
 }}),/APPROVAL_CHANGED/);
 await db.query('UPDATE stockchief_runtime.assistant_action_proposals SET payload=$2::jsonb WHERE id=$1',[card.proposalId,JSON.stringify(card.proposal.payload)]);
 assert.equal((await fixtures.snapshot(db,f)).movements.length,f.before.movements.length);
 // Crash after canonical commit, before delivery settlement; resume must read
 // the executed proposal instead of repeating its effects or asking again.
 await assert.rejects(handoff.resumeApproved({database:db,ctx,goalId:held.id,id:card.id,execute:async(proposal,executionDb)=>{
  executions++;await fixtures.approvalPolicy.execute(executionDb,{...ctx,goalId:held.id},proposal,{provider:{complete:async()=>{throw Error('NO_PAID_MODELS');}}});
  throw Error('DISCONNECTED_AFTER_CANONICAL_COMMIT');}}),/DISCONNECTED/);
 const resumed=await handoff.resumeApproved({database:db,ctx,goalId:held.id,id:card.id,execute:async()=>{throw Error('DUPLICATE_EFFECT');}});assert(resumed.alreadyExecuted);assert.equal(executions,1);
 await require(base+'waits').refresh(db,ctx,held.id);held=await goals.claim(db,ctx,held.id);assert(held);
 ({session,gateway}=attach((client,context)=>fixtures.verifiedOutcome(client,{...context,fixture:f})));
 const final=await require(base+'worker').run({...options,session,gateway});assert.equal(final.completionSource,'host_verified_receipt');
 const verdict=await fixtures.verify(db,f,final.answer);assert(verdict.achieved,JSON.stringify(verdict.checks));assert(Object.values(verdict.checks).every(Boolean));
 assert.equal(verdict.after.movements.filter(m=>m.reference===task.reference).length,1);
 assert.equal((await goals.get(db,ctx,held.id)).status,'COMPLETED');assert.equal(providerCalls,1);assert.equal(counterCalls,1);
 assert((await handoff.resumeApproved({database:db,ctx,goalId:held.id,id:card.id,execute:async()=>{throw Error('DUPLICATE_AFTER_FINAL');}})).alreadyExecuted);
 fs.mkdirSync(artifactDirectory,{recursive:true});fs.writeFileSync(path.join(artifactDirectory,'result.json'),JSON.stringify({mode:'OFFLINE_ACTUAL_SDK_RECORDED_LIVE_BOUNDARY',
  paidCalls:0,realTokenCounterCalls:0,syntheticModelCalls:1,restoredNativeThread:h.native.codex.threadId,
  codexRequests:24,toolCalls:30,stableApprovalCards:1,approvalReadyEvents:1,deliveryNotifications:notifications,simulatedHumanApprovals:1,
  separateProcessRecovery:true,crashBeforeExecutionRecovered:true,crashAfterCanonicalCommitRecovered:true,
  canonicalExecutions:executions,inventoryReceiptCount:1,checks:verdict.checks,goalStatus:'COMPLETED',finalReportWithoutModel:true,limitsIncreased:false},null,2));
});
