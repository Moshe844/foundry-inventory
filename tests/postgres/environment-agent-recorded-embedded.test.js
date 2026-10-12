'use strict';
// One end-to-end embedded SDK replay of the FIRST ACTUAL FAILED TASK. The
// provider emits recorded decisions, not newly invented successful decisions.
// This certifies integration invariants, never model intelligence/business pass.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const recorded=require('../fixtures/environment-agent-context-loss/recorded.json').cases[0];
const fixtures=require('../../scripts/environment-agent-demo/embedded-certification-fixtures');
const base='../../scripts/environment-agent-demo/';
function response(body,item){
 const result={id:'resp_replay',object:'response',created_at:1,status:'completed',model:body.model,output:[item],usage:{input_tokens:200,output_tokens:30}};
 const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},
  {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',...(item.type==='function_call'?{arguments:''}:{content:[]})}}];
 if(item.type==='function_call')events.push({type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments},
  {type:'response.function_call_arguments.done',output_index:0,item_id:item.id,arguments:item.arguments});
 else events.push({type:'response.content_part.added',output_index:0,content_index:0,item_id:item.id,part:{type:'output_text',text:'',annotations:[]}},
  {type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:item.content[0].text},
  {type:'response.output_text.done',output_index:0,content_index:0,item_id:item.id,text:item.content[0].text},
  {type:'response.content_part.done',output_index:0,content_index:0,item_id:item.id,part:item.content[0]});
 events.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:result});
 return new Response(events.map((e,i)=>`event: ${e.type}\ndata: ${JSON.stringify({...e,sequence_number:i})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
test('ONE actual failed task: embedded SDK, live browser, metered fake transport, durable context and PostgreSQL verifier',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-recorded-embedded-'));
 const out=process.env.STOCKCHIEF_OFFLINE_REPLAY_OUTPUT||path.join(tmp,'attempt');
 const budget=new (require(base+'budget').ExperimentBudget)(path.join(tmp,'offline.sqlite'),'offline-recorded-only');
 t.after(()=>{budget.close();fs.rmSync(tmp,{recursive:true,force:true});});
 budget.approve({ceilingMicroUsd:1000000,approvalReference:'OFFLINE FAKE TRANSPORT ONLY',expiresAt:new Date(Date.now()+300000).toISOString()});
 const manifest=JSON.parse(fs.readFileSync('data/environment-agent-demo/embedded-readiness/manifest.json','utf8'));
 const task=manifest.tasks.find(t=>t.id===recorded.task);assert.equal(task.prompt,recorded.goal);
 const decisions=recorded.events.filter(e=>e.kind==='agent_tool_started');let calls=0,assertedFormRequests=0,latestOriginal=null;
 // Decision replay maps historical observation handles to fresh equivalents.
 // No browser action occurs here: only the embedded SDK executes tool calls.
 function currentScreen(){const log=fs.readFileSync(path.join(out,'trace.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
  return log.filter(e=>e.kind==='browser_observation').at(-1)?.screen;}
 const result=await require(base+'run-pilot').attempt({candidate:'openai',helperProvider:'openai',task,fixtures,budget,
  certificate:{passed:true,testOnly:true,sourceHash:require(base+'certification').sourceHash(),image:JSON.parse(fs.readFileSync('data/environment-agent-demo/sandbox-certificate.json')).image},
  credentials:{openai:'FAKE'},outputDirectory:out,approvalDecision:async()=>{throw Error('RECORDED_TASK_HAS_NO_APPROVAL');},
  offlineFetch:async(_url,init)=>{
   const body=JSON.parse(init.body);require(base+'protocol').validate('openai',body);calls++;
   const note=body.input.findLast(i=>typeof i.content==='string'&&i.content.startsWith(require(base+'wire-context').NOTICE));assert(note);
   const memory=JSON.parse(note.content.slice(require(base+'wire-context').NOTICE.length));
   assert(Buffer.byteLength(JSON.stringify(memory))<=8500);
   if(calls>9){assert(memory.browser.pages.some(p=>p.text?.includes('Handling requirement:')),
    'the ACTUAL SDK wire request must retain form evidence after leaving it and after compaction');assertedFormRequests++;}
   if(calls<=decisions.length){
    const event=decisions[calls-1],input=structuredClone(event.input);
    if(event.name==='environment_evidence'){
     const sequence=event.input.id.split(':').at(-1),match=memory.evidence.find(e=>e.id.endsWith(':'+sequence));assert(match);input.id=match.id;
    }
    if(event.name==='environment_browser'&&input.ref){
     const source=recorded.events.filter(e=>e.kind==='browser_observation').find(e=>e.screen.controls.some(c=>c.ref===input.ref));assert(source);
     const at=source.screen.controls.findIndex(c=>c.ref===input.ref),old=source.screen.controls[at],fresh=currentScreen().controls[at];
     assert(fresh);assert.equal(fresh.tag,old.tag);assert.equal(fresh.type,old.type);input.ref=fresh.ref;
    }
    latestOriginal=event;
    return response(body,{id:'fc_'+calls,type:'function_call',call_id:'recorded_'+calls,name:event.name,arguments:JSON.stringify(input),status:'completed'});
   }
   assert.equal(body.tool_choice,'none');
   return response(body,{id:'msg_final',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',
    text:recorded.answer,annotations:[]}]});
  }});
 assert.equal(calls,decisions.length+1,JSON.stringify(result.error));assert.equal(assertedFormRequests,14);
 assert.equal(result.providerMode,'OFFLINE_SYNTHETIC');assert.equal(result.status,'BLOCKED');assert.equal(result.failure.code,'REPEATED_UNCHANGED_EVIDENCE');
 assert.equal(result.verifiedOutcome,false,'replaying original unsuccessful decisions MUST NOT earn a business pass');
 assert.equal(result.verdict.discovery.previewCompleted,false);assert(Object.values(result.verdict.checks).every(Boolean));
 const before=JSON.parse(fs.readFileSync(path.join(out,'before.json')));assert.deepEqual(result.verdict.after,before);
 const trace=fs.readFileSync(path.join(out,'trace.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
 const tools=trace.filter(e=>e.kind==='agent_tool_started');assert.equal(tools.length,decisions.length);
 assert(tools.every(e=>e.sdkToolCallId?.startsWith('recorded_')));assert(trace.some(e=>e.kind==='working_context'&&e.beforeBytes>e.afterBytes));
 const summary={integrationTestPassed:true,liveIntelligenceCertified:false,originalTask:recorded.task,recordedSourceFiles:recorded.sourceFiles,
  provider:'deterministic replay of actual failed decisions; no inference',providerRequests:0,paidCostUsd:0,replayRequests:calls,
  requestsVerifiedAfterFormDiscovery:assertedFormRequests,toolDecisionsReplayed:tools.length,status:result.status,failure:result.failure,
  businessTaskCompleted:false,businessStateUnchanged:true,allSafetyChecksPassed:true,allToolsExecutedByEmbeddedSdk:true,
  compactionObserved:true,contextLimit:16000,memoryLimit:8500,limitsUnchanged:true};
 fs.writeFileSync(path.join(out,'offline-integration-summary.json'),JSON.stringify(summary,null,2));
 t.diagnostic(JSON.stringify(summary));
});
