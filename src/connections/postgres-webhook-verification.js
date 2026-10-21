'use strict';
const {createHash}=require('node:crypto');
const {ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');
const vault=require('./credentials');
const TTL_MS=15*60_000,MAX_RETAINED=20;
function scope({provider,appId,environment}){
 if(typeof provider!=='string'||!/^[a-z][a-z0-9_]{0,59}$/.test(provider)||
   typeof appId!=='string'||!appId||appId.length>240||!['sandbox','production'].includes(environment))
  throw new ValidationError('Provider webhook setup is not configured for this deployment.');
 return [provider,appId,environment];
}
async function retain(database,input,{now=Date.now()}={}){
 const values=scope(input);
 if(typeof input.code!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(input.code))
  throw new ValidationError('The provider verification challenge is invalid.');
 const codeHash=createHash('sha256').update(input.code).digest('hex');
 const sealed=vault.encrypt({provider:input.provider,appId:input.appId,environment:input.environment,code:input.code});
 return database.transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['webhook-challenges:'+JSON.stringify(values)]);
  await client.query('DELETE FROM stockchief_runtime.provider_webhook_challenges WHERE expires_at<=$1',[now]);
  const result=await client.query(`INSERT INTO stockchief_runtime.provider_webhook_challenges
   (id,provider,app_id,environment,code_hash,ciphertext,iv,auth_tag,received_at,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(provider,app_id,environment,code_hash) DO NOTHING RETURNING id`,
  [newId('pwhc'),...values,codeHash,sealed.ciphertext,sealed.iv,sealed.authTag,new Date(now).toISOString(),now+TTL_MS]);
  await client.query(`DELETE FROM stockchief_runtime.provider_webhook_challenges WHERE id IN
   (SELECT id FROM stockchief_runtime.provider_webhook_challenges WHERE provider=$1 AND app_id=$2 AND environment=$3
    ORDER BY received_at DESC,id DESC OFFSET $4)`,[...values,MAX_RETAINED]);
  return {received:true,replayed:result.rows.length===0,businessEvent:false,providerVerified:false};
 },{isolation:'READ COMMITTED',retrySafe:true});
}
// Operator-only database access. Deliberately absent from customer HTTP routes,
// agent tools and tenant datasets; receiving a code never changes authority.
async function readLatest(database,input,{now=Date.now(),after=now-TTL_MS}={}){
 const values=scope(input);
 if(!Number.isFinite(after))throw new ValidationError('A valid verification window is required.');
 const row=(await database.query(`SELECT * FROM stockchief_runtime.provider_webhook_challenges
  WHERE provider=$1 AND app_id=$2 AND environment=$3 AND expires_at>$4 AND received_at>=$5
  ORDER BY received_at DESC,id DESC LIMIT 1`,[...values,now,new Date(after).toISOString()])).rows[0];
 if(!row)return null;
 const payload=vault.decrypt(row);
 if(payload.provider!==input.provider||payload.appId!==input.appId||payload.environment!==input.environment)
  throw new ValidationError('The verification challenge does not match this provider application.');
 return {code:payload.code,receivedAt:row.received_at,expiresAt:new Date(Number(row.expires_at)).toISOString(),providerVerified:false};
}
module.exports={retain,readLatest};
