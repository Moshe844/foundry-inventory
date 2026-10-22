'use strict';
const CHUNK=500;
async function insert(database,workspaceId,importId,rows,at){
 for(let start=0;start<rows.length;start+=CHUNK){
  const batch=rows.slice(start,start+CHUNK).map(row=>({id:row.id,row_number:row.rowNumber,raw:row.raw,parsed:row.parsed,status:row.status,problems:row.problems,location_id:row.parsed.locationId||null,quantity:row.parsed.quantity??null}));
  await database.query(`INSERT INTO import_rows(id,import_id,workspace_id,row_number,raw,parsed,status,problems,location_id,quantity,created_at)
   SELECT x.id,$2,$1,x.row_number,x.raw,x.parsed,x.status,x.problems,x.location_id,x.quantity,$4
   FROM jsonb_to_recordset($3::jsonb) AS x(id text,row_number bigint,raw jsonb,parsed jsonb,status text,problems jsonb,location_id text,quantity bigint)`,[workspaceId,importId,JSON.stringify(batch),at]);
 }
}
async function revise(database,workspaceId,importId,current,rows){
 const identities=new Map(current.map(row=>[row.rowNumber,row.id]));
 for(let start=0;start<rows.length;start+=CHUNK){
  const batch=rows.slice(start,start+CHUNK).map(row=>({id:identities.get(row.rowNumber),parsed:row.parsed,status:row.status,problems:row.problems,location_id:row.parsed.locationId||null,quantity:row.parsed.quantity??null}));
  await database.query(`UPDATE import_rows saved SET parsed=x.parsed,status=x.status,problems=x.problems,location_id=x.location_id,quantity=x.quantity
   FROM jsonb_to_recordset($3::jsonb) AS x(id text,parsed jsonb,status text,problems jsonb,location_id text,quantity bigint)
   WHERE saved.workspace_id=$1 AND saved.import_id=$2 AND saved.id=ANY($4::text[]) AND saved.id=x.id`,[workspaceId,importId,JSON.stringify(batch),batch.map(r=>r.id)]);
 }
}
async function markImported(database,workspaceId,importId,rows){
 if(!rows.length)return;
 const batch=rows.map(row=>({id:row.id,item_id:row.itemId,sku_id:row.skuId,location_id:row.locationId,movement_ids:JSON.stringify(row.movementIds),quantity:row.quantity,imported_at:row.at}));
 const result=await database.query(`UPDATE import_rows saved SET status='IMPORTED',item_id=x.item_id,sku_id=x.sku_id,location_id=x.location_id,
   movement_ids=x.movement_ids,quantity=x.quantity,imported_at=x.imported_at
  FROM jsonb_to_recordset($3::jsonb) AS x(id text,item_id text,sku_id text,location_id text,movement_ids text,quantity bigint,imported_at text)
  WHERE saved.workspace_id=$1 AND saved.import_id=$2 AND saved.id=ANY($4::text[]) AND saved.id=x.id`,[workspaceId,importId,JSON.stringify(batch),batch.map(r=>r.id)]);
 if(result.rowCount!==rows.length)throw new Error('The imported row identities did not reconcile.');
}
module.exports={insert,revise,markImported};
