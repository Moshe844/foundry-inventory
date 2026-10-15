'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ExperimentBudget}=require('../../scripts/environment-agent-demo/budget'),{createRelay}=require('../../scripts/environment-agent-demo/relay');
const wire=require('../../scripts/environment-agent-demo/wire-policy'),conversation=require('../../src/assistant/agent-conversation'),recorded=require('../fixtures/codex-provider-timeout.json');
async function setup(t,{upstream,complete=async()=>{}}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-timeout-')),filename=path.join(dir,'budget.sqlite'),budget=new ExperimentBudget(filename,'offline-timeout');
 budget.approve({ceilingMicroUsd:1000000,approvalReference:'OFFLINE ONLY',expiresAt:new Date(Date.now()+60000).toISOString()});let calls=0,unknowns=0;
 const reopened=[];const relay=await createRelay({budget,credentials:{openai:'FAKE'},allowedProviders:['openai'],timeoutMs:50,
  commercial:{begin:async()=>({}),complete,unknown:async()=>{unknowns++;},release:async()=>{}},
  fetchImpl:async(url,init)=>{calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init.redirect,'error');assert.equal(budget.status().unresolved,1);return upstream(init);}});
 const transport=relay.grant({candidate:'openai',task:'offline-timeout',provider:'openai',authorize:async()=>{},fundingKey:'offline',goalId:'offline-goal',ctx:{workspaceId:'offline',actorId:'offline'}});
 t.after(async()=>{await relay.close();for(const handle of reopened)handle.close();budget.close();const target=fs.realpathSync(dir);assert(target.startsWith(fs.realpathSync(os.tmpdir())+path.sep+'stockchief-timeout-'));fs.rmSync(target,{recursive:true,force:true});});
 const call=()=>fetch(transport.openaiBaseURL+'/responses',{method:'POST',headers:{authorization:'Bearer '+transport.token,'content-type':'application/json'},body:JSON.stringify({model:wire.MODELS.openai,input:'Read the authorized records.',max_output_tokens:100})});
 return {budget,filename,call,transport,reopened,calls:()=>calls,unknowns:()=>unknowns};
}
test('recorded provider timeout before headers retains a named, correlated full hold; another call and restart cannot spend',async t=>{
 const s=await setup(t,{upstream:init=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('The operation was aborted due to timeout','TimeoutError')),{once:true}))});
 const response=await s.call();assert.equal(response.status,403);assert(!JSON.stringify(await response.json()).includes('TimeoutError'));
 const row=s.budget.db.prepare('SELECT * FROM experiment_calls').get(),detail=JSON.parse(row.detail);assert.equal(row.state,'UNKNOWN');assert.equal(row.charged,null);assert.equal(s.budget.status().committed,row.reserved);
 assert.equal(detail.reason,'PROVIDER_REQUEST_TIMEOUT');assert.equal(detail.model,wire.MODELS.openai);assert.equal(detail.provider,'openai');assert.equal(detail.transport.phase,'request');assert.equal(detail.transport.clientRequestId,row.id);assert.equal(detail.transport.receivedBytes,0);assert(detail.timings.providerMs>=40);
 assert.equal(s.transport.lastBlock().limitKind,'provider_transport');assert.equal(s.unknowns(),1);assert.equal((await s.call()).status,403);assert.equal(s.calls(),1);
 const reopened=new ExperimentBudget(s.filename,'offline-timeout');s.reopened.push(reopened);assert.equal(reopened.status().unresolved,1);assert.throws(()=>reopened.reserve({candidate:'openai',task:'other',upperBoundMicroUsd:1}),/UNRESOLVED_MODEL_CALL/);
});
test('partial SSE timeout keeps safe header and response IDs, never exposes or executes unfinished output',async t=>{
 let clientId;
 const s=await setup(t,{upstream:async init=>{clientId=init.headers['x-client-request-id'];return new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.from('data: '+JSON.stringify({type:'response.created',response:{id:'resp_offline_partial',object:'response',status:'in_progress',output:[]}})+'\n\n'));init.signal.addEventListener('abort',()=>controller.error(new DOMException('Timeout','TimeoutError')),{once:true});}}),{headers:{'content-type':'text/event-stream','x-request-id':'req_offline_partial','set-cookie':'PRIVATE_COOKIE'}});}});
 assert.equal((await s.call()).status,403);const row=s.budget.db.prepare('SELECT * FROM experiment_calls').get(),d=JSON.parse(row.detail);
 assert.equal(d.reason,'PROVIDER_REQUEST_TIMEOUT');assert.equal(d.transport.clientRequestId,clientId);assert.equal(clientId,row.id);assert.equal(d.transport.phase,'body');assert.equal(d.transport.providerRequestId,'req_offline_partial');assert.equal(d.transport.providerResponseId,'resp_offline_partial');assert(d.transport.receivedBytes>0);assert(d.timings.firstByteMs>=0);assert.equal(d.usage,undefined);assert.equal(s.transport.lastResponse(),null);assert(!row.detail.includes('PRIVATE_COOKIE'));assert(!row.detail.includes('FAKE'));
});
test('a local settlement failure retains the genuine provider receipt and is not misclassified as provider timeout',async t=>{
 const s=await setup(t,{upstream:async()=>Response.json({object:'response',id:'resp_offline_complete',status:'completed',model:wire.MODELS.openai,usage:{input_tokens:100,output_tokens:3},output:[]}),complete:async()=>{throw Error('LOCAL_SETTLEMENT_INTERRUPTED');}});
 assert.equal((await s.call()).status,403);const d=JSON.parse(s.budget.db.prepare('SELECT detail FROM experiment_calls').get().detail);
 assert.equal(d.reason,'LOCAL_SETTLEMENT_INTERRUPTED');assert.equal(d.transport.phase,'settlement');assert.equal(d.transport.providerResponseId,'resp_offline_complete');assert.equal(d.usage.input_tokens,100);assert.match(d.accounting,/local settlement requires reconciliation/);assert.equal(s.transport.lastResponse(),null);
});
test('actual recorded legacy code 23 plus pending native delivery becomes a non-resumable accounting pause, preserving real approvals',()=>{
 assert.equal(recorded.providerDeadlineMs,120000);assert.equal(recorded.settledBeforeFailure,2);
 const goal={id:'recorded-timeout',status:'BLOCKED',answer:'The investigation stopped before final verification.',checkpoint:{harness:{interruption:recorded.interruption,codexDelivery:recorded.codexDelivery}}};
 let state=conversation.state(goal);assert.equal(state.phase,'usage_review');assert.equal(state.canReply,false);assert.equal(state.active,false);assert.equal(state.terminal,false);assert.match(state.message,/usage is checked/);assert.match(state.message,/no automatic retry/);assert(!state.message.includes('23'));
 conversation.sync(goal);state=conversation.state(JSON.parse(JSON.stringify(goal)));assert.equal(state.phase,'usage_review');assert.equal(state.input,null);
 goal.checkpoint.harness.completionSource='partial_verified_receipt';goal.answer='The earlier approved receipt remains recorded.';assert(conversation.state(goal).message.startsWith(goal.answer));
 goal.status='WAITING_APPROVAL';assert.equal(conversation.state(goal).phase,'approval');goal.status='WAITING_USER';goal.checkpoint.harness.userQuestion={question:'Which destination?',missingInformation:['Destination']};assert.equal(conversation.state(goal).phase,'clarification');
 goal.status='COMPLETED';assert.equal(conversation.state(goal).phase,'completed');
});
