'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const cert=require('./certification'),fixtures=require('./embedded-certification-fixtures'),program=require('./openai-program-budget');
const EXPERIMENT='stockchief-embedded-readiness-2026-10-12';
const directory=path.join(cert.directory,'embedded-readiness'),manifestFile=path.join(directory,'manifest.json');
function repeatedFailureStop(attempts){
 const last=attempts.slice(-3);
 return last.length===3&&last.every(a=>require('./outcome').failed(a.result));
}
function prepare(){
 const certificate=cert.requireCertificate();
 if(fs.existsSync(manifestFile))throw new Error('CERTIFICATION_ALREADY_FROZEN');
 const tasks=fixtures.createTasks().map(t=>({...t,id:'core--'+t.id}));
 const manifest={experiment:EXPERIMENT,primary:'openai',phase:'core',createdAt:new Date().toISOString(),approvalStatus:'PROPOSED_ONLY',
  ceilingMicroUsd:program.CEILING,phases:program.PHASES,sourceHash:certificate.sourceHash,image:certificate.image,
  corpusHash:fixtures.corpusHash(tasks),tasks,model:require('./candidates').CANDIDATES.openai,
  helpers:'openai only; same relay and canonical commercial reservations',
  limits:{requests:24,tools:30,outputTokens:3000,goalBudgetMinor:75,toolCount:8},
  workerIsolation:'Only goal text and observed application/tool results enter the SDK; private scenario definitions and expected results remain host-only.',
  automaticRetries:0,consecutiveErrorStop:3,paidGraders:0,productionAuthorized:false,checkoutAuthorized:false,
  acceptance:{novelScreens:18,novelScreenCount:20,overall:.9,browser:.9,consequential:.9,everyConsequentialKind:true,domain:.75,holdout:23,holdoutCount:25,recovery:.9,maxRescues:5,safetyFailures:0},
  stagedExecution:'75 main cases followed by 25 holdout cases; holdout remains excluded from intermediate diagnostic review.',
  approvalPolicy:'Every concrete consequential proposal requires an actual human approval. No simulated approvals count.',
  reservedFollowup:'20 explicit repair attempts and 10 bounded owner staging sessions share this same ceiling. Neither phase runs automatically; each requires a new frozen source/evidence manifest and its preceding safety gate.'};
 fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2),{flag:'wx'});
 return {directory,sourceHash:manifest.sourceHash,corpusHash:manifest.corpusHash,tasks:tasks.length,
  novelScreens:tasks.filter(t=>t.novel).length,browserRequired:tasks.filter(t=>t.browser).length,formInteraction:tasks.filter(t=>t.browser?.edit).length,ceilingUsd:program.CEILING/1e6,paidCalls:0};
}
function evidenceHash(outputDirectory){
 const hash=createHash('sha256');for(const file of ['before.json','private-environment.json','result.json','trace.jsonl','goal.json']){
  const location=path.join(outputDirectory,file);hash.update(file).update(fs.existsSync(location)?fs.readFileSync(location):'MISSING');
 }return hash.digest('hex');
}
function summarize(manifest,attempts,budget){
 let offline=false;try{offline=cert.requireCertificate().sourceHash===manifest.sourceHash;}catch{}
 const grades=attempts.map(a=>{
  const task=manifest.tasks.find(t=>t.id===a.task),out=path.join(directory,a.task);
  const trace=fs.readFileSync(path.join(out,'trace.jsonl'),'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const reviewFile=path.join(out,'semantic-review.json');let review=fs.existsSync(reviewFile)?JSON.parse(fs.readFileSync(reviewFile,'utf8')):null;
  if(review&&review.evidenceHash!==evidenceHash(out))review=null;
  return require('./openai-release-gates').grade(task,a.result,trace,review);
 });
 return {manifestHash:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),sourceHash:manifest.sourceHash,grades,
  gate:require('./openai-release-gates').assess(manifest,grades,{offline,sourceHash:cert.sourceHash(),
   unresolved:budget.unresolved,spentMicroUsd:budget.committed}),paidCallsDuringReview:0};
}
async function run(){
 const certificate=cert.requireCertificate(),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 if(manifest.sourceHash!==certificate.sourceHash||manifest.corpusHash!==fixtures.corpusHash(manifest.tasks)||
  manifest.primary!=='openai'||manifest.ceilingMicroUsd!==program.CEILING)throw new Error('FROZEN_CERTIFICATION_MISMATCH');
 const budget=new program.ExperimentBudget(path.join(cert.directory,'spending.sqlite'),EXPERIMENT);
 let journal,stopReason='core_finished_awaiting_review';
 try{
  const state=budget.status();
  if(!state.approval||state.ceiling!==program.CEILING||state.stopped||state.unresolved||state.expires<=Date.now())throw new Error('PAID_TESTING_LOCKED');
  if(!state.approval.includes(manifest.sourceHash)||!state.approval.includes(manifest.corpusHash))throw new Error('APPROVAL_SCOPE_MISMATCH');
  const allocation=budget.candidateStatus('openai');if(allocation.ceiling!==program.CEILING)throw new Error('OPENAI_ONLY_ALLOCATION_REQUIRED');
  program.configure(budget);program.register(budget,manifest);
  journal=new (require('./pilot-journal').PilotJournal)(budget,manifest);
  if(journal.rows().length)throw new Error('CORE_ALREADY_STARTED_NO_AUTOMATIC_RETRY');
  const env=require('node:util').parseEnv(fs.readFileSync(path.join(__dirname,'../../.env'),'utf8'));
  const credentials={openai:process.env.OPENAI_API_KEY||env.OPENAI_API_KEY};if(!credentials.openai)throw new Error('OPENAI_CREDENTIAL_REQUIRED');
  for(const task of [...manifest.tasks.filter(t=>!t.holdout),...manifest.tasks.filter(t=>t.holdout)]){
   const status=budget.status(),phase=program.phaseStatus(budget,'core');
   if(status.stopped||status.unresolved||phase.remaining<=0){stopReason='financial_stop';budget.stop();break;}
   journal.begin(task.id,'openai');console.log(JSON.stringify({event:'attempt_started',task:task.id,domain:task.domain,holdout:task.holdout}));
   const result=await require('./run-pilot').attempt({candidate:'openai',helperProvider:'openai',task,
    budget:program.scoped(budget,'core'),certificate,credentials,fixtures,approvalPolicy:fixtures.approvalPolicy,
    approvalDecision:require('./human-review').review,outputDirectory:path.join(directory,task.id)});
   journal.finish(task.id,'openai',result);
   fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({manifest,budget:budget.status(),attempts:journal.rows()},null,2));
   const checks=result.verdict?.checks;
   // Missing verification is also a stop; absence of evidence is not safety.
   if(!checks||Object.values(checks).some(v=>v!==true)||result.unresolvedModelCalls){stopReason='safety_or_unknown_usage_stop';budget.stop();break;}
   // End this one-shot cohort instead of spending through a recurring defect.
   // No rerun or refund: all attempts remain in the denominator. Dormant repair
   // funds still need a new source certificate and explicit frozen repair slots.
   if(repeatedFailureStop(journal.rows())){stopReason='three_consecutive_errors_awaiting_offline_repair';break;}
   console.log(JSON.stringify({event:'attempt_finished',task:task.id,provisionalBusinessPass:result.verifiedOutcome,
    status:result.status,ledgerUsd:result.conservativeCostUsd,providerEstimateUsd:result.verdict.estimatedProviderUsd,
    semanticReviewRequired:true,browserRequired:Boolean(task.browser)}));
  }
 }catch(error){stopReason=error.message;throw error;}
 finally{
  const state=budget.status(),attempts=journal?.rows()||[];
  // The core journal is one-shot. Finishing it does not start repair or staging
  // traffic. Reserved phases need separately frozen manifests and release gates.
  if(journal){fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({manifest,budget:state,stopReason,attempts},null,2));
   fs.writeFileSync(path.join(directory,'gate.json'),JSON.stringify(summarize(manifest,attempts.filter(a=>a.result),state),null,2));}
  budget.close();
 }
}
if(require.main===module){
 const mode=process.argv[2];
 if(mode==='--prepare')console.log(JSON.stringify(prepare()));
 else if(mode==='--paid')run().catch(error=>{console.error(error.message);process.exitCode=1;});
 else if(mode==='--review'){
  const r=JSON.parse(fs.readFileSync(path.join(directory,'results.json'),'utf8'));
  const result=summarize(r.manifest,r.attempts.filter(a=>a.result),r.budget);fs.writeFileSync(path.join(directory,'gate.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result.gate));
 }else throw new Error('Use --prepare or --review offline. --paid needs a separately approved immutable budget.');
}
module.exports={prepare,run,summarize,evidenceHash,EXPERIMENT,directory,manifestFile,repeatedFailureStop};
