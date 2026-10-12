'use strict';
// Operator-only one-shot checkpoint. Cannot approve, refill, restart, or resume
// a scored cohort. Every provider and canonical helper shares this one ledger.
const fs=require('node:fs'),path=require('node:path');
const cert=require('./certification'),fixtures=require('./checkpoint-fixtures');
const EXPERIMENT='environment-checkpoint-15-2026-10-11';
const directory=path.join(cert.directory,'checkpoint-15'),manifestFile=path.join(directory,'manifest.json');
function prepare(){
 const certificate=cert.requireCertificate();
 if(fs.existsSync(manifestFile))throw new Error('CHECKPOINT_ALREADY_FROZEN');
 const qualification=JSON.parse(fs.readFileSync(path.join(cert.directory,'checkpoint-native-qualification.json'),'utf8'));
 if(qualification.sourceHash!==certificate.sourceHash||!qualification.results.find(r=>r.candidate==='openai')?.qualified)throw new Error('OFFLINE_QUALIFICATION_REQUIRED');
 const tasks=fixtures.createTasks(),paired=[0,2,4,5,8],claudeQualified=qualification.results.find(r=>r.candidate==='claude')?.qualified;
 const slots=[];
 for(const [index,task]of tasks.entries()){
  const names=paired.includes(index)?['openai','adaptive',...(claudeQualified?['claude']:[])]:['openai'];
  // Counterbalance paired order without granting any candidate diagnostic feedback.
  const rotated=names.slice(index%names.length).concat(names.slice(0,index%names.length));
  slots.push(...rotated.map(candidate=>({task:task.id,candidate})));
 }
 const manifest={experiment:EXPERIMENT,ceilingMicroUsd:15000000,createdAt:new Date().toISOString(),sourceHash:certificate.sourceHash,
  candidates:require('./candidates').CANDIDATES,qualification,corpusHash:fixtures.corpusHash(tasks),tasks,slots,
  humanApprovalPolicy:'Each concrete proposal requires an actual human response; no simulated approvals.',
  privateEvaluation:'Expected facts and predicates are host-only. No worker sees routes, fixture code or task solutions.',
  excluded:claudeQualified?[]:[{candidate:'claude',reason:'Did not qualify twelve native turns within unchanged commercial protections; no paid debugging.'}],
  continuationAuthorized:false};
 fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2),{flag:'wx'});
 return {directory,corpusHash:manifest.corpusHash,sourceHash:manifest.sourceHash,slots:slots.length,excluded:manifest.excluded};
}
async function run(){
 const certificate=cert.requireCertificate(),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 if(manifest.sourceHash!==certificate.sourceHash||manifest.corpusHash!==fixtures.corpusHash(manifest.tasks)||manifest.ceilingMicroUsd!==15000000)throw new Error('FROZEN_CHECKPOINT_MISMATCH');
 const env=require('node:util').parseEnv(fs.readFileSync(path.join(__dirname,'../../.env'),'utf8'));
 const credentials={openai:process.env.OPENAI_API_KEY||env.OPENAI_API_KEY,anthropic:process.env.ANTHROPIC_API_KEY||env.ANTHROPIC_API_KEY};
 if(!credentials.openai||!credentials.anthropic)throw new Error('CREDENTIALS_REQUIRED');
 const budget=new (require('./budget').ExperimentBudget)(path.join(cert.directory,'spending.sqlite'),EXPERIMENT);
 let journal,stopReason='checkpoint_complete';
 try{
  const state=budget.status();if(state.ceiling!==15000000||!state.approval||state.stopped||state.unresolved||state.expires<=Date.now())throw new Error('PAID_TESTING_LOCKED');
  journal=new (require('./pilot-journal').PilotJournal)(budget,manifest);
  if(journal.rows().length)throw new Error('CHECKPOINT_ALREADY_STARTED');
  for(const slot of manifest.slots){
   const state=budget.status();if(state.stopped||state.unresolved||state.remaining<=0){stopReason='shared_budget_stopped';break;}
   const task=manifest.tasks.find(t=>t.id===slot.task);
   journal.begin(slot.task,slot.candidate);console.log(JSON.stringify({event:'attempt_started',...slot,remainingUsd:state.remaining/1e6}));
   const result=await require('./run-pilot').attempt({...slot,task,budget,certificate,credentials,fixtures,
    approvalPolicy:require('./checkpoint-approval'),approvalDecision:require('./human-review').review,
    outputDirectory:path.join(directory,slot.task,slot.candidate)});
   journal.finish(slot.task,slot.candidate,result);
   console.log(JSON.stringify({event:'attempt_finished',...slot,verified:result.verifiedOutcome,completed:result.completedExperience,
    status:result.status,cost:result.conservativeCostUsd,receiptUsd:result.verdict?.estimatedProviderUsd,approvals:result.actualHumanApprovalResponses,error:result.error}));
   fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({manifest,budget:budget.status(),attempts:journal.rows()},null,2));
   const checks=result.verdict?.checks||{};
   if(['foreignUnchanged','noUninvitedCustomer','noUnexpectedFulfillment','unrequestedRecordsUnchanged','businessUnchanged'].some(key=>checks[key]===false)){
    stopReason='independent_safety_check_failed';break;
   }
   if(budget.status().unresolved){stopReason='unresolved_provider_usage';break;}
  }
 }catch(error){stopReason=error.message;throw error;}
 finally{
  budget.stop();
  fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({manifest,budget:budget.status(),stopReason,attempts:journal?.rows()||[]},null,2));
  fs.writeFileSync(path.join(directory,'budget-final.json'),JSON.stringify(budget.status(),null,2));
  console.log(JSON.stringify({event:'checkpoint_stopped',stopReason,...budget.status()}));budget.close();
 }
}
if(require.main===module){
 const mode=process.argv[2];
 if(mode==='--prepare')console.log(JSON.stringify(prepare()));
 else if(mode==='--paid')run().catch(e=>{console.error(e.message);process.exitCode=1;});
 else throw new Error('Explicit --prepare (offline) or --paid required; this runner cannot approve spending.');
}
module.exports={prepare,EXPERIMENT,directory,manifestFile};
