'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const base='../../scripts/environment-agent-demo/',wire=require(base+'codex-wire');
const request={model:wire.MODEL,reasoning:{effort:wire.EFFORT},input:[{role:'user',content:'Inspect the environment.'}]};
test('Codex transport preserves native context and selected effort, while enforcing existing limits',()=>{
 const input={...request,input:[...request.input,{role:'assistant',content:'a'.repeat(20000)}]};
 const result=wire.normalize(input);
 assert.deepEqual(result.body.input,input.input);assert.equal(result.body.reasoning.effort,wire.EFFORT);
 assert.equal(result.body.max_output_tokens,3000);assert.equal(result.body.store,false);assert.equal(result.body.service_tier,'default');
 assert.equal(result.upperBoundMicroUsd,null);assert.equal(result.inputTokens,null,'no byte-based token admission');
 for(const bad of [{model:'unapproved-model'},{reasoning:{effort:'low'}},{max_output_tokens:3001},{previous_response_id:'hidden'},
  {tools:[{type:'web_search'}]},{input:[{type:'compaction',encrypted_content:'unknown'}]}])assert.throws(()=>wire.normalize({...request,...bad}));
 assert.throws(()=>wire.receipt({returnedModel:'different'}),/RETURNED_MODEL/);
 assert.throws(()=>wire.normalize({...request,input:[{type:'additional_tools',tools:[{type:'namespace',tools:[{type:'web_search'}]}]}]}),/HOSTED_TOOLS_DISABLED/);
 assert.deepEqual(wire.countRequest(result.body).input,input.input);
 for(const count of [0,-1,NaN,1.5,180001])assert.throws(()=>wire.counted(result,{object:'response.input_tokens',input_tokens:count}),/TOKEN_COUNT/);
});
test('token preflight sends identical native model inputs and fails closed without retries',async()=>{
 let calls=0;
 const counted=wire.countRequest(wire.normalize(request).body);
 const counter=require(base+'codex-token-counter').createTokenCounter({apiKey:'FAKE',fetchImpl:async(url,init)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/responses/input_tokens');assert.equal(init.redirect,'error');
  assert.deepEqual(JSON.parse(init.body),counted);return Response.json({object:'response.input_tokens',input_tokens:4321});
 }});
 const r=wire.counted(wire.normalize(request),await counter(counted));assert.equal(r.inputTokens,4321);assert.equal(calls,1);
 const denied=require(base+'codex-token-counter').createTokenCounter({apiKey:'FAKE',fetchImpl:async()=>{calls++;return new Response('',{status:400});}});
 await assert.rejects(()=>denied(counted),/TOKEN_COUNT_UNAVAILABLE/);assert.equal(calls,2);
});
test('native state digest survives PostgreSQL JSONB key ordering',()=>{
 const {digest}=require(base+'codex-runtime');assert.equal(digest({b:'two',a:'one'}),digest({a:'one',b:'two'}));
});
test('Codex calls, restart, denied compaction and uncertain retry all share the existing durable ledger',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-codex-wire-'));let calls=0,fail=false,count=0;
 const {ExperimentBudget}=require(base+'budget');let budget=new ExperimentBudget(path.join(dir,'budget.db'),'offline-codex');
 budget.approve({ceilingMicroUsd:1000000,approvalReference:'FAKE TRANSPORT ONLY',expiresAt:new Date(Date.now()+60000).toISOString()});
 const commercial={begin:async c=>{assert.equal(c.body.model,wire.MODEL);return c;},complete:async()=>{},unknown:async()=>{},release:async()=>{}};
 const relay=await require(base+'relay').createRelay({budget,credentials:{openai:'FAKE'},commercial,
  countCodexInput:async()=>({object:'response.input_tokens',input_tokens:10000}),fetchImpl:async(_url,init)=>{
  calls++;assert.equal(budget.status().unresolved,1);if(fail)throw Error('connection lost');
  return require('../helpers/environment-agent-response')(JSON.parse(init.body),calls,null,null,'Observed result.');
 }});
 t.after(async()=>{await relay.close();budget.close();fs.rmSync(dir,{recursive:true,force:true});});
 const grant=()=>relay.grant({candidate:'codex',provider:'openai',task:'offline',goalId:'goal',ctx:{workspaceId:'w',actorId:'a'},fundingKey:'f',
  authorize:async()=>{},wireProfile:'codex',requestGate:async()=>{count++;}});
 let transport=grant();
 const call=(suffix='/responses')=>fetch(transport.openaiBaseURL+suffix,{method:'POST',headers:{authorization:`Bearer ${transport.token}`,'content-type':'application/json'},body:JSON.stringify(request)});
 assert.equal((await call()).status,200);assert.equal(calls,1);assert.equal(count,1);
 assert.equal((await call('/responses/compact')).status,403);assert.equal(calls,1);assert.equal(count,1);
 assert.equal(transport.lastBlock().code,'CODEX_COMPACTION_UNBOUNDED_OUTPUT');
 const reopen=new ExperimentBudget(path.join(dir,'budget.db'),'offline-codex');assert.equal(reopen.status().committed,budget.status().committed);reopen.close();
 transport.revoke();transport=grant();fail=true;
 assert.equal((await call()).status,403);const exposure=budget.status().committed;
 assert.equal((await call()).status,403);assert.equal(calls,2);assert.equal(budget.status().committed,exposure);assert.equal(budget.status().unresolved,1);
});
test('live Codex execution is blocked pending certification even when a historical budget exists',async()=>{
 const old=process.env.STOCKCHIEF_CODEX_SDK_DEMO;process.env.STOCKCHIEF_CODEX_SDK_DEMO='1';
 try{await assert.rejects(()=>require(base+'codex-runtime').run({}),/CODEX_LIVE_NOT_CERTIFIED/);}finally{if(old===undefined)delete process.env.STOCKCHIEF_CODEX_SDK_DEMO;else process.env.STOCKCHIEF_CODEX_SDK_DEMO=old;}
});
