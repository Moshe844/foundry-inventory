'use strict';

const {newId,nowIso,requireText}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const providerService=require('./postgres-provider-service');
const defaultProviders=require('./providers/registry');


function scopedDatabase(client){return {query:(statement,values=[])=>client.query(statement,values),
  transaction:(operation,options)=>typeof client.transaction==='function'?client.transaction(operation,options):operation(client)};}

function providerData(record){
  return record.providerData&&typeof record.providerData==='object'&&!Array.isArray(record.providerData)
    ?record.providerData:{};
}

async function exactTarget(client,workspaceId,record){
  const data=providerData(record);
  if(record.entityType==='sku'){
    if(record.code){
      const byCode=await client.query(`SELECT id FROM skus WHERE workspace_id=$1 AND is_active=1
        AND lower(code)=lower($2) LIMIT 2`,[workspaceId,String(record.code)]);
      if(byCode.rows.length===1)return byCode.rows[0].id;
    }
    if(data.barcode){
      const byBarcode=await client.query(`SELECT id FROM skus WHERE workspace_id=$1 AND is_active=1
        AND lower(barcode)=lower($2) LIMIT 2`,[workspaceId,String(data.barcode)]);
      if(byBarcode.rows.length===1)return byBarcode.rows[0].id;
    }
    const itemName=String(data.itemName||'').trim();
    const variantName=String(data.variationName||'').trim();
    if(itemName){
      const byName=await client.query(`SELECT sku.id FROM skus sku JOIN items item ON item.id=sku.item_id
        WHERE sku.workspace_id=$1 AND sku.is_active=1 AND item.is_active=1 AND lower(item.name)=lower($2)
          AND lower(COALESCE(sku.variant_label,''))=lower($3) LIMIT 2`,[workspaceId,itemName,variantName]);
      if(byName.rows.length===1)return byName.rows[0].id;
    }
    return null;
  }
  if(record.entityType==='location'){
    const found=await client.query(`SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1
      AND lower(name)=lower($2) LIMIT 2`,[workspaceId,String(record.displayName||'')]);
    return found.rows.length===1?found.rows[0].id:null;
  }
  throw new ValidationError(`Provider discovery returned unsupported ${record.entityType||'record'} data.`);
}

async function resolveMappingIssues(client,connection,entityType,externalId,at){
  await client.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$5,updated_at=$5
    WHERE workspace_id=$1 AND connector_id=$2 AND status='OPEN' AND
      (fingerprint=$3 OR fingerprint=$4)`,[connection.workspace_id,connection.id,
    `unknown-${entityType}:${connection.id}:${externalId}`,
    `UNKNOWN_${entityType.toUpperCase()}:${connection.id}:${externalId}`,at]);
}

async function cacheRecord(client,connection,record){
  return (await require('./postgres-catalog-cache').cacheRecords(client,connection,[record]))[0];
}
async function sync(job,client,providers=defaultProviders){
  const connectorId=job.payload?.connectorId;
  if(!job.workspaceId||!connectorId)throw Object.assign(new Error('A provider catalogue sync needs workspace and connection identity.'),
    {code:'invalid_provider_catalog_sync',retryable:false});
  const connection=(await client.query(`SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2`,
    [job.workspaceId,connectorId])).rows[0];
  if(!connection)return {skipped:'connection_missing'};
  if(connection.status!=='connected'||connection.paused_at)return {skipped:'connection_not_active'};
  const syncConfig=require('./synchronization-policy').object(connection.config);
  if(syncConfig.syncDisabled===true)return {skipped:'synchronization_disabled'};
  if(Date.parse(syncConfig.syncRetryAt||'')>Date.now())return {skipped:'provider_backoff',retryAt:syncConfig.syncRetryAt};
  const adapter=providers.get(connection.provider_type);
  if(!adapter?.discover)throw Object.assign(new Error('This provider does not expose catalogue discovery.'),
    {code:'provider_discovery_unavailable',retryable:false});
  const database=scopedDatabase(client);
  const runId=newId('csync');const startedAt=nowIso();
  await client.query(`INSERT INTO connection_sync_runs(id,workspace_id,connector_id,sync_kind,status,started_at)
    VALUES($1,$2,$3,'CATALOG_AND_LOCATIONS','RUNNING',$4)`,[runId,job.workspaceId,connectorId,startedAt]);
  let previousScratch,discoveryScratch;
  try{
  discoveryScratch=require('../imports/validation-scratch').create();
  const discovered=discoveryScratch.map('discovered-products'),identities=discoveryScratch.map('discovered-identities');let productCount=0;
  const onProduct=record=>{const id=requireText(record.externalId,'Provider record id',{max:240}),hash=require('node:crypto').createHash('sha256').update(JSON.stringify(record)).digest('hex');
    if(identities.has(id)){if(identities.get(id)!==hash)throw new ValidationError('The provider returned conflicting catalogue pages for one identity. The saved catalogue was preserved.');return;}
    identities.set(id,hash);discovered.set(String(++productCount).padStart(16,'0'),record);
  };
  const found=await require('../commercial/operations').run(client,job.workspaceId,{capability:
    adapter.integrationClass==='accounting'?'connections.accounting':'connections.commerce',key:`catalog-sync:${job.id}`,
    provider:connection.provider_type,operation:'catalog_sync',retryReversed:true},async()=>{
      const credentials=await providerService.loadProviderCredentials(database,connection,adapter);
      return adapter.discover({credentials,connection,onProduct});});
  // Legacy adapters remain compatible; streaming adapters emit normalized
  // records as each provider page arrives and return an empty products array.
  if(!Array.isArray(found?.products)||!Array.isArray(found?.locations))throw new ValidationError('The provider did not return a complete catalogue and location snapshot. The saved catalogue was preserved.');
  for(const record of found.products)onProduct(record);
  const products={length:productCount,*[Symbol.iterator](){for(const [,record] of discovered)yield record;}};
  const locations=Array.isArray(found?.locations)?found.locations:[];
  const apply=async(client)=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`provider-sync:${connectorId}`]);
  const current=(await client.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
    [job.workspaceId,connectorId])).rows[0];
  if(!current||current.status!=='connected'||current.paused_at||new Date(current.updated_at).getTime()!==new Date(connection.updated_at).getTime()){
    await client.query(`UPDATE connection_sync_runs SET status='FAILED',completed_at=$2 WHERE id=$1`,[runId,nowIso()]);
    return {skipped:'connection_changed',runId};}
  await require('../commercial/enforcement').workspace(client,job.workspaceId,
    adapter.integrationClass==='accounting'?'connections.accounting':'connections.commerce');
  // Only reconciliation needs the old source values. Keep its exact baseline
  // on scratch disk and read database pages instead of duplicating the entire
  // provider catalogue in the worker heap.
  let previous=new Map();
  if(syncConfig.autoImportCatalog===true&&adapter.integrationClass!=='accounting'){
    previousScratch?.close();previousScratch=null;previousScratch=require('../imports/validation-scratch').create();previous=previousScratch.map('provider-previous');
    let after=null;
    for(;;){const rows=(await client.query(`SELECT external_id,provider_data FROM connection_external_records
      WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sku' AND ($3::text IS NULL OR external_id>$3)
      ORDER BY external_id LIMIT 500`,[job.workspaceId,connectorId,after])).rows;
      for(const row of rows)previous.set(row.external_id,require('./postgres-service').parseJson(row.provider_data,{}));
      if(rows.length<500)break;after=rows.at(-1).external_id;
    }
  }
  await client.query(`UPDATE connection_external_records SET selected=0,updated_at=$3
    WHERE workspace_id=$1 AND connector_id=$2`,[job.workspaceId,connectorId,nowIso()]);
  let autoMapped=0;let needsMapping=0;let ignored=0;
  async function applyPage(page){for(const result of await require('./postgres-catalog-cache').cacheRecords(client,connection,page)){
    if(result==='mapped')autoMapped+=1;else if(result==='unmapped')needsMapping+=1;else ignored+=1;
  }}
  for(const [records,entityType] of [[products,'sku'],[locations,'location']]){
    let page=[];for(const source of records){page.push({...source,entityType});if(page.length===500){await applyPage(page);page=[];}}
    if(page.length)await applyPage(page);
  }
  const reconciled=syncConfig.autoImportCatalog===true&&adapter.integrationClass!=='accounting'
    ?await require('./postgres-catalog-reconciliation').reconcile(client,current,previous):{names:0,prices:0,conflicts:0};
  const commerceReconciled=await require('./postgres-commerce-sync').reconcile(client,current);
  const completedAt=nowIso();
  await client.query(`UPDATE connection_issues issue SET status='RESOLVED',resolved_at=$3,updated_at=$3
    WHERE issue.workspace_id=$1 AND issue.connector_id=$2 AND issue.status='OPEN'
      AND issue.issue_type IN ('UNKNOWN_SKU','UNKNOWN_LOCATION')
      AND EXISTS(SELECT 1 FROM connection_mappings mapping
        WHERE mapping.workspace_id=issue.workspace_id AND mapping.connector_id=issue.connector_id
          AND (issue.fingerprint='unknown-'||mapping.entity_type||':'||mapping.connector_id||':'||mapping.external_id
            OR issue.fingerprint='UNKNOWN_'||upper(mapping.entity_type)||':'||mapping.connector_id||':'||mapping.external_id))`,
  [job.workspaceId,connectorId,completedAt]);
  await require('./postgres-webhook-inbox').scheduleMappedInTransaction(client,job.workspaceId,connectorId);
  await client.query(`UPDATE connection_sync_runs SET status='COMPLETED',discovered_products=$2,
    discovered_locations=$3,auto_mapped=$4,needs_mapping=$5,completed_at=$6 WHERE id=$1`,
  [runId,products.length,locations.length,autoMapped,needsMapping,completedAt]);
  await client.query(`UPDATE workspace_connectors SET status='connected',setup_status=$3,last_synced_at=$4,
    last_error=NULL,config=jsonb_set(config::jsonb-'syncRetryAt'-'syncFailureCount','{syncCadenceStartedAt}',to_jsonb($5::text),true)::text,
    updated_at=$4 WHERE workspace_id=$1 AND id=$2`,
  [job.workspaceId,connectorId,adapter.integrationClass==='accounting'?connection.setup_status:needsMapping?'MAPPING':'CONNECTED',completedAt,startedAt]);
  await client.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3
    WHERE workspace_id=$1 AND connector_id=$2 AND status='OPEN'
      AND issue_type IN ('PROVIDER_REFRESH_REQUIRED','CONNECTION_SYNC_FAILED')`,
  [job.workspaceId,connectorId,completedAt]);
  return {runId,products:products.length,locations:locations.length,autoMapped,needsMapping,ignored,completedAt,reconciled,commerceReconciled};
  };
  const result=await database.transaction(apply,{isolation:'SERIALIZABLE',retrySafe:true});
  if(!result.skipped)await require('./postgres-webhook-inbox').reconcileCancellationObservations(database,connection,adapter);
  if(!result.skipped)result.returnReviews=await require('./postgres-return-review').reconcile(database,job.workspaceId,{connectorId});
  if(!result.skipped&&syncConfig.autoImportCatalog===true&&adapter.integrationClass!=='accounting'){
    try{
      result.imported=await require('./postgres-catalog-import').importAutomatic(database,
        {workspaceId:job.workspaceId,actorId:connection.authorized_by_user_id},connectorId);
      await client.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3
        WHERE workspace_id=$1 AND connector_id=$2 AND fingerprint=$4 AND status='OPEN'`,
      [job.workspaceId,connectorId,nowIso(),`catalogue-import:${connectorId}`]);
    }catch(error){
      result.importNeedsReview=true;
      const at=nowIso();await client.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,issue_type,fingerprint,title,detail,
        resolution_hint,status,created_at,updated_at) VALUES($1,$2,$3,'CATALOG_IMPORT_REVIEW',$4,$5,$6,$7,'OPEN',$8,$8)
        ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,updated_at=EXCLUDED.updated_at`,
      [newId('conissue'),job.workspaceId,connectorId,`catalogue-import:${connectorId}`,'Review newly discovered products',
        'The provider was checked, but some new records could not be imported safely. Completed imports are preserved.',
        'Open the connection to review its product and location matches before importing the remaining records.',at]);
    }
  }
  return result;
  }catch(error){
    const failureCount=Math.min(8,Number(syncConfig.syncFailureCount||0)+1);
    const delay=Math.max(Number.isFinite(error.retryAfterMs)?error.retryAfterMs:0,
      Math.min(60*60_000,60_000*2**(failureCount-1)));
    const at=nowIso(),retryAt=new Date(Date.now()+delay).toISOString();
    await database.transaction(async queryable=>{
      await queryable.query(`UPDATE connection_sync_runs SET status='FAILED',completed_at=$2 WHERE id=$1`,[runId,at]);
      await queryable.query(`UPDATE workspace_connectors SET
        config=(config::jsonb||$3::jsonb)::text,last_error=$4,updated_at=$5
        WHERE workspace_id=$1 AND id=$2 AND status='connected' AND paused_at IS NULL`,
      [job.workspaceId,connectorId,JSON.stringify({syncRetryAt:retryAt,syncFailureCount:failureCount}),
        error.status===429?'The provider asked StockChief to wait. Updates will retry automatically.':
          'The latest provider check did not finish. Your saved records are preserved; StockChief will retry automatically.',at]);
    },{isolation:'SERIALIZABLE',retrySafe:true});
    error.retryAfterMs=delay;throw error;
  }finally{try{previousScratch?.close();}finally{discoveryScratch?.close();}}
}

async function setMappingInTransaction(client,ctx,input){
  const entityType=requireText(input.entityType,'Mapped record type',{max:40});
  const externalId=requireText(input.externalId,'External record id',{max:240});
  const targetId=requireText(input.foundryRecordId,'StockChief record',{max:240});
  const targetTables={sku:'skus',location:'locations',customer:'customers',sales_order:'sales_orders',supplier:'suppliers'};
  const targetTable=targetTables[entityType];
  if(!targetTable)throw new ValidationError('That external record type cannot be mapped.');
  const connection=(await client.query(`SELECT * FROM workspace_connectors
    WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,input.connectorId])).rows[0];
  if(!connection)throw new ValidationError('That connection is not in this inventory.');
  await require('../commercial/enforcement').workspace(client,ctx.workspaceId,
    ['custom','erp','custom_api'].includes(connection.provider_type)?'connections.custom_api':
      ['quickbooks','xero'].includes(connection.provider_type)?'connections.accounting':'connections.commerce');
  const target=(await client.query(`SELECT id FROM ${targetTable} WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,targetId])).rows[0];
  if(!target)throw new ValidationError('The selected StockChief record is not in this inventory.');
  const current=(await client.query(`SELECT * FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2
    AND entity_type=$3 AND external_id=$4 FOR UPDATE`,[ctx.workspaceId,connection.id,entityType,externalId])).rows[0];
  if(input.expectedFoundryRecordId && current?.foundry_record_id!==input.expectedFoundryRecordId
    && current?.foundry_record_id!==targetId){
    throw new ValidationError('That external match changed after the repair was prepared. Diagnose it again before changing anything.');
  }
  const at=nowIso();
  if(current){
    await client.query(`UPDATE connection_mappings SET catalog_sync_state=CASE WHEN foundry_record_id<>$5 THEN '{}' ELSE catalog_sync_state END,foundry_record_id=$5,confidence='approved',
      approved_by_user_id=$6,updated_at=$7 WHERE workspace_id=$1 AND connector_id=$2 AND entity_type=$3 AND external_id=$4`,
    [ctx.workspaceId,connection.id,entityType,externalId,targetId,ctx.actorId,at]);
  }else{
    await client.query(`INSERT INTO connection_mappings
      (id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'approved',$7,$8,$8)`,
    [newId('cmap'),ctx.workspaceId,connection.id,entityType,externalId,targetId,ctx.actorId,at]);
  }
  await client.query(`UPDATE connection_external_records SET mapping_status='MAPPED',updated_at=$5
    WHERE workspace_id=$1 AND connector_id=$2 AND entity_type=$3 AND external_id=$4`,
  [ctx.workspaceId,connection.id,entityType,externalId,at]);
  await resolveMappingIssues(client,connection,entityType,externalId,at);
  await require('./postgres-webhook-inbox').scheduleMappedInTransaction(client,ctx.workspaceId,connection.id);
  const remaining=(await client.query(`SELECT 1 FROM connection_external_records
    WHERE workspace_id=$1 AND connector_id=$2 AND selected=1 AND mapping_status='UNMAPPED' LIMIT 1`,
  [ctx.workspaceId,connection.id])).rows.length;
  if(!remaining&&defaultProviders.get(connection.provider_type)?.integrationClass!=='accounting')await client.query(`UPDATE workspace_connectors SET setup_status='CONNECTED',updated_at=$3
    WHERE workspace_id=$1 AND id=$2 AND status='connected'`,[ctx.workspaceId,connection.id,at]);
  return (await client.query(`SELECT * FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2
    AND entity_type=$3 AND external_id=$4`,[ctx.workspaceId,connection.id,entityType,externalId])).rows[0];
}

async function setMapping(database,ctx,input){
  return database.transaction(client=>setMappingInTransaction(client,ctx,input),{isolation:'SERIALIZABLE',retrySafe:true});
}

module.exports={sync,cacheRecord,exactTarget,setMapping,setMappingInTransaction,resolveMappingIssues};
