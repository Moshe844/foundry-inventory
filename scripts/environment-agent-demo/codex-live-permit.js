'use strict';
// Trusted host capability, never serialized into a tool, container or prompt.
// It binds this temporary certification runtime to one immutable paid slot.
const permits=new WeakMap();
function bindingTable(budget){budget.db.exec(`CREATE TABLE IF NOT EXISTS codex_runtime_authorizations(
 experiment TEXT PRIMARY KEY,task TEXT NOT NULL,source_hash TEXT NOT NULL,image TEXT NOT NULL,
 profile TEXT NOT NULL,ceiling INTEGER NOT NULL,goal_id TEXT,workspace_id TEXT,actor_id TEXT)`);}
function capability(budget,row){const permit=Object.freeze({});permits.set(permit,{budget,task:row.task,sourceHash:row.source_hash,
 image:row.image,profile:row.profile,ceilingMicroUsd:row.ceiling,goalBudgetMinor:Math.min(100,row.ceiling/10000),
 goalId:row.goal_id||null,workspaceId:row.workspace_id||null,actorId:row.actor_id||null});return permit;}
function issue({budget,task,sourceHash,image,ceilingMicroUsd=750000}){
 const state=budget.status();
 const slots=budget.db.prepare('SELECT task,candidate,state FROM pilot_attempts WHERE experiment=?').all(budget.experiment);
 if(!Number.isSafeInteger(ceilingMicroUsd)||ceilingMicroUsd<=0||ceilingMicroUsd>3000000||ceilingMicroUsd%10000!==0||
  !state.approval||state.ceiling!==ceilingMicroUsd||state.stopped||state.unresolved||state.expires<=Date.now()||
  state.calls!==0||slots.length!==1||slots[0].task!==task||slots[0].candidate!=='codex'||slots[0].state!=='RUNNING'||
  sourceHash!==require('./certification').sourceHash()||!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('CODEX_LIVE_NOT_CERTIFIED');
 bindingTable(budget);
 const row={task,source_hash:sourceHash,image,profile:require('./codex-wire').PROFILE.id,ceiling:ceilingMicroUsd};
 budget.transaction(()=>{
  if(budget.db.prepare('SELECT 1 FROM codex_runtime_authorizations WHERE experiment=?').get(budget.experiment))throw Error('CODEX_LIVE_NOT_CERTIFIED');
  budget.db.prepare('INSERT INTO codex_runtime_authorizations(experiment,task,source_hash,image,profile,ceiling) VALUES(?,?,?,?,?,?)').run(budget.experiment,task,sourceHash,image,row.profile,ceilingMicroUsd);
 });
 return capability(budget,row);
}
function bind(permit,identity){
 if(require('../../src/assistant/codex-staging-permit').has(permit))return require('../../src/assistant/codex-staging-permit').bind(permit,identity);
 const p=permits.get(permit);if(!p)throw Error('CODEX_LIVE_NOT_CERTIFIED');assert(permit,{budget:p.budget});
 if(identity?.candidate!=='codex'||!['goalId','workspaceId','actorId'].every(key=>typeof identity[key]==='string'&&identity[key]))throw Error('INVALID_CODEX_SESSION');
 p.budget.transaction(()=>{
  const row=p.budget.db.prepare('SELECT * FROM codex_runtime_authorizations WHERE experiment=?').get(p.budget.experiment);
  if(row.goal_id&&(row.goal_id!==identity.goalId||row.workspace_id!==identity.workspaceId||row.actor_id!==identity.actorId))throw Error('CODEX_SESSION_AUTHORITY_BINDING_MISMATCH');
  if(!row.goal_id)p.budget.db.prepare('UPDATE codex_runtime_authorizations SET goal_id=?,workspace_id=?,actor_id=? WHERE experiment=? AND goal_id IS NULL')
   .run(identity.goalId,identity.workspaceId,identity.actorId,p.budget.experiment);
 });
 Object.assign(p,{goalId:identity.goalId,workspaceId:identity.workspaceId,actorId:identity.actorId});
}
// Restore the SAME unfinished authorization, never issue another attempt or
// refill money. Unknown calls, a completed slot, changed code/model/image,
// expired approval or a stopped ledger all require explicit reconciliation.
function recover({budget,task,sourceHash,image}){
 const state=budget.status();
 const exists=budget.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_runtime_authorizations'").get();
 const row=exists&&budget.db.prepare('SELECT * FROM codex_runtime_authorizations WHERE experiment=?').get(budget.experiment);
 const slots=budget.db.prepare('SELECT task,candidate,state FROM pilot_attempts WHERE experiment=?').all(budget.experiment);
 if(!row||!state.approval||state.stopped||state.unresolved||state.expires<=Date.now()||state.remaining<=0||state.ceiling!==row.ceiling||
  row.task!==task||row.source_hash!==sourceHash||sourceHash!==require('./certification').sourceHash()||row.image!==image||row.profile!==require('./codex-wire').PROFILE.id||
  state.calls>0&&!row.goal_id||slots.length!==1||slots[0].task!==task||slots[0].candidate!=='codex'||slots[0].state!=='RUNNING')throw Error('CODEX_RESUMPTION_NOT_CERTIFIED');
 return capability(budget,row);
}
function assert(permit,{budget,task,image}={}){
 if(require('../../src/assistant/codex-staging-permit').has(permit))return require('../../src/assistant/codex-staging-permit').assert(permit,{budget,task,image});
 const p=permit&&permits.get(permit),state=budget?.status();
 if(!p||p.profile!==require('./codex-wire').PROFILE.id||p.budget!==budget||task&&task!==p.task||image&&image!==p.image||!state.approval||state.ceiling!==p.ceilingMicroUsd||
  state.stopped||state.unresolved||state.expires<=Date.now()||p.sourceHash!==require('./certification').sourceHash())throw Error('CODEX_LIVE_NOT_CERTIFIED');
 return p;
}
function assertSetup(permit,options={}){
 if(require('../../src/assistant/codex-staging-permit').has(permit))return require('../../src/assistant/codex-staging-permit').assertBinding(permit,options);
 return assert(permit,options);
}
async function assertFresh(permit,options={}){
 if(require('../../src/assistant/codex-staging-permit').has(permit))return require('../../src/assistant/codex-staging-permit').assertFresh(permit,options);
 return assert(permit,options);
}
module.exports={issue,assert,assertFresh,assertSetup,recover,bind};
