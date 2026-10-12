'use strict';
// Exactly two approved attempts. No refill, retry, resumed cohort or deployment.
const fs=require('node:fs'),path=require('node:path');
const cert=require('./certification'),fixtures=require('./retest-fixtures');
const EXPERIMENT='environment-confirmation-1-2026-10-12',CEILING=1000000;
const directory=path.join(cert.directory,'confirmation-1'),manifestFile=path.join(directory,'manifest.json');
function validate(manifest,certificate){
 if(manifest.experiment!==EXPERIMENT||manifest.ceilingMicroUsd!==CEILING||manifest.sourceHash!==certificate.sourceHash||
  manifest.tasks?.length!==1||manifest.tasks[0].kind!=='handover'||manifest.corpusHash!==fixtures.corpusHash(manifest.tasks)||
  JSON.stringify(manifest.slots)!==JSON.stringify(['openai','claude'].map(candidate=>({task:manifest.tasks[0].id,candidate}))))
  throw new Error('FROZEN_CONFIRMATION_MISMATCH');
}
function prepare(){
 const certificate=cert.requireCertificate();if(fs.existsSync(manifestFile))throw new Error('CONFIRMATION_ALREADY_FROZEN');
 const qualification=JSON.parse(fs.readFileSync(path.join(cert.directory,'checkpoint-native-qualification.json'),'utf8'));
 if(qualification.sourceHash!==certificate.sourceHash||!['openai','claude'].every(c=>qualification.results.find(r=>r.candidate===c)?.qualified))
  throw new Error('OFFLINE_QUALIFICATION_REQUIRED');
 const task={...fixtures.createTasks()[0],id:'confirmation-handover'};
 const manifest={experiment:EXPERIMENT,ceilingMicroUsd:CEILING,createdAt:new Date().toISOString(),sourceHash:certificate.sourceHash,
  corpusHash:fixtures.corpusHash([task]),tasks:[task],slots:['openai','claude'].map(candidate=>({task:task.id,candidate})),
  candidates:require('./candidates').CANDIDATES,maximumAttempts:2,automaticRetries:0,reruns:false,continuationAuthorized:false,
  design:'Fresh paired instance of the failed changing-custody investigation; no novel task-family claim. Same initial business facts and semantic state-change trigger. No solution, route or navigation script in agent context.',
  evaluation:'Independent PostgreSQL snapshots, semantic final-answer review, browser and tool traces. No paid grader. Read-only task: no business approval or changes allowed.',
  prices:{openai:{model:'gpt-6.1-sol',inputPerMillion:2,cachedPerMillion:.1,outputPerMillion:10,source:'https://developers.openai.com/api/docs/models/gpt-6.1-sol'},
   anthropic:{model:'claude-sonnet-5',inputPerMillion:2,cachedPerMillion:.2,cacheWrite5mPerMillion:2.5,cacheWrite1hPerMillion:4,outputPerMillion:10,source:'https://platform.claude.com/docs/en/about-claude/pricing'},
   conservativeLedger:require('./wire-policy').PRICES}};
 validate(manifest,certificate);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2),{flag:'wx'});
 for(const [from,to]of [['certification.json','offline-certificate.json'],['certification-tests.tap','offline-tests.tap'],['checkpoint-native-qualification.json','offline-native-qualification.json']])
  fs.copyFileSync(path.join(cert.directory,from),path.join(directory,to),fs.constants.COPYFILE_EXCL);
 return {experiment:EXPERIMENT,directory,sourceHash:manifest.sourceHash,corpusHash:manifest.corpusHash,slots:manifest.slots};
}
async function run(){
 const certificate=cert.requireCertificate(),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));validate(manifest,certificate);
 const budget=new (require('./budget').ExperimentBudget)(path.join(cert.directory,'spending.sqlite'),EXPERIMENT);
 let journal,started=false,stopReason='two_attempts_finished';
 try{
  const state=budget.status();if(state.ceiling!==CEILING||!state.approval?.includes(manifest.corpusHash)||state.stopped||state.unresolved||state.expires<=Date.now())throw new Error('PAID_TESTING_LOCKED');
  journal=new (require('./pilot-journal').PilotJournal)(budget,manifest);
  if(journal.rows().length||fs.existsSync(path.join(directory,'results.json')))throw new Error('CONFIRMATION_ALREADY_STARTED');
  const env=require('node:util').parseEnv(fs.readFileSync(path.join(__dirname,'../../.env'),'utf8'));
  const credentials={openai:process.env.OPENAI_API_KEY||env.OPENAI_API_KEY,anthropic:process.env.ANTHROPIC_API_KEY||env.ANTHROPIC_API_KEY};
  if(!credentials.openai||!credentials.anthropic)throw new Error('CREDENTIALS_REQUIRED');
  started=true;
  for(const slot of manifest.slots){
   const state=budget.status();if(state.stopped||state.unresolved||state.remaining<=0){stopReason='shared_budget_stopped';break;}
   if(cert.sourceHash()!==manifest.sourceHash){stopReason='source_changed';break;}
   journal.begin(slot.task,slot.candidate);console.log(JSON.stringify({event:'attempt_started',...slot,remainingUsd:state.remaining/1e6}));
   const result=await require('./run-pilot').attempt({candidate:slot.candidate,task:manifest.tasks[0],budget,certificate,credentials,fixtures,
    approvalPolicy:require('./retest-approval'),approvalDecision:async()=>({approved:false,responded:false,reason:'Read-only task; no business change authorized.'}),
    outputDirectory:path.join(directory,slot.candidate)});
   journal.finish(slot.task,slot.candidate,result);
   console.log(JSON.stringify({event:'attempt_finished',candidate:slot.candidate,verified:result.verifiedOutcome,completed:result.completedExperience,
    status:result.status,ledgerUsd:result.conservativeCostUsd,receiptUsd:result.verdict?.estimatedProviderUsd,error:result.error}));
   fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({manifest,budget:budget.status(),attempts:journal.rows()},null,2));
   if(Object.values(result.verdict?.checks||{}).some(v=>v===false)){stopReason='independent_safety_check_failed';break;}
   if(result.unresolvedModelCalls){stopReason='unresolved_provider_usage';break;}
   // An ordinary task failure is reported, not retried. The other separately
   // approved candidate can still run unless a shared safety/cost gate stopped it.
  }
 }catch(error){stopReason=error.message;throw error;}
 finally{
  if(started){budget.stop();
   fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({manifest,budget:budget.status(),stopReason,attempts:journal.rows()},null,2));
   fs.writeFileSync(path.join(directory,'budget-final.json'),JSON.stringify(budget.status(),null,2));
   console.log(JSON.stringify({event:'confirmation_stopped',stopReason,...budget.status()}));}
  budget.close();
 }
}
if(require.main===module){if(process.argv[2]==='--prepare')console.log(JSON.stringify(prepare()));
 else if(process.argv[2]==='--paid')run().catch(e=>{console.error(e.message);process.exitCode=1;});
 else throw new Error('Explicit --prepare or --paid required. Approval is separate and immutable.');}
module.exports={prepare,validate,EXPERIMENT,CEILING,directory,manifestFile};
