'use strict';
// Operator-only continuation after a reviewed transport fix. Completed or failed
// slots are never rerun. Original corpus, model choices and approval stay sealed.
const fs=require('node:fs'),path=require('node:path');
const {directory,requireCertificate}=require('./certification');
async function main(){
 if(process.argv[2]!=='--remaining-only')throw new Error('Explicit remaining-only continuation required.');
 const certificate=requireCertificate(),{ExperimentBudget}=require('./budget');
 const {EXPERIMENT,attempt}=require('./run-pilot'),fixtures=require('./pilot-fixtures'),candidates=require('./candidates');
 const budget=new ExperimentBudget(path.join(directory,'spending.sqlite'),EXPERIMENT);
 try{
  const state=budget.status();if(state.ceiling!==10000000||!state.approval||state.stopped||state.unresolved||state.expires<=Date.now())throw new Error('PAID_TESTING_LOCKED');
  const manifest=JSON.parse(budget.db.prepare('SELECT manifest FROM pilot_manifest WHERE experiment=?').get(EXPERIMENT).manifest);
  if(manifest.corpusHash!==fixtures.corpusHash()||JSON.stringify(manifest.candidates)!==JSON.stringify(candidates.CANDIDATES)||manifest.attempts!==18)throw new Error('FROZEN_PILOT_CHANGED');
  const journal=new (require('./pilot-journal').PilotJournal)(budget,manifest),prior=journal.rows();
  if(prior.some(r=>r.state!=='FINISHED'))throw new Error('Interrupted task must be reconciled; do not rerun.');
  fs.appendFileSync(path.join(directory,'operator-continuations.jsonl'),JSON.stringify({at:new Date().toISOString(),sourceHash:certificate.sourceHash,
   originalManifest:manifest,priorAttempts:prior.length,budget:state,rule:'remaining slots only; no cost refund; no second batch'})+'\n');
  const env=require('node:util').parseEnv(fs.readFileSync(path.join(__dirname,'../../.env'),'utf8'));
  const credentials={openai:process.env.OPENAI_API_KEY||env.OPENAI_API_KEY,anthropic:process.env.ANTHROPIC_API_KEY||env.ANTHROPIC_API_KEY};
  if(!credentials.openai||!credentials.anthropic)throw new Error('Both API credentials required.');
  const names=['adaptive','openai','claude'];
  for(const [index,task]of fixtures.TASKS.entries())for(let position=0;position<3;position++){
   const candidate=names[(index+position)%3];if(prior.some(r=>r.task===task.id&&r.candidate===candidate))continue;
   const current=budget.status();if(current.unresolved||current.stopped||current.remaining<=0)throw new Error('Shared budget stopped the remaining pilot.');
   journal.begin(task.id,candidate);console.log(JSON.stringify({event:'attempt_started',task:task.id,candidate,remainingUsd:current.remaining/1e6}));
   const result=await attempt({candidate,task,budget,certificate,credentials,outputDirectory:path.join(directory,'pilot',task.id,candidate)});
   journal.finish(task.id,candidate,result);console.log(JSON.stringify({event:'attempt_finished',task:task.id,candidate,
    verified:result.verifiedOutcome,status:result.status,cost:result.conservativeCostUsd,error:result.error}));
   fs.writeFileSync(path.join(directory,'pilot-results.json'),JSON.stringify({manifest,budget:budget.status(),attempts:journal.rows()},null,2));
  }
 }finally{console.log(JSON.stringify({event:'budget_final',...budget.status()}));budget.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
