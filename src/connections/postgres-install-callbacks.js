'use strict';
const vault=require('./postgres-credential-store'),{newId}=require('../lib/util');
// Call only after the provider adapter verifies the signed lifecycle callback.
// Provider identity revokes its own grants; it never creates StockChief users,
// changes memberships or removes historical business transactions.
async function revokeBigCommerce(database,claims,action){return database.transaction(async client=>{
 const rows=(await client.query("SELECT c.* FROM workspace_connectors c JOIN workspaces w ON w.id=c.workspace_id WHERE c.provider_type='bigcommerce' AND c.provider_account_id=$1 AND c.status<>'disconnected' AND w.deletion_requested_at IS NULL FOR UPDATE OF c",[claims.storeHash])).rows;let revoked=0;
 for(const c of rows){const credential=await vault.get(client,c.workspace_id,c.id,'provider');if(action==='remove_user'&&credential?.providerUserId!==claims.userId)continue;
  // An old but still valid uninstall JWT cannot revoke a later reinstall.
  if(credential?.authorizedAt&&new Date(credential.authorizedAt).getTime()>claims.issuedAt*1000)continue;
  await client.query("UPDATE workspace_connectors SET status='disconnected',setup_status='REAUTHORIZATION_REQUIRED',paused_at=now(),last_error='BigCommerce revoked this installation. Sign in again to restore it.',updated_at=now() WHERE workspace_id=$1 AND id=$2",[c.workspace_id,c.id]);await vault.remove(client,c.workspace_id,c.id);
  const eventId=newId('evt');await client.query("INSERT INTO domain_events(id,workspace_id,event_type,payload,source,source_record_type,source_record_id,idempotency_key,status,result,created_at,processed_at) VALUES($1,$2,'connection.authorization_revoked',$3,'bigcommerce','connection',$4,$5,'PROCESSED','{}',now(),now()) ON CONFLICT DO NOTHING",[eventId,c.workspace_id,JSON.stringify({action,providerCallbackId:claims.jti}),c.id,'bigcommerce:'+c.id+':'+claims.jti]);revoked++;
 }return {received:true,revoked};
},{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={revokeBigCommerce};
