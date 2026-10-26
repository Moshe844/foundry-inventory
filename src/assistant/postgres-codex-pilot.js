'use strict';
const {AuthorizationError,ValidationError,NotFoundError}=require('../domain/errors');
const store=require('./postgres-goal-store');
const readonlyAuthorizations=new WeakMap();
const {list,configured,fundingWorkspaces,customerAccess}=require('./codex-pilot-scope');
async function access(db,ctx,{enabled=false,owner=false}={}){
 if(!configured(ctx))throw new AuthorizationError('The Codex pilot is not available in this business.');
 // One fresh identity/pilot snapshot for this boundary. No authority is cached
 // between reads, model requests or operations.
 const row=(await db.query(`SELECT u.id,u.role,u.permissions,a.email,a.id AS account_id,w.owner_account_id,w.name AS business_name,p.pilot
  FROM users u JOIN accounts a ON a.id=u.account_id JOIN workspaces w ON w.id=u.workspace_id
  LEFT JOIN stockchief_runtime.codex_pilot_workspace_access p ON p.workspace_id=u.workspace_id
    AND (p.funding_workspace_id=ANY($3::text[]) OR $4 AND p.pilot->>'admission_kind'='COMMERCIAL')
  WHERE u.workspace_id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId,fundingWorkspaces(),customerAccess()])).rows[0];
 const actor=row&&{id:row.id,role:row.role,permissions:row.permissions,email:row.email};
 if(customerAccess()&&actor&&(!row.pilot||row.pilot.admission_kind==='COMMERCIAL')){
  if(owner&&actor.role!=='owner')throw new AuthorizationError('Only an owner can change agent availability.');
  const checked=await require('./postgres-codex-enrollment').policy(db,ctx);
  const pilot=row.pilot||{admission_kind:'COMMERCIAL',enabled:true,unprovisioned:true,ceiling_micro_usd:checked.ceiling,
   period_ends_at:checked.period.end.toISOString(),approval_reference:'commercial-plan:'+checked.subscription.id,stopped:false};
  if(enabled&&!pilot.enabled)throw new AuthorizationError('The business agent is disabled in this inventory.');
  return {actor,pilot,commercialAccess:{scope:checked.scope,entitlement:checked.entitlement},environment:{business:{name:row.business_name},actor:{role:actor.role},clock:{utc:new Date().toISOString()}}};
 }
 if(!actor||!list(process.env.STOCKCHIEF_CODEX_PILOT_EMAILS).map(s=>s.toLowerCase()).includes(actor.email.toLowerCase())||owner&&actor.role!=='owner')
  throw new AuthorizationError('This account is not authorized for the Staging pilot.');
 const pilot=row.pilot;
 const authorized=pilot?.account_inherited?row.account_id===row.owner_account_id&&actor?.role==='owner':pilot?.authorized_actor_ids.includes(ctx.actorId);
 if(!pilot||!authorized||enabled&&!pilot.enabled)
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
 if(pilot.admission_kind==='COMMERCIAL')return null;
 const usage=await require('./postgres-codex-budget').createBudget(db,ctx,null).status();return {
 enabled:pilot.enabled,canToggle:actor.role==='owner',funded:!spendingLockMessage(pilot),lockMessage:spendingLockMessage(pilot),
 workerAvailable:Boolean(pilot.worker_seen_at&&Date.now()-new Date(pilot.worker_seen_at).getTime()<30000),
 budget:{ceiling:usage.ceiling,committed:usage.committed,remaining:usage.remaining},
 model:'Codex SDK',reasoning:'Adaptive reasoning'};}catch(e){if(e instanceof AuthorizationError)return null;throw e;}}
async function toggle(db,ctx,enabled){await access(db,ctx,{owner:true});
 await require('./postgres-codex-enrollment').ensure(db,ctx);
 return db.transaction(async client=>{
  const {pilot}=await access(client,ctx,{owner:true});
  if(pilot.account_inherited)await client.query(`INSERT INTO stockchief_runtime.codex_pilot_workspace_settings(workspace_id,enabled)
   VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,revision=codex_pilot_workspace_settings.revision+1,updated_at=now()`,[ctx.workspaceId,Boolean(enabled)]);
  else await client.query(`UPDATE stockchief_runtime.codex_pilots SET enabled=$2,revision=revision+1,updated_at=now() WHERE workspace_id=$1`,[ctx.workspaceId,Boolean(enabled)]);
  if(!enabled)await client.query(`UPDATE stockchief_runtime.assistant_goals SET status='CANCELLED',run_token=NULL,lease_until=NULL,
   answer='The Staging agent was disabled. Approved operations retain their canonical recorded status.',updated_at=now()
   WHERE workspace_id=$1 AND checkpoint->>'runtime'='codex-staging' AND status NOT IN ('COMPLETED','CANCELLED','BLOCKED')`,[ctx.workspaceId]);
 });
}
async function start(db,ctx,message,options={}){
 ctx=await require('./codex-model-routing').context(db,ctx);
 await require('./postgres-codex-enrollment').ensure(db,ctx);
 const {pilot}=await access(db,ctx,{enabled:true});
 const locked=spendingLockMessage(pilot);if(locked)throw new ValidationError('Ask is temporarily paused because its usage allowance is unavailable. Your message has not run. It is kept below so you can try again when access is restored.',{reason:'agent_allowance_unavailable'});
 const conversation=await require('./postgres-agent-context').capture(db,ctx,options.startedAt||null);
 const goal=await store.create(db,ctx,message,{...options,budgetMinor:Math.min(options.budgetMinor||100,100)});
 if(goal.checkpoint.runtime&&goal.checkpoint.runtime!=='codex-staging')throw new ValidationError('That request already belongs to another Ask runtime.');
 await db.query(`UPDATE stockchief_runtime.assistant_goals SET checkpoint=$4::jsonb||checkpoint||$5::jsonb WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,
  [ctx.workspaceId,ctx.actorId,goal.id,JSON.stringify({conversation,clientIntegration:1}),JSON.stringify({runtime:'codex-staging',pilotRevision:pilot.revision,
   ...(!goal.checkpoint.modelRouting&&!goal.checkpoint.harness?.native?.codex?{modelRouting:require('./codex-model-routing').initial(ctx)}:{})})]);
 goal.checkpoint.runtime='codex-staging';
 await store.enqueue(db,goal);return {status:'CLARIFY',answer:'StockChief is investigating your goal.',goalId:goal.id,goalStatus:goal.status};
}
async function inbox(db,ctx,id,{progress=false}={}){await access(db,ctx);
 const read=progress?store.progress:store.get,goal=await read(db,ctx,id);
 if(!goal||goal.checkpoint.runtime!=='codex-staging')throw new ValidationError('Pilot goal not found.');
 const result=await require('../../scripts/environment-agent-demo/approval-handoff').inbox(db,ctx,id);
 const approvals=result?.approvals||[];
 for(const card of approvals)if(card.kind==='business'){
  const mission=await require('./postgres-capability-plans').missionForProposal(db,ctx.workspaceId,ctx.actorId,card.proposalId);
  const approvedScope=card.decision?.source==='human_user'&&card.decision.approved&&card.decision.scope?.kind==='mission'&&card.decision.scope.id===mission?.id&&card.decision.scope.sha256===mission?.plan_hash;
  if(mission?.goal_id===id&&mission.waiting_proposal_id===card.proposalId&&(mission.approval_status==='PENDING'||mission.approval_status==='APPROVED'&&approvedScope)&&mission.approved_steps.length>1)
   card.mission={id:mission.id,sha256:mission.plan_hash,count:mission.approved_steps.length};
 }
 return {goal:result?await read(db,ctx,id):goal,approvals};
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
   if(scope){
    // The handoff rechecks the recorded human decision and frozen scope before
    // this callback. Continue its remaining steps; never reapprove or rerun a
    // completed first operation to recover a later preparation.
    if(proposal.status==='EXECUTED'){
      try{return {...proposal,replayed:true,missionId:scope.id,
        continued:await service.resumeMission(executionDb,{...ctx,goalId:id},scope.id,options)};}
      catch(error){console.warn('[stockchief] approved mission continuation failed',error.code||error.name);
        return {...proposal,replayed:true,missionId:scope.id,continuationError:error.message};}
    }
    options.missionApproval={expectedHash:scope.sha256,expectedId:scope.id};return service.executeMission(executionDb,{...ctx,goalId:id},proposal.id,options);
   }
   return service.executeProposal(executionDb,{...ctx,goalId:id},proposal.id,options);
  }});
 if(!approved){const current=await inbox(db,ctx,id),card=current.approvals.find(c=>c.id===deliveryId);
  if(card?.kind==='rule')await require('../manager/postgres-operating-instructions').cancel(db,ctx,card.proposalId);
  else if(card)await require('./postgres-service').cancelProposal(db,ctx,card.proposalId);}
 const updated=await require('../../scripts/environment-agent-demo/waits').refresh(db,ctx,id);
 if(updated?.status==='READY')await store.enqueue(db,updated);return result;
}
async function run(db,ctx,id,options={}){
 await require('./postgres-codex-enrollment').ensure(db,ctx);
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
// Shared read-only eligibility, not an execution grant. The mutation path calls
// this again on its freshly locked owned row. History may display its decision
// without clearing a failure, enqueueing, reconciling usage or invoking a model.
async function continuationState(client,ctx,row){
  if(!row||row.workspace_id!==ctx.workspaceId||row.actor_user_id!==ctx.actorId||row.checkpoint.runtime!=='codex-staging'||row.status!=='BLOCKED'||new Date(row.expires_at)<=new Date())throw new ValidationError('This saved request cannot be continued.');
  const id=row.id;
  const h=row.checkpoint.harness||{};
  if(h.inflight||h.codexDelivery?.state==='PENDING'||h.helperDelivery?.state==='PENDING'||(await client.query("SELECT 1 FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1 AND goal_id=$2 AND state IN ('RESERVED','UNKNOWN') LIMIT 1",[ctx.workspaceId,id])).rows.length)
   throw new ValidationError('An earlier step still needs reconciliation. StockChief will not repeat an uncertain operation or charge.');
  if(Number(h.codexRequests||0)>=24||Number(row.tool_calls)>=30){
   const profile=require('./codex-model-routing').selected(row,ctx);
   if(!require('../../scripts/environment-agent-demo/codex-runtime').savedFinal(h,{profile,messages:row.checkpoint.messages||[]}))
    throw new ValidationError('This request reached its existing execution limits. Recorded changes and approvals remain available for review.');
  }
  await require('../../scripts/environment-agent-demo/waits').authority(client,ctx,h);
  const dependencies=require('../../scripts/environment-agent-demo/waits').dependencies(h);
  const state=await require('../../scripts/environment-agent-demo/waits').current(client,ctx,id,dependencies);
  if(state==='BLOCKED')throw new ValidationError('A recorded dependency still needs attention before this request can continue.');
  if(state==='READY'&&h.failure?.code==='REQUEST_REFUSED')throw new ValidationError('This request was declined. Start a new request with work you are authorized to perform.');
  if(state==='READY'&&h.interruption?.limitKind==='goal_cost'){
   // Preserve free verification and canonical approval/event recovery. A
   // previously denied paid step is different: do not offer the same futile
   // Continue while its exact reservation still exceeds this goal's balance.
   let freeVerification=false;
   try{const saved=require('../../scripts/environment-agent-demo/codex-runtime').savedFinal(h,
     {profile:require('./codex-model-routing').selected(row,ctx),messages:row.checkpoint.messages||[]});
    if(saved){const check=require('./native-answer-review').checked(row,saved);freeVerification=!check.required||check.verified;}
   }catch{/* An invalid or unreviewed saved report cannot bypass the allowance. */}
   if(!freeVerification){
    const denied=(await client.query(`SELECT reserved FROM stockchief_runtime.codex_pilot_calls
     WHERE workspace_id=$1 AND actor_id=$2 AND goal_id=$3 AND state='SETTLED' AND charged=0
      AND detail->>'reason'='rate_limited' AND detail->>'upstreamAttempted'='false'
     ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
    if(denied&&await require('../../scripts/environment-agent-demo/commercial').createCommercialAccounting(client)
      .goalRemainingMicroUsd({ctx,goalId:id})<Number(denied.reserved))
     throw new ValidationError('This request’s remaining allowance cannot cover its next step. Recorded work is saved. An allowance change requires authorization; nothing will retry automatically.');
   }
  }
  return state;
}
async function continuation(db,ctx,id){return db.transaction(async client=>{
 const row=(await client.query('SELECT * FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3',[ctx.workspaceId,ctx.actorId,id])).rows[0];
 if(!row||row.checkpoint?.runtime!=='codex-staging')return null;
 const no=reason=>({eligible:false,nextState:null,reason,executionGuaranteed:false});
 if(row.status==='COMPLETED')return no('This request is complete. No continuation is needed.');
 if(row.status==='CANCELLED')return no('This request was stopped. Review its recorded work before starting another request.');
 if(new Date(row.expires_at)<=new Date())return no('This saved request has expired and is available for review only. It cannot continue.');
 if(row.status==='WAITING_USER')return no('This conversation needs your answer. Reply to its question in Ask StockChief.');
 if(row.status==='WAITING_APPROVAL')return no('The prepared changes need your approval. Opening history does not approve them.');
 if(row.status==='WAITING_EVENT')return no('This request is waiting for confirmation. Opening history does not repeat its operations.');
 if(['READY','RUNNING'].includes(row.status))return no('This request is already queued or working. Do not start a second copy.');
 try{
  const {pilot}=await access(client,ctx,{enabled:true}),locked=spendingLockMessage(pilot);if(locked)return no(locked);
  const nextState=await continuationState(client,ctx,row);
  return {eligible:true,nextState,executionGuaranteed:false,reason:nextState==='READY'
   ?'Currently eligible to request continuation of the investigation. StockChief will recheck permissions and spending before work starts; completion is not guaranteed.'
   :nextState==='WAITING_APPROVAL'?'Currently eligible to reopen at the approval step. The remaining changes still require your approval.'
   :'Currently eligible to reopen while waiting for external confirmation. No operation is repeated by opening history.'};
 }catch(error){
  if(error instanceof NotFoundError)return no('A recorded dependency is unavailable in this business. Your saved request remains available for review; it cannot continue until that dependency is reconciled.');
  if(error instanceof ValidationError)return no(error.message);
  if(error instanceof AuthorizationError||error.code==='entitlement_required'||error.message==='SESSION_AUTHORITY_CHANGED')return no('Continuation is not available under your current access. Your recorded work is preserved.');
  throw error;
 }
},{isolation:'REPEATABLE READ',readOnly:true});}
async function resume(db,ctx,id){
 await require('./postgres-codex-enrollment').ensure(db,ctx);
 const {pilot}=await access(db,ctx,{enabled:true});const locked=spendingLockMessage(pilot);if(locked)throw new ValidationError('Ask is temporarily paused because its usage allowance is unavailable. Your message has not run. It is kept below so you can try again when access is restored.',{reason:'agent_allowance_unavailable'});
 const goal=await db.transaction(async client=>{
  const row=(await client.query('SELECT * FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE',[ctx.workspaceId,ctx.actorId,id])).rows[0];
  const state=await continuationState(client,ctx,row),h=row.checkpoint.harness||{};
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
module.exports={configured,access,selected,view,toggle,start,inbox,decide,run,resume,continuation,readAuthorization,assertReadAuthorization,spendingLockMessage};
