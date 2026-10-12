'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ExperimentBudget}=require('../../scripts/environment-agent-demo/budget');
const {createRelay}=require('../../scripts/environment-agent-demo/relay');
const candidates=require('../../scripts/environment-agent-demo/candidates');

test('both native SDKs make exactly one HTTP request on a retryable 503 when retries are disabled',{timeout:45000},async()=>{
 for(const candidate of ['openai','claude']){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-no-retry-')),http=require('node:http');let requests=0;
  const server=http.createServer((req,res)=>{requests++;req.resume();res.writeHead(503,{'content-type':'application/json','retry-after':'0'});
   res.end(JSON.stringify({error:{type:'api_error',message:'Synthetic retryable error; no provider contacted.'}}));});
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,native={},abortController=new AbortController();
  const timer=setTimeout(()=>abortController.abort(),15000);
  try{
   const session={load:async()=>({native}),checkpoint:async v=>Object.assign(native,v),execute:async(_n,_i,fn)=>fn('offline')};
   await assert.rejects(()=>candidates[candidate]({candidate,budget:{status:()=>({approval:'SYNTHETIC ONLY',ceiling:1000000,remaining:1000000,expires:Date.now()+30000})},
    transport:{token:'FAKE',openaiBaseURL:origin+'/openai/v1',anthropicBaseURL:origin+'/anthropic',allCallsMetered:true,commercialGoalBudgetEnforced:true},
    isolationCertificate:{passed:true,testOnly:true},goal:'Protocol retry test only.',session,gateway:{authorize:async()=>{}},browser:{},
    sandbox:{state:{manifest:new (require('@openai/agents/sandbox').Manifest)({root:'/workspace'}),workspaceReady:true}},
    privateHarnessDirectory:directory,abortController,signal:abortController.signal}));
   assert.equal(requests,1,`${candidate} must not retry a 503`);
  }finally{clearTimeout(timer);abortController.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
   await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
 }
});

test('confirmation freezes exactly one task and two candidates below the one-dollar ceiling',()=>{
 const confirmation=require('../../scripts/environment-agent-demo/run-confirmation'),fixtures=require('../../scripts/environment-agent-demo/retest-fixtures');
 const task=fixtures.createTasks()[0],certificate={sourceHash:'offline'};
 const manifest={experiment:confirmation.EXPERIMENT,sourceHash:'offline',ceilingMicroUsd:1000000,tasks:[task],
  corpusHash:fixtures.corpusHash([task]),slots:['openai','claude'].map(candidate=>({task:task.id,candidate}))};
 assert.doesNotThrow(()=>confirmation.validate(manifest,certificate));
 for(const invalid of [{...manifest,ceilingMicroUsd:1000001},{...manifest,slots:[...manifest.slots,manifest.slots[0]]},
  {...manifest,sourceHash:'changed'},{...manifest,tasks:[{...task,opening:999}]}])
  assert.throws(()=>confirmation.validate(invalid,certificate),/FROZEN_CONFIRMATION_MISMATCH/);
});

// Synthetic protocol smoke test only. No business decisions are evaluated and
// no vendor endpoint is contacted. A fake provider cannot earn a success score.
test('native OpenAI harness sends its requests through the relay and persists serializable run state',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-native-offline-'));
 const budget=new ExperimentBudget(path.join(directory,'test.sqlite'),'offline-native');
 budget.approve({ceilingMicroUsd:10000000,approvalReference:'FAKE TRANSPORT ONLY',expiresAt:new Date(Date.now()+120000).toISOString()});
 let requests=0,forceTool=false;
 const relay=await createRelay({budget,credentials:{openai:'FAKE'},commercial:{begin:async()=>({}),complete:async()=>{},unknown:async()=>{},release:async()=>{}},
  fetchImpl:async(url,init)=>{
   requests++;const body=JSON.parse(init.body);assert.equal(body.model,candidates.CANDIDATES.openai.model);assert.equal(body.max_output_tokens,3000);
   assert.ok(require('../../scripts/environment-agent-demo/wire-policy').normalize('openai',body).inputTokens<50000,'bounded history must fit existing commercial limits');
   if(requests===1||forceTool){
    forceTool=false;
    const item={id:`fc_offline_${requests}`,type:'function_call',call_id:'call_browser_offline',name:'environment_browser',
     arguments:JSON.stringify({action:'inspect',ref:null,value:null}),status:'completed'};
    const response={id:'resp_tool_offline',object:'response',created_at:1,status:'completed',model:body.model,output:[item],usage:{input_tokens:100,output_tokens:20}};
    const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
     {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',arguments:''}},
     {type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments},
     {type:'response.function_call_arguments.done',output_index:0,item_id:item.id,arguments:item.arguments},
     {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
    return new Response(events.map((event,index)=>`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number:index})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
   }
   const message={id:'msg_offline',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Offline protocol reply.',annotations:[]}]};
   const response={id:'resp_offline',object:'response',created_at:1,status:'completed',model:body.model,output:[message],
    usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
   const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}},
    {type:'response.content_part.added',output_index:0,content_index:0,item_id:message.id,part:{type:'output_text',text:'',annotations:[]}},
    {type:'response.output_text.delta',output_index:0,content_index:0,item_id:message.id,delta:'Offline protocol reply.'},
    {type:'response.output_text.done',output_index:0,content_index:0,item_id:message.id,text:'Offline protocol reply.'},
    {type:'response.content_part.done',output_index:0,content_index:0,item_id:message.id,part:message.content[0]},
    {type:'response.output_item.done',output_index:0,item:message},{type:'response.completed',response}];
   return new Response(events.map((event,index)=>`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number:index})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  }});
 t.after(async()=>{await relay.close();budget.close();fs.rmSync(directory,{recursive:true,force:true});});
 const transport=relay.grant({candidate:'openai',provider:'openai',task:'offline',goalId:'offline-goal',ctx:{},fundingKey:'offline',authorize:async()=>{}});
 const native={},audit=[];let browserCalls=0;
 const session={load:async()=>({native}),checkpoint:async value=>Object.assign(native,value),execute:async(name,input,fn)=>fn('offline-journal-call')};
 const {Manifest}=require('@openai/agents/sandbox');
 const options={budget,transport,isolationCertificate:{passed:true,testOnly:true},goal:'Return a protocol smoke-test answer.',
  session,sandbox:{state:{manifest:new Manifest({root:'/workspace'}),workspaceReady:true}},gateway:{authorize:async()=>{}},
  browser:{act:async()=>{browserCalls++;return {text:'Synthetic protocol screen',controls:[]};}},audit:e=>audit.push(e)};
 const result=await candidates.openai(options);
 assert.equal(requests,2);assert.equal(browserCalls,1);assert.ok(audit.some(e=>e.sdkToolCallId==='call_browser_offline'));
 assert.equal(result.answer,'Offline protocol reply.');assert.ok(native.openaiHistory);
 assert.ok(JSON.stringify(native.openaiHistory).length>10);assert.equal(budget.status().unresolved,0);
 await candidates.openai({...options,resumeContext:'An external dependency changed. Reinvestigate.'});
 assert.equal(requests,3,'resuming after a terminal SDK reply must investigate again, not return the old final answer');
 const history=[{role:'user',content:options.goal}];
 for(let i=0;i<80;i++)history.push({type:'function_call',callId:`old_${i}`,name:'environment_browser',arguments:'{"action":"inspect","ref":null,"value":null}'},
  {type:'function_call_result',callId:`old_${i}`,name:'environment_browser',status:'completed',output:'Historical untrusted screen. '.repeat(130)});
 native.openaiHistory=history;
 await candidates.openai({...options,resumeContext:'Continue with bounded history.'});assert.equal(requests,4);
 forceTool=true;const beforeBrowser=browserCalls,finalNative={};let checks=0;
 const finishingSession={...session,load:async()=>({native:finalNative}),checkpoint:async v=>Object.assign(finalNative,v),
  completeIfVerified:async()=>{checks++;return browserCalls>beforeBrowser?{answer:'Host verified complete outcome.',completionSource:'host_verified_receipt'}:null;},
  stop:async()=>{throw new Error('Verified completion must not become an interruption');}};
 const finished=await require('../../scripts/environment-agent-demo/worker').run({...options,candidate:'openai',session:finishingSession});
 assert.equal(finished.answer,'Host verified complete outcome.');assert.equal(requests,5,'no model request after verified tool outcome');
 assert.ok(checks>=3);
});

test('native Claude harness uses the relay and persists a resumable session identity',{timeout:45000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-claude-offline-'));
 const budget=new ExperimentBudget(path.join(directory,'test.sqlite'),'offline-claude');
 budget.approve({ceilingMicroUsd:10000000,approvalReference:'FAKE TRANSPORT ONLY',expiresAt:new Date(Date.now()+120000).toISOString()});
 const audit=[];let requests=0;
 const relay=await createRelay({budget,credentials:{anthropic:'FAKE'},audit:event=>audit.push(event),
  commercial:{begin:async()=>({}),complete:async()=>{},unknown:async()=>{},release:async()=>{}},
  fetchImpl:async(url,init)=>{
   requests++;const body=JSON.parse(init.body);assert.equal(body.model,candidates.CANDIDATES.claude.model);
   if(requests===1){
    const name=body.tools.find(t=>t.name.endsWith('environment_browser')).name;
    const input=JSON.stringify({action:'inspect',ref:null,value:null});
    const events=[{type:'message_start',message:{id:'msg_tool_offline',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0}}},
     {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool_browser_offline',name,input:{}}},
     {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:input}},
     {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:20}},{type:'message_stop'}];
    return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
   }
   const message={id:'msg_offline',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'Offline protocol reply.'}],
    stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:100,output_tokens:20}};
   if(!body.stream)return Response.json(message);
   const events=[{type:'message_start',message:{...message,content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Offline protocol reply.'}},
    {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:20}},{type:'message_stop'}];
   return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  }});
 const abortController=new AbortController();const timer=setTimeout(()=>abortController.abort(),30000);
 t.after(async()=>{clearTimeout(timer);abortController.abort();await relay.close();budget.close();
  await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const transport=relay.grant({candidate:'claude',provider:'anthropic',task:'offline',goalId:'offline-goal',ctx:{},fundingKey:'offline',authorize:async()=>{}});
 const native={};let browserCalls=0;const session={load:async()=>({native}),checkpoint:async value=>Object.assign(native,value),execute:async(name,input,fn)=>fn('offline-journal-call')};
 const browser={act:async()=>{browserCalls++;return {text:'Synthetic protocol screen',controls:[]};}};
 let result;
 try{result=await candidates.claude({budget,transport,isolationCertificate:{passed:true,testOnly:true},goal:'Return a protocol smoke-test answer.',
  session,privateHarnessDirectory:directory,abortController,sandbox:{},gateway:{authorize:async()=>{}},browser,audit:e=>audit.push(e)});}
 catch(error){error.message+=` Relay diagnostics: ${JSON.stringify(audit)}`;throw error;}
 assert.ok(requests>0,JSON.stringify(audit));assert.equal(result.answer,'Offline protocol reply.',JSON.stringify(result.result));
 assert.ok(native.claudeSessionId);assert.equal(budget.status().unresolved,0);
 assert.equal(browserCalls,1);assert.ok(audit.some(e=>e.sdkToolCallId==='tool_browser_offline'),JSON.stringify(audit));
 const firstSession=native.claudeSessionId;
 await candidates.claude({budget,transport,isolationCertificate:{passed:true,testOnly:true},goal:'Return another protocol smoke-test answer.',
  session,privateHarnessDirectory:directory,abortController,sandbox:{},gateway:{authorize:async()=>{}},browser:{}});
 assert.equal(native.claudeSessionId,firstSession);assert.equal(requests,3);
});
