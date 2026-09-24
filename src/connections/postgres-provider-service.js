'use strict';

const crypto=require('node:crypto');
const config=require('../config');
const { AuthenticationError,NotFoundError,ValidationError }=require('../domain/errors');
const { newId,nowIso,requireText }=require('../lib/util');
const credentials=require('./postgres-credential-store');
const connections=require('./postgres-service');
const defaultProviders=require('./providers/registry');
const jobs=require('../operations/postgres-job-queue');

const stateHash=(value)=>crypto.createHash('sha256').update(String(value)).digest('hex');
const parseJson=(value)=>connections.parseJson(value,{});
const providerOrigin=(requestOrigin)=>config.connections.publicOrigin||requestOrigin;

async function beginAuthorization(database,ctx,input,requestOrigin,options={}){
  const registry=options.providers||defaultProviders;
  const providerType=requireText(input.providerType,'Provider',{max:40}).toLowerCase();
  const adapter=registry.get(providerType);
  if(!adapter)throw new ValidationError('Choose a supported connection provider.');
  const meta=adapter.metadata();
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
      await client.query(`INSERT INTO workspace_connectors
        (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
         expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'disconnected','[]',$6,'{}',$7,'AUTHORIZING',$8,$9,$9)`,
      [connectorId,ctx.workspaceId,`${providerType}:${connectorId}`,input.displayName||meta.name,providerType,
        JSON.stringify(meta.provides||[]),['gmail','microsoft365'].includes(providerType)?5:360,ctx.actorId,now]);
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
  return {connectorId,redirectUrl:auth.url};
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
    let target=connection;
    if(result.accountId){
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`connection:${connection.workspace_id}:${connection.provider_type}:${result.accountId}`]);
      const established=await client.query(`SELECT * FROM workspace_connectors
        WHERE workspace_id=$1 AND provider_type=$2 AND provider_account_id=$3 AND id<>$4
          AND status='connected' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [connection.workspace_id,connection.provider_type,result.accountId,connection.id]);
      if(established.rows.length&&connection.setup_status==='AUTHORIZING'&&!connection.credential_ref){
        await client.query('DELETE FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',
          [connection.workspace_id,connection.id]);
        target=established.rows[0];
      }
    }
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
    return target.id;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function completeOAuth(database,providerType,query,requestOrigin,options={}){
  const registry=options.providers||defaultProviders;
  const adapter=registry.get(providerType);
  if(!adapter)throw new NotFoundError('Provider not found.');
  const state=await readState(database,query.state,providerType,{consume:true});
  const connection=await connections.get(database,state.workspace_id,state.connector_id);
  try{
    const result=await adapter.exchangeAuthorization({query,metadata:state.metadata});
    if(adapter.verifyReadOnly&&!result.verifiedFact&&adapter.integrationClass==='accounting'){
      result.verifiedFact=await adapter.verifyReadOnly({credentials:result.credentials,connection});
    }
    const connectorId=await finishAuthorization(database,connection,state.actor_id,result,requestOrigin);
    let connected=await connections.get(database,state.workspace_id,connectorId);
    if(adapter.integrationClass==='accounting'&&result.verifiedFact){
      const accountingSync=require('../accounting/postgres-integration-sync');
      await accountingSync.initialize(database,connected,state.actor_id,result.verifiedFact);
      connected=await connections.get(database,state.workspace_id,connectorId);
    }
    if(adapter.registerWebhooks){
      const origin=options.publicOrigin||providerOrigin(requestOrigin);
      const webhookUrl=providerType==='gmail'?`${origin}/api/v1/connections/gmail/webhooks`
        :`${origin}/api/v1/connections/${providerType}/webhooks/${encodeURIComponent(connectorId)}`;
      try{
        const current=await loadProviderCredentials(database,connected,adapter);
        const registered=await adapter.registerWebhooks({credentials:current,webhookUrl,connection:connected});
        if(registered?.credentials)await credentials.put(database,connected.workspace_id,connected.id,'provider',
          registered.credentials,registered.expiresAt||null);
        const at=nowIso();
        await database.query(`UPDATE workspace_connectors SET last_error=NULL,updated_at=$3 WHERE workspace_id=$1 AND id=$2`,
          [connected.workspace_id,connected.id,at]);
        await database.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3
          WHERE workspace_id=$1 AND fingerprint=$2 AND status='OPEN'`,
        [connected.workspace_id,`push-setup:${connected.id}`,at]);
      }catch(error){
        const at=nowIso();const detail=String(error.message||'Push delivery setup failed.').slice(0,500);
        await database.query(`UPDATE workspace_connectors SET last_error=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2`,
          [connected.workspace_id,connected.id,
            'Push notifications could not be enabled. Scheduled polling remains active; reconnect or retry push setup.',at]);
        await database.query(`INSERT INTO connection_issues
          (id,workspace_id,connector_id,issue_type,fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
          VALUES($1,$2,$3,'PUSH_SETUP_FAILED',$4,'Mailbox push notifications need attention',$5,$6,'OPEN',$7,$7)
          ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,detail=EXCLUDED.detail,
            resolution_hint=EXCLUDED.resolution_hint,updated_at=EXCLUDED.updated_at`,
        [newId('conissue'),connected.workspace_id,connected.id,`push-setup:${connected.id}`,detail,
          'Mail is still checked by scheduled polling. Reconnect the mailbox to retry push setup.',at]);
      }
      connected=await connections.get(database,state.workspace_id,connectorId);
    }
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
  let providerCredentials=await credentials.get(database,connection.workspace_id,connection.id,'provider');
  if(!providerCredentials)throw new AuthenticationError('Reconnect this provider before syncing.');
  if(adapter?.refreshCredentials){
    try{
      const refreshed=await adapter.refreshCredentials(providerCredentials);
      providerCredentials=refreshed.credentials;
      if(refreshed.refreshed)await credentials.put(database,connection.workspace_id,connection.id,'provider',
        providerCredentials,refreshed.expiresAt||null);
    }catch(error){
      if(error.transient||error.status===429||error.status>=500){
        await database.query('UPDATE workspace_connectors SET last_error=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',
          [connection.workspace_id,connection.id,'The provider is temporarily unavailable. Retry safely; authorization was preserved.',nowIso()]);
      }else{
        await database.query(`UPDATE workspace_connectors SET status='error',setup_status='REAUTHORIZATION_REQUIRED',
          last_error=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2`,[connection.workspace_id,connection.id,
          String(error.message).slice(0,500),nowIso()]);
      }
      throw error;
    }
  }
  return providerCredentials;
}

module.exports={stateHash,providerOrigin,beginAuthorization,readState,callbackContext,finishAuthorization,
  completeOAuth,loadProviderCredentials};
