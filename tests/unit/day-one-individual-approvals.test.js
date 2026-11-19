'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../../src/commercial/agent-plan');

for(const plan of ['starter','growth','pro'])test(plan+': watch period permits exact reviews but refuses automatic and mission authority',async()=>{
 const state={plan,terms:{offerId:'agent-v3'},shadow:true};
 const db={query:async sql=>({rows:sql.includes('workspace_autopilot')?[{mode:'OBSERVE',paused:0,suspended:0}]:[]})};
 for(const action of ['contact.create','inventory.adjust','communication.send_email','report.template.create','autopilot.resume']){
  assert.equal(await policy.stopped(db,'workspace',state,action,false),null,action+' can be individually reviewed');
  assert.equal(await policy.stopped(db,'workspace',state,action,true),policy.SHADOW_REASON,action+' cannot run as automatic or mission work');
 }
 // An explicit per-job Watch only setting is still a separate owner restriction.
 const watched={query:async sql=>({rows:sql.includes('agent_job_modes')?[{mode:'watch'}]:[{mode:'SUPERVISED'}]})};
 assert.match(await policy.stopped(watched,'workspace',state,'sales_quote.create',false),/job is set to Watch only/);
 const after={...state,shadow:false};
 assert.match(await policy.stopped(db,'workspace',after,'contact.create',false),/watch-only mode/,'expiry alone never changes an explicit inventory mode');
});
