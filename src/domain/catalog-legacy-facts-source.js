'use strict';
function source(){return `SELECT f.id,x.sku_id,x.location_id,x.source_import_id,x.source_row,f.name
 FROM jsonb_to_recordset($2::jsonb) AS x(sku_id text,location_id text,source_import_id text,source_row bigint)
 JOIN LATERAL(SELECT id,name FROM catalog_source_facts
  WHERE workspace_id=$1 AND sku_id=x.sku_id AND COALESCE(location_id,'')=COALESCE(x.location_id,'')
  AND source_import_id=x.source_import_id AND source_row=x.source_row AND attributes IS NULL OFFSET 0)f ON true`;}
module.exports={source};
