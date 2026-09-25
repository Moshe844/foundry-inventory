'use strict';

const crypto=require('node:crypto');
const config=require('../config');
const auth=require('./auth-service');
const credentials=require('../connections/credentials');
const jobs=require('../operations/postgres-job-queue');
const {newId,nowIso}=require('../lib/util');
const {ValidationError}=require('./errors');

const TTL_MS=30*60*1000;
const hash=(token)=>crypto.createHash('sha256').update(String(token)).digest('hex');
const scopedDatabase=(client)=>({query:(statement,values=[])=>client.query(statement,values),
  transaction:(operation)=>operation(client)});

async function request(database,emailInput,options={}){
  const email=String(emailInput||'').trim().toLowerCase();
  const account=(await database.query('SELECT id,email,name FROM accounts WHERE email=$1',[email])).rows[0];
  if(!account)return {accepted:true,queued:false};
  const token=crypto.randomBytes(32).toString('base64url');const now=Number(options.now||Date.now());
  const expiresAt=now+Number(options.ttlMs||TTL_MS);const origin=options.origin||config.connections.publicOrigin;
  if(!origin)throw new ValidationError('Password recovery needs FOUNDRY_PUBLIC_URL configured.');
  const id=newId('reset');const at=new Date(now).toISOString();
  await database.transaction(async(client)=>{
    await client.query(`UPDATE password_reset_tokens SET used_at=$2
      WHERE account_id=$1 AND used_at IS NULL`,[account.id,at]);
    await client.query(`INSERT INTO password_reset_tokens
      (id,account_id,token_hash,requested_ip,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
    [id,account.id,hash(token),options.ip||null,expiresAt,at]);
    const link=`${origin.replace(/\/$/,'')}/reset-password?token=${encodeURIComponent(token)}`;
    const sealed=credentials.encrypt({to:account.email,subject:'Reset your StockChief password',
      text:`Use this link within 30 minutes to reset your StockChief password:\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
      html:`<p>Use the secure link below within 30 minutes to reset your StockChief password.</p><p><a href="${link}">Reset my password</a></p><p>If you did not request this, you can ignore this email.</p>`});
    await jobs.enqueue(scopedDatabase(client),{kind:'system.email-send',idempotencyKey:`password-reset:${id}`,
      payload:{messageType:'password_reset',sealed,resetId:id},priority:5,maxAttempts:8,availableAt:now,now});
  },{isolation:'SERIALIZABLE'});
  return {accepted:true,queued:true};
}

async function inspect(database,token,options={}){
  const row=(await database.query(`SELECT token.*,account.email FROM password_reset_tokens token
    JOIN accounts account ON account.id=token.account_id WHERE token.token_hash=$1`,[hash(token)])).rows[0];
  const now=Number(options.now||Date.now());
  if(!row||row.used_at||Number(row.expires_at)<=now)return null;
  return row;
}

async function consume(database,token,password,options={}){
  return database.transaction(async(client)=>{
    const row=(await client.query(`SELECT token.*,account.email FROM password_reset_tokens token
      JOIN accounts account ON account.id=token.account_id WHERE token.token_hash=$1 FOR UPDATE`,[hash(token)])).rows[0];
    const now=Number(options.now||Date.now());
    if(!row||row.used_at||Number(row.expires_at)<=now)throw new ValidationError('That reset link is invalid or has expired.');
    const passwordHash=auth.hashPassword(auth.checkPasswordStrength(password));const used=options.nowIso||nowIso();
    await client.query('UPDATE accounts SET password_hash=$2 WHERE id=$1',[row.account_id,passwordHash]);
    await client.query('UPDATE password_reset_tokens SET used_at=$2 WHERE id=$1 AND used_at IS NULL',[row.id,used]);
    await client.query(`DELETE FROM stockchief_runtime.sessions WHERE data->>'accountId'=$1`,[row.account_id]);
    return {accountId:row.account_id,email:row.email};
  },{isolation:'SERIALIZABLE'});
}

module.exports={TTL_MS,hash,request,inspect,consume};
