'use strict';
const {ValidationError}=require('./errors'),{newId,nowIso}=require('../lib/util');
async function saveManyInTransaction(client,ctx,inputs){
 if(!inputs.length)return;
 const grouped=new Map();for(const input of inputs){const name=String(input.name??''),value=String(input.value);
  if(!name||name.length>240||value.length>10000||!input.importId||!Number.isSafeInteger(input.rowNumber)||input.rowNumber<0)throw new ValidationError('Imported details require a field name, supported value and exact source row.');
  const key=JSON.stringify([input.skuId,input.locationId||null,input.importId,input.rowNumber]);let row=grouped.get(key);
  if(!row){row={id:newId('fact'),sku_id:input.skuId,location_id:input.locationId||null,source_import_id:input.importId,source_row:input.rowNumber,attributes:Object.create(null)};grouped.set(key,row);}
  if(Object.hasOwn(row.attributes,name))throw new ValidationError('An imported source row contains the same detail more than once.');row.attributes[name]=value;
 }
 const rows=[...grouped.values()];
 for(let start=0;start<rows.length;start+=500){const batch=rows.slice(start,start+500),keys=JSON.stringify(batch),skus=[...new Set(batch.map(row=>row.sku_id))];
  const allowed=await client.query(`SELECT x.source_row FROM jsonb_to_recordset($2::jsonb) AS x(sku_id text,location_id text,source_import_id text,source_row bigint)
   JOIN skus s ON s.workspace_id=$1 AND s.id=x.sku_id AND s.id=ANY($3::text[])
   JOIN import_plans p ON p.workspace_id=$1 AND p.id=x.source_import_id
   WHERE x.location_id IS NULL OR EXISTS(SELECT 1 FROM locations l WHERE l.workspace_id=$1 AND l.id=x.location_id)`,[ctx.workspaceId,keys,skus]);
  if(allowed.rowCount!==batch.length)throw new ValidationError('Imported product details and their source must belong to this inventory.');
  const legacy=(await client.query(`SELECT f.id,f.sku_id,f.location_id,f.source_import_id,f.source_row,f.name FROM catalog_source_facts f
   JOIN jsonb_to_recordset($2::jsonb) AS x(sku_id text,location_id text,source_import_id text,source_row bigint)
    ON f.sku_id=x.sku_id AND f.location_id IS NOT DISTINCT FROM x.location_id AND f.source_import_id=x.source_import_id AND f.source_row=x.source_row
   WHERE f.workspace_id=$1 AND f.sku_id=ANY($3::text[]) AND f.attributes IS NULL`,[ctx.workspaceId,keys,skus])).rows,updates=[];
  const bySource=new Map(batch.map(row=>[JSON.stringify([row.sku_id,row.location_id,row.source_import_id,Number(row.source_row)]),row]));
  for(const field of legacy){const row=bySource.get(JSON.stringify([field.sku_id,field.location_id,field.source_import_id,Number(field.source_row)]));if(row&&Object.hasOwn(row.attributes,field.name)){updates.push({id:field.id,value:row.attributes[field.name]});delete row.attributes[field.name];}}
  if(updates.length){const changed=await client.query(`UPDATE catalog_source_facts f SET value=x.value,updated_at=$3 FROM jsonb_to_recordset($2::jsonb) AS x(id text,value text)
   WHERE f.workspace_id=$1 AND f.id=ANY($4::text[]) AND f.id=x.id AND f.attributes IS NULL`,[ctx.workspaceId,JSON.stringify(updates),nowIso(),updates.map(row=>row.id)]);if(changed.rowCount!==updates.length)throw new ValidationError('An imported source detail changed during this update.');}
  const documents=batch.filter(row=>Object.keys(row.attributes).length);if(!documents.length)continue;
  const saved=await client.query(`INSERT INTO catalog_source_facts(id,workspace_id,sku_id,location_id,attributes,source_import_id,source_row,updated_at)
   SELECT x.id,$1,x.sku_id,x.location_id,x.attributes,x.source_import_id,x.source_row,$3 FROM jsonb_to_recordset($2::jsonb) AS x(id text,sku_id text,location_id text,attributes jsonb,source_import_id text,source_row bigint)
   ON CONFLICT(workspace_id,sku_id,(COALESCE(location_id,'')),source_import_id,source_row) WHERE attributes IS NOT NULL
   DO UPDATE SET attributes=catalog_source_facts.attributes||EXCLUDED.attributes,updated_at=EXCLUDED.updated_at`,[ctx.workspaceId,JSON.stringify(documents),nowIso()]);
  if(saved.rowCount!==documents.length)throw new ValidationError('Imported product details did not reconcile.');
 }
}
async function read(database,workspaceId,{skuIds=null,itemIds=null,catalog=false}={}){return(await database.query(`SELECT
 CASE WHEN f.attributes IS NULL THEN f.id ELSE f.id||':'||md5(field.key) END AS id,f.workspace_id,f.sku_id,f.location_id,field.key AS name,field.value,
 f.source_import_id,f.source_row,f.updated_at${catalog?',s.code,l.name AS location_name':''}
 FROM catalog_source_facts f JOIN skus s ON s.workspace_id=f.workspace_id AND s.id=f.sku_id
 LEFT JOIN locations l ON l.workspace_id=f.workspace_id AND l.id=f.location_id
 CROSS JOIN LATERAL jsonb_each_text(CASE WHEN f.attributes IS NULL THEN jsonb_build_object(f.name,f.value) ELSE f.attributes END) field
 WHERE f.workspace_id=$1 AND ($2::text[] IS NULL OR f.sku_id=ANY($2::text[])) AND ($3::text[] IS NULL OR s.item_id=ANY($3::text[]))
 ORDER BY s.code,l.name NULLS FIRST,field.key,f.id`,[workspaceId,skuIds,itemIds])).rows;}
async function listForSkus(database,workspaceId,ids){return ids.length?read(database,workspaceId,{skuIds:ids,catalog:true}):[];}
async function exportRows(database,workspaceId,{itemIds=null}={}){return read(database,workspaceId,{itemIds});}
module.exports={saveManyInTransaction,listForSkus,exportRows};
