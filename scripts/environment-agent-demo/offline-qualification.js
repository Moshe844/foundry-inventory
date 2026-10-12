'use strict';
// Exercise actual SDK context growth against real commercial holds, with fake
// provider responses. No vendor connection and no capability score is possible.
const fs=require('node:fs'),path=require('node:path');
function protocol(provider,body,turn,last,{stress=false,toolName='environment_browser',toolInput,reply='Offline qualification complete.'}={}){
 const input=toolInput||{action:'inspect',ref:null,value:null};let events;
 if(provider==='openai'){
  const item=last?{id:`msg_${turn}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:reply,annotations:[]}]}:
   {id:`fc_${turn}`,type:'function_call',call_id:`call_${turn}`,name:toolName,arguments:JSON.stringify(input),status:'completed'};
  const response={id:`resp_${turn}`,object:'response',created_at:1,status:'completed',model:body.model,output:[item],usage:{input_tokens:100,output_tokens:20}};
  events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
   {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',...(last?{content:[]}:{arguments:''})}},
   ...(last?[{type:'response.content_part.added',output_index:0,content_index:0,item_id:item.id,part:{type:'output_text',text:'',annotations:[]}},
    {type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:reply},
    {type:'response.output_text.done',output_index:0,content_index:0,item_id:item.id,text:reply},
    {type:'response.content_part.done',output_index:0,content_index:0,item_id:item.id,part:item.content[0]}]:
    [{type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments},
     {type:'response.function_call_arguments.done',output_index:0,item_id:item.id,arguments:item.arguments}]),
   {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
 }else{
  const block=last?{type:'text',text:''}:{type:'tool_use',id:`tool_${turn}`,name:body.tools.find(t=>t.name.endsWith(toolName)).name,input:{}};
  events=[{type:'message_start',message:{id:`msg_${turn}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:block},
   {type:'content_block_delta',index:0,delta:last?{type:'text_delta',text:reply}:{type:'input_json_delta',partial_json:JSON.stringify(input)}},
   {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:last?'end_turn':'tool_use',stop_sequence:null},usage:{output_tokens:20}},{type:'message_stop'}];
 }
 if(stress&&!last){
  if(provider==='openai'){
   const reasoning={id:`rs_${turn}`,type:'reasoning',summary:[],encrypted_content:'synthetic-signed-history-'.repeat(300)};
   for(const event of events){if(event.output_index!==undefined)event.output_index++;
    if(event.response?.output?.length)event.response.output.unshift(reasoning);}
   events.splice(1,0,{type:'response.output_item.added',output_index:0,item:reasoning},
    {type:'response.output_item.done',output_index:0,item:reasoning});
  }else{
   for(const event of events)if(event.index!==undefined)event.index++;
   events.splice(1,0,{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
    {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Synthetic reasoning data '.repeat(100)}},
    {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'synthetic-signed-history-'.repeat(200)}},
    {type:'content_block_stop',index:0});
  }
 }
 return new Response(events.map((event,i)=>`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number:i})}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
async function qualify(candidate,{stress=false,turns=12,mode='context'}={}){
 const cluster=await require('../../tests/helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);let relay,budget,timer;
 try{
  await require('../../src/db/migrate-postgres').migratePostgres(db);await require('./run-pilot').seedPrices(db);
  const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Offline qualifier',businessName:'Offline qualifier',
   email:`${require('node:crypto').randomUUID()}@example.test`,password:`Offline!${require('node:crypto').randomUUID()}`});
  const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},goals=require('../../src/assistant/postgres-goal-store');
  const goal=await goals.claim(db,ctx,(await goals.create(db,ctx,'Investigate the offline synthetic environment and report the evidence and any limitations.',{budgetMinor:75})).id);
  const entitlements=require('../../src/commercial/entitlements'),scope=await entitlements.ownerScopeForWorkspace(db,ctx.workspaceId);
  await entitlements.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:`${ctx.workspaceId}:qualification`});
  budget=new (require('./budget').ExperimentBudget)(path.join(cluster.directory,'fake-budget.sqlite'),'offline-only');
  budget.approve({ceilingMicroUsd:15000000,approvalReference:'FAKE PROVIDER RESPONSES ONLY',expiresAt:new Date(Date.now()+180000).toISOString()});
  let requests=0,browserCalls=0,businessCalls=0,error=null;const events=[],bounds=[],requestChecks=[],provider=candidate==='openai'?'openai':'anthropic';
  const fixture=mode==='retest-loop'?require('../../tests/fixtures/environment-agent-retest-failure'):null;
  const observation=fixture?JSON.parse(fixture.evidence.find(e=>e.name==='business_operations').text):null;
  relay=await require('./relay').createRelay({budget,credentials:{[provider]:'FAKE'},audit:e=>events.push(e),commercial:require('./commercial').createCommercialAccounting(db),
   fetchImpl:async(url,init)=>{requests++;const body=JSON.parse(init.body);bounds.push(require('./wire-policy').normalize(provider,body).inputTokens);
    // Independent strict provider fixture as well as the production validator.
    // Native SDK output, not a hand-built request, reaches this assertion.
    if(provider==='anthropic')for(let i=0;i<body.messages.length;i++)if(body.messages[i].role==='system'){
     let end=i;while(body.messages[end+1]?.role==='system')end++;
     if(body.messages[i-1]?.role!=='user'||end<body.messages.length-1&&body.messages[end+1].role!=='assistant')
      throw new Error('STRICT_FAKE_PROVIDER_REJECTED_SYSTEM_ORDER');i=end;
    }
    const final=provider==='openai'?body.tool_choice==='none':body.tool_choice?.type==='none';
    const serialized=JSON.stringify(body);
    requestChecks.push({final,model:body.model,maxOutput:body.max_output_tokens||body.max_tokens,
     toolCount:body.tools?.length,consolidatedFacts:serialized.includes('"facts"')||serialized.includes('\\"facts\\"'),
     hasInventoryFacts:serialized.includes('internalTransferInTransit')&&serialized.includes('inTransitUnits')&&serialized.includes('balanceAfter'),
     roles:provider==='anthropic'?body.messages.map(m=>m.role):null});
    const business=mode==='retest-loop'&&requests===1;
    return protocol(provider,body,requests,mode==='context'?requests>turns:final,{stress,
     ...(business?{toolName:'business_operations',toolInput:{stepsJson:JSON.stringify(observation.outcomes.map(o=>({capability:o.capability,arguments:[],dependsOn:[]})))}}:{})});}});
  const transport=relay.grant({candidate,provider,task:'offline',ctx,goalId:goal.id,fundingKey:'qualification',authorize:async()=>{}});
  const session=require('./session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate,authorize:async()=>({stamp:'offline'})});
  const nativeDirectory=path.join(cluster.directory,'sdk');fs.mkdirSync(nativeDirectory);
  const abortController=new AbortController();timer=setTimeout(()=>abortController.abort(),60000);
  let result;
  try{result=await require('./candidates')[candidate]({candidate,budget,transport,goal:goal.original_request,
   isolationCertificate:{passed:true,testOnly:true},session,gateway:{authorize:async()=>{},operate:async()=>{businessCalls++;return structuredClone(observation);}},privateHarnessDirectory:nativeDirectory,abortController,
   sandbox:{state:{manifest:new (require('@openai/agents/sandbox').Manifest)({root:'/workspace'}),workspaceReady:true}},
   browser:{act:async()=>{browserCalls++;return {text:`Observation version ${mode==='retest-loop'?1:browserCalls}. `+'Untrusted synthetic screen '.repeat(stress?1200:240),controls:[]};}},audit:e=>events.push(e)});
  }catch(e){error={name:e.name,message:e.message};}
  const expected=mode==='retest-loop'?5:mode==='last-turn'?23:turns;
  return {candidate,mode,stress,turns,qualified:browserCalls===expected&&result?.answer==='Offline qualification complete.',requests,browserCalls,businessCalls,bounds,error,requestChecks,
   control:events.filter(e=>e.kind==='model_control'),
   context:events.filter(e=>['wire_context','working_context'].includes(e.kind)),
   blocked:events.filter(e=>e.kind==='model_call_blocked'),unresolved:budget.status().unresolved,paidCalls:0};
 }finally{clearTimeout(timer);await relay?.close();budget?.close();await db.close();await cluster.stop();}
}
module.exports={qualify};
