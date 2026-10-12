'use strict';
// Capture a fresh native request without model inference, then (explicitly)
// validate only the provider's token-count endpoint. No generation path exists.
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const out=path.resolve('data/environment-agent-demo/codex-sdk-sol-high');
const hash=b=>createHash('sha256').update(b).digest('hex');
async function capture(){
 const wire=require('./codex-wire');if(wire.MODEL!=='gpt-6.1-sol'||wire.EFFORT!=='high')throw Error('SOL_HIGH_REQUIRED');
 const runtime=JSON.parse(fs.readFileSync(path.join(out,'runtime.json')));
 const prior=JSON.parse(fs.readFileSync('data/environment-agent-demo/codex-sdk-integration/proposed-live-task.json'));
 const task={...prior.task,id:'codex-sol-receiving-'+randomUUID()};
 const proposal={...prior,status:'AWAITING_USER_BUDGET_APPROVAL',model:wire.MODEL,reasoningEffort:wire.EFFORT,
  profile:wire.PROFILE.id,sharedCeilingMicroUsd:1000000,goalBudgetMinor:100,task,
  note:'Proposed allocation uses the existing 100-minor-unit maximum. No approval or live budget is created.'};
 fs.writeFileSync(path.join(out,'proposed-live-task.json'),JSON.stringify(proposal,null,2),{flag:'wx'});
 const budget=new(require('./budget').ExperimentBudget)(path.join(out,'capture-only.sqlite'),'OFFLINE REQUEST CAPTURE');
 try{
  budget.approve({ceilingMicroUsd:750000,approvalReference:'OFFLINE ONLY; NO INFERENCE TRANSPORT',expiresAt:new Date(Date.now()+120000).toISOString()});
  const certificate={passed:true,testOnly:true,image:runtime.image,sourceHash:require('./certification').sourceHash()};
  const journal=new(require('./pilot-journal').PilotJournal)(budget,{captureOnly:true});journal.begin(task.id,'codex');
  const permit=require('./codex-live-permit').issue({budget,task:task.id,sourceHash:certificate.sourceHash,image:runtime.image});
  let captured=0,generations=0;process.env.STOCKCHIEF_CODEX_SDK_DEMO='1';
  const fixtures=require('./embedded-certification-fixtures');
  const result=await require('./run-pilot').attempt({candidate:'codex',task,budget,certificate,credentials:{openai:'FAKE'},
   outputDirectory:path.join(out,'request-capture'),fixtures,approvalPolicy:fixtures.approvalPolicy,helperProvider:'openai',codexLivePermit:permit,
   offlineFetch:async()=>{generations++;throw Error('GENERATION_FORBIDDEN_IN_PREPARATION');},
   countCodexInput:async body=>{
    if(++captured!==1||body.model!==wire.MODEL||body.reasoning.effort!==wire.EFFORT)throw Error('NATIVE_PROFILE_MISMATCH');
    fs.writeFileSync(path.join(out,'native-initial-request.json'),JSON.stringify(body,null,2),{flag:'wx'});
    throw Error('PREFLIGHT_CAPTURE_ONLY');
   }});
  if(captured!==1||generations||result.modelCalls||budget.status().committed||result.browserToolCalls)throw Error('CAPTURE_CONTRACT_FAILED');
  fs.writeFileSync(path.join(out,'capture-result.json'),JSON.stringify({nativeSdk:wire.VERSION,model:wire.MODEL,effort:wire.EFFORT,
   capturedRequests:captured,modelGenerations:generations,agentBrowserActions:result.browserToolCalls,spendUsd:0},null,2),{flag:'wx'});
  console.log(JSON.stringify({captured:true,model:wire.MODEL,effort:wire.EFFORT,modelGenerations:0}));
 }finally{budget.stop();budget.close();}
}
async function count(){
 const request=JSON.parse(fs.readFileSync(path.join(out,'native-initial-request.json'))),wire=require('./codex-wire');
 if(request.model!==wire.MODEL||request.reasoning.effort!==wire.EFFORT)throw Error('NATIVE_PROFILE_MISMATCH');
 // One token-count check; failure requires review, never an automatic retry.
 fs.writeFileSync(path.join(out,'count-started.json'),JSON.stringify({at:new Date().toISOString(),model:request.model}),{flag:'wx'});
 const env=require('node:util').parseEnv(fs.readFileSync('.env','utf8'));
 require('../../src/net-trust').installSystemCertificates();let requests=0,http;
 const counter=require('./codex-token-counter').createTokenCounter({apiKey:process.env.OPENAI_API_KEY||env.OPENAI_API_KEY,
  fetchImpl:async(url,init)=>{
   if(++requests!==1||url!=='https://api.openai.com/v1/responses/input_tokens')throw Error('ONLY_ONE_TOKEN_COUNT_ALLOWED');
   const response=await fetch(url,init);http={status:response.status,requestId:response.headers.get('x-request-id')};return response;
  }});
 try{
  const response=await counter(request),bound=wire.counted(wire.normalize({...request,max_output_tokens:3000}),response);
  const report={checkedAt:new Date().toISOString(),kind:'LIVE_NATIVE_TOKEN_COUNT_ONLY',model:request.model,effort:request.reasoning.effort,
   requestHash:hash(JSON.stringify(request)),http,response,modelGenerations:0,maxOutputTokens:3000,
   maximumRequestUsd:bound.upperBoundMicroUsd/1e6,requestCeilingUsd:.30,fitsRequestCeiling:bound.upperBoundMicroUsd<=300000};
  fs.writeFileSync(path.join(out,'native-preflight.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report));
 }catch(error){fs.writeFileSync(path.join(out,'native-preflight.json'),JSON.stringify({http,failed:true,code:error.code||error.message,modelGenerations:0}),{flag:'wx'});throw error;}
}
if(require.main===module)(process.argv[2]==='--capture'?capture():process.argv[2]==='--count'?count():Promise.reject(Error('Use --capture or --count')))
 .catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={capture,count};
