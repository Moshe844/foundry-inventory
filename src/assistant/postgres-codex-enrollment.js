'use strict';
const {AuthorizationError,ValidationError}=require('../domain/errors');
const entitlements=require('../commercial/entitlements'),scopePolicy=require('./codex-pilot-scope');
async function policy(db,ctx){
 if(!scopePolicy.customerAccess())throw new AuthorizationError('The customer agent rollout is not enabled.');
 const row=(await db.query(`SELECT w.owner_account_id,a.email_verified_at,actor.email_verified_at AS actor_verified,u.role FROM workspaces w
  JOIN users u ON u.workspace_id=w.id AND u.id=$2 JOIN accounts a ON a.id=w.owner_account_id JOIN accounts actor ON actor.id=u.account_id
  WHERE w.id=$1 AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!row||!row.email_verified_at||!row.actor_verified)throw new AuthorizationError('A verified account and current business membership are required.');
 const scope={accountId:row.owner_account_id,workspaceId:ctx.workspaceId};
 const subscription=await entitlements.subscriptionFor(db,scope.accountId);
 if(!subscription||!entitlements.operationalAccess(subscription).canOperate)throw new AuthorizationError('An active plan is required for the business agent.');
 let entitlement;try{entitlement=await entitlements.assertCapability(db,scope,'ask.lookup');}catch(error){if([402,403].includes(error.status))throw new AuthorizationError('This plan does not include agent access.');throw error;}
 const period=entitlements.periodBounds(subscription),ceiling=Math.floor(require('../commercial/model-cost-budget').periodLimit(subscription.plan_id)*1000000);
 if(!Number.isSafeInteger(ceiling)||ceiling<=0||period.start>new Date()||period.end<=new Date())throw new ValidationError('This plan has no current approved agent budget period.');
 return {scope,entitlement,subscription,period,ceiling};
}
async function ensure(db,ctx){
 if(!scopePolicy.customerAccess())return;
 return db.transaction(async client=>{
  const checked=await policy(client,ctx);
  await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[checked.scope.accountId]);
  const established=(await client.query(`SELECT p.* FROM stockchief_runtime.codex_pilot_accounts a
   JOIN stockchief_runtime.codex_pilots p ON p.workspace_id=a.funding_workspace_id WHERE a.account_id=$1 FOR UPDATE OF p`,[checked.scope.accountId])).rows[0];
  // Existing human-approved certification money is never converted into a
  // commercial grant, increased, renewed or unpaused by automatic enrollment.
  if(established?.admission_kind==='PILOT')return;
  const funding=established?.workspace_id||(await client.query(`SELECT w.id,u.id AS actor_id FROM workspaces w
   JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id AND u.role='owner'
   WHERE w.owner_account_id=$1 AND w.deletion_requested_at IS NULL ORDER BY w.created_at,w.id LIMIT 1`,[checked.scope.accountId])).rows[0];
  const fundingId=typeof funding==='string'?funding:funding?.id;
  if(!fundingId)throw new AuthorizationError('The business owner could not be resolved.');
  const existing=(await client.query('SELECT admission_kind FROM stockchief_runtime.codex_pilots WHERE workspace_id=$1',[fundingId])).rows[0];
  if(existing?.admission_kind==='PILOT')throw new AuthorizationError('This account has an explicit pilot policy that must remain unchanged.');
  const reference='commercial-plan:'+checked.subscription.id+':'+checked.period.start.toISOString();
  if(established){
   if(Number(established.ceiling_micro_usd)===checked.ceiling&&established.approval_reference===reference&&
     new Date(established.period_starts_at).getTime()===checked.period.start.getTime()&&
     new Date(established.period_ends_at).getTime()===checked.period.end.getTime())return;
   await client.query(`UPDATE stockchief_runtime.codex_pilots SET ceiling_micro_usd=$2,period_starts_at=$3,
    period_ends_at=$4,approval_reference=$5,updated_at=now()
    WHERE workspace_id=$1 AND admission_kind='COMMERCIAL'`,[fundingId,checked.ceiling,checked.period.start.toISOString(),checked.period.end.toISOString(),reference]);
  }else{
   await client.query(`INSERT INTO stockchief_runtime.codex_pilots(workspace_id,enabled,approved_by,period_starts_at,period_ends_at,
    ceiling_micro_usd,approval_reference,stopped,admission_kind,worker_seen_at)
    VALUES($1,true,$2,$3,$4,$5,$6,false,'COMMERCIAL',(SELECT max(worker_seen_at) FROM stockchief_runtime.codex_pilots))`,
   [fundingId,funding.actor_id,checked.period.start.toISOString(),checked.period.end.toISOString(),checked.ceiling,reference]);
   await client.query('INSERT INTO stockchief_runtime.codex_pilot_accounts(account_id,funding_workspace_id) VALUES($1,$2)',[checked.scope.accountId,fundingId]);
  }
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={policy,ensure};
