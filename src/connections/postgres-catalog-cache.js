'use strict';
const {newId,nowIso,requireText}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const {exclusion}=require('./catalog-record-policy');

// Caller owns the connector lock and transaction. One bounded provider page
// shares lookup/write round trips; identity ambiguity is still checked for
// each source record, including matches beyond the current provider page.
async function cacheRecords(client,connection,records){
 if(!records.length)return [];
 if(records.length>500)throw new ValidationError('Provider catalogue pages must contain at most 500 records.');
 const seen=new Set(),at=nowIso(),w=connection.workspace_id,c=connection.id;
 const rows=records.map(record=>{
  const entity_type=requireText(record.entityType,'Provider record type',{max:40});
  if(!['sku','location'].includes(entity_type))throw new ValidationError(`Provider discovery returned unsupported ${entity_type} data.`);
  const external_id=requireText(record.externalId,'Provider record id',{max:240}),key=entity_type+':'+external_id;
  if(seen.has(key))throw new ValidationError('The provider page contains a duplicate catalogue identity.');seen.add(key);
  const data=record.providerData&&typeof record.providerData==='object'&&!Array.isArray(record.providerData)?record.providerData:{};
  return {id:newId('cext'),entity_type,external_id,parent_external_id:record.parentExternalId?String(record.parentExternalId):null,
   code:record.code?String(record.code):null,display_name:requireText(record.displayName||record.code||external_id,'Provider record name',{max:500}),
   provider_data:data,excluded:Boolean(exclusion(data)),barcode:data.barcode?String(data.barcode):null,
   item_name:String(data.itemName||'').trim(),variant_name:String(data.variationName||'').trim()};
 });
 const resolved=(await client.query(`WITH input AS MATERIALIZED(SELECT * FROM jsonb_to_recordset($3::jsonb)
  r(entity_type text,external_id text,code text,display_name text,excluded boolean,barcode text,item_name text,variant_name text))
  SELECT r.entity_type,r.external_id,m.foundry_record_id AS existing_id,e.mapping_status,
   COALESCE(m.foundry_record_id,match.id) AS target_id
  FROM input r LEFT JOIN connection_mappings m ON m.workspace_id=$1 AND m.connector_id=$2 AND m.entity_type=r.entity_type AND m.external_id=r.external_id
  LEFT JOIN connection_external_records e ON e.workspace_id=$1 AND e.connector_id=$2 AND e.entity_type=r.entity_type AND e.external_id=r.external_id
  LEFT JOIN LATERAL(
   SELECT COALESCE(code.id,barcode.id,name.id,location.id) AS id FROM (SELECT 1) seed
   LEFT JOIN LATERAL(SELECT min(id) AS id FROM(SELECT s.id FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE r.entity_type='sku' AND r.code IS NOT NULL AND s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND lower(s.code)=lower(r.code) LIMIT 2) candidates HAVING count(*)=1)code ON true
   LEFT JOIN LATERAL(SELECT min(id) AS id FROM(SELECT s.id FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE code.id IS NULL AND r.entity_type='sku' AND r.barcode IS NOT NULL AND s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND lower(s.barcode)=lower(r.barcode) LIMIT 2) candidates HAVING count(*)=1)barcode ON true
   LEFT JOIN LATERAL(SELECT min(id) AS id FROM(SELECT s.id FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id
    WHERE code.id IS NULL AND barcode.id IS NULL AND r.entity_type='sku' AND r.item_name<>'' AND i.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
     AND lower(i.name)=lower(r.item_name) AND lower(COALESCE(s.variant_label,''))=lower(r.variant_name) LIMIT 2) candidates HAVING count(*)=1)name ON true
   LEFT JOIN LATERAL(SELECT min(id) AS id FROM(SELECT id FROM locations WHERE r.entity_type='location' AND workspace_id=$1 AND is_active=1 AND lower(name)=lower(r.display_name) LIMIT 2) candidates HAVING count(*)=1)location ON true
   WHERE m.foundry_record_id IS NULL AND NOT r.excluded AND COALESCE(e.mapping_status,'')<>'IGNORED'
  )match ON true`,[w,c,JSON.stringify(rows)])).rows;
 const byKey=new Map(resolved.map(r=>[r.entity_type+':'+r.external_id,r]));
 for(const row of rows){const result=byKey.get(row.entity_type+':'+row.external_id);row.target_id=result.target_id;row.existing_id=result.existing_id;
  row.mapping_status=row.target_id?'MAPPED':result.mapping_status==='IGNORED'?'IGNORED':row.excluded?'EXCLUDED':'UNMAPPED';
 }
 await client.query(`INSERT INTO connection_external_records(id,workspace_id,connector_id,entity_type,external_id,parent_external_id,code,display_name,provider_data,mapping_status,selected,last_seen_at,created_at,updated_at)
  SELECT r.id,$1,$2,r.entity_type,r.external_id,r.parent_external_id,r.code,r.display_name,r.provider_data::text,r.mapping_status,1,$4,$4,$4
  FROM jsonb_to_recordset($3::jsonb)r(id text,entity_type text,external_id text,parent_external_id text,code text,display_name text,provider_data jsonb,mapping_status text)
  ON CONFLICT(workspace_id,connector_id,entity_type,external_id) DO UPDATE SET parent_external_id=EXCLUDED.parent_external_id,code=EXCLUDED.code,display_name=EXCLUDED.display_name,
   provider_data=EXCLUDED.provider_data,mapping_status=EXCLUDED.mapping_status,selected=1,last_seen_at=EXCLUDED.last_seen_at,updated_at=EXCLUDED.updated_at`,[w,c,JSON.stringify(rows),at]);
 const mappings=rows.filter(r=>r.target_id&&!r.existing_id).map(r=>({...r,id:newId('cmap')}));
 if(mappings.length)await client.query(`INSERT INTO connection_mappings(id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
  SELECT r.id,$1,$2,r.entity_type,r.external_id,r.target_id,'exact',$4,$5,$5 FROM jsonb_to_recordset($3::jsonb)r(id text,entity_type text,external_id text,target_id text)
  ON CONFLICT(workspace_id,connector_id,entity_type,external_id) DO NOTHING`,[w,c,JSON.stringify(mappings),connection.authorized_by_user_id||null,at]);
 const settled=rows.filter(r=>r.mapping_status!=='UNMAPPED');
 if(settled.length)await client.query(`UPDATE connection_issues issue SET status='RESOLVED',resolved_at=$4,updated_at=$4 FROM jsonb_to_recordset($3::jsonb)r(entity_type text,external_id text)
  WHERE issue.workspace_id=$1 AND issue.connector_id=$2 AND issue.status='OPEN'
   AND issue.fingerprint IN ('unknown-'||r.entity_type||':'||$2||':'||r.external_id,'UNKNOWN_'||upper(r.entity_type)||':'||$2||':'||r.external_id)`,[w,c,JSON.stringify(settled),at]);
 const unknown=rows.filter(r=>r.mapping_status==='UNMAPPED').map(r=>({...r,id:newId('conissue'),
  fingerprint:`unknown-${r.entity_type}:${c}:${r.external_id}`,title:`${r.display_name} needs a StockChief match`,
  detail:`${connection.display_name} supplied ${r.entity_type==='sku'?`SKU ${r.code||r.external_id}`:'this location'}, but StockChief cannot safely match it yet.`}));
 if(unknown.length)await client.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,issue_type,fingerprint,title,detail,resolution_hint,candidate_matches,status,created_at,updated_at)
  SELECT r.id,$1,$2,'UNKNOWN_'||upper(r.entity_type),r.fingerprint,r.title,r.detail,
   'Choose the matching StockChief record once. Future activity will use that mapping automatically.','[]','OPEN',$4,$4
  FROM jsonb_to_recordset($3::jsonb)r(id text,entity_type text,fingerprint text,title text,detail text)
  ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,title=EXCLUDED.title,detail=EXCLUDED.detail,resolution_hint=EXCLUDED.resolution_hint,updated_at=EXCLUDED.updated_at`,[w,c,JSON.stringify(unknown),at]);
 return rows.map(r=>r.target_id?'mapped':r.mapping_status==='UNMAPPED'?'unmapped':'ignored');
}
module.exports={cacheRecords};
