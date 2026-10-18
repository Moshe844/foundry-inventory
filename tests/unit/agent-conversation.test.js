'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const contract=require('../../src/assistant/agent-conversation'),trace=require('../fixtures/recorded-sales-clarification.json');

test('recorded post-approval exhaustion keeps the executed receipt and stops offering an exhausted continuation',()=>{
 const goal={id:'recorded-boundary',status:'BLOCKED',answer:'The approved email was executed and verified.',checkpoint:{lifecycleStage:'verification',harness:{completionSource:'partial_verified_receipt',admissionBlock:{code:'DURABLE_TOOL_LIMIT'},interruption:{code:'rate_limited'}}}};
 const state=contract.state(goal);assert.equal(state.phase,'goal_limit');assert.equal(state.active,false);assert.equal(state.canReply,false);assert.match(state.message,/email was executed and verified/);assert.match(state.message,/No automatic retry/);
 goal.checkpoint.harness.codexDelivery={state:'PENDING'};assert.equal(contract.state(goal).phase,'usage_review','Unknown provider usage still outranks a known tool ceiling');
});
test('exact recorded response demonstrates the former string-only failure and becomes a typed clarification',()=>{
 const raw=JSON.parse(trace.rawFinal);
 assert.equal(typeof raw.missingInformation==='string',false,'Original classifier rejected this successful model turn');
 const normalized=contract.parse(trace.rawFinal),result=contract.classify({report:normalized});
 assert.equal(result.status,'WAITING_USER');assert.equal(result.answer,raw.question);assert.deepEqual(result.question.missingInformation,raw.missingInformation);
 assert.equal(contract.classify({answer:JSON.stringify({...raw,missingInformation:'Customer selection'})}).status,'WAITING_USER');
});
test('malformed protocols and raw diagnostics never become customer text or human-input waits',()=>{
 for(const raw of ['{"status":"needs_user","question":"Which?","missingInformation":[]}',
  '{"status":"completed","answer":"Done"}', 'TypeError: internal adapter exploded',
  'Outcome not fully verified. Agent report:\n'+trace.rawFinal]){
  const c=contract.classify({answer:raw});assert.equal(c.status,'BLOCKED');assert.equal(c.answer,contract.FAILED);
 }
 assert.equal(contract.classify({answer:'I am stuck inspecting.',progress:{finalReason:'REPEATED_UNCHANGED_EVIDENCE'}}).status,'BLOCKED');
});
test('host authority controls approval, verification and navigation regardless of the model report',()=>{
 for(const current of ['WAITING_APPROVAL','WAITING_EVENT','BLOCKED'])assert.equal(contract.classify({answer:trace.rawFinal,current}).status,current);
 assert.equal(contract.classify({answer:'Done',verified:true,canonicalVerified:false}).status,'BLOCKED');
 assert.equal(contract.classify({answer:trace.rawFinal,progress:{finalReason:'DURABLE_MODEL_REQUEST_LIMIT'}}).status,'WAITING_USER','A real question survives a turn limit');
 const rejected=contract.classify({answer:trace.rawFinal,progress:{finalReason:'HOST_ADMISSION_REJECTED',requiresUserInput:false}});
 assert.equal(rejected.status,'BLOCKED','An actual non-human admission failure cannot become a user clarification');
 assert.equal(rejected.failure.requiresUserInput,false);
 assert.equal(contract.classify({answer:trace.rawFinal,current:'WAITING_APPROVAL',progress:{finalReason:'HOST_ADMISSION_REJECTED',requiresUserInput:false}}).status,'WAITING_APPROVAL','A durable proposal still outranks an exhausted reasoning stage');
 assert.equal(contract.classify({answer:'Verified outcome',verified:true,progress:{finalReason:'HOST_ADMISSION_REJECTED',requiresUserInput:false}}).status,'COMPLETED','An already verified outcome needs no further reasoning allowance');
 const g={id:'goal',status:'WAITING_USER',answer:'',checkpoint:{messages:[],harness:{userQuestion:contract.classify({answer:trace.rawFinal}).question}}};
 const first=contract.sync(g);assert.equal(first.phase,'clarification');assert(first.canReply);assert(first.active);assert(!first.terminal);
 const id=first.input.id;contract.sync(g);assert.equal(g.checkpoint.conversationState.input.id,id);assert.equal(g.checkpoint.conversationState.history.length,1);
 g.status='CANCELLED';g.answer='Stopped.';assert.equal(contract.state(g).canReply,false);
 g.status='WAITING_EVENT';g.checkpoint.navigation={id:null,state:null};assert.equal(contract.state(g).phase,'external_wait');
 g.checkpoint.navigation.state='PENDING';assert.equal(contract.state(g).phase,'navigation');
});
test('legacy recovery requires a settled successful native final, never just JSON in an error message',()=>{
 const {finalReport}=require('../../src/assistant/postgres-conversation-recovery');
 const response={status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:trace.rawFinal}]}]};
 const h={candidate:'codex',codexDelivery:{state:'SETTLED',packet:{body:'data: '+JSON.stringify({type:'response.completed',response})+'\n\n'}},
  lastCodexResponse:{terminal:true,empty:false,tool:false,usageSettled:true}};
 assert.equal(finalReport(h).question,JSON.parse(trace.rawFinal).question);
 for(const mutate of [x=>x.codexDelivery.state='DELIVERING',x=>x.lastCodexResponse.tool=true,x=>x.lastCodexResponse.usageSettled=false,
  x=>x.codexDelivery.packet.body=trace.rawFinal,x=>x.candidate='adaptive']){
  const changed=structuredClone(h);mutate(changed);assert.equal(finalReport(changed),null);
 }
});
test('compressed replay preserves the recorded clarification and every recovery gate',()=>{
 const {gzipSync}=require('node:zlib'),{createHash}=require('node:crypto');
 const codec=require('../../scripts/environment-agent-demo/replay-packet');
 const {finalReport}=require('../../src/assistant/postgres-conversation-recovery');
 const body='data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:trace.rawFinal}]}]}})+'\n\n';
 const packet={status:200,contentType:'text/event-stream',bodyEncoding:'gzip-base64',bodyBytes:Buffer.byteLength(body),bodySha256:createHash('sha256').update(body).digest('hex'),bodyGzip:gzipSync(body).toString('base64')};
 assert.deepEqual(codec.unpack(JSON.parse(JSON.stringify(packet))),{status:200,contentType:'text/event-stream',body});
 const h={candidate:'codex',codexDelivery:{state:'SETTLED',packet},lastCodexResponse:{terminal:true,empty:false,tool:false,usageSettled:true}};
 assert.equal(finalReport(h).question,JSON.parse(trace.rawFinal).question);
 for(const mutate of [x=>x.codexDelivery.state='PENDING',x=>x.lastCodexResponse.usageSettled=false,x=>x.codexDelivery.packet.bodySha256='0'.repeat(64),x=>x.codexDelivery.packet.bodyBytes=8*1024*1024+1]){
  const changed=structuredClone(h);mutate(changed);assert.equal(finalReport(changed),null);
 }
});
