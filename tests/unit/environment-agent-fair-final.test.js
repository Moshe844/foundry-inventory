'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const base='../../scripts/environment-agent-demo/',{ExperimentBudget}=require(base+'budget');
const fixture=require('../fixtures/environment-agent-confirmation-failure');
function setup(t,allocations){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-fair-final-')),file=path.join(dir,'fake.sqlite');
 const budget=new ExperimentBudget(file,'OFFLINE ONLY');
 budget.approve({ceilingMicroUsd:1500000,allocations,approvalReference:'FAKE TRANSPORT ONLY',expiresAt:new Date(Date.now()+120000).toISOString()});
 t.after(()=>{budget.close();assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(os.tmpdir())+path.sep+'stockchief-fair-final-'));fs.rmSync(dir,{recursive:true,force:true});});
 return {budget,file,dir};
}
const allocations=['openai','claude'].map(candidate=>({candidate,ceilingMicroUsd:750000}));

test('the proposed single comparison cannot run on shared-only funding, substituted models or extra attempts',t=>{
 const runner=require(base+'run-fair-confirmation'),fixtures=require(base+'retest-fixtures');
 const certificate={sourceHash:'offline-source'},task=fixtures.createTasks()[0];
 const manifest={experiment:runner.EXPERIMENT,ceilingMicroUsd:2000000,allocations:runner.allocations(),sourceHash:certificate.sourceHash,
  tasks:[task],corpusHash:fixtures.corpusHash([task]),slots:['openai','claude'].map(candidate=>({task:task.id,candidate})),candidates:require(base+'candidates').CANDIDATES};
 assert.doesNotThrow(()=>runner.validate(manifest,certificate));
 for(const bad of [{...manifest,allocations:[{candidate:'openai',ceilingMicroUsd:1500000},{candidate:'claude',ceilingMicroUsd:500000}]},
  {...manifest,slots:[...manifest.slots,manifest.slots[0]]},{...manifest,ceilingMicroUsd:2000001},{...manifest,candidates:{openai:{model:'other'}}}])
  assert.throws(()=>runner.validate(bad,certificate),/FROZEN_FAIR_COMPARISON_MISMATCH/);
 const state={approval:manifest.corpusHash+' '+manifest.sourceHash,ceiling:2000000,remaining:2000000,expires:Date.now()+60000,stopped:0,unresolved:0};
 assert.throws(()=>runner.validate(manifest,certificate,{status:()=>state,candidateStatus:()=>state}),/INDEPENDENT_ALLOCATION_REQUIRED/);
 assert.doesNotThrow(()=>runner.validate(manifest,certificate,{status:()=>state,candidateStatus:c=>({...state,candidate:c,ceiling:1000000,sharedCeiling:2000000})}));
});

test('each candidate retains its independent allowance in either order and across restart',t=>{
 for(const order of [['openai','claude'],['claude','openai']]){
  const {budget,file}=setup(t,allocations);
  const first=budget.reserve({candidate:order[0],task:'fresh',upperBoundMicroUsd:600000});budget.settle(first,599720);
  assert.equal((budget.candidateStatus?.(order[1])||budget.status()).remaining,750000,'headroom must be the candidate allowance, not the order-dependent shared balance');
  assert.equal(budget.candidateStatus(order[0]).remaining,150280);
  const restarted=new ExperimentBudget(file,'OFFLINE ONLY');
  try{
   assert.throws(()=>restarted.reserve({candidate:order[0],task:'another',upperBoundMicroUsd:150281}),/CANDIDATE_SPENDING_CEILING/);
   assert.throws(()=>restarted.reserve({candidate:'unallocated',task:'fresh',upperBoundMicroUsd:1}),/CANDIDATE_NOT_ALLOCATED/);
   const second=restarted.reserve({candidate:order[1],task:'fresh',upperBoundMicroUsd:750000});restarted.settle(second,750000);
   assert.equal(restarted.status().committed,1349720);assert.equal(restarted.candidateStatus(order[1]).remaining,0);
  }finally{restarted.close();}
 }
});

test('saved interleaved repeats accumulate, but newly discovered screens do not force premature finalization',()=>{
 const h={},states={};for(const o of fixture.observations){require(base+'evidence').remember(h,o.name,o.input,o.result,o.id);states[o.id.split(':').at(-1)]=structuredClone(h.progress);}
 assert.ok(states['10'].stagnant>=2,'the real Home repeats must accumulate across business reads');
 assert.equal(states['11'].stagnant,0,'a newly discovered screen is real progress');
 assert.equal(states['14'].stagnant,0,'first arrival on another new screen must allow investigation');
 assert.equal(h.progress.finalReason,undefined);
 assert.ok(h.progress.repetitions>=5);
});

test('four unchanged observations from the saved screen trigger despite interleaved new contracts',()=>{
 const h={},remember=require(base+'evidence').remember,screen=fixture.observations.find(o=>o.name==='environment_browser').result;
 for(let i=0;i<5;i++){
  remember(h,'environment_browser',{action:'inspect'},screen,`screen${i}`);
  remember(h,'environment_interfaces',{search:`contract ${i}`},{operations:[{name:`contract${i}`}]},`interface${i}`);
 }
 assert.equal(h.progress.stagnant,4);assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE');
});

for(const provider of ['openai','anthropic'])test(`${provider} empty terminal is settled, accurately reported and cannot spend on SDK continuation`,async t=>{
 const {budget}=setup(t,allocations);let upstream=0,complete=0,unknown=0;const events=[];
 const relay=await require(base+'relay').createRelay({budget,credentials:{[provider]:'FAKE'},audit:e=>events.push(e),
  commercial:{begin:async()=>({}),complete:async()=>{complete++;},unknown:async()=>{unknown++;},release:async()=>{}},
  fetchImpl:async()=>{upstream++;return Response.json(provider==='anthropic'
   ?{type:'message',stop_reason:'end_turn',content:[{type:'thinking',thinking:'',signature:'synthetic'}],usage:{input_tokens:100,output_tokens:71}}
   :{object:'response',status:'completed',output:[{type:'reasoning',summary:[]}],usage:{input_tokens:100,output_tokens:71}});}});
 t.after(()=>relay.close());
 const transport=relay.grant({candidate:provider==='openai'?'openai':'claude',provider,task:'offline',goalId:'goal',ctx:{},fundingKey:'test',authorize:async()=>{}});
 let requests=0;transport.setControlSource(async()=>({request:++requests,final:true,reason:'FINAL_COST_HEADROOM'}));
 const body=provider==='anthropic'?{model:'claude-sonnet-5',max_tokens:3000,messages:[{role:'user',content:'Investigate.'}]}:
  {model:'gpt-6.1-sol',max_output_tokens:3000,input:[{role:'user',content:'Investigate.'}]};
 const url=provider==='anthropic'?transport.anthropicBaseURL+'/v1/messages':transport.openaiBaseURL+'/responses';
 const call=()=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${transport.token}`,'content-type':'application/json'},body:JSON.stringify(body)});
 const response=await call();assert.equal(response.status,400);const error=(await response.json()).error;
 assert.equal(error.code,'EMPTY_MODEL_FINAL');assert.match(error.message,/usage.*recorded/i);assert.doesNotMatch(error.message,/authentication|credential/i);
 assert.equal((await call()).status,400);assert.equal(upstream,1);assert.equal(complete,1);assert.equal(unknown,0);
 assert.equal(budget.status().calls,1);assert.equal(budget.status().unresolved,0);
 assert.equal(transport.lastBlock().code,'EMPTY_MODEL_FINAL');assert.equal(transport.lastBlock().upstreamAttempted,false);
 assert.equal(events.filter(e=>e.kind==='model_response').at(-1).empty,true);
});

test('candidate headroom, final-mode choice and unknown reservations do not leak between allocations',async t=>{
 const {budget}=setup(t,allocations);
 const paid=budget.reserve({candidate:'openai',task:'first',upperBoundMicroUsd:599720});budget.settle(paid,599720);
 let seen,upstream=0;
 const relay=await require(base+'relay').createRelay({budget,credentials:{anthropic:'FAKE'},
  commercial:{begin:async()=>({}),complete:async()=>{},unknown:async()=>{},release:async()=>{},goalRemainingMicroUsd:async()=>750000},
  fetchImpl:async()=>{upstream++;return Response.json({type:'message',stop_reason:'end_turn',content:[{type:'text',text:'Synthetic visible answer.'}],usage:{input_tokens:100,output_tokens:20}});}});
 t.after(()=>relay.close());
 const transport=relay.grant({candidate:'claude',provider:'anthropic',task:'second',goalId:'goal',ctx:{},fundingKey:'test',authorize:async()=>{}});
 transport.setControlSource(async input=>{seen=input;return {request:1,final:input.budgetFinal,reason:null};});
 // A request whose paired exploration/final bounds fit 75 cents but not the
 // old 40-cent sequential headroom. The SDK is not granted more output tokens.
 const body={model:'claude-sonnet-5',max_tokens:3000,messages:[{role:'user',content:'Untrusted observation. '.repeat(1900)}]};
 const response=await fetch(transport.anthropicBaseURL+'/v1/messages',{method:'POST',headers:{'x-api-key':transport.token,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal(response.status,200);assert.equal(seen.budgetFinal,false);assert.equal(upstream,1);
 const unknown=budget.reserve({candidate:'claude',task:'second',upperBoundMicroUsd:100000});budget.unknown(unknown,'synthetic uncertainty');
 assert.throws(()=>budget.reserve({candidate:'openai',task:'first',upperBoundMicroUsd:1}),/UNRESOLVED_MODEL_CALL/);
 assert.equal(budget.candidateStatus('openai').remaining,150280);assert.equal(budget.candidateStatus('claude').unresolved,1);
 assert.throws(()=>budget.approve({ceilingMicroUsd:1500000,allocations,approvalReference:'no refill',expiresAt:new Date(Date.now()+60000).toISOString()}),/immutable/);
});

test('invalid allocation totals and duplicate candidates cannot partially activate approval',t=>{
 const {file}=setup(t,allocations);const budget=new ExperimentBudget(file,'invalid');
 try{
  const args={ceilingMicroUsd:1500000,approvalReference:'OFFLINE',expiresAt:new Date(Date.now()+60000).toISOString()};
  for(const entries of [[],[{candidate:'openai',ceilingMicroUsd:1500001}],[allocations[0],allocations[0]],
   [{candidate:'',ceilingMicroUsd:1500000}],[{candidate:'openai',ceilingMicroUsd:0}]])
   assert.throws(()=>budget.approve({...args,allocations:entries}),/ALLOCATION/);
  assert.equal(budget.status().approval,null);assert.equal(budget.status().ceiling,0);
 }finally{budget.close();}
});

test('state changes, failed-screen recovery and canonical changes allow fresh rechecks; note and historical replay do not',()=>{
 const {remember}=require(base+'evidence'),h={};
 const browser=(text,ref='r',status=200)=>({url:'http://local/unknown',text,httpStatus:status,controls:[{ref,label:'Observed control'}]});
 const read=(quantity)=>({outcomes:[{capability:'read.inventory',result:{rows:[{onHand:quantity}]}}]});
 const input={steps:[{capability:'read.inventory',arguments:[{name:'search',value:'random'}],dependsOn:[]}]};
 remember(h,'business_operations',input,read(9),'read1');
 remember(h,'environment_browser',{},browser('nine'),'a');
 for(let i=0;i<3;i++){
  remember(h,'environment_notebook',{note:`Hypothesis ${i}`},{saved:true,note:`Hypothesis ${i}`},`n${i}`);
  remember(h,'environment_interfaces',{search:`unfamiliar ${i}`},{operations:[{name:`contract${i}`}]},`i${i}`);
  remember(h,'environment_browser',{},browser('nine',`new-ref${i}`),`r${i}`);
 }
 assert.equal(h.progress.stagnant,3);
 remember(h,'business_operations',input,read(7),'changed');assert.equal(h.progress.stagnant,0);
 remember(h,'environment_browser',{action:'refresh'},browser('seven'),'fresh');assert.equal(h.progress.stagnant,0);
 remember(h,'environment_browser',{},browser('error','error-ref',500),'error');
 remember(h,'environment_browser',{},browser('seven'),'recovered');assert.equal(h.progress.stagnant,0);
 for(let i=0;i<4;i++){
  remember(h,'environment_notebook',{}, {saved:true,token:i},`note${i}`);
  remember(h,'environment_browser',{},browser('seven'),`repeat${i}`);
 }
 assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE');
 // A changed live record invalidates the stagnation conclusion. Merely seeing
 // an old journal entry with a different timestamp must not do so.
 remember(h,'environment_evidence',{}, {records:[{path:'',value:{onHand:9}}],observedAt:'later'},'historical');
 assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE');
 remember(h,'business_operations',input,read(12),'external-change');assert.equal(h.progress.finalReason,undefined);
 assert.equal(h.progress.stagnant,0);
});

test('alternating previously observed pages cannot defeat repetition detection',()=>{
 const h={},remember=require(base+'evidence').remember;
 for(let i=0;i<6;i++)remember(h,'environment_browser',{action:'click'},{url:`http://local/page${i%2}`,text:`Page ${i%2}`,controls:[]},String(i));
 assert.equal(h.progress.repetitions,4);assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE');
});

test('changed screenshot pixels permit a recheck even when the visible DOM text is unchanged',()=>{
 const h={},remember=require(base+'evidence').remember,screen={url:'http://local/canvas',text:'Graph',controls:[]};
 const capture=bytes=>({screen,image:{base64:Buffer.from(bytes).toString('base64'),mimeType:'image/png'}});
 remember(h,'environment_browser',{action:'screenshot'},capture('first rendered state'),'s1');
 for(let i=0;i<3;i++)remember(h,'environment_browser',{action:'inspect'},screen,`inspect${i}`);
 assert.equal(h.progress.stagnant,3);
 remember(h,'environment_browser',{action:'screenshot'},capture('changed rendered state'),'changed');assert.equal(h.progress.stagnant,0);
 remember(h,'environment_browser',{action:'inspect'},screen,'again');assert.equal(h.progress.stagnant,1);
});

test('streamed whitespace and reasoning are empty; visible text, refusals and real tool calls are not',()=>{
 const {UsageParser}=require(base+'wire-policy');
 const stream=blocks=>[{type:'message_start',message:{usage:{input_tokens:100,output_tokens:0}}},
  ...blocks.flatMap((b,i)=>[{type:'content_block_start',index:i,content_block:b},
   {type:'content_block_delta',index:i,delta:b.type==='text'?{type:'text_delta',text:b.text}:{type:'signature_delta',signature:'synthetic'}},
   {type:'content_block_stop',index:i}]),
  {type:'message_delta',delta:{stop_reason:blocks.some(b=>b.type==='tool_use')?'tool_use':'end_turn'},usage:{output_tokens:71}},{type:'message_stop'}];
 for(const [blocks,empty]of [[[{type:'thinking',thinking:'',signature:''}],true],[[{type:'text',text:' \n'}],true],
  [[{type:'text',text:'Visible 🙂'}],false],[[{type:'tool_use',name:'environment_browser',id:'t',input:{}}],false]]){
  const parser=new UsageParser('anthropic'),encoded=Buffer.from(stream(blocks).map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
  for(const byte of encoded)parser.append(Buffer.of(byte));
  assert.equal(parser.finish().outputTokens,71);assert.equal(parser.response.result().empty,empty);
 }
 for(const [output,status,empty]of [[[{type:'reasoning',summary:[]}],'incomplete',true],
  [[{type:'message',content:[{type:'refusal',refusal:'I cannot execute that.'}]}],'completed',false],
  [[{type:'function_call',name:'environment_browser'}],'completed',false]]){
  const parser=new UsageParser('openai');parser.append(Buffer.from(JSON.stringify({object:'response',status,output,usage:{input_tokens:100,output_tokens:71}})));
  parser.finish();assert.equal(parser.response.result().empty,empty);
 }
});

for(const candidate of ['openai','claude'])test(`${candidate} native SDK empty final uses a zero-call verified or explicitly incomplete host report`,{timeout:45000},async t=>{
 const {budget,dir}=setup(t,allocations),provider=candidate==='openai'?'openai':'anthropic';
 let upstream=0,unknown=0;const events=[];
 const relay=await require(base+'relay').createRelay({budget,credentials:{[provider]:'FAKE'},audit:e=>events.push(e),
  commercial:{begin:async()=>({}),complete:async()=>{},unknown:async()=>{unknown++;},release:async()=>{}},
  fetchImpl:async()=>{
   upstream++;
   // Match the recorded end_turn, 71-token, thinking-only response shape.
   const body=provider==='anthropic'
    ?[{type:'message_start',message:{id:'offline',type:'message',role:'assistant',model:'claude-sonnet-5',content:[],usage:{input_tokens:100,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
      {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'synthetic'}},{type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:fixture.diagnosis.lastPaidResponse.outputTokens}},{type:'message_stop'}]
    :[{type:'response.completed',response:{id:'offline',object:'response',model:'gpt-6.1-sol',status:'completed',output:[{type:'reasoning',summary:[]}],usage:{input_tokens:100,output_tokens:71}}}];
   return new Response(body.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  }});
 t.after(()=>relay.close());
 for(const verified of [false,true]){
  const start=upstream,native={},responses=[];let stopped=0;
  const transport=relay.grant({candidate,provider,task:'offline',goalId:'goal',ctx:{},fundingKey:'test',authorize:async()=>{}});
  const session={load:async()=>({native}),checkpoint:async v=>Object.assign(native,v),
   modelControl:async()=>({request:1,final:true,reason:'FINAL_COST_HEADROOM'}),modelResponse:async o=>responses.push(o),
   completeIfVerified:async()=>verified&&upstream>start?{answer:'Host independently verified the existing outcome.',completionSource:'host_verified_receipt'}:null,
   stop:async({code})=>{stopped++;assert.equal(code,'EMPTY_MODEL_FINAL');return {answer:'Existing evidence does not verify the full goal.',status:'BLOCKED'};}};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000),privateDir=path.join(dir,String(verified));fs.mkdirSync(privateDir);
  let result;
  try{result=await require(base+'worker').run({candidate,session,budget,transport,isolationCertificate:{passed:true,testOnly:true},goal:'Offline protocol only.',
   privateHarnessDirectory:privateDir,abortController:controller,signal:controller.signal,browser:{},gateway:{authorize:async()=>{}},
   sandbox:{state:{manifest:new (require('@openai/agents/sandbox').Manifest)({root:'/workspace'}),workspaceReady:true}}});}
  finally{clearTimeout(timer);controller.abort();}
  assert.equal(upstream,start+1,'no native SDK paid continuation or retry');
  assert.equal(responses.length,1);assert.equal(responses[0].empty,true);assert.equal(responses[0].usageSettled,true);
  assert.equal(stopped,verified?0:1);assert.equal(result.interruption.code,'EMPTY_MODEL_FINAL');
  if(verified)assert.equal(result.completionSource,'host_verified_receipt');
  else {assert.equal(result.status,'BLOCKED');assert.match(result.interruption.message,/provider ended without a visible/);}
 }
 assert.equal(unknown,0);assert.equal(budget.status().unresolved,0);assert.equal(upstream,2);
 const blocks=events.filter(e=>e.kind==='model_call_blocked');
 assert.equal(blocks.filter(e=>e.upstreamAttempted).length,2);
 assert.ok(blocks.every(e=>e.reason==='EMPTY_MODEL_FINAL'));
 // This pinned Claude SDK also attempts a local non-streaming fallback after
 // a 400. It is rejected before reservation, with the same accurate reason.
 assert.ok(blocks.filter(e=>!e.upstreamAttempted).every(e=>e.id===null));
});
