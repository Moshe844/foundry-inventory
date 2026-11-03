'use strict';
const crypto=require('node:crypto');
// Canonical paid-first provisioning. The synthetic COMP subscription must exist
// before workspace/accounting initialization; production enforcement stays on.
async function provision(db,run){
 if(!/^[a-z0-9-]{6,60}$/.test(run||''))throw Error('A bounded synthetic run is required.');
 const email='stockchief-million-'+run+'@example.test',businessName='Synthetic ERP release million '+run;
 return db.transaction(async client=>{
  const existing=(await client.query(`SELECT a.id account_id,w.id workspace_id,w.name,u.id user_id,s.source,s.plan_id,s.plan_version_id,s.status
   FROM accounts a LEFT JOIN workspaces w ON w.owner_account_id=a.id
   LEFT JOIN users u ON u.workspace_id=w.id AND u.account_id=a.id AND u.role='owner'
   LEFT JOIN account_subscriptions s ON s.account_id=a.id WHERE a.email=$1 FOR UPDATE OF a`,[email])).rows;
  if(existing.length){const row=existing[0];if(existing.length!==1||row.name!==businessName||!row.user_id||row.source!=='ISOLATED_STAGING_QUALIFICATION'||row.plan_id!=='pro'||row.plan_version_id!=='approved-2026-11-02:pro'||row.status!=='COMP')throw Error('Existing synthetic identity or subscription differs.');
   return {accountId:row.account_id,workspaceId:row.workspace_id,userId:row.user_id};}
  const scoped={query:client.query.bind(client),transaction:fn=>fn(client)},auth=require('../../src/domain/postgres-auth-service');
  const account=await auth.createPendingAccount(scoped,{name:'Synthetic scale owner',businessName,email,password:crypto.randomBytes(32).toString('base64url')+'!Aa7'});
  await client.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,current_period_start,current_period_end,source) VALUES($1,$2,'pro','approved-2026-11-02:pro','COMP','MONTHLY',now(),now()+interval '1 month','ISOLATED_STAGING_QUALIFICATION')",['million-sub-'+run,account.id]);
  const workspace=await auth.provisionFirstWorkspace(scoped,account.id,{businessName});
  return {accountId:account.id,workspaceId:workspace.workspaceId,userId:workspace.userId};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={provision};
