'use strict';

const crypto=require('node:crypto');
const entitlements=require('../entitlements/postgres-service');
const commercial=require('../commercial/service');
const { AuthenticationError,NotFoundError,ValidationError }=require('../domain/errors');
const { newId,nowIso,requireText }=require('../lib/util');
const credentials=require('./postgres-credential-store');
const catalogueIssues=require('./catalogue-issues');

const TOKEN_PREFIX='fnd_live_';
const parseJson=(value,fallback)=>{
  if(value && typeof value==='object')return value;
  try{return JSON.parse(value)??fallback;}catch{return fallback;}
};
const hash=(value)=>crypto.createHash('sha256').update(String(value)).digest('hex');

function publicHealth(row,now=Date.now()){
  const reasons=[];
  if(row.status==='disconnected')reasons.push('DISCONNECTED');
  if(row.status==='error'||row.last_error)reasons.push('RECORDED_ERROR');
  if(row.paused_at)reasons.push('PAUSED');
  const optionalSetup=catalogueIssues.optionalForAccounting(row)?Number(row.catalogue_setup_issues||0):0;
  if(Number(row.open_issues)>optionalSetup)reasons.push('OPEN_ISSUES');
  const evidence=Math.max(...[row.last_activity_at,row.last_synced_at,row.created_at]
    .map(value=>Date.parse(value||'')).filter(Number.isFinite));
  const expectedMinutes=Number(row.expected_interval_minutes),grace=['gmail','microsoft365'].includes(row.provider_type)?2:1;
  const effectiveMinutes=require('./synchronization-policy').describe(row,null,now).effectiveMinutes;
  if(!row.paused_at&&Number.isFinite(evidence)&&expectedMinutes>0&&evidence+effectiveMinutes*Math.max(2,grace)*60000<now)reasons.push('ACTIVITY_OVERDUE');
  return {status:row.status==='disconnected'?'Disconnected':row.paused_at?
    (parseJson(row.config,{}).syncDisabled===true?'Sync off':'Paused'):reasons.length?'Needs attention':'Connected',
    reasons,lastRecordedActivityAt:Number.isFinite(evidence)?new Date(evidence).toISOString():null,
    expectedIntervalMinutes:Number.isFinite(expectedMinutes)?expectedMinutes:null,activityGraceMultiplier:grace};
}
function publicStatus(row,now=Date.now()){return publicHealth(row,now).status;}

function hydrate(row,now){
  if(!row)return null;
  return {...row,capabilities:parseJson(row.capabilities,[]),provides:parseJson(row.provides,[]),
    config:parseJson(row.config,{}),openIssues:Number(row.open_issues||0),
    catalogueSetupOptional:catalogueIssues.optionalForAccounting(row),catalogueSetupIssues:Number(row.catalogue_setup_issues||0),
    actionableIssues:Math.max(0,Number(row.open_issues||0)-(catalogueIssues.optionalForAccounting(row)?Number(row.catalogue_setup_issues||0):0)),
    unmatchedProducts:Number(row.unmapped_skus||0),unmatchedLocations:Number(row.unmapped_locations||0),
    productsMapped:Number(row.products_mapped||0),locationsMapped:Number(row.locations_mapped||0),
    itemsNeedingMapping:Number(row.items_needing_mapping||0),publicStatus:publicStatus(row,now),
    synchronization:require('./synchronization-policy').describe(row,require('./providers/registry').get(row.provider_type),now)};
}

const SELECT=`SELECT connector.*,
  (SELECT (v.configuration->>'syncIntervalSeconds')::integer FROM workspaces w JOIN account_subscriptions s ON s.account_id=w.owner_account_id JOIN commercial_plan_versions v ON v.id=s.plan_version_id AND v.plan_id=s.plan_id WHERE w.id=connector.workspace_id) AS plan_sync_seconds,
  (SELECT COUNT(*) FROM connection_issues issue WHERE issue.workspace_id=connector.workspace_id
    AND issue.connector_id=connector.id AND issue.status='OPEN') AS open_issues,
  (SELECT COUNT(*) FROM connection_issues issue WHERE issue.workspace_id=connector.workspace_id
    AND issue.connector_id=connector.id AND issue.status='OPEN' AND ${catalogueIssues.setupSql}) AS catalogue_setup_issues,
  (SELECT verified_at IS NOT NULL FROM accounting_sync_policies policy WHERE policy.workspace_id=connector.workspace_id
    AND policy.connector_id=connector.id) AS accounting_verified,
  (SELECT COUNT(*) FROM connection_external_records external WHERE external.workspace_id=connector.workspace_id
    AND external.connector_id=connector.id AND external.selected=1 AND external.mapping_status='UNMAPPED' AND external.entity_type='sku') AS unmapped_skus,
  (SELECT COUNT(*) FROM connection_external_records external WHERE external.workspace_id=connector.workspace_id
    AND external.connector_id=connector.id AND external.selected=1 AND external.mapping_status='UNMAPPED' AND external.entity_type='location') AS unmapped_locations,
  (SELECT COUNT(*) FROM connection_mappings mapping WHERE mapping.workspace_id=connector.workspace_id
    AND mapping.connector_id=connector.id AND mapping.entity_type='sku') AS products_mapped,
  (SELECT COUNT(*) FROM connection_mappings mapping WHERE mapping.workspace_id=connector.workspace_id
    AND mapping.connector_id=connector.id AND mapping.entity_type='location') AS locations_mapped,
  (SELECT COUNT(*) FROM connection_external_records external WHERE external.workspace_id=connector.workspace_id
    AND external.connector_id=connector.id AND external.selected=1 AND external.mapping_status='UNMAPPED') AS items_needing_mapping
  FROM workspace_connectors connector`;

async function list(database,workspaceId,options={}){
  const result=await database.query(`${SELECT} WHERE connector.workspace_id=$1
    AND (connector.first_connected_at IS NOT NULL OR connector.status='connected')
    ORDER BY CASE connector.status WHEN 'connected' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,
      connector.updated_at DESC,LOWER(connector.display_name)`,[workspaceId]);
  return result.rows.map((row)=>hydrate(row,options.now));
}

async function get(database,workspaceId,connectorId){
  const result=await database.query(`${SELECT} WHERE connector.workspace_id=$1 AND connector.id=$2`,
    [workspaceId,connectorId]);
  if(!result.rows.length)throw new NotFoundError('Connection not found.');
  return hydrate(result.rows[0]);
}

async function disconnect(database,workspaceId,connectorId){
  const preview=(await database.query('SELECT provider_type,provider_account_id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',
    [workspaceId,connectorId])).rows[0];
  if(!preview)throw new NotFoundError('Connection not found.');
  if(preview.provider_type==='xero')
    return require('./xero-token-lifecycle').run(database,require('../config').connections.xero.clientId||'unconfigured',
      db=>disconnectLocked(db,workspaceId,connectorId,preview));
  if(preview.provider_type==='quickbooks'&&preview.provider_account_id)
    return require('./quickbooks-token-lifecycle').run(database,require('../config').connections.quickbooks.clientId||'unconfigured',preview.provider_account_id,
      db=>disconnectLocked(db,workspaceId,connectorId,preview));
  return disconnectLocked(database,workspaceId,connectorId,preview);
}
async function disconnectLocked(database,workspaceId,connectorId,preview){
  let providerAuthorizationRevoked=null;
  await database.transaction(async(client)=>{
    const found=await client.query('SELECT id,provider_type,provider_account_id,status FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [workspaceId,connectorId]);
    if(!found.rows.length)throw new NotFoundError('Connection not found.');
    const current=found.rows[0];
    if(['quickbooks','xero'].includes(preview.provider_type)){
      if(current.provider_type!==preview.provider_type||current.provider_account_id!==preview.provider_account_id)
        throw new ValidationError('This accounting connection changed. Refresh the page and review it before disconnecting.');
      const grant=await credentials.get(client,workspaceId,connectorId,'provider');
      if(grant){
        providerAuthorizationRevoked=false;
        const shared=current.provider_account_id&&(await client.query(`SELECT 1 FROM workspace_connectors
          WHERE provider_type=$3 AND provider_account_id=$1 AND status='connected' AND id<>$2 LIMIT 1`,
          [current.provider_account_id,connectorId,preview.provider_type])).rowCount;
        if(current.provider_account_id&&!shared){
          // Local access stops even when the provider is unavailable. No token is
          // logged and an uncertain revocation is never retried automatically.
          try{providerAuthorizationRevoked=await require('./providers/registry').get(preview.provider_type).revokeAuthorization(grant)===true;}catch{}
        }
      }
    }
    const now=nowIso();
    await client.query(`UPDATE workspace_connectors SET status='disconnected',paused_at=$3,credential_ref=NULL,
      setup_status='DISCONNECTED',updated_at=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,connectorId,now]);
    await client.query(`UPDATE connector_feed_tokens SET revoked_at=$3
      WHERE workspace_id=$1 AND connector_id=$2 AND revoked_at IS NULL`,[workspaceId,connectorId,now]);
    await credentials.remove(client,workspaceId,connectorId);
    await client.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3
      WHERE workspace_id=$1 AND connector_id=$2 AND status='OPEN'`,[workspaceId,connectorId,now]);
  },{isolation:'SERIALIZABLE',retrySafe:!['quickbooks','xero'].includes(preview.provider_type)});
  const disconnected=await get(database,workspaceId,connectorId);
  if(['quickbooks','xero'].includes(preview.provider_type))disconnected.providerAuthorizationRevoked=providerAuthorizationRevoked;
  return disconnected;
}

async function pause(database,workspaceId,connectorId){
  const result=await database.query(`UPDATE workspace_connectors SET paused_at=$3,updated_at=$3
    WHERE workspace_id=$1 AND id=$2 RETURNING id`,[workspaceId,connectorId,nowIso()]);
  if(!result.rows.length)throw new NotFoundError('Connection not found.');
  return get(database,workspaceId,connectorId);
}

async function resume(database,workspaceId,connectorId){
  const result=await database.query(`UPDATE workspace_connectors SET paused_at=NULL,
    config=jsonb_set(config::jsonb,'{syncDisabled}','false'::jsonb,true)::text,
    status=CASE WHEN credential_ref IS NULL THEN 'disconnected' ELSE 'connected' END,updated_at=$3
    WHERE workspace_id=$1 AND id=$2 RETURNING id`,[workspaceId,connectorId,nowIso()]);
  if(!result.rows.length)throw new NotFoundError('Connection not found.');
  return get(database,workspaceId,connectorId);
}

async function createFeed(database,ctx,input={}){
  const displayName=requireText(input.displayName||'Custom event connection','Connection name',{max:100});
  const connectorId=newId('con');
  const tokenId=newId('ctok');
  const prefix=crypto.randomBytes(6).toString('hex');
  const token=`${TOKEN_PREFIX}${prefix}.${crypto.randomBytes(32).toString('base64url')}`;
  const now=nowIso();
  await database.transaction(async(client)=>{
    const commercialScope=await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId);
    await entitlements.assertMeterCapacity(client,commercialScope,'connections',1);
    await client.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
       credential_ref,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'reference_webhook','connected',$5,$6,$7,$8,$9,'CONNECTED',$10,$11,$11)`,
    [connectorId,ctx.workspaceId,`reference_webhook:${connectorId}`,displayName,JSON.stringify(['events:ingest']),
      JSON.stringify(input.provides||['business events']),JSON.stringify(input.config||{}),
      `connector_feed_tokens:${tokenId}`,Math.max(0,Number(input.expectedIntervalMinutes)||360),ctx.actorId,now]);
    await client.query(`INSERT INTO connector_feed_tokens
      (id,workspace_id,connector_id,token_prefix,token_hash,created_by_user_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[tokenId,ctx.workspaceId,connectorId,prefix,hash(token),ctx.actorId,now]);
    await commercial.trackOnce(client,{eventName:'first_integration_connected',accountId:commercialScope.accountId,
      sourcePath:'custom_event_connection',detail:{providerType:'reference_webhook'}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
  return {connection:await get(database,ctx.workspaceId,connectorId),token,tokenPrefix:prefix};
}

async function authenticate(database,authorization){
  const match=/^Bearer\s+(.+)$/i.exec(String(authorization||'').trim());
  const token=match?.[1];
  if(!token||token.length>200||!token.startsWith(TOKEN_PREFIX))throw new AuthenticationError('A valid StockChief connection bearer token is required.');
  const prefix=token.slice(TOKEN_PREFIX.length).split('.')[0];
  return database.transaction(async(client)=>{
    const result=await client.query(`SELECT token.*,connector.status AS connector_status,connector.paused_at,
        connector.provider_type,connector.display_name,user_record.account_id,user_record.role,user_record.permissions,user_record.revoked_at AS member_revoked_at
      FROM connector_feed_tokens token
      JOIN workspace_connectors connector ON connector.id=token.connector_id AND connector.workspace_id=token.workspace_id
      JOIN users user_record ON user_record.id=token.created_by_user_id AND user_record.workspace_id=token.workspace_id
      WHERE token.token_prefix=$1 AND token.token_hash=$2 AND token.revoked_at IS NULL FOR UPDATE OF token`,
    [prefix,hash(token)]);
    const row=result.rows[0];
    if(!row||row.member_revoked_at||row.connector_status!=='connected')throw new AuthenticationError('That connection token is invalid or has been revoked.');
    require('../actions/permissions').assertCan(row,require('../actions/permissions').ADMIN,'use this custom connection token');
    await require('../operations/postgres-warehouse-access').assertInventoryWide(client,{workspaceId:row.workspace_id,actorId:row.created_by_user_id});
    await require('../commercial/enforcement').workspace(client,row.workspace_id,'connections.custom_api');
    if(row.paused_at)throw new AuthenticationError('This connection is paused. Resume it before sending more events.');
    await client.query('UPDATE connector_feed_tokens SET last_used_at=$2 WHERE id=$1',[row.id,nowIso()]);
    return {tokenId:row.id,connectorId:row.connector_id,workspaceId:row.workspace_id,
      actorId:row.created_by_user_id,accountId:row.account_id,providerType:row.provider_type,
      displayName:row.display_name};
  },{isolation:'READ COMMITTED'});
}

module.exports={publicHealth,TOKEN_PREFIX,parseJson,publicStatus,hydrate,list,get,disconnect,pause,resume,createFeed,authenticate};
require('../commercial/enforcement').guardExports(module.exports,0,1,{createFeed:'connections.custom_api',resume:'workspace.core'});
