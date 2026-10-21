'use strict';
const {ValidationError}=require('./errors'),{newId,nowIso}=require('../lib/util');
async function saveManyInTransaction(client,ctx,inputs){
 if(!inputs.length)return;
 const rows=inputs.map(r=>({id:newId('fact'),sku_id:r.skuId,location_id:r.locationId||null,name:r.name,value:String(r.value),source_import_id:r.importId,source_row:r.rowNumber}));
 const saved=await client.query(`INSERT INTO catalog_source_facts(id,workspace_id,sku_id,location_id,name,value,source_import_id,source_row,updated_at)
  SELECT x.id,$1,x.sku_id,x.location_id,x.name,x.value,x.source_import_id,x.source_row,$3 FROM jsonb_to_recordset($2::jsonb) AS x(id text,sku_id text,location_id text,name text,value text,source_import_id text,source_row bigint)
  JOIN skus s ON s.workspace_id=$1 AND s.id=x.sku_id
  WHERE x.location_id IS NULL OR EXISTS(SELECT 1 FROM locations l WHERE l.workspace_id=$1 AND l.id=x.location_id)
  ON CONFLICT(workspace_id,sku_id,(COALESCE(location_id,'')),name,source_import_id,source_row) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`,[ctx.workspaceId,JSON.stringify(rows),nowIso()]);
 if(saved.rowCount!==rows.length)throw new ValidationError('Imported product details must belong to this inventory.');
}
async function listForSkus(database,workspaceId,ids){if(!ids.length)return [];return (await database.query(`SELECT f.*,s.code,l.name AS location_name FROM catalog_source_facts f JOIN skus s ON s.workspace_id=f.workspace_id AND s.id=f.sku_id LEFT JOIN locations l ON l.workspace_id=f.workspace_id AND l.id=f.location_id WHERE f.workspace_id=$1 AND f.sku_id=ANY($2::text[]) ORDER BY s.code,l.name NULLS FIRST,f.name,f.id`,[workspaceId,ids])).rows;}
module.exports={saveManyInTransaction,listForSkus};
