'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../../src/commercial/agent-plan');
const registry=require('../../src/autopilot/learning-adapters');
const learning=require('../../src/autopilot/approval-learning');

const plans=['starter','growth','pro','enterprise'];
const trainedJobs=require('../../src/commercial/agent-plan-v3.json').map(r=>r.id).filter(id=>plans.some(p=>policy.allowance(p,id)==='trained'));

// Job 208: every job that is trained on some plan learns from your approvals
// through its own adapter, rides on another job's taught rule, or says why
// approvals cannot teach it. A new trained job fails here until it does.
test('job 208 covers every trained job with an adapter or a reason',()=>{
 assert(trainedJobs.length>50);
 const missing=trainedJobs.filter(job=>!registry.coverage(job));
 assert.deepEqual(missing,[],'trained jobs with no learning adapter and no reason it cannot learn');
 for(const [job,reason] of Object.entries(registry.cannot)){
  assert(trainedJobs.includes(Number(job)),'job '+job+' is not trained on any plan');
  assert(typeof reason==='string'&&reason.length>40,'job '+job+' needs a real reason');
  assert(!registry.adapters.some(a=>a.jobs.includes(Number(job))),'job '+job+' has both an adapter and a reason');
 }
 for(const [job,entry] of Object.entries(registry.via)){
  assert(trainedJobs.includes(Number(job)));assert(entry.reason.length>40);
  assert(entry.kind==='steps'||registry.adapters.some(a=>a.kind===entry.kind),'job '+job+' rides on an adapter that exists');
 }
 const kinds=new Set();
 for(const a of registry.adapters){
  assert(/^[a-z0-9_.:-]{1,80}$/.test(a.kind)&&!kinds.has(a.kind),'adapter kind '+a.kind);kinds.add(a.kind);
  assert(a.jobs.length&&a.jobs.every(job=>trainedJobs.includes(job)),'adapter '+a.kind+' teaches trained jobs only');
  for(const fn of ['history','offer','teach'])assert.equal(typeof a[fn],'function',a.kind+' '+fn);
  assert(Array.isArray(a.tables)&&a.tables.every(t=>/^stockchief_runtime\.[a-z_]+$/.test(t)),a.kind+' tables');
 }
 // The pick release and draft routines keep the decision names they had.
 assert(kinds.has('warehouse.release_orders')&&kinds.has('draft-routines'));
});

test('job 208 runs: five identical approvals in a row, back to the last no',()=>{
 const adapter={kind:'job:test',jobs:[118]},at=n=>new Date(Date.UTC(2026,0,1,0,n));
 const rows=(list)=>list.map(([n,o={}],i)=>({id:'r'+i,scope:o.scope||'a',at:at(n),declined:Boolean(o.no),needsPerson:Boolean(o.person),variant:o.variant??null}));
 const runs=list=>learning.runsOf(adapter,rows(list),new Map());
 assert.equal(runs([[1],[2],[3],[4]]).length,0,'four is not a run');
 assert.equal(runs([[1],[2],[3],[4],[5]])[0].rows.length,5);
 assert.equal(runs([[1],[2],[3,{no:true}],[4],[5],[6],[7]]).length,0,'a no restarts the run');
 assert.equal(runs([[1],[2],[3,{person:true}],[4],[5],[6]])[0].rows.length,5,'an approval that always needs a person neither counts nor breaks the run');
 assert.equal(runs([[1,{variant:'x'}],[2,{variant:'y'}],[3,{variant:'y'}],[4,{variant:'y'}],[5,{variant:'y'}]]).length,0,'a changed choice breaks the run');
 assert.equal(runs([[1],[2],[3],[5,{scope:'b'}],[6]]).length,0,'scopes are counted apart');
 const latest=runs([[1],[2],[3],[4],[5],[6]])[0];assert.equal(latest.latest.id,'r5');assert.equal(latest.first.id,'r0');assert.equal(latest.rows.length,6,'the run is every identical approval back to the last no');
 // Keep asking: nothing up to the newest approval the owner saw counts again.
 const decided=new Map([['job:test\u0000a',at(5)]]);
 assert.equal(learning.runsOf(adapter,rows([[1],[2],[3],[4],[5],[6],[7],[8],[9]]),decided).length,0);
 assert.equal(learning.runsOf(adapter,rows([[1],[2],[3],[4],[5],[6],[7],[8],[9],[10]]),decided)[0].rows.length,5);
});
