'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto'),base='../../scripts/environment-agent-demo/';
const sample=require('../fixtures/environment-agent-progress-loss/recorded.json');
const goals=require('../../src/assistant/postgres-goal-store');
test('actual fourteen-step failure survives PostgreSQL restart with facts, progress and tools available',async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster();let db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Offline repair',businessName:'Recorded progress',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};let paid=0;
 const attach=held=>{const gateway=require(base+'gateway').createGateway({database:db,ctx,goal:held.original_request,goalId:held.id,runToken:held.run_token,provider:{complete:async()=>{paid++;throw Error('NO_PAID_CALLS');}}});
  return require(base+'session').createSession({database:db,ctx,goalId:held.id,runToken:held.run_token,candidate:'openai',authorize:gateway.authorize});};
 let held=await goals.claim(db,ctx,(await goals.create(db,ctx,sample.goal,{budgetMinor:75})).id),session=attach(held);
 const ids=new Map();let step=0;
 for(const e of sample.events.filter(e=>e.kind==='agent_tool_started')){
  step++;assert.equal((await session.modelControl()).final,false);
  const entry=sample.evidence[sample.goalId+':'+step],input=e.name==='environment_evidence'?{...e.input,id:ids.get(e.input.id)}:e.input;
  await session.execute(e.name,input,async id=>{if(entry){ids.set(entry.id,id);return JSON.parse(entry.text);}return session.evidence(input);});
 }
 await db.query("UPDATE stockchief_runtime.assistant_goals SET lease_until=now()-interval '1 second' WHERE id=$1",[held.id]);
 await db.close();db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 await require(base+'waits').recover(db,ctx,held.id);held=await goals.claim(db,ctx,held.id);session=attach(held);
 const h=await session.load(),memory=await session.workingMemory();assert.equal(h.progress.stagnant,2);
 assert.equal(h.modelRequests,14);assert.equal(held.tool_calls,14);assert.equal(Number(held.budget_minor),75);
 assert(memory.facts[0].data.rows.length===2);assert(memory.browser.pages.some(p=>p.fields.length===3));
 const next=await session.modelControl();assert.equal(next.request,15);assert.equal(next.final,false);
 const form=JSON.parse(sample.evidence[sample.goalId+':14'].text);form.controls[0].value='38';
 await session.execute('environment_browser',{action:'fill'},async()=>form);
 assert.equal((await session.load()).progress.stagnant,0);
 const wrong=require(base+'session').createSession({database:db,ctx:{...ctx,workspaceId:'wrong-tenant'},goalId:held.id,runToken:held.run_token,candidate:'openai',authorize:async()=>({})});
 await assert.rejects(()=>wrong.workingMemory(),/LEASE/);
 // Remaining request allowance is durable, even though semantic progress reset.
 for(let i=16;i<=24;i++)assert.equal((await session.modelControl()).final,i===24);
 await assert.rejects(()=>session.modelControl(),/FINAL_REQUEST_EXHAUSTED/);
 await goals.cancel(db,ctx,held.id);assert.equal(paid,0);
});

test('whole embedded path: browser form change, gateway approval, resumption and independent PostgreSQL outcome, FAKE provider only',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-progress-integration-'));
 const out=process.env.STOCKCHIEF_PROGRESS_REPAIR_OUTPUT||path.join(tmp,'attempt');
 const budget=new (require(base+'budget').ExperimentBudget)(path.join(tmp,'fake.sqlite'),'OFFLINE ONLY');
 t.after(()=>{budget.close();assert(fs.realpathSync(tmp).startsWith(fs.realpathSync(os.tmpdir())+path.sep+'stockchief-progress-integration-'));fs.rmSync(tmp,{recursive:true,force:true});});
 budget.approve({ceilingMicroUsd:2000000,approvalReference:'FAKE TRANSPORT ONLY',expiresAt:new Date(Date.now()+300000).toISOString()});
 const task=sample.task,fixtures=require(base+'embedded-certification-fixtures');let requests=0,reviews=0,stage='navigate',cursor=0;
 const bodyChecks=[];const response=require('../helpers/environment-agent-response');
 const events=()=>fs.readFileSync(path.join(out,'trace.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
 const screen=()=>events().filter(e=>e.kind==='browser_observation').at(-1)?.screen;
 // This is a deterministic transport test, NOT a reasoning benchmark. Only
 // the SDK executes browser actions. This test policy is never in worker code.
 const fetchImpl=async(_url,init)=>{
  const body=JSON.parse(init.body);requests++;assert.equal(body.model,require(base+'candidates').CANDIDATES.openai.model);
  require(base+'protocol').validate('openai',body);
  const note=body.input.findLast(i=>typeof i.content==='string'&&i.content.startsWith(require(base+'wire-context').NOTICE));assert(note);
  const mem=JSON.parse(note.content.slice(require(base+'wire-context').NOTICE.length));assert(Buffer.byteLength(JSON.stringify(mem))<=8500);
  bodyChecks.push({request:requests,final:body.tool_choice==='none',facts:mem.facts.some(f=>f.data?.rows),form:mem.browser.pages.some(p=>p.fields.length>=3)});
  const tool=(name,input)=>{assert.notEqual(body.tool_choice,'none','guard must not terminate real forward progress');return response(body,requests,name,input);};
  const act=(action,ref=null,value=null)=>tool('environment_browser',{action,ref,value});
  if(requests===1)return act('inspect');
  let s=screen();
  if(stage==='navigate'){
   if(!s.controls.some(c=>c.tag==='input'&&c.type==='number')){
    const link=s.controls.find(c=>c.tag==='a'&&/worksheet/i.test(c.label));assert(link);return act('click',link.ref);
   }
   stage='contracts';return tool('environment_interfaces',{search:'',offset:0,names:['stock','inventory.receive']});
  }
  if(stage==='contracts'){stage='fill';return tool('environment_dataset',sample.events.find(e=>e.kind==='agent_tool_started'&&e.name==='environment_dataset').input);}
  if(stage==='fill'){
   assert(mem.facts[0].data?.rows,'current stock facts must accompany form contracts on every filling turn');
   if(s.text.includes('Verified worksheet preview')){stage='prepare';}
   else{
    const inputs=s.controls.filter(c=>['input','select'].includes(c.tag)&&c.type!=='hidden');
    // Values derive from the actual task's known evaluator contract. This is
    // deliberately synthetic decision-making, confined to the offline test.
    const rows=mem.facts[0].data.rows,depot=Number(rows.find(r=>r.location===task.warehouse).on_hand),cabinet=Number(rows.find(r=>r.location===task.overflow).on_hand);
    const values={'Physical units at the depot':depot,'Physical units at the cabinet':cabinet,'Physical units across locations':depot+cabinet};
    const field=inputs.find(c=>!c.value);
    if(field){const value=field.label.startsWith('Required handling')?field.options.find(o=>o.value&&s.text.includes(o.label)).value:String(values[field.label]);
     assert.notEqual(value,'undefined');return act(field.tag==='select'?'select':'fill',field.ref,value);}
    return act('click',s.controls.find(c=>c.tag==='button').ref);
   }
  }
  if(stage==='prepare'){
   stage='approval';return tool('business_operations',{stepsJson:JSON.stringify([{capability:'inventory.receive',arguments:[
    {name:'sku',value:task.sku},{name:'location',value:task.warehouse},{name:'quantity',value:task.receive},{name:'reference',value:task.reference}],dependsOn:[]}])});
  }
  if(stage==='approval'){stage='resume';return response(body,requests,null,null,'Worksheet preview completed. The requested physical-only receipt is prepared and awaits exact approval.');}
  if(stage==='resume'){assert.equal(reviews,1);stage='final';return tool('environment_dataset',sample.events.find(e=>e.kind==='agent_tool_started'&&e.name==='environment_dataset').input);}
  assert.equal(stage,'final');return response(body,requests,null,null,'The changed worksheet preview was completed. The approved six-unit physical-only receipt is recorded: depot 44, cabinet 11, total 55. No purchase cost or invoice was created.');
 };
 const result=await require(base+'run-pilot').attempt({candidate:'openai',helperProvider:'openai',task,fixtures,budget,
  certificate:{passed:true,testOnly:true,sourceHash:require(base+'certification').sourceHash(),image:JSON.parse(fs.readFileSync('data/environment-agent-demo/sandbox-certificate.json')).image},
  credentials:{openai:'FAKE'},outputDirectory:out,offlineFetch:fetchImpl,approvalPolicy:fixtures.approvalPolicy,
  approvalDecision:async({proposal})=>{reviews++;assert.equal(proposal.action_type,'inventory.receive');assert.equal(proposal.payload.quantity,task.receive);
   assert.equal(proposal.payload.reference,task.reference);return {approved:true,responded:true,responseReference:'OFFLINE TEST APPROVAL — not a real human',waitMs:0};}});
 assert.equal(result.providerMode,'OFFLINE_SYNTHETIC');assert.equal(result.status,'COMPLETED',JSON.stringify({error:result.error,answer:result.answer}));
 assert.equal(result.verifiedOutcome,true);assert(Object.values(result.verdict.checks).every(Boolean));
 assert.equal(result.verdict.discovery.formChanges,1);assert.equal(result.verdict.discovery.previewCompleted,true);
 assert.equal(reviews,1);assert.equal(result.requiredApprovalsExecuted,1);assert.equal(result.unresolvedModelCalls,0);
 assert(requests<=24);assert.equal(result.toolFailures,0);assert.equal(result.browserOperatedByAgent,true);
 const trace=events();assert(trace.some(e=>e.kind==='working_context'&&e.beforeBytes>e.afterBytes));
 const tools=trace.filter(e=>e.kind==='agent_tool_started');assert(tools.every(e=>e.sdkToolCallId?.startsWith('offline_')));assert(tools.length<=30);
 assert(!trace.some(e=>e.kind==='model_control'&&e.reason==='REPEATED_UNCHANGED_EVIDENCE'));
 const summary={integrationPassed:true,liveIntelligenceCertified:false,provider:'synthetic transport',paidCalls:0,paidCostUsd:0,
  requests,tools:tools.length,offlineApprovals:reviews,businessVerified:result.verifiedOutcome,safetyChecks:result.verdict.checks,bodyChecks,
  limitation:'Deterministic decisions exercise actual SDK/browser/gateway/approval resumption/PG plumbing. They are not an autonomous real-model success.'};
 fs.writeFileSync(path.join(out,'offline-integration-summary.json'),JSON.stringify(summary,null,2));t.diagnostic(JSON.stringify(summary));
});
