'use strict';

const {AuthorizationError,NotFoundError,ValidationError}=require('../domain/errors');
const {nowIso,newId}=require('../lib/util');
const policy=require('./synchronization-policy');
const providers=require('./providers/registry');

async function configure(database,ctx,connectorId,input={},options={}){
  const minutes=policy.interval(input.minutes),disabled=input.disabled===true;
  return database.transaction(async client=>{
    const owner=(await client.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,ctx.actorId])).rows[0];
    if(owner?.role!=='owner')throw new AuthorizationError('Only the business owner can change synchronization.');
    const row=(await client.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ctx.workspaceId,connectorId])).rows[0];
    if(!row)throw new NotFoundError('Connection not found.');
    if(!policy.supports((options.providers||providers).get(row.provider_type)))
      throw new ValidationError('This connection receives events only; it has no scheduled check.');
    const config=policy.object(row.config),wasDisabled=config.syncDisabled===true;
    const before={minutes:Number(row.expected_interval_minutes),disabled:wasDisabled,autoImportCatalog:config.autoImportCatalog===true,
      autoImportOpeningStock:config.autoImportOpeningStock===true};
    const at=nowIso();
    config.syncDisabled=disabled;
    if(typeof input.autoImportCatalog==='boolean'){
      config.autoImportCatalog=input.autoImportCatalog;
      config.autoImportOpeningStock=input.autoImportCatalog;
    }
    config.synchronization={minutes,disabled,changedAt:at,changedBy:ctx.actorId};
    if(['gmail','microsoft365'].includes(row.provider_type))config.mailboxCheckMinutes=minutes;
    await client.query(`UPDATE workspace_connectors SET expected_interval_minutes=$3,config=$4,
      paused_at=CASE WHEN $5 THEN COALESCE(paused_at,$6) WHEN $7 THEN NULL ELSE paused_at END,
      updated_at=$6 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,connectorId,minutes,JSON.stringify(config),disabled,at,wasDisabled&&!disabled]);
    const eventId=newId('evt');
    await client.query(`INSERT INTO domain_events(id,workspace_id,event_type,payload,source,source_record_type,source_record_id,
      idempotency_key,status,result,created_at,processed_at) VALUES($1,$2,'connection.synchronization.updated',$3,
      'connection_settings','connection',$4,$1,'PROCESSED','{"verified":true}',$5,$5)`,
    [eventId,ctx.workspaceId,JSON.stringify({actorId:ctx.actorId,connectorId,before,
      after:{minutes,disabled,autoImportCatalog:config.autoImportCatalog===true,autoImportOpeningStock:config.autoImportOpeningStock===true}}),connectorId,at]);
    return {connectorId,minutes,disabled};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function state(database,workspaceId,connectorId,options={}){
  const connection=await require('./postgres-service').get(database,workspaceId,connectorId);
  const described=policy.describe(connection,(options.providers||providers).get(connection.provider_type));
  const active=(await database.query(`SELECT status,available_at FROM stockchief_runtime.jobs
    WHERE workspace_id=$1 AND payload->>'connectorId'=$2 AND kind IN ('provider.catalog-sync','mailbox.poll')
      AND status IN ('PENDING','RUNNING','RETRY') ORDER BY CASE status WHEN 'RUNNING' THEN 0 ELSE 1 END,available_at LIMIT 1`,
  [workspaceId,connectorId])).rows[0];
  return {...described,connectionId:connectorId,jobState:active?.status||null,
    queuedFor:active?new Date(Number(active.available_at)).toISOString():null,
    productsMapped:connection.productsMapped,locationsMapped:connection.locationsMapped,
    needsMapping:connection.itemsNeedingMapping};
}
module.exports={configure,state};
