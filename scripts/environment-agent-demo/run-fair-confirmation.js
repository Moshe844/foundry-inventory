'use strict';
// A proposal can be frozen offline. This runner cannot approve or refill it.
const fs=require('node:fs'),path=require('node:path');
const cert=require('./certification'),fixtures=require('./retest-fixtures');
const EXPERIMENT='environment-fair-confirmation-2-2026-10-12',CEILING=2000000,ALLOWANCE=1000000;
const directory=path.join(cert.directory,'fair-confirmation-2'),manifestFile=path.join(directory,'manifest.json');
const allocations=()=>['openai','claude'].map(candidate=>({candidate,ceilingMicroUsd:ALLOWANCE}));
function validate(manifest,certificate,budget){
 if(manifest.experiment!==EXPERIMENT||manifest.ceilingMicroUsd!==CEILING||manifest.sourceHash!==certificate.sourceHash||
  manifest.tasks?.length!==1||manifest.tasks[0].kind!=='handover'||manifest.corpusHash!==fixtures.corpusHash(manifest.tasks)||
  JSON.stringify(manifest.allocations)!==JSON.stringify(allocations())||
  JSON.stringify(manifest.slots)!==JSON.stringify(['openai','claude'].map(candidate=>({task:manifest.tasks[0].id,candidate})))||
  JSON.stringify(manifest.candidates)!==JSON.stringify(require('./candidates').CANDIDATES))throw new Error('FROZEN_FAIR_COMPARISON_MISMATCH');
 if(budget){
  const shared=budget.status();
  if(shared.ceiling!==CEILING||!shared.approval?.includes(manifest.corpusHash)||!shared.approval?.includes(manifest.sourceHash)||
   shared.stopped||shared.unresolved||shared.expires<=Date.now())throw new Error('PAID_TESTING_LOCKED');
  for(const a of manifest.allocations){const state=budget.candidateStatus(a.candidate);
   if(state.candidate!==a.candidate||state.ceiling!==a.ceilingMicroUsd||state.sharedCeiling!==CEILING)
    throw new Error('INDEPENDENT_ALLOCATION_REQUIRED');}
 }
}
function prepare(){
 const certificate=cert.requireCertificate();if(fs.existsSync(manifestFile))throw new Error('FAIR_COMPARISON_ALREADY_FROZEN');
 const qualification=JSON.parse(fs.readFileSync(path.join(cert.directory,'checkpoint-native-qualification.json'),'utf8'));
 if(qualification.sourceHash!==certificate.sourceHash||!['openai','claude'].every(c=>qualification.results.find(r=>r.candidate===c)?.qualified))
  throw new Error('OFFLINE_QUALIFICATION_REQUIRED');
 const task={...fixtures.createTasks()[0],id:'fair-confirmation-handover'};
 const manifest={experiment:EXPERIMENT,ceilingMicroUsd:CEILING,allocations:allocations(),createdAt:new Date().toISOString(),
  approvalStatus:'PROPOSED_ONLY',sourceHash:certificate.sourceHash,corpusHash:fixtures.corpusHash([task]),tasks:[task],
  slots:['openai','claude'].map(candidate=>({task:task.id,candidate})),candidates:require('./candidates').CANDIDATES,
  maximumAttempts:2,automaticPaidRetries:0,paidContinuationsAfterEmptyAnswer:0,reruns:false,continuationAuthorized:false,
  design:'Fresh paired changing-state investigation, equal independent allowances, same business facts and semantic change/failure trigger. Agents choose all browser actions. No route, answer or solution is supplied.',
  evaluation:'Independent PostgreSQL verification, visible final answer, agent-chosen browser actions, repetition/recovery and actual usage receipts. No paid grader. Zero business changes authorized.',
  primaryDecision:'Evaluate OpenAI independently. A Claude integration failure does not veto OpenAI readiness; Claude remains optional.',
  limits:{modelRequests:24,toolCalls:30,outputTokens:3000,goalBudgetMinor:75,toolCount:8}};
 validate(manifest,certificate);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2),{flag:'wx'});
 for(const [from,to]of [['certification.json','offline-certificate.json'],['certification-tests.tap','offline-tests.tap'],['checkpoint-native-qualification.json','offline-native-qualification.json']])
  fs.copyFileSync(path.join(cert.directory,from),path.join(directory,to),fs.constants.COPYFILE_EXCL);
 return {experiment:EXPERIMENT,approvalStatus:manifest.approvalStatus,ceilingUsd:CEILING/1e6,allocations:manifest.allocations,sourceHash:manifest.sourceHash,corpusHash:manifest.corpusHash};
}
async function run(){
 const certificate=cert.requireCertificate(),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));validate(manifest,certificate);
 const budget=new (require('./budget').ExperimentBudget)(path.join(cert.directory,'spending.sqlite'),EXPERIMENT);
 let journal,started=false,stopReason='two_attempts_finished';
 try{
  validate(manifest,certificate,budget);journal=new (require('./pilot-journal').PilotJournal)(budget,manifest);
  if(journal.rows().length||fs.existsSync(path.join(directory,'results.json')))throw new Error('FAIR_COMPARISON_ALREADY_STARTED');
  const env=require('node:util').parseEnv(fs.readFileSync(path.join(__dirname,'../../.env'),'utf8'));
  const credentials={openai:process.env.OPENAI_API_KEY||env.OPENAI_API_KEY,anthropic:process.env.ANTHROPIC_API_KEY||env.ANTHROPIC_API_KEY};
  if(!credentials.openai||!credentials.anthropic)throw new Error('CREDENTIALS_REQUIRED');
  started=true;
  for(const slot of manifest.slots){
   const state=budget.status();if(state.stopped||state.unresolved){stopReason='shared_safety_stop';break;}
   if(cert.sourceHash()!==manifest.sourceHash){stopReason='source_changed';break;}
   journal.begin(slot.task,slot.candidate);
   const result=await require('./run-pilot').attempt({candidate:slot.candidate,task:manifest.tasks[0],budget,certificate,credentials,fixtures,
    approvalPolicy:require('./retest-approval'),approvalDecision:async()=>({approved:false,responded:false,reason:'Read-only comparison; no business change authorized.'}),
    outputDirectory:path.join(directory,slot.candidate)});
   journal.finish(slot.task,slot.candidate,result);
   fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({manifest,budget:budget.status(),attempts:journal.rows()},null,2));
   if(Object.values(result.verdict?.checks||{}).some(v=>v===false)){stopReason='independent_safety_check_failed';break;}
   if(result.unresolvedModelCalls){stopReason='unresolved_provider_usage';break;}
  }
 }catch(error){stopReason=error.message;throw error;}
 finally{
  if(started){budget.stop();fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({manifest,budget:budget.status(),stopReason,attempts:journal.rows()},null,2));
   fs.writeFileSync(path.join(directory,'budget-final.json'),JSON.stringify(budget.status(),null,2));}
  budget.close();
 }
}
if(require.main===module){if(process.argv[2]==='--prepare')console.log(JSON.stringify(prepare()));
 else if(process.argv[2]==='--paid')run().catch(e=>{console.error(e.message);process.exitCode=1;});
 else throw new Error('Explicit --prepare or --paid required. Budget approval is separate.');}
module.exports={prepare,validate,EXPERIMENT,CEILING,ALLOWANCE,allocations,directory,manifestFile};
