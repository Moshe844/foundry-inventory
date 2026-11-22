'use strict';
const {newId}=require('../lib/util');
const messages=Object.freeze({
 QUICKBOOKS_SESSION_LOCK_UNAVAILABLE:'QuickBooks is connected, but StockChief could not start its secure update. The update will retry automatically; your saved products and stock are kept.',
 QUICKBOOKS_AUTHORIZATION_BUSY:'Another authorization update is finishing for this QuickBooks company. The update will retry automatically; your saved products and stock are kept.',
 QUICKBOOKS_INVENTORY_UNAVAILABLE:'QuickBooks inventory tracking is unavailable for this company. Check its QuickBooks plan and inventory settings, then retry. Your saved products and stock are preserved.',
 QUICKBOOKS_FEATURE_UNAVAILABLE:'This QuickBooks company does not support the requested feature. Check its QuickBooks plan and settings, then retry. Your saved products and stock are preserved.',
 QUICKBOOKS_API_FAULT:'QuickBooks did not complete this request. Your saved products and stock are preserved; the update will retry safely.',
 SHOPIFY_SESSION_LOCK_UNAVAILABLE:'Your Shopify store is connected, but StockChief could not start its secure update. The update will retry automatically; your saved products and stock are kept.',
 SHOPIFY_AUTHORIZATION_BUSY:'Another update is finishing for this Shopify store. This update will retry automatically; your saved products and stock are kept.',
 PROVIDER_RATE_LIMITED:'The provider asked StockChief to wait before checking again. The update will retry automatically.',
 PROVIDER_UNREACHABLE:'StockChief could not reach the provider. The update will retry automatically; your saved records are kept.',
});
function failureCode(error){return Object.hasOwn(messages,error.code)?error.code:error.status===429?'PROVIDER_RATE_LIMITED':error.code==='PROVIDER_UNREACHABLE'?'PROVIDER_UNREACHABLE':null;}
function explanation(config){return config&&Object.hasOwn(messages,config.syncFailureCode)?messages[config.syncFailureCode]:null;}

function accessRejected(error){
 const appError=String(error.providerBody?.error||'');
 return [401,403].includes(error.status)&&!error.transient&&!error.retryable&&
  !['invalid_client','unauthorized_client'].includes(appError)&&error.code!=='PROVIDER_CONFIGURATION_REQUIRED'&&
  !(Number.isFinite(error.retryAfterMs)&&error.retryAfterMs>0);
}

async function record(db,connection,runId,error){
 const oldConfig=require('./synchronization-policy').object(connection.config),count=Number(oldConfig.syncFailureCount);
 const failureCount=Math.min(8,(Number.isSafeInteger(count)&&count>=0?count:0)+1);
 const delay=Math.max(Number.isFinite(error.retryAfterMs)&&error.retryAfterMs>0?error.retryAfterMs:0,Math.min(3600000,60000*2**(failureCount-1)));
 const at=new Date().toISOString(),retryAt=new Date(Date.now()+delay).toISOString(),rejected=accessRejected(error);
 await db.transaction(async c=>{
  await c.query("UPDATE connection_sync_runs SET status='FAILED',completed_at=$2 WHERE id=$1",[runId,at]);
  if(rejected){
   // A late failure from old credentials must not disable a newer reconnect.
   const changed=await c.query(`UPDATE workspace_connectors SET status='error',setup_status='REAUTHORIZATION_REQUIRED',
    config=(config::jsonb-'syncRetryAt'-'syncFailureCount')::text,last_error=$3,updated_at=$4
    WHERE workspace_id=$1 AND id=$2 AND status='connected' AND paused_at IS NULL AND updated_at IS NOT DISTINCT FROM $5 RETURNING id`,
   [connection.workspace_id,connection.id,'The provider refused access. Reconnect and review the required permissions; your saved records are preserved.',at,connection.updated_at]);
   const already=(await c.query(`SELECT 1 FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 AND status='error' AND setup_status='REAUTHORIZATION_REQUIRED'
    AND provider_type=$3 AND provider_account_id IS NOT DISTINCT FROM $4 AND authorized_by_user_id IS NOT DISTINCT FROM $5`,[connection.workspace_id,connection.id,connection.provider_type,connection.provider_account_id,connection.authorized_by_user_id])).rowCount;
   if(changed.rowCount||already)await c.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,issue_type,fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
    VALUES($1,$2,$3,'PROVIDER_ACCESS_REQUIRED',$4,'Reconnect the provider to restore updates',$5,$6,'OPEN',$7,$7)
    ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,detail=EXCLUDED.detail,resolution_hint=EXCLUDED.resolution_hint,updated_at=EXCLUDED.updated_at`,
   [newId('conissue'),connection.workspace_id,connection.id,'sync-access:'+connection.id,'The provider refused the saved authorization. StockChief stopped automatic checks for this connection and preserved its records.','Reconnect the provider and check its permissions. Updates resume only after the connection is active again.',at]);
  }else await c.query(`UPDATE workspace_connectors SET config=(config::jsonb||$3::jsonb)::text,last_error=$4,updated_at=$5
   WHERE workspace_id=$1 AND id=$2 AND status='connected' AND paused_at IS NULL AND updated_at IS NOT DISTINCT FROM $6`,
  [connection.workspace_id,connection.id,JSON.stringify({syncRetryAt:retryAt,syncFailureCount:failureCount,syncFailureCode:failureCode(error)}),explanation({syncFailureCode:failureCode(error)})||(error.status===429?'The provider asked StockChief to wait. Updates will retry automatically.':'The latest provider check did not finish. Your saved records are preserved; StockChief will retry automatically.'),at,connection.updated_at]);
 },{isolation:'SERIALIZABLE',retrySafe:true});
 if(rejected){error.retryable=false;delete error.retryAfterMs;}else error.retryAfterMs=delay;
 return {accessRejected:rejected,retryAt:rejected?null:retryAt};
}
module.exports={accessRejected,record,failureCode,explanation};
