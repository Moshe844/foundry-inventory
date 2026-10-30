'use strict';
const CHUNK=500;
// Read only the frozen execution inputs, in index order. Reading and sorting
// every raw source row in one statement makes the first step grow with the
// complete workbook and can time out before progress is published.
async function* executionPages(client,workspaceId,importId,{includeImported=false}={}){
 let lastRow=-1,lastId='';
 for(;;){
  const page=(await client.query(`SELECT id,row_number,parsed,item_id,sku_id,location_id,status FROM import_rows
   WHERE workspace_id=$1 AND import_id=$2 AND status IN (${includeImported?"'VALID','NEEDS_REVIEW','IMPORTED'":"'VALID','NEEDS_REVIEW'"})
    AND (row_number,id)>($3::bigint,$4::text)
   ORDER BY row_number,id LIMIT ${CHUNK} FOR UPDATE`,[workspaceId,importId,lastRow,lastId])).rows;
  if(!page.length)break;
  const rows=[];for(const row of page){const parsed=typeof row.parsed==='string'?JSON.parse(row.parsed):row.parsed;
    if(includeImported&&row.sku_id){if(!parsed.existingSkuId)parsed.createdSkuId=row.sku_id;if(!parsed.existingItemId)parsed.createdItemId=row.item_id;if(row.location_id)parsed.locationId=row.location_id;}
    rows.push({id:row.id,rowNumber:Number(row.row_number),parsed,imported:row.status==='IMPORTED'});}
  lastRow=Number(page.at(-1).row_number);lastId=page.at(-1).id;
  yield rows;
 }
}
async function executionRows(client,workspaceId,importId,onProgress,options={}){
 const rows=[];
 for await(const page of executionPages(client,workspaceId,importId,options)){rows.push(...page);await onProgress?.(rows.length);}
 return rows;
}
async function insert(database,workspaceId,importId,rows,at){
 for(let start=0;start<rows.length;start+=CHUNK){
  const batch=rows.slice(start,start+CHUNK).map(row=>({id:row.id,row_number:row.rowNumber,raw:row.raw,parsed:row.parsed,status:row.status,problems:row.problems,location_id:row.parsed.locationId||null,quantity:row.parsed.quantity??null}));
  await database.query(`INSERT INTO import_rows(id,import_id,workspace_id,row_number,raw,parsed,status,problems,location_id,quantity,created_at)
   SELECT x.id,$2,$1,x.row_number,x.raw,x.parsed,x.status,x.problems,x.location_id,x.quantity,$4
   FROM jsonb_to_recordset($3::jsonb) AS x(id text,row_number bigint,raw jsonb,parsed jsonb,status text,problems jsonb,location_id text,quantity numeric)`,[workspaceId,importId,JSON.stringify(batch),at]);
 }
}
async function revise(database,workspaceId,importId,current,rows){
 const identities=new Map(current.map(row=>[row.rowNumber,row.id]));
 for(let start=0;start<rows.length;start+=CHUNK){
  const batch=rows.slice(start,start+CHUNK).map(row=>({id:identities.get(row.rowNumber),parsed:row.parsed,status:row.status,problems:row.problems,location_id:row.parsed.locationId||null,quantity:row.parsed.quantity??null}));
  await database.query(`UPDATE import_rows saved SET parsed=x.parsed,status=x.status,problems=x.problems,location_id=x.location_id,quantity=x.quantity
   FROM jsonb_to_recordset($3::jsonb) AS x(id text,parsed jsonb,status text,problems jsonb,location_id text,quantity numeric)
   WHERE saved.workspace_id=$1 AND saved.import_id=$2 AND saved.id=ANY($4::text[]) AND saved.id=x.id
   AND (saved.parsed::jsonb,saved.status,saved.problems::jsonb,saved.location_id,saved.quantity) IS DISTINCT FROM
       (x.parsed,x.status,x.problems,x.location_id,x.quantity)`,[workspaceId,importId,JSON.stringify(batch),batch.map(r=>r.id)]);
 }
}
async function markImported(database,workspaceId,importId,rows){
 if(!rows.length)return;
 const batch=rows.map(row=>({id:row.id,item_id:row.itemId,sku_id:row.skuId,location_id:row.locationId,movement_ids:JSON.stringify(row.movementIds),quantity:row.quantity,imported_at:row.at}));
 const result=await database.query(`UPDATE import_rows saved SET status='IMPORTED',item_id=x.item_id,sku_id=x.sku_id,location_id=x.location_id,
   movement_ids=x.movement_ids,quantity=x.quantity,imported_at=x.imported_at
  FROM jsonb_to_recordset($3::jsonb) AS x(id text,item_id text,sku_id text,location_id text,movement_ids text,quantity numeric,imported_at text)
  WHERE saved.workspace_id=$1 AND saved.import_id=$2 AND saved.id=ANY($4::text[]) AND saved.id=x.id`,[workspaceId,importId,JSON.stringify(batch),batch.map(r=>r.id)]);
 if(result.rowCount!==rows.length)throw new Error('The imported row identities did not reconcile.');
}
module.exports={insert,revise,markImported,executionRows,executionPages};
