'use strict';
const {AuthorizationError,ValidationError,NotFoundError}=require('./errors');
const {newId,requireText}=require('../lib/util');
const audit=require('../commercial/control-service').audit;

async function disabled(db,accountId){return Boolean(accountId&&(await db.query('SELECT 1 FROM platform_account_access WHERE account_id=$1 AND disabled_at IS NOT NULL',[accountId])).rows.length);}
async function sessionRevision(db,accountId){const state=(await db.query('SELECT disabled_at,revision FROM platform_account_access WHERE account_id=$1',[accountId])).rows[0];if(state?.disabled_at)throw new AuthorizationError('Account access has been disabled by StockChief. Contact support@stockchiefhq.com for help.');return Number(state?.revision||0);}
async function stampSession(db,session,accountId){session.accountAccessRevision=await sessionRevision(db,accountId);}
async function assertOwner(db,actorId){if(!(await db.query("SELECT 1 FROM platform_console_operators o JOIN platform_console_mfa m ON m.account_id=o.account_id JOIN accounts a ON a.id=o.account_id WHERE o.account_id=$1 AND o.active=true AND o.role='OWNER' AND a.email_verified_at IS NOT NULL",[actorId])).rows.length)throw new AuthorizationError('Only a verified platform owner with MFA can manage account access.');}
async function review(db,actorId,targetId){
 await assertOwner(db,actorId);
 const target=(await db.query(`SELECT a.id,a.name,a.email,x.disabled_at,x.reason,coalesce(x.revision,0) revision
 FROM accounts a LEFT JOIN platform_account_access x ON x.account_id=a.id WHERE a.id=$1`,[targetId])).rows[0];
 if(!target)throw new NotFoundError('That customer account was not found.');
 const protectedAccount=target.id===actorId||(await db.query(`SELECT 1 FROM platform_console_operators WHERE account_id=$1 AND active=true
 UNION ALL SELECT 1 FROM developer_account_administrators WHERE account_id=$1
 UNION ALL SELECT 1 FROM commercial_admin_accounts WHERE account_id=$1`,[targetId])).rows.length>0;
 const sessions=Number((await db.query("SELECT count(*) n FROM stockchief_runtime.sessions WHERE data->>'accountId'=$1",[targetId])).rows[0].n);
 const businesses=(await db.query('SELECT id,name FROM workspaces WHERE owner_account_id=$1 ORDER BY name,id',[targetId])).rows;
 return {target,businesses,sessions,protectedAccount,canManage:!protectedAccount};
}
async function change(db,actorId,targetId,input){
 await assertOwner(db,actorId);
 const action=String(input.action||'');if(!['disable','restore','sign_out'].includes(action))throw new ValidationError('Choose disable access, restore access or sign out all sessions.');
 const reason=requireText(input.reason,'Reason',{max:1000});if(reason.length<8)throw new ValidationError('Explain the reason in at least 8 characters.');
 const requestKey=requireText(input.requestKey,'Action reference',{max:100});
 if(input.confirmed!=='yes')throw new ValidationError('Review and confirm the account action.');
 return db.transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['platform-account-action:'+actorId+':'+requestKey]);
  const prior=(await c.query("SELECT subject_id,action,reason,after_state FROM commercial_change_audit WHERE actor_account_id=$1 AND subject_type='platform_account_access' AND after_state->>'requestKey'=$2",[actorId,requestKey])).rows[0];
  if(prior){if(prior.subject_id!==targetId||prior.action!==action||prior.reason!==reason)throw new ValidationError('That action reference was used for a different change. Refresh this review.');return {...prior.after_state,replayed:true};}
  await c.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[targetId]);
  const r=await review(c,actorId,targetId);if(!r.canManage)throw new AuthorizationError('Your own account and active platform operators are protected.');
  if(String(input.confirmEmail||'').trim().toLowerCase()!==r.target.email.toLowerCase())throw new ValidationError('Type this customer’s exact email address to confirm.');
  if(!Number.isSafeInteger(Number(input.revision))||Number(input.revision)!==Number(r.target.revision))throw new ValidationError('This account changed. Review its current access before continuing.');
  const row=(await c.query(`INSERT INTO platform_account_access(account_id,disabled_at,reason,changed_by)
  VALUES($1,CASE WHEN $2='disable' THEN now() ELSE NULL END,$3,$4)
  ON CONFLICT(account_id) DO UPDATE SET disabled_at=CASE WHEN $2='disable' THEN coalesce(platform_account_access.disabled_at,now()) WHEN $2='restore' THEN NULL ELSE platform_account_access.disabled_at END,
  reason=$3,changed_by=$4,revision=platform_account_access.revision+1,updated_at=now() RETURNING disabled_at,revision`,[targetId,action,reason,actorId])).rows[0];
  let sessionsRevoked=0;if(action!=='restore')sessionsRevoked=(await c.query("DELETE FROM stockchief_runtime.sessions WHERE data->>'accountId'=$1 OR ($2 AND data->'sso'->>'ownerAccountId'=$1)",[targetId,action==='disable'])).rowCount;
  const result={requestKey,disabled:Boolean(row.disabled_at),revision:Number(row.revision),sessionsRevoked,businesses:r.businesses.length};
  await audit(c,{actorAccountId:actorId,subjectType:'platform_account_access',subjectId:targetId,action,beforeState:{disabled:Boolean(r.target.disabled_at),revision:Number(r.target.revision)},afterState:result,reason});
  return result;
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={disabled,sessionRevision,stampSession,assertOwner,review,change};
