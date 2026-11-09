'use strict';
const policy=require('./agent-plan');
const jobs=require('./agent-plan-v3.json');
const progress=require('./agent-plan-progress.json');
const labels={excluded:'Unavailable',suggest:'Suggests',draft:'You approve',trained:'After training',alone:'Within your rules'};
const tiers=['starter','growth','pro','enterprise'];
function comparison(){
  return jobs.map(job=>({id:job.id,label:job.job,
    verification:progress.complete.includes(job.id)?'Verified workflow':progress.workflowTests.includes(job.id)?'Partly verified':'Implementation pending',
    plans:tiers.map(tier=>{
      const mode=policy.allowance(tier,job.id);
      return {tier,mode,label:job.id===185&&tier==='pro'?'EDI add-on · '+labels[mode]:labels[mode]};
    })}));
}
module.exports={comparison};
