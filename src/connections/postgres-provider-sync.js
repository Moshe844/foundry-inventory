'use strict';

const {newId,nowIso,requireText}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const providerService=require('./postgres-provider-service');
const defaultProviders=require('./providers/registry');

function scopedDatabase(client){return {query:(statement,values=[])=>client.query(statement,values),
  transaction:(operation)=>operation(client)};}

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
  const entityType=requireText(record.entityType,'Provider record type',{max:40});
  if(!['sku','location'].includes(entityType))throw new ValidationError(`Provider discovery returned unsupported ${entityType} data.`);
  const externalId=requireText(record.externalId,'Provider record id',{max:240});
  const displayName=requireText(record.displayName||record.code||externalId,'Provider record name',{max:500});
  const existing=(await client.query(`SELECT foundry_record_id FROM connection_mappings
    WHERE workspace_id=$1 AND connector_id=$2 AND entity_type=$3 AND external_id=$4`,
  [connection.workspace_id,connection.id,entityType,externalId])).rows[0];
  const target=existing?.foundry_record_id||await exactTarget(client,connection.workspace_id,{...record,entityType});
  const at=nowIso();
  await client.query(`INSERT INTO connection_external_records
    (id,workspace_id,connector_id,entity_type,external_id,parent_external_id,code,display_name,
     provider_data,mapping_status,selected,last_seen_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$11,$11)
    ON CONFLICT(workspace_id,connector_id,entity_type,external_id) DO UPDATE SET
      parent_external_id=EXCLUDED.parent_external_id,code=EXCLUDED.code,display_name=EXCLUDED.display_name,
      provider_data=EXCLUDED.provider_data,mapping_status=CASE
        WHEN connection_external_records.mapping_status='IGNORED' AND EXCLUDED.mapping_status='UNMAPPED' THEN 'IGNORED'
        ELSE EXCLUDED.mapping_status END,selected=1,last_seen_at=EXCLUDED.last_seen_at,updated_at=EXCLUDED.updated_at`,
  [newId('cext'),connection.workspace_id,connection.id,entityType,externalId,
    record.parentExternalId?String(record.parentExternalId):null,record.code?String(record.code):null,displayName,
    JSON.stringify(providerData(record)),target?'MAPPED':'UNMAPPED',at]);
  if(target){
    if(!existing)await client.query(`INSERT INTO connection_mappings
      (id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'exact',$7,$8,$8)
      ON CONFLICT(workspace_id,connector_id,entity_type,external_id) DO NOTHING`,
    [newId('cmap'),connection.workspace_id,connection.id,entityType,externalId,target,
      connection.authorized_by_user_id||null,at]);
    await resolveMappingIssues(client,connection,entityType,externalId,at);
    return 'mapped';
  }
  const cached=(await client.query(`SELECT mapping_status FROM connection_external_records
    WHERE workspace_id=$1 AND connector_id=$2 AND entity_type=$3 AND external_id=$4`,
  [connection.workspace_id,connection.id,entityType,externalId])).rows[0];
  if(cached?.mapping_status==='IGNORED'){
    await resolveMappingIssues(client,connection,entityType,externalId,at);
    return 'ignored';
  }
  const fingerprint=`unknown-${entityType}:${connection.id}:${externalId}`;
  await client.query(`INSERT INTO connection_issues
    (id,workspace_id,connector_id,issue_type,fingerprint,title,detail,resolution_hint,candidate_matches,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'[]','OPEN',$9,$9)
    ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,title=EXCLUDED.title,
      detail=EXCLUDED.detail,resolution_hint=EXCLUDED.resolution_hint,updated_at=EXCLUDED.updated_at`,
  [newId('conissue'),connection.workspace_id,connection.id,`UNKNOWN_${entityType.toUpperCase()}`,fingerprint,
    `${displayName} needs a StockChief match`,
    `${connection.display_name} supplied ${entityType==='sku'?`SKU ${record.code||externalId}`:'this location'}, but StockChief cannot safely match it yet.`,
    'Choose the matching StockChief record once. Future activity will use that mapping automatically.',at]);
  return 'unmapped';
}

async function sync(job,client,providers=defaultProviders){
  const connectorId=job.payload?.connectorId;
  if(!job.workspaceId||!connectorId)throw Object.assign(new Error('A provider catalogue sync needs workspace and connection identity.'),
    {code:'invalid_provider_catalog_sync',retryable:false});
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`provider-sync:${connectorId}`]);
  const connection=(await client.query(`SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [job.workspaceId,connectorId])).rows[0];
  if(!connection)return {skipped:'connection_missing'};
  if(connection.status!=='connected'||connection.paused_at)return {skipped:'connection_not_active'};
  const adapter=providers.get(connection.provider_type);
  if(!adapter?.discover)throw Object.assign(new Error('This provider does not expose catalogue discovery.'),
    {code:'provider_discovery_unavailable',retryable:false});
  const database=scopedDatabase(client);
  const credentials=await providerService.loadProviderCredentials(database,connection,adapter);
  const runId=newId('csync');const startedAt=nowIso();
  await client.query(`INSERT INTO connection_sync_runs(id,workspace_id,connector_id,sync_kind,status,started_at)
    VALUES($1,$2,$3,'CATALOG_AND_LOCATIONS','RUNNING',$4)`,[runId,job.workspaceId,connectorId,startedAt]);
  const found=await adapter.discover({credentials,connection});
  const products=Array.isArray(found?.products)?found.products:[];
  const locations=Array.isArray(found?.locations)?found.locations:[];
  await client.query(`UPDATE connection_external_records SET selected=0,updated_at=$3
    WHERE workspace_id=$1 AND connector_id=$2`,[job.workspaceId,connectorId,nowIso()]);
  let autoMapped=0;let needsMapping=0;let ignored=0;
  for(const record of [...products.map((row)=>({...row,entityType:'sku'})),
    ...locations.map((row)=>({...row,entityType:'location'}))]){
    const result=await cacheRecord(client,connection,record);
    if(result==='mapped')autoMapped+=1;
    else if(result==='unmapped')needsMapping+=1;
    else ignored+=1;
  }
  const completedAt=nowIso();
  await client.query(`UPDATE connection_issues issue SET status='RESOLVED',resolved_at=$3,updated_at=$3
    WHERE issue.workspace_id=$1 AND issue.connector_id=$2 AND issue.status='OPEN'
      AND issue.issue_type IN ('UNKNOWN_SKU','UNKNOWN_LOCATION')
      AND NOT EXISTS(SELECT 1 FROM connection_external_records external
        WHERE external.workspace_id=issue.workspace_id AND external.connector_id=issue.connector_id
          AND external.selected=1 AND external.mapping_status='UNMAPPED'
          AND issue.fingerprint='unknown-'||external.entity_type||':'||external.connector_id||':'||external.external_id)`,
  [job.workspaceId,connectorId,completedAt]);
  await client.query(`UPDATE connection_sync_runs SET status='COMPLETED',discovered_products=$2,
    discovered_locations=$3,auto_mapped=$4,needs_mapping=$5,completed_at=$6 WHERE id=$1`,
  [runId,products.length,locations.length,autoMapped,needsMapping,completedAt]);
  await client.query(`UPDATE workspace_connectors SET status='connected',setup_status=$3,last_synced_at=$4,
    last_error=NULL,updated_at=$4 WHERE workspace_id=$1 AND id=$2`,
  [job.workspaceId,connectorId,needsMapping?'MAPPING':'CONNECTED',completedAt]);
  await client.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3
    WHERE workspace_id=$1 AND connector_id=$2 AND status='OPEN'
      AND issue_type IN ('PROVIDER_REFRESH_REQUIRED','CONNECTION_SYNC_FAILED')`,
  [job.workspaceId,connectorId,completedAt]);
  return {runId,products:products.length,locations:locations.length,autoMapped,needsMapping,ignored,completedAt};
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
    await client.query(`UPDATE connection_mappings SET foundry_record_id=$5,confidence='approved',
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
  const remaining=(await client.query(`SELECT COUNT(*) AS count FROM connection_external_records
    WHERE workspace_id=$1 AND connector_id=$2 AND selected=1 AND mapping_status='UNMAPPED'`,
  [ctx.workspaceId,connection.id])).rows[0];
  if(Number(remaining.count)===0)await client.query(`UPDATE workspace_connectors SET setup_status='CONNECTED',updated_at=$3
    WHERE workspace_id=$1 AND id=$2 AND status='connected'`,[ctx.workspaceId,connection.id,at]);
  return (await client.query(`SELECT * FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2
    AND entity_type=$3 AND external_id=$4`,[ctx.workspaceId,connection.id,entityType,externalId])).rows[0];
}

async function setMapping(database,ctx,input){
  return database.transaction(client=>setMappingInTransaction(client,ctx,input),{isolation:'SERIALIZABLE',retrySafe:true});
}

module.exports={sync,cacheRecord,exactTarget,setMapping,setMappingInTransaction};
