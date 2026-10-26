'use strict';

const crypto=require('node:crypto');
const config=require('../config');
const { AuthenticationError,NotFoundError,ValidationError }=require('../domain/errors');
const { newId,nowIso,requireText }=require('../lib/util');
const credentials=require('./postgres-credential-store');
const connections=require('./postgres-service');
const defaultProviders=require('./providers/registry');
const launchPolicy=require('./launch-policy');
const jobs=require('../operations/postgres-job-queue');
const entitlements=require('../entitlements/postgres-service');
const commercial=require('../commercial/service');

const stateHash=(value)=>crypto.createHash('sha256').update(String(value)).digest('hex');
const parseJson=(value)=>connections.parseJson(value,{});
const providerOrigin=(requestOrigin)=>config.connections.publicOrigin||requestOrigin;

async function beginAuthorization(database,ctx,input,requestOrigin,options={}){
  const registry=options.providers||defaultProviders;
  const providerType=requireText(input.providerType,'Provider',{max:40}).toLowerCase();
  if(registry===defaultProviders)await launchPolicy.assertWorkspaceConnection(database,providerType,ctx);
  const adapter=registry.get(providerType);
  if(!adapter)throw new ValidationError('Choose a supported connection provider.');
  const meta=adapter.metadata({oauthOnly:true});
  const commercialScope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
  await entitlements.assertCapability(database,commercialScope,['gmail','microsoft365'].includes(providerType)?'communications.email_ingestion':
    adapter.integrationClass==='accounting'?'connections.accounting':'connections.commerce');
  if(!meta.available)throw new ValidationError(meta.unavailableReason||`${meta.name} is not configured.`);
  if(adapter.validateInput)adapter.validateInput(input);
  const connectorId=input.connectorId||newId('con');
  const state=crypto.randomBytes(32).toString('base64url');
  const now=nowIso();
  const origin=options.publicOrigin||providerOrigin(requestOrigin);
  let auth;
  await database.transaction(async(client)=>{
    if(input.connectorId){
      const existing=await client.query(`UPDATE workspace_connectors SET setup_status='AUTHORIZING',
        status='disconnected',authorized_by_user_id=$3,last_error=NULL,updated_at=$4
        WHERE workspace_id=$1 AND id=$2 AND provider_type=$5 RETURNING id`,
      [ctx.workspaceId,connectorId,ctx.actorId,now,providerType]);
      if(!existing.rows.length)throw new NotFoundError('Connection not found.');
    }else{
      const commercialScope=await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId);
      await entitlements.assertMeterCapacity(client,commercialScope,'connections',1);
      await client.query(`INSERT INTO workspace_connectors
        (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
         expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'disconnected','[]',$6,$10,$7,'AUTHORIZING',$8,$9,$9)`,
      [connectorId,ctx.workspaceId,`${providerType}:${connectorId}`,input.displayName||meta.name,providerType,
        JSON.stringify(meta.provides||[]),1,ctx.actorId,now,JSON.stringify({autoImportCatalog:Boolean(adapter.catalogueCapabilities?.length)&&adapter.integrationClass!=='accounting',autoImportOpeningStock:Boolean(adapter.catalogueCapabilities?.length)&&adapter.integrationClass!=='accounting'})]);
    }
    auth=adapter.authorizationUrl({state,input:{...input,
      redirectUri:`${origin}/settings/connections/${providerType}/callback`,
      returnUri:`${origin}/settings/connections/woocommerce/return?state=${encodeURIComponent(state)}`,
      callbackUri:`${origin}/api/v1/connections/woocommerce/callback`}});
    await client.query(`INSERT INTO connection_authorization_states
      (id,state_hash,workspace_id,connector_id,provider_type,actor_id,metadata,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[newId('cauth'),stateHash(state),ctx.workspaceId,connectorId,
      providerType,ctx.actorId,JSON.stringify({...auth.metadata,returnOrigin:requestOrigin,
        popup:String(input.popup||'')==='1'}),new Date(Date.now()+15*60000).toISOString(),now]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
  return {connectorId,redirectUrl:auth.url,...(adapter.oauthSessionBound?{authorizationState:state}:{})};
}

async function readState(database,state,providerType,{consume=false}={}){
  const operation=async(queryable)=>{
    const result=consume
      ? await queryable.query(`UPDATE connection_authorization_states SET used_at=$3
          WHERE state_hash=$1 AND provider_type=$2 AND used_at IS NULL AND expires_at>$3 RETURNING *`,
        [stateHash(state),providerType,nowIso()])
      : await queryable.query(`SELECT * FROM connection_authorization_states
          WHERE state_hash=$1 AND provider_type=$2 AND used_at IS NULL AND expires_at>$3`,
        [stateHash(state),providerType,nowIso()]);
    if(!result.rows.length)throw new AuthenticationError('This connection request has expired or was already used. Please start again.');
    return {...result.rows[0],metadata:parseJson(result.rows[0].metadata)};
  };
  return consume?database.transaction(operation,{isolation:'SERIALIZABLE',retrySafe:true}):operation(database);
}

async function callbackContext(database,stateValue,providerType){
  const state=await readState(database,stateValue,providerType);
  return {connection:await connections.get(database,state.workspace_id,state.connector_id),
    returnOrigin:state.metadata.returnOrigin||null,popup:Boolean(state.metadata.popup)};
}

async function finishAuthorization(database,connection,actorId,result){
  return database.transaction(async(client)=>{
    const authorizer=(await client.query("SELECT role FROM users WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[connection.workspace_id,actorId])).rows[0];
    if(authorizer?.role!=='owner')throw new AuthenticationError('The owner who started this connection no longer has permission to authorize it. Start again with a current owner.');
    const scope=await entitlements.ownerScopeForWorkspace(client,connection.workspace_id);
    await entitlements.assertCapability(client,scope,['gmail','microsoft365'].includes(connection.provider_type)?'communications.email_ingestion':
      ['quickbooks','xero'].includes(connection.provider_type)?'connections.accounting':'connections.commerce');
    let target=connection;
    if(result.accountId){
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`connection:${connection.workspace_id}:${connection.provider_type}:${result.accountId}`]);
      const established=await client.query(`SELECT * FROM workspace_connectors
        WHERE workspace_id=$1 AND provider_type=$2 AND provider_account_id=$3 AND id<>$4
          AND status='connected' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [connection.workspace_id,connection.provider_type,result.accountId,connection.id]);
      if(established.rows.length&&connection.setup_status==='AUTHORIZING'&&!connection.credential_ref){
        await client.query('UPDATE connection_authorization_states SET connector_id=$3 WHERE workspace_id=$1 AND connector_id=$2',
          [connection.workspace_id,connection.id,established.rows[0].id]);
        await client.query('DELETE FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',
          [connection.workspace_id,connection.id]);
        target=established.rows[0];
      }
    }
    // A callback has consumed its temporary consent reservation. Re-admit the
    // actual target atomically; another connection may have taken the slot.
    const delta=await require('../commercial/connection-capacity').activationDelta(client,target.workspace_id,target.id);
    await entitlements.assertMeterCapacity(client,scope,'connections',delta);
    await credentials.put(client,target.workspace_id,target.id,'provider',result.credentials,result.expiresAt||null);
    const currentConfig=parseJson(target.config);
    const safeConfig={...currentConfig};
    if(result.credentials?.shop)safeConfig.shop=result.credentials.shop;
    if(result.credentials?.storeUrl)safeConfig.storeUrl=result.credentials.storeUrl;
    if(result.verifiedFact)safeConfig.verifiedFact=result.verifiedFact;
    const now=nowIso();
    await client.query(`UPDATE workspace_connectors SET status='connected',setup_status='CONNECTED',
      capabilities=$3,config=$4,credential_ref=$5,provider_account_id=$6,provider_account_name=$7,
      authorized_by_user_id=$8,last_error=NULL,paused_at=NULL,last_activity_at=$9,updated_at=$9
      WHERE workspace_id=$1 AND id=$2`,[target.workspace_id,target.id,JSON.stringify(result.capabilities||[]),
      JSON.stringify(safeConfig),`connection_credentials:${target.id}`,result.accountId||null,
      result.accountName||null,actorId,now]);
    if(result.accountId){
      await client.query(`UPDATE workspace_connectors SET status='disconnected',setup_status='DUPLICATE_CONNECTION',
        paused_at=$5,last_error='Another connection to this provider account is active. Mapping and audit history are preserved.',updated_at=$5
        WHERE workspace_id=$1 AND provider_type=$2 AND provider_account_id=$3 AND id<>$4
          AND status<>'disconnected'`,[target.workspace_id,target.provider_type,result.accountId,target.id,now]);
    }
    const owner=(await client.query('SELECT owner_account_id FROM workspaces WHERE id=$1',[target.workspace_id])).rows[0];
    if(owner?.owner_account_id)await commercial.trackOnce(client,{eventName:'first_integration_connected',
      accountId:owner.owner_account_id,sourcePath:'provider_authorization',detail:{providerType:target.provider_type}});
    return target.id;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function setupWebhookDelivery(database,ctx,connectorId,requestOrigin,options={}){
  const role=(await database.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(role?.role!=='owner')throw new (require('../domain/errors').AuthorizationError)('Only an owner can configure provider event delivery.');
  let connection=await connections.get(database,ctx.workspaceId,connectorId);
  if(connection.status!=='connected'||connection.paused_at)throw new ValidationError('Reconnect or resume this provider before configuring event delivery.');
  const providerType=connection.provider_type,adapter=(options.providers||defaultProviders).get(providerType);
  const mailbox=['gmail','microsoft365'].includes(providerType);
    if(adapter?.registerWebhooks){
      const origin=options.publicOrigin||providerOrigin(requestOrigin);
      const webhookUrl=providerType==='gmail'?`${origin}/api/v1/connections/gmail/webhooks`
        :providerType==='square'?`${origin}/api/v1/connections/square/webhooks`
        :`${origin}/api/v1/connections/${providerType}/webhooks/${encodeURIComponent(connectorId)}`;
      try{
        const current=await loadProviderCredentials(database,connection,adapter);
        const registered=await require('../commercial/operations').run(database,connection.workspace_id,{capability:
          ['gmail','microsoft365'].includes(providerType)?'communications.email_ingestion':'connections.commerce',key:options.operationKey||`webhook-setup:${newId('attempt')}`,
          provider:providerType,operation:'webhook_registration'},()=>adapter.registerWebhooks({credentials:current,webhookUrl,connection:connection}));
        if(registered?.credentials)await credentials.put(database,connection.workspace_id,connection.id,'provider',
          registered.credentials,registered.expiresAt||current.expiresAt||null);
        const at=nowIso();
        await database.query(`UPDATE workspace_connectors SET last_error=NULL,updated_at=$3 WHERE workspace_id=$1 AND id=$2`,
          [connection.workspace_id,connection.id,at]);
        await database.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3
          WHERE workspace_id=$1 AND fingerprint=$2 AND status='OPEN'`,
        [connection.workspace_id,`push-setup:${connection.id}`,at]);
      }catch(error){
        const at=nowIso();const detail=String(error.message||'Push delivery setup failed.').slice(0,500);
        await database.query(`UPDATE workspace_connectors SET last_error=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2`,
          [connection.workspace_id,connection.id,
            mailbox?'Push notifications could not be enabled. Scheduled mailbox checks remain active; retry event setup.':'Automatic provider events could not be enabled. Retry event setup before relying on ongoing updates.',at]);
        await database.query(`INSERT INTO connection_issues
          (id,workspace_id,connector_id,issue_type,fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
          VALUES($1,$2,$3,'PUSH_SETUP_FAILED',$4,$5,$6,$7,'OPEN',$8,$8)
          ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,detail=EXCLUDED.detail,
            resolution_hint=EXCLUDED.resolution_hint,updated_at=EXCLUDED.updated_at`,
        [newId('conissue'),connection.workspace_id,connection.id,`push-setup:${connection.id}`,
          mailbox?'Mailbox push notifications need attention':'Automatic provider events need attention',detail,
          mailbox?'Scheduled mailbox checks remain active. Retry push setup.':'Retry event setup. Do not rely on automatic updates until delivery is verified.',at]);
      }
      connection=await connections.get(database,ctx.workspaceId,connectorId);
    }
  return connection;
}

async function completeOAuth(database,providerType,query,requestOrigin,options={}){
  const registry=options.providers||defaultProviders;
  const adapter=registry.get(providerType);
  if(!adapter)throw new NotFoundError('Provider not found.');
  // Outside the Staging pilot, excluded providers are rejected before reading
  // or consuming any authorization state. Staging callbacks resolve their
  // inventory from the saved state, then recheck its current owner below.
  if(registry===defaultProviders&&process.env.STOCKCHIEF_RUNTIME_ENV!=='staging')launchPolicy.assertNewConnection(providerType);
  const state=await readState(database,query.state,providerType,{consume:true});
  if(registry===defaultProviders)await launchPolicy.assertWorkspaceConnection(database,providerType,{workspaceId:state.workspace_id});
  const connection=await connections.get(database,state.workspace_id,state.connector_id);
  try{
    const result=await require('../commercial/operations').run(database,connection.workspace_id,{capability:
      ['gmail','microsoft365'].includes(providerType)?'communications.email_ingestion':adapter.integrationClass==='accounting'?'connections.accounting':'connections.commerce',
      key:`oauth:${state.id}`,provider:providerType,operation:'authorization_exchange'},()=>adapter.exchangeAuthorization({query,metadata:state.metadata}));
    if(adapter.verifyReadOnly&&!result.verifiedFact&&adapter.integrationClass==='accounting'){
      result.verifiedFact=await require('../commercial/operations').run(database,connection.workspace_id,{capability:'connections.accounting',
        key:`oauth-verify:${state.id}`,provider:providerType,operation:'accounting_verify'},()=>adapter.verifyReadOnly({credentials:result.credentials,connection}));
    }
    const connectorId=await finishAuthorization(database,connection,state.actor_id,result,requestOrigin);
    let connected=await connections.get(database,state.workspace_id,connectorId);
    if(adapter.integrationClass==='accounting'&&result.verifiedFact){
      const accountingSync=require('../accounting/postgres-integration-sync');
      await accountingSync.initialize(database,connected,state.actor_id,result.verifiedFact);
      connected=await connections.get(database,state.workspace_id,connectorId);
    }
    if(adapter.registerWebhooks)connected=await setupWebhookDelivery(database,{workspaceId:state.workspace_id,actorId:state.actor_id},connectorId,requestOrigin,{...options,operationKey:`oauth-webhooks:${state.id}`});
    if(adapter.discover)await jobs.enqueue(database,{workspaceId:connected.workspace_id,kind:'provider.catalog-sync',
      idempotencyKey:`provider-catalog-sync:${connected.id}:authorization:${connected.updated_at}`,
      payload:{connectorId:connected.id,source:'authorization'},priority:25,maxAttempts:5});
    return connected;
  }catch(error){
    await database.query(`UPDATE workspace_connectors SET status='error',setup_status='AUTHORIZATION_FAILED',
      last_error=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2`,[connection.workspace_id,connection.id,
      String(error.message||'Authorization failed.').slice(0,500),nowIso()]);
    throw error;
  }
}

async function loadProviderCredentials(database,connection,adapter){
  if(connection.setup_status==='REAUTHORIZATION_REQUIRED')throw new AuthenticationError('Reconnect this provider before using its authorization again.');
  const refresh=async queryable=>{
  if(adapter?.refreshCredentials){
    // Refresh tokens can be single use. Serialize readers of the same grant
    // and read the current ciphertext after the lock, never an earlier token.
    await queryable.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`provider-credentials:${connection.workspace_id}:${connection.id}`]);
  }
  const current=(await queryable.query('SELECT status,setup_status FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',
    [connection.workspace_id,connection.id])).rows[0];
  if(!current||current.status==='disconnected'||current.setup_status==='REAUTHORIZATION_REQUIRED')
    throw new AuthenticationError('Reconnect this provider before using its authorization again.');
  let providerCredentials=await credentials.get(queryable,connection.workspace_id,connection.id,'provider');
  if(!providerCredentials)throw new AuthenticationError('Reconnect this provider before syncing.');
  if(adapter?.refreshCredentials){
    if(adapter.metadata?.().available===false)throw Object.assign(new Error(
      'This connection is waiting for StockChief’s provider configuration. Its saved authorization is preserved.'),
    {code:'PROVIDER_CONFIGURATION_REQUIRED',status:503,transient:true,retryable:true});
    const refreshed=await adapter.refreshCredentials(providerCredentials);
    if(!refreshed?.credentials)throw Object.assign(new Error('The provider did not confirm refreshed authorization.'),
      {code:'PROVIDER_REFRESH_UNCONFIRMED',status:503,transient:true});
    providerCredentials=refreshed.credentials;
    if(refreshed.refreshed)await credentials.put(queryable,connection.workspace_id,connection.id,'provider',
      providerCredentials,refreshed.expiresAt||null);
  }
  return providerCredentials;
  };
    try{
      return typeof database.transaction==='function'?await database.transaction(refresh,
        {isolation:'READ COMMITTED',retrySafe:false}):await refresh(database);
    }catch(error){
      if(error.code==='entitlement_required'||error.status===402)throw error;
      const invalidClient=/invalid_client|unauthorized_client/.test(String(error.providerBody?.error||''));
      const rejectedGrant=error instanceof AuthenticationError||error.status===401||error.status===403||
        String(error.providerBody?.error||'')==='invalid_grant';
      if(!rejectedGrant||invalidClient||error.transient||error.status===429||error.status>=500){
        await database.query("UPDATE workspace_connectors SET last_error=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2 AND status<>'disconnected'",
          [connection.workspace_id,connection.id,error.code==='PROVIDER_CONFIGURATION_REQUIRED'||invalidClient?
            'StockChief’s provider configuration needs attention. Your authorization is preserved; signing in again is not required.':
            'The provider check could not finish. StockChief will retry safely; authorization was preserved.',nowIso()]);
      }else{
        await database.query(`UPDATE workspace_connectors SET status='error',setup_status='REAUTHORIZATION_REQUIRED',
          last_error=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2 AND status<>'disconnected'`,[connection.workspace_id,connection.id,
          'The provider could not renew this authorization. Sign in again to restore updates; your records are preserved.',nowIso()]);
      }
      throw error;
    }
}

module.exports={stateHash,providerOrigin,beginAuthorization,readState,callbackContext,finishAuthorization,
  completeOAuth,loadProviderCredentials,setupWebhookDelivery};
require('../commercial/enforcement').guardExports(module.exports,0,1,{loadProviderCredentials:'workspace.core',setupWebhookDelivery:'workspace.core'});
