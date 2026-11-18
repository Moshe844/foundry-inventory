'use strict';
const {AuthenticationError,ValidationError,DomainError}=require('../domain/errors');
const profiles=require('./shopify-app-profile'),lifecycle=require('./shopify-token-lifecycle'),vault=require('./credentials');
const {newId}=require('../lib/util');
const configOf=connection=>typeof connection.config==='string'?JSON.parse(connection.config||'{}'):connection.config||{};
function applies(connection,headers){return connection.provider_type==='shopify'&&headers['x-shopify-topic']==='app/uninstalled';}
function identity(connection){
 const config=configOf(connection),app=profiles.forGrant({}, {...connection,config}),shop=connection.provider_account_id;
 if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop||'')||config.shop&&config.shop!==shop)throw new AuthenticationError('The Shopify connection does not identify its original store.');
 return {clientId:app.clientId,profile:app.name,shop};
}
const shopId=value=>String(value||'').replace(/^gid:\/\/shopify\/Shop\//,'');
function payloadIdentity(bound,body){
 if(body?.myshopify_domain!=null&&body.myshopify_domain!==bound.shop)throw new AuthenticationError('This Shopify uninstall payload belongs to a different store.');
 if(typeof body?.id==='number'&&!Number.isSafeInteger(body.id)||!/^\d{1,30}$/.test(shopId(body?.id)))throw new ValidationError('The Shopify uninstall payload needs a valid store identity.');
}
function verify(connection,input){
 const bound=identity(connection);
 // The app secret remains available after OAuth credentials have been erased.
 // The signed Shop payload also binds the store: headers alone are not signed.
 require('./providers/shopify').verifyWebhook({...input,credentials:{},connection:{...connection,config:configOf(connection)}});
 payloadIdentity(bound,input.body);
 const triggeredAt=Date.parse(input.headers['x-shopify-triggered-at']||'');
 if(!Number.isFinite(triggeredAt)||triggeredAt>Date.now()+300000)throw new ValidationError('The Shopify uninstall event needs a valid trigger time.');
 return {...bound,triggeredAt};
}
async function run(database,connection,operation){const bound=identity(connection);return lifecycle.run(database,bound.clientId,bound.shop,db=>operation(db,bound));}
// The caller holds this app/store's lifecycle lock and the connector row lock.
// Record revocation and receipt completion in the same transaction. The only
// network operation is one bounded identity read of the exact saved token.
function deferred(){return Object.assign(new DomainError('Shopify could not confirm that this authorization was revoked. Its credentials have been kept; retry this delivery or review the connection.',{code:'shopify_uninstall_unconfirmed',status:503}),{transient:true,retryable:true,retryAfterMs:60000});}
async function apply(c,connection,headers,body,receiptId,expected){
 const bound=identity(connection);
 if(expected&&(bound.clientId!==expected.clientId||bound.shop!==expected.shop))throw new AuthenticationError('The Shopify installation changed before this event could be applied.');
 payloadIdentity(bound,body);
 if(headers['x-shopify-shop-domain']!==bound.shop)throw new AuthenticationError('The Shopify uninstall event does not match this store.');
 const triggeredAt=Date.parse(headers['x-shopify-triggered-at']||'');
 if(!Number.isFinite(triggeredAt)||triggeredAt>Date.now()+300000)throw new ValidationError('The Shopify uninstall event needs a valid trigger time.');
 const row=(await c.query("SELECT * FROM connection_credentials WHERE workspace_id=$1 AND connector_id=$2 AND credential_kind='provider' FOR UPDATE",[connection.workspace_id,connection.id])).rows[0];
 const grant=row?vault.decrypt(row):null;
 let trustedShopId=shopId(grant?.shopifyShopId||configOf(connection).shopifyShopId);
 if(body.myshopify_domain==null&&!trustedShopId&&bound.profile==='public'){
  const appId=String(process.env.SHOPIFY_PUBLIC_APP_ID||'').replace(/^gid:\/\/shopify\/App\//,'');
  if(/^\d{1,30}$/.test(appId))trustedShopId=shopId((await c.query(`SELECT b.shop_id FROM commercial_shopify_subscriptions b JOIN workspaces w ON w.owner_account_id=b.account_id
   WHERE w.id=$1 AND b.shop=$2 AND b.app_id=$3`,[connection.workspace_id,bound.shop,'gid://shopify/App/'+appId])).rows[0]?.shop_id);
 }
 if(trustedShopId&&shopId(body.id)!==trustedShopId)throw new AuthenticationError('The signed Shopify store identity does not match this installation.');
 if(body.myshopify_domain==null&&!trustedShopId&&(row||connection.status!=='disconnected'))throw new ValidationError('This Shopify uninstall needs the stored, verified store identity before it can revoke authorization.');
 if(connection.status==='disconnected'&&!row)return {revoked:false,alreadyRevoked:true};
 let authorizationBoundary,revocationEvidence='CURRENT_UNEXPIRED_TOKEN_REJECTED';
 if(grant){
  const app=profiles.forGrant(grant,{...connection,config:configOf(connection)});
  if(app.clientId!==bound.clientId||grant.shop!==bound.shop)throw new AuthenticationError('The Shopify grant does not match this installation.');
  // Token refresh must retain authorizedAt. Older grants predate that field;
  // their latest credential write is a conservative replacement boundary.
  authorizationBoundary=Date.parse(grant.authorizedAt||row.updated_at||row.created_at);
  if(!Number.isFinite(authorizationBoundary))throw deferred();
  let probe,scope;const deadline=Date.now()+4000,adapter=require('./providers/shopify');
  try{
   scope=await require('../commercial/entitlements').ownerScopeForWorkspace(c,connection.workspace_id);
   probe=await require('../commercial/context').run({database:c,scope,system:true,requestId:'shopify-uninstall-probe:'+receiptId},()=>adapter.probeGrant(grant,{clientId:bound.clientId,shop:bound.shop,shopId:trustedShopId||body.id,timeoutMs:Math.max(1,Math.min(2000,deadline-Date.now()))}));
  }catch{throw deferred();}
  if(probe.authorized)return {revoked:false,ignored:'current_grant_valid'};
  // A 401 for an expired access token needs independent refresh-family proof.
  // Only the current, nonexpired public family is eligible, under this same
  // store lock. Local expiry and unsigned trigger headers prove no revocation.
  const expiresAt=Date.parse(grant.accessTokenExpiresAt||row.expires_at||'');
  const permanentLegacy=bound.profile==='legacy'&&grant.authMode!=='client_credentials'&&!grant.accessTokenExpiresAt&&!row.expires_at;
  if(!permanentLegacy&&(!Number.isFinite(expiresAt)||expiresAt<=Date.now()+5000)){
   const refreshExpiresAt=Date.parse(grant.refreshTokenExpiresAt||''),remaining=Math.min(2000,deadline-Date.now());
   if(!Number.isFinite(expiresAt)||bound.profile!=='public'||!grant.refreshToken||!Number.isFinite(refreshExpiresAt)||refreshExpiresAt<=Date.now()+5000||remaining<1)throw deferred();
   let refreshed;
   try{refreshed=await require('../commercial/context').run({database:c,scope,system:true,requestId:'shopify-uninstall-refresh:'+receiptId},()=>adapter.refreshCredentials(grant,{timeoutMs:remaining,retries:0}));}
   catch(error){
    if(![400,401].includes(error.status)||error.providerBody?.error!=='invalid_grant'||refreshExpiresAt<=Date.now()+5000)throw deferred();
    revocationEvidence='CURRENT_REFRESH_FAMILY_REJECTED';
   }
   if(refreshed){
    if(!refreshed.refreshed||!refreshed.credentials?.accessToken||!refreshed.credentials?.refreshToken)throw deferred();
    // Authenticated refresh success itself proves this exact app/store family
    // is still installed. Persist the single-use rotation and finish now: no
    // later probe/error may roll back the fresh credentials.
    await require('./postgres-credential-store').put(c,connection.workspace_id,connection.id,'provider',refreshed.credentials,refreshed.expiresAt);
    return {revoked:false,ignored:'current_refresh_family_valid',refreshed:true};
   }
  }
 }else throw deferred();
 const now=new Date().toISOString(),at=new Date(authorizationBoundary).toISOString();
 await c.query(`UPDATE workspace_connectors SET status='disconnected',setup_status='REAUTHORIZATION_REQUIRED',credential_ref=NULL,
  paused_at=$3,last_error='Shopify uninstalled this app. Open StockChief from Shopify to authorize it again.',updated_at=$3
  WHERE workspace_id=$1 AND id=$2`,[connection.workspace_id,connection.id,now]);
 await c.query("DELETE FROM connection_credentials WHERE workspace_id=$1 AND connector_id=$2 AND credential_kind='provider'",[connection.workspace_id,connection.id]);
 await c.query('UPDATE connector_feed_tokens SET revoked_at=$3 WHERE workspace_id=$1 AND connector_id=$2 AND revoked_at IS NULL',[connection.workspace_id,connection.id,now]);
 // Use the rejected grant's server-recorded generation, never a webhook
 // header, to retire old consent. A newer pending grant is not disproven by
 // rejection of this token and must remain untouched.
 const handoffs=(await c.query(`SELECT * FROM shopify_public_installs
  WHERE client_id=$1 AND shop=$2 AND status<>'FAILED' FOR UPDATE`,[bound.clientId,bound.shop])).rows;
 for(const handoff of handoffs){
  const handoffAt=handoff.status==='AUTHORIZED'&&handoff.ciphertext?Date.parse(vault.decrypt(handoff).credentials?.authorizedAt||''):new Date(handoff.created_at).getTime();
  if(!(handoff.status==='LINKED'&&handoff.linked_connector_id===connection.id)&&(!Number.isFinite(handoffAt)||handoffAt>authorizationBoundary))continue;
  await c.query("UPDATE shopify_public_installs SET status='FAILED',ciphertext=NULL,iv=NULL,auth_tag=NULL WHERE id=$1",[handoff.id]);
 }
 await c.query(`UPDATE connection_authorization_states SET expires_at=$4
  WHERE provider_type='shopify' AND used_at IS NULL AND created_at<=$4
  AND metadata::jsonb->>'shop'=$1 AND COALESCE(metadata::jsonb->>'shopifyProfile','legacy')=$2
  AND COALESCE(metadata::jsonb->>'shopifyClientId',$3)=$3`,[bound.shop,bound.profile,bound.clientId,at]);
 await c.query(`INSERT INTO domain_events(id,workspace_id,event_type,payload,source,source_record_type,source_record_id,idempotency_key,status,result,created_at,processed_at)
  VALUES($1,$2,'connection.authorization_revoked',$3,'shopify','connection',$4,$5,'PROCESSED','{}',$6,$6) ON CONFLICT DO NOTHING`,
 [newId('evt'),connection.workspace_id,JSON.stringify({topic:'app/uninstalled',receiptId,clientId:bound.clientId,shop:bound.shop,reportedTriggeredAt:new Date(triggeredAt).toISOString(),verifiedAt:now,verification:revocationEvidence}),connection.id,'shopify-uninstall:'+receiptId,now]);
 return {revoked:true};
}
module.exports={applies,identity,verify,run,apply};
