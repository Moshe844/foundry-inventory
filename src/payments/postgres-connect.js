'use strict';

const crypto=require('node:crypto');
const legacy=require('./connect');
const providerService=require('../connections/postgres-provider-service');
const {AuthenticationError,NotFoundError,ValidationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');

const PROVIDER='stripe';
const STATE_PROVIDER='stripe_connect';
const AUTHORIZE='https://connect.stripe.com/oauth/authorize';
const TOKEN='https://connect.stripe.com/oauth/token';
const DEAUTHORIZE='https://connect.stripe.com/oauth/deauthorize';

async function rowFor(database,workspaceId){return (await database.query(`SELECT * FROM payment_connect_accounts
  WHERE workspace_id=$1 AND provider=$2`,[workspaceId,PROVIDER])).rows[0]||null;}

async function describe(database,workspaceId){const row=await rowFor(database,workspaceId);const held=legacy.platform();
  const available=Boolean(held.clientId&&held.secretKey);if(!row)return {connected:false,available,
    because:available?'Connect an existing Stripe account owned by this business.':
      'Stripe existing-account sign-in needs the StockChief platform client ID and secret key.'};
  return {connected:true,available,provider:PROVIDER,accountId:row.provider_account_id,displayName:row.display_name,
    chargesEnabled:Number(row.charges_enabled)===1,liveMode:Number(row.livemode)===1,checkedAt:row.checked_at,
    because:Number(row.charges_enabled)===1?null:
      'Stripe has this account connected but has not approved it to accept charges yet.'};}

async function begin(database,ctx,input={}){const held=legacy.platform();
  if(!held.clientId||!held.secretKey)throw new ValidationError(
    'Stripe existing-account sign-in is not configured. Add the StockChief Stripe Connect client ID and secret key.');
  const current=await rowFor(database,ctx.workspaceId);
  if(current&&Number(current.charges_enabled)===1)throw new ValidationError(
    'This inventory already has a Stripe account connected. Disconnect it first to use another account.');
  const connectorId=current?.connector_id||newId('con');const state=crypto.randomBytes(32).toString('base64url');const at=nowIso();
  const callbackUrl=`${input.publicOrigin||input.requestOrigin}/settings/connections/payments/return`;
  await database.transaction(async(client)=>{if(current?.connector_id)await client.query(`UPDATE workspace_connectors
      SET setup_status='AUTHORIZING',status='disconnected',last_error=NULL,authorized_by_user_id=$3,updated_at=$4
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,connectorId,ctx.actorId,at]);
    else await client.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,
       setup_status,authorized_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,'Stripe','stripe',$4,$5,'disconnected',$6,'AUTHORIZING',$7,$8,$8)`,
    [connectorId,ctx.workspaceId,`stripe:${connectorId}`,JSON.stringify(['payments']),JSON.stringify({connect:true}),
      JSON.stringify(['invoices','refunds']),ctx.actorId,at]);
    await client.query(`INSERT INTO connection_authorization_states
      (id,state_hash,workspace_id,connector_id,provider_type,actor_id,metadata,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[newId('cauth'),providerService.stateHash(state),ctx.workspaceId,
      connectorId,STATE_PROVIDER,ctx.actorId,JSON.stringify({returnOrigin:input.requestOrigin,popup:true,callbackUrl}),
      new Date(Date.now()+15*60000).toISOString(),at]);},{isolation:'SERIALIZABLE',retrySafe:true});
  const query=new URLSearchParams({response_type:'code',client_id:held.clientId,scope:'read_write',state,
    redirect_uri:callbackUrl});if(input.businessName)query.set('stripe_user[business_name]',input.businessName);
  if(input.email)query.set('stripe_user[email]',input.email);
  return {redirectUrl:`${input.authorizeEndpoint||AUTHORIZE}?${query}`,connectorId};}

async function complete(database,query={},options={}){const state=await providerService.readState(database,query.state,
  STATE_PROVIDER,{consume:true});const actor=(await database.query(`SELECT role FROM users
    WHERE workspace_id=$1 AND id=$2`,[state.workspace_id,state.actor_id])).rows[0];
  if(actor?.role!=='owner')throw new AuthenticationError('The owner who started this Stripe connection no longer has permission.');
  if(query.error){const reason=String(query.error_description||'The Stripe connection was not approved.').slice(0,500);
    await database.query(`UPDATE workspace_connectors SET status='disconnected',setup_status='AUTHORIZATION_FAILED',
      last_error=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2`,[state.workspace_id,state.connector_id,reason,nowIso()]);
    return {connected:false,workspaceId:state.workspace_id,connectorId:state.connector_id,message:reason,
      returnOrigin:state.metadata.returnOrigin};}
  if(!query.code)throw new AuthenticationError('Stripe sent nothing to complete the connection with.');
  try{const held=legacy.platform();const exchange=options.exchange||((code)=>legacy.post(TOKEN,
    {grant_type:'authorization_code',code,client_secret:held.secretKey}));const granted=await exchange(query.code);
    const accountId=granted.stripe_user_id||granted.account_id||granted.stripe_account_id;
    if(!accountId)throw new ValidationError('Stripe did not say which account was connected.');
    const read=options.readAccount||((id)=>legacy.readAccount(id,held.secretKey));const account=await read(accountId).catch(()=>null);
    const displayName=account&&(account.display_name||account.business_profile?.name||account.settings?.dashboard?.display_name||
      account.email)||null;const chargesEnabled=legacy.canTakeCharges(account);
    const liveMode=granted.livemode===true||granted.livemode==='true'||account?.livemode===true;
    const at=nowIso();await database.transaction(async(client)=>{await client.query(`UPDATE workspace_connectors
      SET status='connected',paused_at=NULL,setup_status='CONNECTED',last_error=NULL,provider_account_id=$3,
      provider_account_name=$4,updated_at=$5 WHERE workspace_id=$1 AND id=$2`,
    [state.workspace_id,state.connector_id,accountId,displayName,at]);
    await client.query(`INSERT INTO payment_connect_accounts
      (id,workspace_id,connector_id,provider,provider_account_id,display_name,charges_enabled,livemode,
       checked_at,connected_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,'stripe',$4,$5,$6,$7,$8,$9,$8,$8)
      ON CONFLICT(workspace_id,provider) DO UPDATE SET connector_id=EXCLUDED.connector_id,
       provider_account_id=EXCLUDED.provider_account_id,display_name=EXCLUDED.display_name,
       charges_enabled=EXCLUDED.charges_enabled,livemode=EXCLUDED.livemode,checked_at=EXCLUDED.checked_at,
       connected_by_user_id=EXCLUDED.connected_by_user_id,updated_at=EXCLUDED.updated_at`,
    [newId('paycon'),state.workspace_id,state.connector_id,accountId,displayName,chargesEnabled?1:0,liveMode?1:0,
      at,state.actor_id]);},{isolation:'SERIALIZABLE',retrySafe:true});
    return {connected:true,workspaceId:state.workspace_id,connectorId:state.connector_id,returnOrigin:state.metadata.returnOrigin,
      ...(await describe(database,state.workspace_id))};
  }catch(error){await database.query(`UPDATE workspace_connectors SET status='error',setup_status='AUTHORIZATION_FAILED',
      last_error=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2`,[state.workspace_id,state.connector_id,
      String(error.message||'Stripe authorization failed.').slice(0,500),nowIso()]);throw error;}}

async function refresh(database,workspaceId,options={}){const row=await rowFor(database,workspaceId);
  if(!row)return describe(database,workspaceId);const held=legacy.platform();if(!held.secretKey)return describe(database,workspaceId);
  const read=options.readAccount||((id)=>legacy.readAccount(id,held.secretKey));let account;
  try{account=await read(row.provider_account_id);}catch(error){if([401,403,404].includes(Number(error.status))){
      await database.transaction(async(client)=>{await client.query(`DELETE FROM payment_connect_accounts
          WHERE workspace_id=$1 AND provider=$2`,[workspaceId,PROVIDER]);if(row.connector_id)await client.query(`UPDATE workspace_connectors
          SET status='disconnected',setup_status='REAUTHORIZATION_REQUIRED',last_error=$3,updated_at=$4
          WHERE workspace_id=$1 AND id=$2`,[workspaceId,row.connector_id,
          'Stripe no longer authorizes this inventory. Connect the account again before requesting payment.',nowIso()]);},
      {isolation:'SERIALIZABLE',retrySafe:true});return describe(database,workspaceId);}throw error;}
  const name=account.display_name||account.business_profile?.name||account.settings?.dashboard?.display_name||account.email||null;
  const at=nowIso();await database.query(`UPDATE payment_connect_accounts SET charges_enabled=$3,livemode=$4,
    display_name=$5,checked_at=$6,updated_at=$6 WHERE workspace_id=$1 AND provider=$2`,
  [workspaceId,PROVIDER,legacy.canTakeCharges(account)?1:0,account.livemode?1:0,name,at]);return describe(database,workspaceId);}

async function disconnect(database,ctx,options={}){const row=await rowFor(database,ctx.workspaceId);
  if(!row)throw new NotFoundError('No Stripe account is connected to this inventory.');const held=legacy.platform();
  let releasedAtStripe=false;if(held.clientId&&held.secretKey){try{const release=options.deauthorize||((accountId)=>legacy.post(
      DEAUTHORIZE,{client_id:held.clientId,stripe_user_id:accountId},held.secretKey));await release(row.provider_account_id);
    releasedAtStripe=true;}catch{releasedAtStripe=false;}}
  await database.transaction(async(client)=>{await client.query('DELETE FROM payment_connect_accounts WHERE workspace_id=$1 AND provider=$2',
      [ctx.workspaceId,PROVIDER]);if(row.connector_id)await client.query(`UPDATE workspace_connectors
      SET status='disconnected',setup_status='DISCONNECTED',paused_at=$3,updated_at=$3 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,row.connector_id,nowIso()]);},{isolation:'SERIALIZABLE',retrySafe:true});
  return {disconnected:true,releasedAtStripe};}

module.exports={PROVIDER,STATE_PROVIDER,rowFor,describe,begin,complete,refresh,disconnect};
