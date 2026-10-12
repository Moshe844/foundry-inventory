'use strict';
// One operator-authorized slot. No task creation, budget approval, top-up, model
// fallback, automatic rerun, synthetic decisions or navigational script here.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const out=path.resolve(root,process.argv[3]||'data/environment-agent-demo/codex-sdk-sol-high');
const hash=b=>createHash('sha256').update(b).digest('hex');
async function main(){
 if(process.argv[2]!=='--approved-live')throw Error('EXPLICIT_LIVE_ENTRY_REQUIRED');
 if(!out.startsWith(path.join(root,'data/environment-agent-demo')+path.sep))throw Error('ISOLATED_ARTIFACT_DIRECTORY_REQUIRED');
 const cert=JSON.parse(fs.readFileSync(path.join(out,'readiness.json')));
 const approval=JSON.parse(fs.readFileSync(path.join(out,'approval.json')));
 const experiment=approval.experiment;
 const proposalBytes=fs.readFileSync(path.join(out,'proposed-live-task.json'));
 const proposal=JSON.parse(proposalBytes);
 if(!cert.passed||cert.sourceHash!==require('./certification').sourceHash()||Date.now()-Date.parse(cert.checkedAt)>86400000||
  hash(proposalBytes)!==approval.proposalSha256||!/^codex-sdk-sol-high-[a-z0-9-]+$/.test(experiment)||
  !Number.isSafeInteger(approval.ceilingMicroUsd)||approval.ceilingMicroUsd<=0||approval.ceilingMicroUsd>3000000||approval.ceilingMicroUsd%10000!==0||
  approval.perRequestCeilingUsd!==.30||approval.maxAttempts!==1||approval.paidRetries!==0||
  proposal.model!=='gpt-6.1-sol'||proposal.reasoningEffort!=='high'||!proposal.visibleBrowser||
  proposal.goalBudgetMinor!==Math.min(100,approval.ceilingMicroUsd/10000)||proposal.maxModelRequests!==24||proposal.maxToolCalls!==30||
  proposal.sharedCeilingMicroUsd!==approval.ceilingMicroUsd||proposal.model!==require('./codex-wire').MODEL||proposal.reasoningEffort!==require('./codex-wire').EFFORT||
  require('../../src/commercial/model-cost-budget').operationLimit('ask')!==.30)throw Error('CURRENT_MATCHING_CERTIFICATION_AND_APPROVAL_REQUIRED');
 for(const artifact of cert.files)if(hash(fs.readFileSync(path.join(out,artifact.path)))!==artifact.sha256)throw Error('CERTIFICATION_ARTIFACT_CHANGED');
 const budget=new(require('./budget').ExperimentBudget)(path.join(root,'data/environment-agent-demo/spending.sqlite'),experiment);
 try{
  if(budget.status().approval!==approval.reference)throw Error('EXPLICIT_BUDGET_APPROVAL_REQUIRED');
  const journal=new(require('./pilot-journal').PilotJournal)(budget,{sourceHash:cert.sourceHash,proposalSha256:approval.proposalSha256,candidate:'codex',maxAttempts:1});
  if(journal.rows().length)throw Error('ONE_ATTEMPT_ALREADY_STARTED_NO_RETRY');
  // Claim before credentials, subprocesses or network: a crash never reopens it.
  journal.begin(proposal.task.id,'codex');
  const permit=require('./codex-live-permit').issue({budget,task:proposal.task.id,sourceHash:cert.sourceHash,image:cert.image,ceilingMicroUsd:approval.ceilingMicroUsd});
  const env=require('node:util').parseEnv(fs.readFileSync(path.join(root,'.env'),'utf8'));
  const key=process.env.OPENAI_API_KEY||env.OPENAI_API_KEY;
  if(!key)throw Error('OPENAI_API_KEY_REQUIRED');
  const directory=path.join(out,'attempt');fs.mkdirSync(directory,{recursive:true});
  let preflights=0;
  const counter=require('./codex-token-counter').createTokenCounter({apiKey:key,fetchImpl:async(url,init)=>{
   const number=++preflights,body=JSON.parse(init.body);
   fs.writeFileSync(path.join(directory,`native-count-request-${number}.json`),JSON.stringify(body,null,2),{flag:'wx'});
   const response=await fetch(url,init);
   fs.appendFileSync(path.join(directory,'preflight-http.jsonl'),JSON.stringify({number,status:response.status,requestId:response.headers.get('x-request-id')})+'\n');
   return response;
  }});
  process.env.STOCKCHIEF_CODEX_SDK_DEMO='1';
  const fixtures=require('./embedded-certification-fixtures');
  console.log(JSON.stringify({event:'codex_confirmation_started',experiment,model:proposal.model,effort:proposal.reasoningEffort,ceilingUsd:approval.ceilingMicroUsd/1e6,requestCeilingUsd:.30}));
  const result=await require('./run-pilot').attempt({candidate:'codex',task:proposal.task,budget,certificate:cert,
   credentials:{openai:key},outputDirectory:directory,fixtures,approvalPolicy:fixtures.approvalPolicy,
   approvalDecision:require('./human-review').review,helperProvider:'openai',visibleBrowser:true,codexLivePermit:permit,countCodexInput:counter,
   verifyOutcome:fixtures.verifiedOutcome});
  journal.finish(proposal.task.id,'codex',result);
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({result,preflights,budget:budget.status()},null,2));
  console.log(JSON.stringify({event:'codex_confirmation_finished',verified:result.verifiedOutcome,status:result.status,
   error:result.error,modelCalls:result.modelCalls,estimatedProviderUsd:result.verdict?.estimatedProviderUsd,ledgerUsd:result.conservativeCostUsd,preflights}));
 }finally{
  budget.stop();fs.writeFileSync(path.join(out,'budget-final.json'),JSON.stringify(budget.status(),null,2));budget.close();
 }
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main};
