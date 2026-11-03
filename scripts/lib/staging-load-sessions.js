'use strict';
// CLI-only load fixtures. No customer-facing authentication bypass is added.
const crypto=require('node:crypto');
async function create(db,workspaceId,secret,{users=50}={}){
 if(!workspaceId||!secret||!Number.isInteger(users)||users<1||users>50)throw Error('A bounded staging load fixture is required.');
 const row=(await db.query(`SELECT w.id,w.name,w.owner_account_id,u.id user_id,a.email FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id JOIN users u ON u.workspace_id=w.id AND u.account_id=a.id AND u.role='owner' WHERE w.id=$1 AND w.deletion_requested_at IS NULL`,[workspaceId])).rows[0];
 if(!row?.name.startsWith('Synthetic ERP release')||!row.email.endsWith('@example.test'))throw Error('Only the dedicated synthetic staging inventory can be used.');
 const actor=await require('../../src/domain/postgres-auth-service').getAccount(db,row.owner_account_id);if(actor.platform_access_disabled_at)throw Error('Disabled accounts cannot be used for qualification.');
 const Store=require('../../src/web/postgres-session-store').PostgresSessionStore,store=new Store(db),ids=[],cookies=[];
 async function close(){for(const id of ids)await new Promise((resolve,reject)=>store.destroy(id,e=>e?reject(e):resolve()));await store.close();}
 try{for(let n=0;n<users;n++){
  const id=crypto.randomBytes(24).toString('base64url');ids.push(id);
  await new Promise((resolve,reject)=>store.set(id,{accountId:row.owner_account_id,workspaceId:row.id,accountAccessRevision:Number(actor.platform_access_revision||0),csrfToken:crypto.randomBytes(32).toString('hex'),cookie:{originalMaxAge:600000,maxAge:600000,httpOnly:true,secure:true,sameSite:'lax',expires:new Date(Date.now()+600000).toISOString()}},e=>e?reject(e):resolve()));
  cookies.push('foundry.sid='+encodeURIComponent('s:'+require('cookie-signature').sign(id,secret)));
 }
 return {owner:{workspaceId:row.id,accountId:row.owner_account_id,userId:row.user_id,email:row.email,businessName:row.name},cookies,close};
 }catch(error){await close();throw error;}
}
module.exports={create};
