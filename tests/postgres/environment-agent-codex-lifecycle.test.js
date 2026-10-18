'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const base='../../scripts/environment-agent-demo/',goals=require('../../src/assistant/postgres-goal-store'),wire=require(base+'codex-wire');
test('recorded live context: actual SDK discovers changing worksheet, restarts, natively compacts, obtains canonical approval and verifies PostgreSQL',{timeout:240000},async t=>{
 const out=path.resolve(process.env.STOCKCHIEF_CODEX_ARTIFACT_DIR||'data/environment-agent-demo/codex-sdk-lifecycle-audit');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-codex-lifecycle-')),cleanup=[];
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();await cluster.stop();fs.rmSync(tmp,{recursive:true,force:true});delete process.env.STOCKCHIEF_CODEX_SDK_DEMO;});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const fixtures=require(base+'embedded-certification-fixtures');
 const task=fixtures.createTasks().find(t=>t.novel?.family===2&&t.kind==='receive');assert(task);task.novel.depth=1;
 const f=await fixtures.seed(db,task),ctx=f.ctx;
 let held=await goals.claim(db,ctx,(await goals.create(db,ctx,task.prompt,{budgetMinor:75})).id);
 function attach(verifier){const gateway=require(base+'gateway').createGateway({database:db,ctx,goal:task.prompt,goalId:held.id,runToken:held.run_token,provider:{complete:async()=>{throw Error('PAID_MODEL_FORBIDDEN');}}});
  return {gateway,session:require(base+'session').createSession({database:db,ctx,goalId:held.id,runToken:held.run_token,candidate:'codex',authorize:gateway.authorize,verifyOutcome:verifier})};}
 let {session,gateway}=attach();
 // Bind this fresh fixture run to current authority before restoring native
 // history, just as the production runtime's prepareContext/session.load does.
 await session.load();
 // Restore the actual failed run's native JSONL and journal, not a fabricated
 // short history. All records in it were disposable fixtures. Fresh task data
 // and fresh browser handles are supplied only by this separate test environment.
 const recorded=JSON.parse(fs.readFileSync('data/environment-agent-demo/codex-sdk-sol-high/attempt/goal.json'));
 const state=recorded.checkpoint.harness.native.codex;
 const recordedObservation=Object.values(recorded.checkpoint.harness.evidence).findLast(e=>e.name==='environment_browser');assert(recordedObservation?.sha256);
 await session.checkpoint({codex:state});
 await db.query(`UPDATE stockchief_runtime.assistant_goals SET checkpoint=jsonb_set(checkpoint,'{harness,evidence}',$2::jsonb) WHERE id=$1`,[held.id,JSON.stringify(recorded.checkpoint.harness.evidence)]);
 const budget=new(require(base+'budget').ExperimentBudget)(path.join(tmp,'budget.db'),'OFFLINE LIFECYCLE');cleanup.push(()=>budget.close());
 budget.approve({ceilingMicroUsd:1000000,approvalReference:'SYNTHETIC PROVIDER ONLY - NO API KEYS',expiresAt:new Date(Date.now()+240000).toISOString()});
 for(const [operation,dollars]of Object.entries(wire.PROFILE.rates))await db.query(`INSERT INTO commercial_cost_rates(id,provider,model,provider_version,operation,unit,cost_per_unit_minor,currency,effective_from,source,pricing_basis,confidence)
  VALUES($1,'openai',$2,'responses-2026-10-11',$3,'token',$4,'USD',now(),$5,'VERIFIED_PUBLIC','HIGH')`,['lifecycle-'+operation,wire.MODEL,operation,dollars/10000,wire.source]);
 const ent=require('../../src/commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(db,ctx.workspaceId);
 await ent.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:ctx.workspaceId+':fake'});
 const events=[],requests=[],counts=[];let compactions=0;const audit=e=>{events.push(e);fs.appendFileSync(path.join(out,'lifecycle-trace.jsonl'),JSON.stringify(e)+'\n');};
 fs.writeFileSync(path.join(out,'lifecycle-trace.jsonl'),'');
 const values=JSON.stringify(f.novel.facts);
 // These are explicitly SYNTHETIC model decisions in a test provider. No
 // route, field name, fixture, scenario text or decision enters agent code.
 const browserPrelude=`const tool=n=>ALL_TOOLS.find(t=>t.name.endsWith('__'+n));const call=async(n,a)=>{const r=await tools[tool(n).name](a);return r.content?JSON.parse(r.content.find(c=>c.type==='text').text):r;};let s;const B=async(a,ref=null,value=null)=>{const r=await call('environment_browser',{action:a,ref,value});s=r.screen||r;if(s.textEncoding==='labelled_blocks_and_separators')s.text=Object.values(s.textBlocks).map((block,i)=>s.textSeparators[i]+block).join('')+s.textSeparators.at(-1);if(s.controlDefaults)s.controls=s.controls.map(c=>({...s.controlDefaults,...c}));text(r);return s;};const choose=re=>s.controls.find(c=>c.tag==='a'&&re.test(c.label));const enter=async()=>{await B('click',choose(/worksheet/i).ref);while(!s.controls.some(c=>c.form&&c.required))await B('click',choose(/continue/i).ref);};const values=${values};const key=c=>/ordered/i.test(c.label)?'ordered':/received/i.test(c.label)?'received':/outstanding/i.test(c.label)?'outstanding':null;const fill=async()=>{for(const k of ['ordered','received','outstanding']){const c=s.controls.find(c=>c.form&&key(c)===k);await B(c.tag==='select'?'select':'fill',c.ref,String(values[k]));}};`;
 const first=browserPrelude+`await B('inspect');await enter();await fill();await B('click',s.controls.find(c=>c.tag==='button').ref);if(!s.text.includes('worksheet changed'))throw Error('Expected changing form');text(await call('workspace_exec',{command:'printf durable-workspace-marker > audit-note.txt'}));await B('click',choose(/^Home$/).ref);await B('click',choose(/^Inventory$/).ref);await B('click',choose(/^Home$/).ref);await B('click',choose(/^Purchasing$/).ref);await B('click',choose(/^Home$/).ref);await enter();await B('click','expired-recorded-handle');`;
 const historyCheck=`const originalObservation=await call('environment_evidence',{id:${JSON.stringify(recordedObservation.id)},offset:0});if(originalObservation.sha256!==${JSON.stringify(recordedObservation.sha256)})throw Error('Original recorded evidence changed after native compaction');text(originalObservation);`;
 const second=browserPrelude+historyCheck+`text(await call('environment_evidence',{id:'@index',offset:0}));text(await call('environment_evidence',{id:${JSON.stringify(held.id+':7')},offset:0}));const note=await call('workspace_read',{path:'/workspace/audit-note.txt'});if(note.text!=='durable-workspace-marker')throw Error('Workspace lost');await B('inspect');await fill();const c=s.controls.find(c=>c.tag==='select'&&/handling/i.test(c.label));const material=s.text.match(/Handling requirement: ([^.]+)\./)[1];const option=c.options.find(o=>o.label===material);await B('select',c.ref,option.value);await B('click',s.controls.find(c=>c.tag==='button').ref);if(!s.text.includes('Verified worksheet preview'))throw Error('Preview not verified');const found=await call('environment_interfaces',{search:'physically arrived',offset:0,names:[]});text(found);const contract=found.operations.find(c=>/physical-only receipt/.test(c.description));if(!contract)throw Error('Canonical contract missing');text(await call('environment_interfaces',{search:'',offset:0,names:[contract.name]}));text(await call('business_operations',{stepsJson:JSON.stringify([{capability:contract.name,arguments:[{name:'sku',value:${JSON.stringify(task.sku)}},{name:'location',value:${JSON.stringify(task.warehouse)}},{name:'quantity',value:${task.receive}},{name:'reference',value:${JSON.stringify(task.reference)}}],dependsOn:[]}])}));`;
 const relay=await require(base+'relay').createRelay({budget,credentials:{openai:'FAKE'},commercial:require(base+'commercial').createCommercialAccounting(db),audit,
  countCodexInput:async body=>{counts.push({bytes:Buffer.byteLength(JSON.stringify(body))});return {object:'response.input_tokens',input_tokens:36969};},
  fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body);requests.push(body);fs.writeFileSync(path.join(out,'lifecycle-native-requests.json'),JSON.stringify(requests,null,2));const n=requests.length;
   if(n===1){assert(Buffer.byteLength(JSON.stringify(wire.countRequest(body)))>=162729,'actual failed context must be exceeded');return require('../helpers/codex-offline-response')(body,n,first);}
   if(n===2)return require('../helpers/codex-offline-response').final(body,n,'The changing worksheet has been inspected; its preview and business operation remain incomplete.');
   if(JSON.stringify(body.input.at(-1)).includes('CONTEXT CHECKPOINT COMPACTION')){compactions++;return require('../helpers/codex-offline-response').final(body,n,'Earlier browser evidence is durably available from environment_evidence. The current goal still requires the changed worksheet preview, an approved physical receipt and verification.');}
   if(n===4){assert(JSON.stringify(body.input).includes('Earlier browser evidence is durably available'),'native compaction output must be used');return require('../helpers/codex-offline-response')(body,n,second);}
   assert.equal(n,6);return require('../helpers/codex-offline-response').final(body,n,'The worksheet preview completed. The physical-only receipt is prepared and requires approval. No inventory receipt has been executed yet.');
  }});cleanup.push(()=>relay.close());
 const transport=relay.grant({candidate:'codex',provider:'openai',task:'offline-lifecycle',ctx,goalId:held.id,fundingKey:'fake',authorize:()=>gateway.authorize(),wireProfile:'codex',requestGate:()=>session.codexRequest()});
 const inspection=await require(base+'inspection').createInspectionServer({cluster,database:db,ctx});cleanup.push(()=>inspection.close());
 const environment=await fixtures.environment(db,f,inspection);cleanup.push(()=>environment.close());
 const chromium=await require('playwright').chromium.launch({headless:true});cleanup.push(()=>chromium.close());
 const browser=await require(base+'browser').createBrowserTools(chromium,{origin:environment.origin,audit});cleanup.push(()=>browser.close());
 const image=JSON.parse(fs.readFileSync(path.join(out,'runtime.json'))).image;process.env.STOCKCHIEF_CODEX_SDK_DEMO='1';
 const options={candidate:'codex',session,transport,budget,gateway,browser,codexImage:image,audit,offlineOnly:true,credentials:{openai:'FAKE'},resumeContext:task.prompt};
 const firstResult=await require(base+'codex-runtime').run(options);assert(firstResult.answer.includes('incomplete'));assert.equal(requests.length,2);
 const countBeforeReplay=counts.length;
 const replay=await fetch(transport.openaiBaseURL+'/responses',{method:'POST',headers:{authorization:`Bearer ${transport.token}`,'content-type':'application/json'},body:JSON.stringify(requests.at(-1))});
 assert.equal(replay.status,200);assert.equal(counts.length,countBeforeReplay);assert.equal(requests.length,2,'settled response redelivery must never buy a replacement');
 let cp=(await goals.get(db,ctx,held.id)).checkpoint.harness;assert.equal(cp.native.codex.encoding,'gzip');assert.equal(cp.sequence,16);
 const journalRef=events.find(e=>e.kind==='codex_event'&&e.event.type==='item.completed'&&e.event.item.type==='mcp_tool_call').event.item.result.content[0].text;
 assert(JSON.parse(journalRef)._stockchiefEvidence.evidenceId,'full native tool results must advertise their durable journal reference');
 assert.equal(f.novel.changes,1);assert.equal(f.novel.previews.length,0);
 const beforeRestart=await session.evidence({id:held.id+':7',offset:0});assert(beforeRestart.records.length);
 // Interrupt a genuinely started read, expire its lease, claim a fresh run and
 // discard every process-local runtime/controller variable and Docker sandbox.
 let release,entered;const didEnter=new Promise(r=>entered=r);const pending=new Promise(r=>release=r);
 const interrupted=session.execute('environment_browser',{action:'inspect'},async()=>{entered();await pending;return {text:'late read'};}).catch(e=>e);
 await didEnter;await db.query("UPDATE stockchief_runtime.assistant_goals SET lease_until=now()-interval '1 second' WHERE id=$1",[held.id]);
 await require(base+'waits').recover(db,ctx,held.id);held=await goals.claim(db,ctx,held.id);assert(held);({session,gateway}=attach());
 release();assert((await interrupted) instanceof Error);assert.equal((await session.evidence({id:held.id+':7',offset:0})).sha256,beforeRestart.sha256);
 const next=await require(base+'worker').run({...options,session,gateway,offlineCompact:true});assert(!next.interruption,JSON.stringify(next));assert.equal(requests.length,4);
 assert(f.novel.previews.some(p=>p.correct&&p.beforeEffects));assert.equal(f.novel.posts,0);
 const proposal=(await db.query("SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND status='PENDING'",[ctx.workspaceId])).rows[0];assert(proposal);
 assert(await fixtures.approvalPolicy.permits(db,f,proposal));assert.deepEqual((await fixtures.snapshot(db,f)).stock,f.before.stock);
 assert.equal(next.completionSource,'durable_approval_handoff');assert.equal((await goals.get(db,ctx,held.id)).status,'WAITING_APPROVAL');
 // Simulated human approval exists ONLY in the test operator, never SDK tools.
 await fixtures.approvalPolicy.execute(db,ctx,proposal,{provider:{complete:async()=>{throw Error('PAID_MODEL_FORBIDDEN');}}});
 await require(base+'waits').refresh(db,ctx,held.id);held=await goals.claim(db,ctx,held.id);assert(held);
 ({session,gateway}=attach((client,context)=>fixtures.verifiedOutcome(client,{...context,fixture:f})));
 const final=await require(base+'worker').run({...options,session,gateway});assert.equal(final.completionSource,'host_verified_receipt');assert.equal(requests.length,4,'final reporting cannot require another model call');
 const verdict=await fixtures.verify(db,f,final.answer);assert(verdict.achieved,JSON.stringify(verdict.checks));
 assert(final.answer.includes('Verified worksheet preview:'));assert(final.answer.includes(f.novel.material));
 const goal=await goals.get(db,ctx,held.id);assert.equal(goal.status,'COMPLETED');assert.equal(goal.tool_calls,30);
 const holds=(await db.query('SELECT status,maximum_minor,actual_minor FROM commercial_model_cost_holds WHERE goal_id=$1',[held.id])).rows;assert.equal(holds.length,4);assert(holds.every(h=>h.status==='SETTLED'&&Number(h.maximum_minor)<=30));
 const result={mode:'ACTUAL_SDK_SYNTHETIC_PROVIDER',paidCalls:0,realTokenCounterCalls:0,sdk:wire.VERSION,profile:wire.PROFILE.id,
  recordedNativeThread:state.threadId,recordedJournalObservations:15,initialRequestBytes:counts[0].bytes,failedLastAdmittedRequestBytes:162729,
  modelRequests:requests.length,toolCalls:goal.tool_calls,browserActions:events.filter(e=>e.kind==='browser_action').length,
  nativeCompaction:true,nativeCompactionRequests:compactions,newContainerResumption:true,interruptedReadRecovered:true,durableEvidenceHash:beforeRestart.sha256,
  scratchFileRestored:true,settledResponseReplayedWithoutSpending:true,simulatedHumanApprovals:1,actualHumanInteractions:0,hostVerifiedFinalWithoutModel:true,
  peakNativeThreads:Math.max(...events.filter(e=>e.kind==='codex_resources').map(e=>e.totalThreads)),nativeCompactionTokenLimit:wire.nativeCompactionTokenLimit,
  goalStatus:goal.status,checks:verdict.checks,discovery:verdict.discovery,after:verdict.after,commercialHolds:holds,
  budget:budget.status(),liveReasoningProven:false};
 fs.writeFileSync(path.join(out,'lifecycle-result.json'),JSON.stringify(result,null,2));
 fs.writeFileSync(path.join(out,'lifecycle-native-requests.json'),JSON.stringify(requests,null,2));
});
