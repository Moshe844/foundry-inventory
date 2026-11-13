'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

// Job 181: every job in the action map that may act on its own appears in the
// one activity log, through one of its sources:
//  - a prepared change (a registered mutation capability), recorded with an
//    'Agent action completed' audit entry;
//  - the work a job records in its own table (WORK);
//  - the audit trail entries a job writes when it acts on its own (SOURCES);
//  - an alert email ('Alert email queued' names its job).
// The rest only answer, read for a person to confirm, or warn in the app.
const answersOnly={
 46:'adds photos to the supplier claim of job 45, which the log shows when it is sent',
 84:'answers website chat questions; it changes nothing',
 140:'reads a shelf photo for a person to confirm',
 188:'answers questions in Slack, Teams or WhatsApp; it changes nothing',
 191:'warns about expiring stock in the app and Needs you; it changes nothing'
};

test('the activity log covers every job that may act on its own, and its sources match the code',()=>{
 const root=path.join(__dirname,'..','..'),activity=require('../../src/autopilot/agent-activity');
 const registry=require('../../src/assistant/postgres-capability-registry').registry.entries;
 const plan=require('../../src/commercial/agent-plan-v3.json');
 const source=fs.readFileSync(path.join(root,'src/commercial/agent-plan.js'),'utf8');
 const pairs=[...source.match(/const actionJobs=new Map\(\[([\s\S]*?)\]\);/)[1].matchAll(/\['([^']+)',(\d+)\]/g)].map(m=>[m[1],Number(m[2])]);
 const alerts=Object.keys(require('../../src/autopilot/agent-alerts').JOBS).map(Number);
 const covered=new Set([...activity.SOURCES.map(s=>s.job),...Object.values(activity.WORK).map(w=>w.job),...alerts]);
 const missing=[];
 for(const job of new Set(pairs.map(p=>p[1]))){
  const row=plan.find(r=>r.id===job);
  if(!['starter','growth','pro','enterprise'].some(k=>['alone','trained'].includes(row[k])))continue;
  const prepared=pairs.some(([cap,j])=>j===job&&registry.get(cap)?.kind==='mutation');
  if(!prepared&&!covered.has(job)&&!answersOnly[job])missing.push(job);
 }
 assert.deepEqual(missing,[],'jobs that act on their own but are not in the activity log');

 // Each audit trail action the log reads is still written by the code, once.
 const files=[];(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(p.endsWith('.js')&&!p.endsWith('agent-activity.js'))files.push(fs.readFileSync(p,'utf8'));}})(path.join(root,'src'));
 const code=files.join('\n'),seen=new Set();
 for(const s of activity.SOURCES)for(const action of s.actions){
  assert.ok(code.includes("'"+action+"'"),'no code writes '+action);
  assert.ok(!seen.has(action),action+' is listed twice');seen.add(action);
  assert.ok(s.why&&s.rule,action+' needs why and what allowed it');
  assert.ok(s.undo?activity.UNDO[s.undo]:(s.fix||s.none),action+' needs an undo or a correction');
 }
 for(const [origin,w] of Object.entries(activity.WORK))assert.ok(w.why&&w.rule&&(w.undo?activity.UNDO[w.undo]:(w.fix||w.none)),origin);
 // Undo is only offered for internal records: outside effects show their correction.
 for(const s of activity.SOURCES)assert.ok(!(s.outside&&s.undo),s.actions[0]);
});
