'use strict';const test=require('node:test'),assert=require('node:assert/strict'),wire=require('../../scripts/environment-agent-demo/codex-wire'),provider=require('../../scripts/environment-agent-demo/codex-helper-provider');
const regular=wire.forProfile('sol-low-fast'),quick=wire.forProfile('sol-low-ultrafast');
test('faster semantic processing preserves model, reasoning and exact native financial bounds',()=>{
 const small={system:'Verify the supplied facts and completeness.',prompt:'A small unfamiliar evidence packet.',schema:{type:'object'},maxOutputTokens:500};
 assert(provider.preferredFits(small,{policy:quick},regular));assert(!provider.preferredFits({...small,prompt:'x'.repeat(200000)},{policy:quick},regular));assert(!provider.preferredFits(small,null,regular));
 assert.throws(()=>provider.preferredFits(small,{policy:quick},wire.forProfile('sol-high')),/STRENGTH_MISMATCH/);
 const normalized=quick.normalize({model:quick.MODEL,reasoning:{effort:'low'},instructions:small.system,input:[{role:'user',content:small.prompt}],max_output_tokens:500});assert.equal(normalized.body.service_tier,'ultrafast');assert.equal(normalized.outputTokens,500);assert.equal(quick.counted(normalized,{object:'response.input_tokens',input_tokens:1000}).upperBoundMicroUsd,45000);
 assert.equal(quick.REQUEST_CEILING_MICRO_USD,regular.REQUEST_CEILING_MICRO_USD);assert.equal(quick.receipt({returnedModel:quick.MODEL,returnedServiceTier:'ultrafast',inputTokens:1000,outputTokens:100}).conservativeMicroUsd,21000);
 for(const tier of ['flex','priority','fast'])assert.throws(()=>quick.receipt({returnedModel:quick.MODEL,returnedServiceTier:tier}),/SERVICE_TIER_MISMATCH/);
 assert.throws(()=>quick.receipt({returnedModel:quick.MODEL}),/SERVICE_TIER_MISSING/);
});
test('short and large checks use host-granted transports without retries or changing the request',async t=>{
 const old=global.fetch,calls=[];t.after(()=>global.fetch=old);global.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body),authorization:options.headers.authorization});return{ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"complete":true}'}]}]})};};
 const regularTransport={openaiBaseURL:'http://regular.test',token:'regular',lastBlock:()=>null},fastTransport={openaiBaseURL:'http://quick.test',token:'quick',lastBlock:()=>null},helper=provider.create({transport:regularTransport,policy:regular,preferred:{transport:fastTransport,policy:quick}}),request={system:'Check facts.',prompt:'The full packet.',schema:{type:'object',additionalProperties:false,properties:{complete:{type:'boolean'}},required:['complete']},maxOutputTokens:500};
 assert.equal((await helper.complete(request)).data.complete,true);assert.equal(calls[0].url,'http://quick.test/responses');assert.equal(calls[0].body.input[0].content,request.prompt);assert.equal(calls[0].body.reasoning.effort,regular.EFFORT);
 await helper.complete({...request,prompt:'x'.repeat(200000)});assert.equal(calls[1].url,'http://regular.test/responses');assert.equal(calls.length,2);
});
test('preferred processing crosses the actual native relay and settles its priced receipt before returning a result',async t=>{
 const {ExperimentBudget}=require('../../scripts/environment-agent-demo/budget'),{createRelay}=require('../../scripts/environment-agent-demo/relay');
 const budget=new ExperimentBudget(':memory:','offline-helper-processing');budget.approve({ceilingMicroUsd:1000000,approvalReference:'OFFLINE ONLY',expiresAt:new Date(Date.now()+60000).toISOString()});let sent=0,gates=0,completed=0;
 const relay=await createRelay({budget,credentials:{openai:'FAKE'},allowedProviders:['openai'],countCodexInput:async()=>({object:'response.input_tokens',input_tokens:100}),
  commercial:{begin:async call=>{assert.equal(call.body.service_tier,'ultrafast');assert.equal(call.upperBoundMicroUsd,31500);return{};},complete:async(_held,r)=>{assert.equal(r.returnedServiceTier,'ultrafast');completed++;},unknown:async()=>assert.fail('Known receipt must settle'),release:async()=>{}},
  fetchImpl:async()=>{sent++;assert.equal(budget.status().unresolved,1);return Response.json({object:'response',id:'resp_offline_processing',status:'completed',model:quick.MODEL,service_tier:'ultrafast',usage:{input_tokens:100,output_tokens:10},output:[{type:'message',content:[{type:'output_text',text:'{"complete":true}'}]}]});}});
 t.after(async()=>{await relay.close();budget.close();});
 const transport=relay.grant({candidate:'codex',task:'offline-helper-processing',goalId:'offline-goal',fundingKey:'offline-funding',ctx:{workspaceId:'offline-workspace',actorId:'offline-actor'},provider:'openai',authorize:async()=>({}),codexPolicy:quick,wireProfile:'codex',requestGate:async()=>{gates++;}}),helper=provider.create({transport,policy:quick});
 const result=await helper.complete({system:'Verify the facts.',prompt:'Complete evidence.',schema:{type:'object',additionalProperties:false,properties:{complete:{type:'boolean'}},required:['complete']},maxOutputTokens:500});
 assert.equal(result.data.complete,true);assert.equal(sent,1);assert.equal(gates,1);assert.equal(completed,1);assert.equal(budget.status().unresolved,0);assert.equal(budget.status().committed,2100);
});
