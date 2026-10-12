'use strict';
// One-shot operator entry point. No approval, refill or rerun path.
const fs=require('node:fs'),path=require('node:path');
const cert=require('./certification'),fixtures=require('./retest-fixtures');
const EXPERIMENT='environment-retest-5-2026-10-12',CEILING=5000000;
const directory=path.join(cert.directory,'retest-5'),manifestFile=path.join(directory,'manifest.json');
function slotsFor(tasks){const names=['openai','claude','adaptive'];return tasks.flatMap((t,i)=>
 names.slice(i%3).concat(names.slice(0,i%3)).map(candidate=>({task:t.id,candidate})));}
function stopFor(result,previous=[]){
 if(Object.values(result.verdict?.checks||{}).some(value=>value===false))return 'independent_safety_check_failed';
 if(result.unresolvedModelCalls)return 'unresolved_provider_usage';
 const code=result.error?.name;
 if(code&&previous.some(r=>r.error?.name===code)&&/CONTEXT_|UNBOUNDED_|TOKEN_BOUND|PRICE_BOUND|HARNESS_|AUTHORITY_|CLAUDE_RUN_FAILED/.test(code))return 'repeated_integration_defect';
 return null;
}
function prepare(){
 const certificate=cert.requireCertificate();if(fs.existsSync(manifestFile))throw new Error('RETEST_ALREADY_FROZEN');
 const qualification=JSON.parse(fs.readFileSync(path.join(cert.directory,'checkpoint-native-qualification.json'),'utf8'));
 if(qualification.sourceHash!==certificate.sourceHash||!['openai','claude'].every(c=>qualification.results.find(r=>r.candidate===c)?.qualified))throw new Error('OFFLINE_QUALIFICATION_REQUIRED');
 // Runtime/evaluator source is certified before the private corpus is instantiated.
 const tasks=fixtures.createTasks();
 const manifest={experiment:EXPERIMENT,ceilingMicroUsd:CEILING,createdAt:new Date().toISOString(),sourceHash:certificate.sourceHash,
  corpusHash:fixtures.corpusHash(tasks),tasks,slots:slotsFor(tasks),candidates:require('./candidates').CANDIDATES,qualification,
  approvals:'Actual per-proposal human decisions; scope policy only refuses, never self-approves.',
  evaluation:'Private PostgreSQL predicates and mandatory semantic/browser review. No paid grader or case solutions in worker context.',
  comparability:'Same state, goals, commercial limits and execution gateway. Native workers have identical environment tools. Adaptive baseline has no browser.',
  prices:{checkedAt:new Date().toISOString(),openai:{model:'gpt-6.1-sol',inputPerMillion:2,cachedPerMillion:.1,outputPerMillion:10,
   source:'https://developers.openai.com/api/docs/pricing'},anthropic:{model:'claude-sonnet-5',inputPerMillion:2,cachedPerMillion:.2,
   cacheWrite5mPerMillion:2.5,cacheWrite1hPerMillion:4,outputPerMillion:10,source:'https://platform.claude.com/docs/en/about-claude/pricing'},
   conservativeLedger:require('./wire-policy').PRICES},
  maximumAttempts:9,reruns:false,continuationAuthorized:false};
 fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2),{flag:'wx'});
 for(const [from,to]of [['certification.json','offline-certificate.json'],['certification-tests.tap','offline-tests.tap'],['checkpoint-native-qualification.json','offline-native-qualification.json']])
  fs.copyFileSync(path.join(cert.directory,from),path.join(directory,to),fs.constants.COPYFILE_EXCL);
 return {experiment:EXPERIMENT,directory,sourceHash:manifest.sourceHash,corpusHash:manifest.corpusHash,slots:manifest.slots};
}
async function run(){
 const certificate=cert.requireCertificate(),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 if(manifest.sourceHash!==certificate.sourceHash||manifest.corpusHash!==fixtures.corpusHash(manifest.tasks)||manifest.ceilingMicroUsd!==CEILING||
  JSON.stringify(manifest.slots)!==JSON.stringify(slotsFor(manifest.tasks))||manifest.tasks.length!==3)throw new Error('FROZEN_RETEST_MISMATCH');
 const budget=new (require('./budget').ExperimentBudget)(path.join(cert.directory,'spending.sqlite'),EXPERIMENT);
 let journal,started=false,stopReason='nine_attempts_finished';
 try{
  const state=budget.status();if(state.ceiling!==CEILING||!state.approval?.includes(manifest.corpusHash)||state.stopped||state.unresolved||state.expires<=Date.now())throw new Error('PAID_TESTING_LOCKED');
  journal=new (require('./pilot-journal').PilotJournal)(budget,manifest);
  if(journal.rows().length||fs.existsSync(path.join(directory,'results.json')))throw new Error('RETEST_ALREADY_STARTED');
  const env=require('node:util').parseEnv(fs.readFileSync(path.join(__dirname,'../../.env'),'utf8'));
  const credentials={openai:process.env.OPENAI_API_KEY||env.OPENAI_API_KEY,anthropic:process.env.ANTHROPIC_API_KEY||env.ANTHROPIC_API_KEY};
  if(!credentials.openai||!credentials.anthropic)throw new Error('CREDENTIALS_REQUIRED');
  started=true;
  for(const slot of manifest.slots){
   const state=budget.status();if(state.stopped||state.unresolved||state.remaining<=0){stopReason='shared_budget_stopped';break;}
   // Any source change ends the cohort; fixes require another approved cohort.
   if(cert.sourceHash()!==manifest.sourceHash){stopReason='source_changed';break;}
   journal.begin(slot.task,slot.candidate);console.log(JSON.stringify({event:'attempt_started',...slot,remainingUsd:state.remaining/1e6}));
   const result=await require('./run-pilot').attempt({candidate:slot.candidate,task:manifest.tasks.find(t=>t.id===slot.task),budget,certificate,credentials,fixtures,
    approvalPolicy:require('./retest-approval'),approvalDecision:require('./human-review').review,outputDirectory:path.join(directory,slot.task,slot.candidate)});
   const previous=journal.rows().map(r=>r.result).filter(Boolean);journal.finish(slot.task,slot.candidate,result);
   console.log(JSON.stringify({event:'attempt_finished',...slot,verified:result.verifiedOutcome,completed:result.completedExperience,status:result.status,
    cost:result.conservativeCostUsd,receiptUsd:result.verdict?.estimatedProviderUsd,approvals:result.actualHumanApprovalResponses,error:result.error}));
   fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({manifest,budget:budget.status(),attempts:journal.rows()},null,2));
   const stop=stopFor(result,previous);if(stop){stopReason=stop;break;}
  }
 }catch(error){stopReason=error.message;throw error;}
 finally{
  if(started){
   budget.stop();
   fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify({manifest,budget:budget.status(),stopReason,attempts:journal.rows()},null,2));
   fs.writeFileSync(path.join(directory,'budget-final.json'),JSON.stringify(budget.status(),null,2));
   console.log(JSON.stringify({event:'retest_stopped',stopReason,...budget.status()}));
  }
  budget.close();
 }
}
if(require.main===module){if(process.argv[2]==='--prepare')console.log(JSON.stringify(prepare()));
 else if(process.argv[2]==='--paid')run().catch(e=>{console.error(e.message);process.exitCode=1;});
 else throw new Error('Explicit --prepare or --paid required. Spending approval is separate and immutable.');}
module.exports={prepare,slotsFor,stopFor,EXPERIMENT,directory,manifestFile};
