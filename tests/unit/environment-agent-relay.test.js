'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {ExperimentBudget}=require('../../scripts/environment-agent-demo/budget');
const {createRelay}=require('../../scripts/environment-agent-demo/relay');
const wire=require('../../scripts/environment-agent-demo/wire-policy');
const request={model:wire.MODELS.anthropic,max_tokens:100,messages:[{role:'user',content:'Inspect current stock.'}]};
test('native progress-display beta is normalized and encrypted thinking receives a full prior-output token bound',()=>{
 const normal=wire.normalize('anthropic',request);
 assert.equal(normal.body.service_tier,'standard_only');
 const signed=wire.normalize('anthropic',{...request,thinking:{type:'adaptive',display:'updates'},messages:[
  ...request.messages,{role:'assistant',content:[{type:'thinking',thinking:'',signature:'opaque'}]}]});
 assert.equal(signed.body.thinking.display,'omitted');assert.ok(signed.inputTokens>=normal.inputTokens+3000);
 const open=wire.normalize('openai',{model:wire.MODELS.openai,input:[]});
 const encrypted=wire.normalize('openai',{model:wire.MODELS.openai,input:[{type:'reasoning',encrypted_content:'opaque',summary:[]}]});
 assert.ok(encrypted.inputTokens>=open.inputTokens+3000);
});
async function setup(t,{upstream,commercialOverrides={},ceiling=10000000,allowedProviders,provider='anthropic'}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-relay-'));const filename=path.join(dir,'budget.sqlite');
 const budget=new ExperimentBudget(filename,'offline');
 budget.approve({ceilingMicroUsd:ceiling,approvalReference:'LOCAL FAKE PROVIDER TEST ONLY',expiresAt:new Date(Date.now()+60000).toISOString()});
 const events=[];let calls=0;
 const commercial={begin:async call=>{events.push('commercial_reserved');return call;},complete:async()=>{events.push('commercial_settled');},
  unknown:async()=>events.push('commercial_unknown'),release:async()=>events.push('commercial_released'),...commercialOverrides};
 const relay=await createRelay({budget,credentials:{anthropic:'FAKE_SECRET_NEVER_NETWORKED',openai:'FAKE_SECRET'},commercial,allowedProviders,
  fetchImpl:async(url,options)=>{calls++;assert.ok(budget.status().unresolved);assert.equal(options.redirect,'error');
   events.push('upstream');return upstream?upstream(url,options):Response.json({type:'message',usage:{input_tokens:100,output_tokens:30},content:[]});}});
 const transport=relay.grant({candidate:provider==='openai'?'openai':'claude',task:'offline',provider,authorize:async()=>events.push('authority'),
  fundingKey:'funded',goalId:'goal',ctx:{workspaceId:'workspace',actorId:'actor'}});
 t.after(async()=>{await relay.close();budget.close();fs.rmSync(dir,{recursive:true,force:true});});
 const call=(body=request,token=transport.token)=>fetch(provider==='openai'?transport.openaiBaseURL+'/responses':transport.anthropicBaseURL+'/v1/messages',{
  method:'POST',headers:{'x-api-key':token,'content-type':'application/json'},body:JSON.stringify(body)});
 return {budget,events,call,calls:()=>calls,filename,transport};
}
test('relay settles before releasing output, includes retries, and persists across reopen',async t=>{
 const s=await setup(t);assert.equal((await s.call()).status,200);assert.equal((await s.call()).status,200);
 assert.equal(s.calls(),2);assert.equal(s.budget.status().committed,1400);
 assert.deepEqual(s.events.slice(0,4),['authority','commercial_reserved','upstream','commercial_settled']);
 const reopened=new ExperimentBudget(s.filename,'offline');assert.equal(reopened.status().committed,1400);reopened.close();
});
test('invalid credentials, model, hosted context, and commercial rejection make zero upstream calls',async t=>{
 const s=await setup(t,{commercialOverrides:{begin:async()=>{throw new Error('GOAL_BUDGET');}}});
 for(const body of [{...request,model:'unapproved'},{...request,mcp_servers:[{url:'https://evil.test'}]},
  {...request,max_tokens:3001},{...request,tools:[{type:'web_search_20250305'}]}])assert.equal((await s.call(body)).status,403);
 assert.equal((await s.call(request,'bad-token')).status,403);
 assert.equal((await s.call()).status,403);assert.equal(s.calls(),0);assert.equal(s.budget.status().committed,0);
});
test('uncertain HTTP outcome retains full reservation and prevents all subsequent spend',async t=>{
 const s=await setup(t,{upstream:async()=>{throw new Error('LOST_RECEIPT');}});
 assert.equal((await s.call()).status,403);const state=s.budget.status();assert.ok(state.committed>0);assert.equal(state.unresolved,1);
 assert.equal((await s.call()).status,403);assert.equal(s.calls(),1);assert.equal(s.budget.status().committed,state.committed);
});
test('an underfunded shared ceiling prevents even the first provider call',async t=>{
 const s=await setup(t,{ceiling:1});assert.equal((await s.call()).status,403);assert.equal(s.calls(),0);
 assert.equal(s.transport.lastBlock().upstreamAttempted,false);assert(s.transport.lastBlock().reservationMicroUsd>0);assert.equal(s.transport.lastBlock().reservationMicroUsd,wire.normalize('anthropic',request).upperBoundMicroUsd);
});

test('OpenAI-only certification rejects an Anthropic helper before reserving funds or contacting any provider',async t=>{
 const s=await setup(t,{allowedProviders:['openai']});
 assert.equal((await s.call()).status,403);assert.equal(s.calls(),0);
 assert.equal(s.budget.status().calls,0);assert.deepEqual(s.events,[]);
});
test('concurrent requests serialize; no second provider request can cross the gate',async t=>{
 let release;const wait=new Promise(resolve=>{release=resolve;});
 const s=await setup(t,{upstream:async()=>{await wait;return Response.json({type:'message',usage:{input_tokens:10,output_tokens:10}});}});
 const first=s.call();while(!s.calls())await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal((await s.call()).status,403);release();assert.equal((await first).status,200);assert.equal(s.calls(),1);
});
test('stream parser handles split UTF-8, cache creation durations, and missing terminal receipts',()=>{
 const parser=new wire.UsageParser('anthropic');
 const text='event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{usage:{input_tokens:10,output_tokens:0,
  cache_creation_input_tokens:70,cache_creation:{ephemeral_1h_input_tokens:50},cache_read_input_tokens:20}}})+
  '\n\nevent: message_delta\ndata: '+JSON.stringify({type:'message_delta',usage:{output_tokens:5}})+
  '\n\ndata: {"type":"message_stop"}\n\n';
 for(const byte of Buffer.from(text))parser.append(Uint8Array.of(byte));
 const receipt=parser.finish();assert.equal(receipt.inputTokens,100);assert.equal(receipt.cacheWrite5mTokens,20);assert.equal(receipt.cacheWrite1hTokens,50);
 const partial=new wire.UsageParser('anthropic');partial.append(Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
 assert.throws(()=>partial.finish(),/UNKNOWN_USAGE/);
 const openai=new wire.UsageParser('openai');openai.append(Buffer.from(JSON.stringify({object:'response',usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:50}}})));
 assert.equal(openai.finish().inputTokens,100);
});
test('usage exceeding its token reservation stops the experiment, without releasing output',async t=>{
 const s=await setup(t,{upstream:async()=>Response.json({type:'message',usage:{input_tokens:999999,output_tokens:30}})});
 assert.equal((await s.call()).status,403);assert.equal(s.budget.status().stopped,1);assert.equal(s.budget.status().unresolved,1);
});

test('failed OpenAI responses retain verified usage but never become successful output',async t=>{
 const s=await setup(t,{provider:'openai',upstream:async()=>new Response('data: '+JSON.stringify({type:'response.failed',response:{object:'response',id:'resp_fixture',status:'failed',model:wire.MODELS.openai,error:{code:'server_error',message:'private provider text'},usage:{input_tokens:20,output_tokens:3},output:[]}})+'\n\n',{headers:{'content-type':'text/event-stream'}})});
 const body={model:wire.MODELS.openai,input:[{role:'user',content:'Inspect current stock.'}],max_output_tokens:100};assert.equal((await s.call(body)).status,403);assert.equal(s.calls(),1,JSON.stringify(s.transport.lastBlock()));assert.equal(s.budget.status().unresolved,0);assert.equal(s.budget.status().committed,145);assert(s.events.includes('commercial_settled'));assert.equal(s.transport.lastBlock().code,'PROVIDER_RESPONSE_FAILED');assert.equal(s.transport.lastBlock().usageSettled,true);assert.equal((await s.call(body)).status,403);assert.equal(s.calls(),1,'a settled failure is not permission for an automatic paid retry');assert.equal(s.budget.status().committed,145);
});

test('missing failure usage stays held and diagnostics expose only bounded protocol metadata',()=>{
 const p=new wire.UsageParser('openai');p.append(Buffer.from('data: '+JSON.stringify({type:'response.failed',response:{object:'response',status:'failed',error:{code:'server_error',message:'DO_NOT_LOG_PRIVATE_MESSAGE'},usage:null,output:[]}})+'\n\n'));
 assert.throws(()=>p.finish(),/UNKNOWN_USAGE/);assert.deepEqual(p.diagnostics(),{eventCount:1,streamEnded:true,terminalStatus:'failed',failureCode:'server_error',usagePresent:false});assert(!JSON.stringify(p.diagnostics()).includes('DO_NOT_LOG'));assert.equal(p.response.result().failed,true);
 const partial=new wire.UsageParser('openai');partial.append(Buffer.from('data: {"type":"response.created","response":{"status":"in_progress"}}\n\n'));assert.throws(()=>partial.finish(),/UNKNOWN_USAGE/);assert.equal(partial.diagnostics().terminalStatus,null);
});
