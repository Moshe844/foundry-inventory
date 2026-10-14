'use strict';
const {AuthorizationError,ValidationError}=require('../domain/errors');
const store=require('./postgres-goal-store');
const readonlyAuthorizations=new WeakMap();
const list=value=>String(value||'').split(',').map(s=>s.trim()).filter(Boolean);
function configured(ctx){return process.env.STOCKCHIEF_RUNTIME_ENV==='staging'&&process.env.STOCKCHIEF_CODEX_PILOT==='1'&&
 list(process.env.STOCKCHIEF_CODEX_PILOT_WORKSPACES).includes(ctx.workspaceId);}
async function access(db,ctx,{enabled=false,owner=false}={}){
 if(!configured(ctx))throw new AuthorizationError('The Codex pilot is not available in this business.');
 // One fresh identity/pilot snapshot for this boundary. No authority is cached
 // between reads, model requests or operations.
 const row=(await db.query(`SELECT u.id,u.role,u.permissions,a.email,w.owner_account_id,w.name AS business_name,to_jsonb(p) AS pilot
  FROM users u JOIN accounts a ON a.id=u.account_id JOIN workspaces w ON w.id=u.workspace_id
  LEFT JOIN stockchief_runtime.codex_pilots p ON p.workspace_id=u.workspace_id
  WHERE u.workspace_id=$1 AND u.id=$2`,[ctx.workspaceId,ctx.actorId])).rows[0];
 const actor=row&&{id:row.id,role:row.role,permissions:row.permissions,email:row.email};
 if(!actor||!list(process.env.STOCKCHIEF_CODEX_PILOT_EMAILS).map(s=>s.toLowerCase()).includes(actor.email.toLowerCase())||owner&&actor.role!=='owner')
  throw new AuthorizationError('This account is not authorized for the Staging pilot.');
 const pilot=row.pilot;
 if(!pilot||!pilot.authorized_actor_ids.includes(ctx.actorId)||enabled&&!pilot.enabled)
  throw new AuthorizationError('The Staging pilot is disabled for this account.');
 // assertCapability still freshly verifies the commercial ownership scope,
 // subscription, overrides and entitlement; the joined owner avoids a second
 // identical owner lookup before that check.
 const scope={accountId:row.owner_account_id,workspaceId:ctx.workspaceId};
 const entitlement=await require('../commercial/entitlements').assertCapability(db,scope,'ask.lookup');
 return {actor,pilot,commercialAccess:{scope,entitlement},environment:{business:{name:row.business_name},actor:{role:actor.role},clock:{utc:new Date().toISOString()}}};
}
async function selected(db,ctx){if(!configured(ctx))return false;try{await access(db,ctx,{enabled:true});return true;}catch(e){if(e instanceof AuthorizationError)return false;throw e;}}
function spendingLockMessage(pilot){
 if(!pilot.approval_reference||Number(pilot.ceiling_micro_usd)<=0)return 'The pilot is enabled, but paid agent work is locked until a Staging budget is approved.';
 if(new Date(pilot.period_ends_at)<=new Date())return 'Your approved Staging budget period has expired. Paid agent work is locked.';
 if(pilot.stopped)return 'Agent spending is paused. Your Staging budget is already approved.';
 return null;
}
async function view(db,ctx){if(!configured(ctx))return null;try{const {actor,pilot}=await access(db,ctx);
 const usage=await require('./postgres-codex-budget').createBudget(db,ctx,null).status();return {
 enabled:pilot.enabled,canToggle:actor.role==='owner',funded:!spendingLockMessage(pilot),lockMessage:spendingLockMessage(pilot),
 workerAvailable:Boolean(pilot.worker_seen_at&&Date.now()-new Date(pilot.worker_seen_at).getTime()<30000),
 budget:{ceiling:usage.ceiling,committed:usage.committed,remaining:usage.remaining},
 model:'Codex SDK',reasoning:'Adaptive reasoning'};}catch(e){if(e instanceof AuthorizationError)return null;throw e;}}
async function toggle(db,ctx,enabled){await access(db,ctx,{owner:true});
 return db.transaction(async client=>{
  await client.query(`UPDATE stockchief_runtime.codex_pilots SET enabled=$2,revision=revision+1,updated_at=now() WHERE workspace_id=$1`,[ctx.workspaceId,Boolean(enabled)]);
  if(!enabled)await client.query(`UPDATE stockchief_runtime.assistant_goals SET status='CANCELLED',run_token=NULL,lease_until=NULL,
   answer='The Staging agent was disabled. Approved operations retain their canonical recorded status.',updated_at=now()
   WHERE workspace_id=$1 AND checkpoint->>'runtime'='codex-staging' AND status NOT IN ('COMPLETED','CANCELLED','BLOCKED')`,[ctx.workspaceId]);
 });
}
async function start(db,ctx,message,options={}){
 ctx=await require('./codex-model-routing').context(db,ctx);
 const {pilot}=await access(db,ctx,{enabled:true});
 const locked=spendingLockMessage(pilot);if(locked)throw new ValidationError(locked);
 const conversation=await require('./postgres-agent-context').capture(db,ctx,options.startedAt||null);
 const goal=await store.create(db,ctx,message,{...options,budgetMinor:Math.min(options.budgetMinor||100,100)});
 if(goal.checkpoint.runtime&&goal.checkpoint.runtime!=='codex-staging')throw new ValidationError('That request already belongs to another Ask runtime.');
 await db.query(`UPDATE stockchief_runtime.assistant_goals SET checkpoint=$4::jsonb||checkpoint||$5::jsonb WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,
  [ctx.workspaceId,ctx.actorId,goal.id,JSON.stringify({conversation,clientIntegration:1}),JSON.stringify({runtime:'codex-staging',pilotRevision:pilot.revision,
   ...(!goal.checkpoint.modelRouting&&!goal.checkpoint.harness?.native?.codex?{modelRouting:require('./codex-model-routing').initial(ctx)}:{})})]);
 goal.checkpoint.runtime='codex-staging';
 await store.enqueue(db,goal);return {status:'CLARIFY',answer:'StockChief is investigating your goal.',goalId:goal.id,goalStatus:goal.status};
}
async function inbox(db,ctx,id){await access(db,ctx);const goal=await store.get(db,ctx,id);
 if(!goal||goal.checkpoint.runtime!=='codex-staging')throw new ValidationError('Pilot goal not found.');
 const result=await require('../../scripts/environment-agent-demo/approval-handoff').inbox(db,ctx,id);
 const approvals=result?.approvals||[];
 for(const card of approvals)if(card.kind==='business'){
  const mission=await require('./postgres-capability-plans').missionForProposal(db,ctx.workspaceId,ctx.actorId,card.proposalId);
  const approvedScope=card.decision?.source==='human_user'&&card.decision.approved&&card.decision.scope?.kind==='mission'&&card.decision.scope.id===mission?.id&&card.decision.scope.sha256===mission?.plan_hash;
  if(mission?.goal_id===id&&mission.waiting_proposal_id===card.proposalId&&(mission.approval_status==='PENDING'||mission.approval_status==='APPROVED'&&approvedScope)&&mission.approved_steps.length>1)
   card.mission={id:mission.id,sha256:mission.plan_hash,count:mission.approved_steps.length};
 }
 return {goal:result?await store.get(db,ctx,id):goal,approvals};
}
async function decide(db,ctx,id,deliveryId,sha256,approved,{responseReference,missionScope=null}={}){
 await access(db,ctx,{enabled:true});
 const goal=await store.get(db,ctx,id);if(goal?.checkpoint.runtime!=='codex-staging')throw new ValidationError('Pilot goal not found.');
 if(goal.checkpoint.harness?.approvalDeliveries?.[deliveryId]?.sha256!==sha256)throw new ValidationError('The prepared approval changed. Reload its exact card before approving.');
 const handoff=require('../../scripts/environment-agent-demo/approval-handoff');
 const result=await handoff.decide({database:db,ctx,goalId:id,id:deliveryId,sha256,
  decision:{source:'human_user',approved:Boolean(approved),responseReference,...(missionScope?{scope:missionScope}:{})},
  execute:async(proposal,executionDb,scope)=>{
   if(!proposal.action_type)return require('../manager/postgres-operating-instructions').approve(executionDb,ctx,proposal.id,proposal.integrity_hash);
   const service=require('./postgres-service'),options={provider:{name:'openai',model:'gpt-6.1-sol',complete:async()=>{throw Error('UNAPPROVED_HELPER_MODEL_CALL');}}};
   if(scope){options.missionApproval={expectedHash:scope.sha256,expectedId:scope.id};return service.executeMission(executionDb,{...ctx,goalId:id},proposal.id,options);}
   return service.executeProposal(executionDb,{...ctx,goalId:id},proposal.id,options);
  }});
 if(!approved){const current=await inbox(db,ctx,id),card=current.approvals.find(c=>c.id===deliveryId);
  if(card?.kind==='rule')await require('../manager/postgres-operating-instructions').cancel(db,ctx,card.proposalId);
  else if(card)await require('./postgres-service').cancelProposal(db,ctx,card.proposalId);}
 const updated=await require('../../scripts/environment-agent-demo/waits').refresh(db,ctx,id);
 if(updated?.status==='READY')await store.enqueue(db,updated);return result;
}
async function run(db,ctx,id,options={}){
 const {pilot}=await access(db,ctx,{enabled:true});
 if(spendingLockMessage(pilot)){
  const goal=await store.get(db,ctx,id);
  if(goal?.checkpoint.runtime!=='codex-staging')throw new ValidationError('Pilot goal not found.');
  // A funding pause is not a failed investigation. Leave the durable goal,
  // native thread and already-approved operations available for resumption.
  return {status:goal.status,waitingForFunding:true,answer:spendingLockMessage(pilot)};
 }
 return require('./postgres-codex-runtime').run(db,ctx,id,options);
}
async function resume(db,ctx,id){
 const {pilot}=await access(db,ctx,{enabled:true});const locked=spendingLockMessage(pilot);if(locked)throw new ValidationError(locked);
 const goal=await db.transaction(async client=>{
  const row=(await client.query('SELECT * FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE',[ctx.workspaceId,ctx.actorId,id])).rows[0];
  if(!row||row.checkpoint.runtime!=='codex-staging'||row.status!=='BLOCKED'||new Date(row.expires_at)<=new Date())throw new ValidationError('This saved request cannot be continued.');
  const h=row.checkpoint.harness||{};
  if(h.inflight||h.codexDelivery?.state==='PENDING'||h.helperDelivery?.state==='PENDING'||(await client.query("SELECT 1 FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1 AND goal_id=$2 AND state IN ('RESERVED','UNKNOWN') LIMIT 1",[ctx.workspaceId,id])).rows.length)
   throw new ValidationError('An earlier step still needs reconciliation. StockChief will not repeat an uncertain operation or charge.');
  if(Number(h.codexRequests||0)>=24||Number(row.tool_calls)>=30)throw new ValidationError('This request reached its existing execution limits. Recorded changes and approvals remain available for review.');
  await require('../../scripts/environment-agent-demo/waits').authority(client,ctx,h);
  const dependencies=require('../../scripts/environment-agent-demo/waits').dependencies(h);
  const state=await require('../../scripts/environment-agent-demo/waits').current(client,ctx,id,dependencies);
  if(state==='BLOCKED')throw new ValidationError('A recorded dependency still needs attention before this request can continue.');
  h.failure=null;h.interruption=null;h.admissionBlock=null;h.pendingReport=null;row.checkpoint.harness=h;
  row.status=state==='READY'?'READY':state;row.answer=state==='READY'?'Continuing your saved request. Previously recorded work will not be repeated.':row.answer;
  require('./agent-conversation').sync(row);
  return (await client.query(`UPDATE stockchief_runtime.assistant_goals SET status=$4,answer=$5,checkpoint=$6::jsonb,recoveries=recoveries+1,
   run_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 RETURNING *`,[ctx.workspaceId,ctx.actorId,id,row.status,row.answer,JSON.stringify(row.checkpoint)])).rows[0];
 },{isolation:'SERIALIZABLE',retrySafe:true});
 if(goal.status==='READY')await store.enqueue(db,goal);return goal;
}
async function readAuthorization(db,ctx,connectionString){await access(db,ctx,{enabled:true});
 if(!connectionString||connectionString!==(process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL))throw new AuthorizationError('The renderer must use the configured Staging database.');
 const token=Object.freeze({});readonlyAuthorizations.set(token,{...ctx,connectionString});return token;
}
function assertReadAuthorization(token,cluster,ctx){const p=readonlyAuthorizations.get(token);
 if(!p||!configured(ctx)||p.connectionString!==cluster.connectionString||p.workspaceId!==ctx.workspaceId||p.actorId!==ctx.actorId)
  throw new AuthorizationError('Invalid Staging renderer identity.');
}
module.exports={configured,access,selected,view,toggle,start,inbox,decide,run,resume,readAuthorization,assertReadAuthorization};
