'use strict';
const policy=require('../commercial/agent-plan'),{ValidationError}=require('../domain/errors');
async function requireRoutineAuthority(db,ctx){
 await policy.requireWorkspaceJob(db,ctx.workspaceId,98,'automatic');
 const grant=(await db.query(`SELECT m.revision FROM stockchief_runtime.agent_job_modes m JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
  JOIN accounts a ON a.id=u.account_id JOIN workspaces owned ON owned.id=u.workspace_id AND owned.owner_account_id=u.account_id AND owned.deletion_requested_at IS NULL JOIN workspace_autopilot w ON w.workspace_id=m.workspace_id
  WHERE m.workspace_id=$1 AND m.job_id=98 AND m.mode='routine' AND u.id=$2
   AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL) FOR SHARE OF m,u,w,a,owned`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!grant||!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)throw new ValidationError('The owner must enable the supplier invoice routine and automatic work before it can post.');
 return {kind:'standing_job_rule',job:98,ownerId:ctx.actorId,modeRevision:Number(grant.revision)};
}
async function run(db,workspaceId){
 const result={posted:0,held:0,skipped:0},grant=(await db.query(`SELECT m.updated_by FROM stockchief_runtime.agent_job_modes m JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
  JOIN accounts a ON a.id=u.account_id WHERE m.workspace_id=$1 AND m.job_id=98 AND m.mode='routine'
   AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)`,[workspaceId])).rows[0];
 if(!grant)return result;
 const state=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,98,'automatic')||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return result;
 const ctx={workspaceId,actorId:grant.updated_by},proposals=(await db.query(`SELECT id FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND actor_user_id=$2 AND action_type='purchase_order.record_supplier_invoice' AND status='PENDING'
  AND payload->>'needsInvoiceConfirmation'='false' AND payload->>'expectedStatus'='OPEN' ORDER BY created_at,id LIMIT 20`,[workspaceId,ctx.actorId])).rows;
 for(const proposal of proposals){
  const status=await db.transaction(async c=>{
   const scoped={query:(...args)=>c.query(...args),transaction:fn=>fn(c)};
   await c.query('SAVEPOINT supplier_invoice_post');
   try{const posted=await require('../assistant/postgres-service').executeInvoiceRoutine(scoped,ctx,proposal.id);await c.query('RELEASE SAVEPOINT supplier_invoice_post');return posted.replayed?'skipped':'posted';}
   catch(error){
    if(!['validation_error','entitlement_required','forbidden'].includes(error.code))throw error;
    await c.query('ROLLBACK TO SAVEPOINT supplier_invoice_post');await c.query('RELEASE SAVEPOINT supplier_invoice_post');
    await c.query(`UPDATE stockchief_runtime.assistant_action_proposals SET payload=payload||jsonb_build_object('needsInvoiceConfirmation',true,'invoiceRoutineHold',$3::text) WHERE workspace_id=$1 AND id=$2 AND status='PENDING'`,[workspaceId,proposal.id,error.message]);
    return 'held';
   }
  },{isolation:'SERIALIZABLE',retrySafe:true});result[status]++;
 }
 if(result.posted)await require('../assistant/postgres-goal-resume').refreshWorkspace(db,workspaceId);
 return result;
}
module.exports={run,requireRoutineAuthority};
