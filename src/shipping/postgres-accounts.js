'use strict';

const { ValidationError,NotFoundError }=require('../domain/errors');
const { newId,nowIso,requireText }=require('../lib/util');
const credentials=require('../connections/postgres-credential-store');

const PROVIDERS=['shipengine','shipstation','easypost','shippo'];
const KEY_FIELD={shipengine:'shipengineApiKey',shipstation:'shipstationApiKey',
  easypost:'easypostApiKey',shippo:'shippoApiKey'};
const DISPLAY={shipengine:'ShipEngine',shipstation:'ShipStation',easypost:'EasyPost',shippo:'Shippo'};

function requireProvider(value){
  const provider=String(value||'').toLowerCase();
  if(!PROVIDERS.includes(provider))throw new ValidationError(`Choose ${PROVIDERS.join(', ')}.`);
  return provider;
}
function isTestKey(provider,key){
  if(provider==='easypost')return /^EZTK/i.test(String(key||''));
  if(provider==='shippo')return /^shippo_test_/i.test(String(key||''));
  return /^TEST_/i.test(String(key||''));
}

async function connectorFor(queryable,workspaceId){
  const result=await queryable.query(`SELECT * FROM workspace_connectors
    WHERE workspace_id=$1 AND provider_type=ANY($2::text[]) AND status='connected' AND paused_at IS NULL
    ORDER BY updated_at DESC LIMIT 1`,[workspaceId,PROVIDERS]);
  return result.rows[0]||null;
}

async function forWorkspace(database,workspaceId){
  const connector=await connectorFor(database,workspaceId);
  if(!connector)return null;
  const held=await credentials.get(database,workspaceId,connector.id,'provider')||{};
  if(!held.apiKey)return null;
  return {provider:connector.provider_type,source:'workspace',connectorId:connector.id,apiKey:held.apiKey,
    webhookSecret:held.webhookSecret||null,displayName:connector.display_name,testMode:isTestKey(connector.provider_type,held.apiKey)};
}

async function contextFor(database,ctx){
  const account=await forWorkspace(database,ctx.workspaceId);
  return account?{account,ctx:{...ctx,[KEY_FIELD[account.provider]]:account.apiKey}}:null;
}

async function connect(database,ctx,input={}){
  const provider=requireProvider(input.provider);
  const apiKey=requireText(input.apiKey,'API key',{max:400});
  const webhookSecret=String(input.webhookSecret||'').trim()||null;
  const now=nowIso();
  const connectorId=await database.transaction(async(client)=>{
    const actor=await client.query(`SELECT role FROM users WHERE id=$1 AND workspace_id=$2`,
      [ctx.actorId,ctx.workspaceId]);
    if(actor.rows[0]?.role!=='owner')throw new ValidationError('Only an owner can connect the postage account.');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`shipping-account:${ctx.workspaceId}`]);
    const existing=await client.query(`SELECT id FROM workspace_connectors
      WHERE workspace_id=$1 AND provider_type=$2 ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
    [ctx.workspaceId,provider]);
    const id=existing.rows[0]?.id||newId('con');
    if(existing.rows.length){
      await client.query(`UPDATE workspace_connectors SET status='connected',paused_at=NULL,
        setup_status='CONNECTED',last_error=NULL,credential_ref=$3,authorized_by_user_id=$4,updated_at=$5
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,`connection_credentials:${id}`,ctx.actorId,now]);
    }else{
      await client.query(`INSERT INTO workspace_connectors
        (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,
         credential_ref,setup_status,authorized_by_user_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'["shipping"]','{}','connected','["rates","labels","tracking"]',
          $6,'CONNECTED',$7,$8,$8)`,[id,ctx.workspaceId,`shipping-${provider}`,DISPLAY[provider],provider,
        `connection_credentials:${id}`,ctx.actorId,now]);
    }
    await credentials.put(client,ctx.workspaceId,id,'provider',{apiKey,webhookSecret});
    await client.query(`UPDATE workspace_connectors SET status='disconnected',paused_at=$3,updated_at=$3
      WHERE workspace_id=$1 AND provider_type=ANY($2::text[]) AND id<>$4 AND status='connected'`,
    [ctx.workspaceId,PROVIDERS,now,id]);
    return id;
  },{isolation:'SERIALIZABLE',retrySafe:true});
  return describe(database,ctx.workspaceId,connectorId);
}

async function disconnect(database,ctx){
  const connector=await connectorFor(database,ctx.workspaceId);
  if(!connector)throw new NotFoundError('No shipping account is connected to this inventory.');
  await database.transaction(async(client)=>{
    const actor=await client.query('SELECT role FROM users WHERE id=$1 AND workspace_id=$2',[ctx.actorId,ctx.workspaceId]);
    if(actor.rows[0]?.role!=='owner')throw new ValidationError('Only an owner can disconnect the postage account.');
    await credentials.remove(client,ctx.workspaceId,connector.id);
    await client.query(`UPDATE workspace_connectors SET status='disconnected',paused_at=$3,
      credential_ref=NULL,setup_status='DISCONNECTED',updated_at=$3 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,connector.id,nowIso()]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
  return describe(database,ctx.workspaceId);
}

async function describe(database,workspaceId){
  const account=await forWorkspace(database,workspaceId);
  if(!account)return {connected:false,provider:null,because:'No postage account is connected. Live rates and labels are unavailable.'};
  return {connected:true,provider:account.provider,providerName:DISPLAY[account.provider],source:account.source,
    testMode:account.testMode,keyEnding:String(account.apiKey).slice(-4),keyEndsWith:String(account.apiKey).slice(-4),
    hasWebhookSecret:Boolean(account.webhookSecret),connectorId:account.connectorId,
    because:account.testMode?'Sandbox account: rates and labels are test-only.':'This inventory uses its own postage account.'};
}

module.exports={PROVIDERS,KEY_FIELD,requireProvider,isTestKey,connectorFor,forWorkspace,contextFor,connect,disconnect,describe};
