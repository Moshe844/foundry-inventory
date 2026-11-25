'use strict';

// An owner-issued review link is an additional credential, not an OTP exemption.
// It works only with the account password and its existing expiring ADMIN trial.
const crypto=require('node:crypto');
const config=require('../config');
const {AuthorizationError,ValidationError}=require('./errors');
const audit=require('../commercial/control-service').audit;
const MAX_AGE_MS=30*86400000;
const denied=()=>new AuthorizationError('That private review access is invalid, expired or no longer available.');
const scoped=c=>({query:(sql,args=[])=>c.query(sql,args),transaction:fn=>fn(c)});
function key(secret=config.sessionSecret){
  if(typeof secret!=='string'||secret.length<24)throw new Error('Review access requires the configured session signing secret.');
  return crypto.createHmac('sha256',secret).update('stockchief/private-review/v1').digest();
}
const mac=(value,secret)=>crypto.createHmac('sha256',key(secret)).update(value).digest('base64url');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const version=(row,secret)=>mac(JSON.stringify([row.password_hash,Number(row.revision||0),row.subscription_id,
  row.plan_id,new Date(row.trial_ends_at).toISOString(),row.subscription_revision||'']),secret);
function ticket(row,{now=Date.now(),secret}={}){
  const expires=Math.min(new Date(row.trial_ends_at).getTime(),now+MAX_AGE_MS);
  if(!Number.isFinite(expires)||expires<=now)throw denied();
  const claims={v:1,a:row.id,w:row.workspace_id,i:now,e:expires,s:version(row,secret),n:crypto.randomBytes(24).toString('base64url')};
  const body=Buffer.from(JSON.stringify(claims)).toString('base64url');
  return {token:'sr1.'+body+'.'+mac(body,secret),claims};
}
function decode(token,{now=Date.now(),secret}={}){
  if(typeof token!=='string'||token.length>2048)throw denied();
  const parts=/^sr1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if(!parts||!equal(parts[2],mac(parts[1],secret)))throw denied();
  let c;try{c=JSON.parse(Buffer.from(parts[1],'base64url').toString());}catch{throw denied();}
  if(c?.v!==1||typeof c.a!=='string'||typeof c.w!=='string'||!Number.isSafeInteger(c.i)||!Number.isSafeInteger(c.e)
    ||c.i>now+30000||c.e<=now||c.e-c.i>MAX_AGE_MS||c.e<=c.i||typeof c.s!=='string'||typeof c.n!=='string')throw denied();
  return c;
}
async function eligible(db,accountId,workspaceId,{now=Date.now()}={}){
  const row=(await db.query(`SELECT a.id,a.email,a.password_hash,w.id workspace_id,s.id subscription_id,s.plan_id,s.trial_ends_at,
      coalesce(x.revision,0) revision,extract(epoch FROM s.updated_at)::text subscription_revision
    FROM accounts a JOIN account_subscriptions s ON s.account_id=a.id
    JOIN workspaces w ON w.owner_account_id=a.id
    LEFT JOIN platform_account_access x ON x.account_id=a.id
    WHERE a.id=$1 AND w.id=$2 AND a.email_verified_at IS NOT NULL AND x.disabled_at IS NULL
      AND w.data_mode='synthetic' AND w.deletion_requested_at IS NULL
      AND s.source='ADMIN' AND s.status='TRIALING' AND s.stripe_subscription_id IS NULL
      AND s.trial_ends_at>$3::timestamptz
      AND (SELECT count(*) FROM workspaces z WHERE z.owner_account_id=a.id AND z.deletion_requested_at IS NULL)=1
      AND (SELECT count(*) FROM users u WHERE u.account_id=a.id AND to_jsonb(u)->>'revoked_at' IS NULL)=1
      AND EXISTS(SELECT 1 FROM users u WHERE u.account_id=a.id AND u.workspace_id=w.id AND u.role='owner' AND to_jsonb(u)->>'revoked_at' IS NULL)
      AND NOT EXISTS(SELECT 1 FROM users u WHERE u.workspace_id=w.id AND u.account_id IS DISTINCT FROM a.id AND to_jsonb(u)->>'revoked_at' IS NULL)
      AND NOT EXISTS(SELECT 1 FROM platform_console_operators p WHERE p.account_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM commercial_admin_accounts p WHERE p.account_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM developer_account_administrators p WHERE p.account_id=a.id)`,
  [accountId,workspaceId,new Date(now).toISOString()])).rows[0];
  if(!row||config.commercial.adminEmails.includes(row.email.toLowerCase()))return null;
  return row;
}
async function validateSession(db,claims,accountId,workspaceId,options={}){
  const now=options.now??Date.now();
  if(!claims||claims.v!==1||claims.a!==accountId||claims.w!==workspaceId||!Number.isSafeInteger(claims.e)||claims.e<=now
    ||!Number.isSafeInteger(claims.i)||claims.e-claims.i>MAX_AGE_MS||claims.i>now+30000)return false;
  const row=await eligible(db,accountId,workspaceId,{now});
  return Boolean(row&&equal(claims.s,version(row,options.secret))&&claims.e<=new Date(row.trial_ends_at).getTime());
}
async function verify(db,token,accountId,options={}){
  const claims=decode(token,options);
  if(!await validateSession(db,claims,accountId,claims.w,options))throw denied();
  await audit(db,{actorAccountId:accountId,subjectType:'private_review_access',subjectId:claims.w,action:'password_and_link_verified',
    reason:'Scoped review sign-in; ordinary sign-in codes and owner MFA are unchanged.',afterState:{expiresAt:new Date(claims.e).toISOString()}});
  return claims;
}
async function issue(db,actorId,input,options={}){
  if(input.confirmed!=='yes')throw new ValidationError('Confirm that this separate account and inventory are for synthetic review only.');
  const reason=String(input.reason||'').trim();
  if(reason.length<8||reason.length>500)throw new ValidationError('Enter the review purpose in 8 to 500 characters.');
  const actor=await require('../platform-owner/auth').operator(db,actorId);
  if(actor?.role!=='OWNER'||!(await db.query('SELECT 1 FROM platform_console_mfa WHERE account_id=$1',[actorId])).rows.length)throw denied();
  return db.transaction(async client=>{
    const target=(await client.query('SELECT id,email,email_verified_at FROM accounts WHERE email=$1 FOR UPDATE',
      [String(input.email||'').trim().toLowerCase()])).rows[0];
    if(!target?.email_verified_at||target.id===actorId)throw new ValidationError('Choose a separate, email-verified review account.');
    const current=(await client.query(`SELECT * FROM account_subscriptions WHERE account_id=$1 AND source='ADMIN'
      AND status='TRIALING' AND stripe_subscription_id IS NULL AND trial_ends_at>now()`,[target.id])).rows[0];
    if(!current)throw new ValidationError('Grant this account a time-limited admin trial first; no paid subscription is changed here.');
    // Reject privileged accounts before creating any workspace, even if it has no businesses yet.
    const protectedAccount=config.commercial.adminEmails.includes(target.email.toLowerCase())||(await client.query(`
      SELECT 1 FROM platform_console_operators WHERE account_id=$1 UNION ALL
      SELECT 1 FROM commercial_admin_accounts WHERE account_id=$1 UNION ALL
      SELECT 1 FROM developer_account_administrators WHERE account_id=$1`,[target.id])).rows.length;
    if(protectedAccount)throw denied();
    let businesses=(await client.query('SELECT id,data_mode FROM workspaces WHERE owner_account_id=$1 AND deletion_requested_at IS NULL',[target.id])).rows;
    if(!businesses.length){
      if((await client.query("SELECT 1 FROM users WHERE account_id=$1 AND to_jsonb(users)->>'revoked_at' IS NULL",[target.id])).rows.length)throw denied();
      const database=scoped(client);
      await require('../commercial/context').run({database,scope:{accountId:target.id,workspaceId:null}},()=>
        require('./postgres-auth-service').provisionFirstWorkspace(database,target.id,{businessName:'Google Workspace Review',dataMode:'synthetic'}));
      businesses=(await client.query('SELECT id,data_mode FROM workspaces WHERE owner_account_id=$1 AND deletion_requested_at IS NULL',[target.id])).rows;
    }
    if(businesses.length!==1||businesses[0].data_mode!=='synthetic')throw new ValidationError('Use a separate account with one synthetic inventory. Existing business inventories are never converted or copied.');
    const row=await eligible(client,target.id,businesses[0].id,options);
    if(!row)throw denied();
    const result=ticket(row,options);
    await audit(client,{actorAccountId:actorId,subjectType:'private_review_access',subjectId:row.workspace_id,action:'issued',reason,
      afterState:{accountId:row.id,workspaceId:row.workspace_id,subscriptionId:row.subscription_id,expiresAt:new Date(result.claims.e).toISOString(),passwordRequired:true}});
    return {...result,email:row.email,workspaceId:row.workspace_id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={issue,verify,validateSession,eligible,ticket,decode,MAX_AGE_MS};
