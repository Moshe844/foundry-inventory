'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const wire=require('../../scripts/environment-agent-demo/wire-policy');
const request={model:wire.MODELS.openai,input:[{role:'user',content:[{type:'input_text',text:'Unfamiliar request.'}]}]};
test('priced cache lifetime preserves default and explicit 30-minute caching without changing history',()=>{
 for(const options of [undefined,{ttl:'30m'},{mode:'explicit',ttl:'30m'}]){
  const input={...request,...(options?{prompt_cache_options:options}:{})},normal=wire.normalize('openai',input);
  assert.deepEqual(normal.body.input,input.input);assert.deepEqual(normal.body.prompt_cache_options,options);
 }
 const input=structuredClone(request);input.prompt_cache_retention='24h';input.input[0].content[0].prompt_cache_breakpoint={mode:'explicit',ttl:'30m'};
 assert.deepEqual(wire.normalize('openai',input).body.input,input.input);
 assert.equal(wire.normalize('openai',input).body.prompt_cache_retention,'24h');
});
test('unpriced lifetimes cannot enter through a request or nested content breakpoint in any native profile',()=>{
 const policies=Object.keys(require('../../scripts/environment-agent-demo/codex-models').profiles).map(id=>require('../../scripts/environment-agent-demo/codex-wire').forProfile(id));
 for(const p of policies){const base={...request,model:p.MODEL,reasoning:{effort:p.EFFORT}};
  for(const ttl of ['12h','1h','unexpected']){
   assert.throws(()=>p.normalize({...base,prompt_cache_options:{ttl}}),/UNPRICED_CACHE_LIFETIME/);
   const input=structuredClone(base);input.input[0].content[0].prompt_cache_breakpoint={ttl};assert.throws(()=>p.normalize(input),/UNPRICED_CACHE_LIFETIME/);
  }
 }
});
test('receipts validate cache-write lifetime splits and reject any unpriced long write before settlement',()=>{
 const usage=(details,writes=30)=>wire.usage('openai',[{object:'response',usage:{input_tokens:100,output_tokens:5,input_tokens_details:{cached_tokens:20,cache_write_tokens:writes,...(details?{cache_write_tokens_details:details}:{})}}}]);
 assert.equal(usage({ttl_30m_tokens:30,ttl_12h_tokens:0}).cacheWrite5mTokens,30);
 assert.equal(usage(null).cacheWrite5mTokens,30,'Older receipts without lifetime fields remain compatible with the priced request policy');
 assert.throws(()=>usage({ttl_30m_tokens:20,ttl_12h_tokens:10}),/UNPRICED_CACHE_LIFETIME/);
 for(const d of [{ttl_30m_tokens:30},{ttl_30m_tokens:29,ttl_12h_tokens:0},{ttl_30m_tokens:-1,ttl_12h_tokens:31},{ttl_30m_tokens:30,ttl_12h_tokens:'0'}])assert.throws(()=>usage(d),/INVALID_CACHE_USAGE/);
});
test('the real relay blocks unpriced cache requests before spending and holds an unexpected long-write receipt as unknown',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cache-lifetime-test-'));
 const budget=new(require('../../scripts/environment-agent-demo/budget').ExperimentBudget)(path.join(dir,'budget.sqlite'),'offline');
 budget.approve({ceilingMicroUsd:1000000,approvalReference:'OFFLINE FAKE ONLY',expiresAt:new Date(Date.now()+60000).toISOString()});
 let calls=0,settlements=0,unknown=0;
 const relay=await require('../../scripts/environment-agent-demo/relay').createRelay({budget,credentials:{openai:'FAKE'},allowedProviders:['openai'],
  commercial:{begin:async x=>x,complete:async()=>{settlements++;},unknown:async()=>{unknown++;},release:async()=>{}},
  fetchImpl:async()=>{calls++;return Response.json({object:'response',status:'completed',model:wire.MODELS.openai,output:[],usage:{input_tokens:100,output_tokens:5,input_tokens_details:{cache_write_tokens:30,cache_write_tokens_details:{ttl_30m_tokens:20,ttl_12h_tokens:10}}}});}});
 t.after(async()=>{await relay.close();budget.close();fs.rmSync(dir,{recursive:true,force:true});});
 const transport=relay.grant({candidate:'offline',task:'offline',provider:'openai',authorize:async()=>{},fundingKey:'offline',goalId:'offline',ctx:{workspaceId:'offline',actorId:'offline'}});
 const send=body=>fetch(transport.openaiBaseURL+'/responses',{method:'POST',headers:{authorization:'Bearer '+transport.token,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await send({...request,prompt_cache_options:{ttl:'12h'}})).status,403);assert.equal(calls,0);assert.equal(budget.status().calls,0);
 assert.equal((await send({...request,prompt_cache_options:{ttl:'30m'}})).status,403);assert.equal(calls,1);assert.equal(settlements,0);assert.equal(unknown,1);assert.equal(budget.status().unresolved,1);
 const held=budget.status().committed;assert(held>0);assert.equal((await send(request)).status,403);assert.equal(calls,1);assert.equal(budget.status().committed,held);
});
