'use strict';
const policy=require('./agent-plan');
const jobs=require('./agent-plan-v3.json');
const progress=require('./agent-plan-progress.json');
const currentScope=require('./agent-current-scope');
const labels={excluded:'Not included',suggest:'Answers or suggests',draft:'Prepares it; you approve',trained:'After you train it',alone:'No training needed'};
const tiers=['starter','growth','pro','enterprise'];
// Section boundaries from the 19 areas in the approved v3 PDF.
const areas=[[1,'Stock & counts'],[18,'Reorder & purchasing'],[43,'Receiving'],[52,'Orders & shipping'],[72,'Customers, quotes & pricing'],[89,'Suppliers & negotiation'],[98,'Invoices, bills & payments'],[111,'Returns'],[117,'Locations & warehouses'],[126,'Products & catalog'],[135,'Documents, email & photos'],[144,'Forecasting & planning'],[152,'Reports & questions'],[166,'Alerts & monitoring'],[174,'Team & approvals'],[182,'Integrations & channels'],[191,'Lots, expiry & recalls'],[198,'Trust & safety'],[207,'Training & playbooks']];
const defaults={
 starter:'Answers, alerts and reports without training. You approve stock changes, spending and each shipment tracking email.',
 growth:'Handles small daily jobs without training. Repeat purchasing uses the suppliers and items you mark as trusted. Other duties need a taught rule or your approval.',
 pro:'Handles routine buying, selling and stock work without training, inside your limits. Some specialist duties still need training or approval.',
 enterprise:'Handles the duties included in your agreement, inside your rules and agreed limits. Required human approvals still apply.'
};
function comparison(){
  return jobs.map(job=>({id:job.id,label:job.job,area:areas.filter(([first])=>first<=job.id).at(-1)[0],
    status:progress.complete.includes(job.id)?'complete':progress.workflowTests.includes(job.id)?'partial':'pending',
    verification:progress.complete.includes(job.id)?'Working workflow':progress.workflowTests.includes(job.id)?'Limited scope':'Planned',
    currentScope:progress.workflowTests.includes(job.id)?currentScope.current(job.id):null,
    plans:tiers.map(tier=>{
      const mode=policy.allowance(tier,job.id);
      return {tier,mode,label:job.id===185&&tier==='pro'?'EDI add-on · '+labels[mode]:labels[mode],currentScope:mode!=='excluded'&&progress.workflowTests.includes(job.id)?currentScope.current(job.id,tier):null};
    })}));
}
function presentation(){
 const rows=comparison(),groups=areas.map(([id,label])=>({id,label,jobs:rows.filter(r=>r.area===id)}));
 const plans=Object.fromEntries(tiers.map(tier=>{const included=rows.map(row=>{const cell=row.plans.find(p=>p.tier===tier);return {...row,mode:cell.mode,modeLabel:cell.label,currentScope:cell.currentScope};}).filter(r=>r.mode!=='excluded'),working=included.filter(r=>r.status!=='pending');return [tier,{defaultDescription:defaults[tier],included:included.length,working:working.length,pending:included.length-working.length,counts:Object.fromEntries(['alone','trained','draft','suggest'].map(mode=>[mode,working.filter(r=>r.mode===mode).length])),groups:groups.map(g=>({...g,jobs:included.filter(r=>r.area===g.id)})).filter(g=>g.jobs.length)}];}));
 return {rows,groups,plans,modeLabels:labels};
}
module.exports={comparison,presentation};
