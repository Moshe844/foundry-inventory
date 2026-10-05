'use strict';

const crypto=require('node:crypto');
const config=require('../config');
const credentials=require('../connections/credentials');
const jobs=require('../operations/postgres-job-queue');
const auth=require('./auth-service');
const entitlements=require('../entitlements/postgres-service');
const {newId}=require('../lib/util');
const {ValidationError,NotFoundError}=require('./errors');

const hash=(token)=>crypto.createHash('sha256').update(String(token)).digest('hex');
const scoped=(client)=>({query:(statement,values=[])=>client.query(statement,values),transaction:(operation)=>operation(client)});

async function queueEmail(client,input){
  const sealed=credentials.encrypt({to:input.to,subject:input.subject,text:input.text,html:input.html});
  return jobs.enqueue(scoped(client),{kind:'system.email-send',idempotencyKey:input.idempotencyKey,
    payload:{messageType:input.messageType,sealed},priority:5,maxAttempts:8,availableAt:Date.now()});
}

async function requestVerification(database,accountId,options={}){
  const origin=options.origin||config.connections.publicOrigin;if(!origin)throw new ValidationError('Email verification needs a public StockChief URL.');
  const token=crypto.randomBytes(32).toString('base64url');const id=newId('verify');const hours=Number(options.hours||24);
  return database.transaction(async(client)=>{const account=(await client.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE',[accountId])).rows[0];
    if(!account)throw new NotFoundError('That account could not be found.');if(account.email_verified_at)return {alreadyVerified:true};
    await client.query('UPDATE account_email_verifications SET used_at=now() WHERE account_id=$1 AND used_at IS NULL',[accountId]);
    await client.query(`INSERT INTO account_email_verifications(id,account_id,token_hash,expires_at)
      VALUES($1,$2,$3,now()+($4||' hours')::interval)`,[id,accountId,hash(token),String(hours)]);
    const link=`${origin.replace(/\/$/,'')}/verify-email?token=${encodeURIComponent(token)}`;
    await queueEmail(client,{to:account.email,subject:'Verify your StockChief email',messageType:'email_verification',
      idempotencyKey:`email-verification:${id}`,text:`Verify your email to finish setting up StockChief:\n\n${link}`,
      html:`<p>Verify your email to finish setting up StockChief.</p><p><a href="${link}">Verify my email</a></p>`});
    return {queued:true};
  },{isolation:'SERIALIZABLE'});
}

async function inspectVerification(database,token){
  const row=(await database.query(`SELECT verification.account_id,verification.expires_at,verification.used_at,account.email
    FROM account_email_verifications verification JOIN accounts account ON account.id=verification.account_id
    WHERE verification.token_hash=$1`,[hash(token)])).rows[0];
  if(!row||row.used_at||new Date(row.expires_at)<=new Date())
    throw new ValidationError('That verification link is invalid or has expired. Request a new link and try again.');
  return {accountId:row.account_id,email:row.email,expiresAt:row.expires_at};
}

async function consumeVerification(database,token){return database.transaction(async(client)=>{
  const row=(await client.query(`SELECT verification.* FROM account_email_verifications verification
    WHERE token_hash=$1 FOR UPDATE`,[hash(token)])).rows[0];
  if(!row||row.used_at||new Date(row.expires_at)<=new Date())throw new ValidationError('That verification link is invalid or has expired.');
  await client.query('UPDATE account_email_verifications SET used_at=now() WHERE id=$1',[row.id]);
  await client.query('UPDATE accounts SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1',[row.account_id]);
  return {accountId:row.account_id};},{isolation:'SERIALIZABLE'});}

async function createInvitation(database,ctx,input,options={}){
  await require('../commercial/enforcement').workspace(database,ctx.workspaceId,'workspace.core');
  const email=auth.normaliseEmail(input.email);const name=String(input.name||'').trim()||null;
  const role=['owner','staff','accountant'].includes(input.role)?input.role:'staff';const token=crypto.randomBytes(32).toString('base64url');
  const id=newId('invite');const origin=options.origin||config.connections.publicOrigin;
  if(!origin)throw new ValidationError('Workspace invitations need a public StockChief URL.');
  return database.transaction(async(client)=>{await client.query(`UPDATE workspace_invitations SET status='REVOKED'
    WHERE workspace_id=$1 AND email=$2 AND status='PENDING'`,[ctx.workspaceId,email]);
    await client.query(`INSERT INTO workspace_invitations
      (id,workspace_id,invited_by_user_id,email,name,role,token_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '7 days')`,[id,ctx.workspaceId,ctx.actorId,email,name,role,hash(token)]);
    const workspace=(await client.query('SELECT name FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0];
    const link=`${origin.replace(/\/$/,'')}/invite?token=${encodeURIComponent(token)}`;
    await queueEmail(client,{to:email,subject:`Join ${workspace.name} in StockChief`,messageType:'workspace_invitation',
      idempotencyKey:`workspace-invitation:${id}`,text:`You were invited to ${workspace.name} in StockChief:\n\n${link}`,
      html:`<p>You were invited to <strong>${workspace.name}</strong> in StockChief.</p><p><a href="${link}">Accept invitation</a></p>`});
    return {id,email,role,token:options.includeToken?token:undefined};},{isolation:'SERIALIZABLE'});
}

async function inspectInvitation(database,token){const row=(await database.query(`SELECT invitation.*,workspace.name AS workspace_name,
    inviter.name AS inviter_name FROM workspace_invitations invitation JOIN workspaces workspace ON workspace.id=invitation.workspace_id
    JOIN users inviter ON inviter.id=invitation.invited_by_user_id WHERE invitation.token_hash=$1`,[hash(token)])).rows[0];
  if(!row)return null;if(row.status==='PENDING'&&new Date(row.expires_at)<=new Date()){await database.query(
    "UPDATE workspace_invitations SET status='EXPIRED' WHERE id=$1 AND status='PENDING'",[row.id]);row.status='EXPIRED';}
  return row;}

async function acceptInvitation(database,token,input={}){return database.transaction(async(client)=>{
  const invitation=(await client.query('SELECT * FROM workspace_invitations WHERE token_hash=$1 FOR UPDATE',[hash(token)])).rows[0];
  if(!invitation||invitation.status!=='PENDING'||new Date(invitation.expires_at)<=new Date())
    throw new ValidationError('That invitation is invalid, expired or was already used.');
  await require('../commercial/enforcement').workspace(client,invitation.workspace_id,'workspace.core');
  let account=input.accountId?(await client.query('SELECT * FROM accounts WHERE id=$1',[input.accountId])).rows[0]:null;
  if(account&&account.email.toLowerCase()!==String(invitation.email).toLowerCase())throw new ValidationError('Sign in with the invited email address.');
  if(!account)account=(await client.query('SELECT * FROM accounts WHERE email=$1',[invitation.email])).rows[0];
  if(!account){const password=auth.checkPasswordStrength(input.password);account={id:newId('acc')};
    await client.query(`INSERT INTO accounts(id,email,name,password_hash,plan,email_verified_at,created_at)
      VALUES($1,$2,$3,$4,'invited',now(),now())`,[account.id,invitation.email,input.name||invitation.name||invitation.email,
      auth.hashPassword(password)]);}
  const membership=(await client.query('SELECT id FROM users WHERE workspace_id=$1 AND account_id=$2',
    [invitation.workspace_id,account.id])).rows[0];
  if(!membership){const scope=await entitlements.ownerScopeForWorkspace(client,invitation.workspace_id);
    await entitlements.assertMeterCapacity(client,scope,'members',1);}
  await client.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES($1,$2,$3,$4,$5,now())
    ON CONFLICT(workspace_id,account_id) DO NOTHING`,[newId('usr'),invitation.workspace_id,account.id,
    input.name||invitation.name||account.name,invitation.role]);
  await client.query(`UPDATE workspace_invitations SET status='ACCEPTED',accepted_by_account_id=$2,accepted_at=now()
    WHERE id=$1`,[invitation.id,account.id]);
  return {accountId:account.id,workspaceId:invitation.workspace_id};},{isolation:'SERIALIZABLE'});}

module.exports={hash,requestVerification,inspectVerification,consumeVerification,createInvitation,inspectInvitation,acceptInvitation};
