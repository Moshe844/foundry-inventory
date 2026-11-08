'use strict';
const CHUNK=500;
// A product's variants stay in neighbouring batches. A SKU's source rows keep
// their original order, including different costs and locations. The old SKU
// cursor remains valid for imports approved before product-local ordering.
async function* stockPages(client,workspaceId,importId,{batchSize,lock,cursor,includeImported,orderByItem=false,lane=null}){
 let last=cursor||{itemKey:'',key:'',rowNumber:-1,rowId:''};
 for(;;){
  // Probe the unique source ID before checking scope. Statistics from an
  // older import must not select a scope index and rescan this whole source
  // for each row. Both workspace and import remain mandatory join checks.
  const page=(await client.query(`WITH page AS MATERIALIZED(
   ${lane!==null?`SELECT row_id,row_number,coalesce(existing_item_id,product_key) AS item_key,coalesce(existing_sku_id,product_key||':'||variant_key) AS execution_key
   FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2 AND execution_lane IS NOT NULL AND execution_lane=$7::smallint
    AND (coalesce(existing_item_id,product_key),coalesce(existing_sku_id,product_key||':'||variant_key),row_number,row_id)>($6::text,$3::text,$4::bigint,$5::text)
   ORDER BY coalesce(existing_item_id,product_key),coalesce(existing_sku_id,product_key||':'||variant_key),row_number,row_id LIMIT ${batchSize}`:orderByItem?`SELECT * FROM stockchief_import_item_page($1,$2,$6,$3,$4,$5,${batchSize})`:`SELECT row_id,row_number,coalesce(existing_sku_id,product_key||':'||variant_key) AS execution_key
   FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2
    AND (coalesce(existing_sku_id,product_key||':'||variant_key),row_number,row_id)>($3::text,$4::bigint,$5::text)
   ORDER BY coalesce(existing_sku_id,product_key||':'||variant_key),row_number,row_id LIMIT ${batchSize}`})
   SELECT ${orderByItem?'p.item_key,':''}p.execution_key,r.id,r.row_number,r.parsed,r.item_id,r.sku_id,r.location_id,r.status
   FROM page p JOIN LATERAL(SELECT id,row_number,parsed,item_id,sku_id,location_id,status,workspace_id,import_id FROM import_rows
    WHERE id=p.row_id OFFSET 0${lock?' FOR UPDATE':''}) r ON r.workspace_id=$1 AND r.import_id=$2
   ORDER BY ${orderByItem?'p.item_key,':''}p.execution_key,p.row_number,p.row_id`,[workspaceId,importId,last.key,last.rowNumber,last.rowId,...(orderByItem?[last.itemKey]:[]),...(lane!==null?[lane]:[])])).rows;
  if(!page.length)break;
  if(page.some(row=>!(includeImported?['VALID','NEEDS_REVIEW','IMPORTED']:['VALID','NEEDS_REVIEW']).includes(row.status)))throw new (require('../domain/errors').ValidationError)('Saved stock import progress does not match its approved source rows. Its recorded batches remain safe.');
  const rows=page.map(row=>{const parsed=typeof row.parsed==='string'?JSON.parse(row.parsed):row.parsed;if(includeImported&&row.sku_id){if(!parsed.existingSkuId)parsed.createdSkuId=row.sku_id;if(!parsed.existingItemId)parsed.createdItemId=row.item_id;if(row.location_id)parsed.locationId=row.location_id;}
   return {id:row.id,rowNumber:Number(row.row_number),parsed,imported:row.status==='IMPORTED',executionCursor:{...(orderByItem?{itemKey:row.item_key}:{}),key:row.execution_key,rowNumber:Number(row.row_number),rowId:row.id}};});
  last=rows.at(-1).executionCursor;
  const size=rows.some(row=>!['quantity','lot'].includes(row.parsed.trackingMode)||row.parsed.secondaryUnitLabel)?Math.min(CHUNK,batchSize):batchSize;
  for(let start=0;start<rows.length;start+=size)yield rows.slice(start,start+size);
 }
}
// Read only the frozen execution inputs, in index order. Reading and sorting
// every raw source row in one statement makes the first step grow with the
// complete workbook and can time out before progress is published.
async function* executionPages(client,workspaceId,importId,{includeImported=false,lock=true,batchSize=CHUNK,orderBySku=false,orderByItem=false,cursor=null,lane=null}={}){
 if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>2000)throw new TypeError('Import execution pages must contain one to 2,000 rows.');
 if(lane!==null&&(!Number.isInteger(lane)||lane<0||lane>3||!orderByItem))throw new TypeError('Choose a saved stock lane and its item order.');
 if(orderBySku||orderByItem){yield* stockPages(client,workspaceId,importId,{batchSize,lock,cursor,includeImported,orderByItem,lane});return;}
 let lastRow=-1,lastId='';
 for(;;){
  const page=(await client.query(`SELECT id,row_number,parsed,item_id,sku_id,location_id,status FROM import_rows
   WHERE workspace_id=$1 AND import_id=$2 AND status IN (${includeImported?"'VALID','NEEDS_REVIEW','IMPORTED'":"'VALID','NEEDS_REVIEW'"})
    AND (row_number,id)>($3::bigint,$4::text)
   ORDER BY row_number,id LIMIT ${batchSize}${lock?' FOR UPDATE':''}`,[workspaceId,importId,lastRow,lastId])).rows;
  if(!page.length)break;
  const rows=[];for(const row of page){const parsed=typeof row.parsed==='string'?JSON.parse(row.parsed):row.parsed;
    if(includeImported&&row.sku_id){if(!parsed.existingSkuId)parsed.createdSkuId=row.sku_id;if(!parsed.existingItemId)parsed.createdItemId=row.item_id;if(row.location_id)parsed.locationId=row.location_id;}
    rows.push({id:row.id,rowNumber:Number(row.row_number),parsed,imported:row.status==='IMPORTED'});}
  lastRow=Number(page.at(-1).row_number);lastId=page.at(-1).id;
  // Identity-bearing and measured receipts use their detailed per-unit path.
  // Keep those lock windows small even when ordinary quantity stock is batched.
  const size=rows.some(row=>!['quantity','lot'].includes(row.parsed.trackingMode)||row.parsed.secondaryUnitLabel)?Math.min(CHUNK,batchSize):batchSize;
  for(let start=0;start<rows.length;start+=size)yield rows.slice(start,start+size);
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
 // Freeze and lock only this batch's primary-key matches. A scope/row-number
 // index cannot bound an ID-only update: with stale statistics PostgreSQL
 // otherwise walks the complete source again for each committed batch.
 // Update through the stable primary key, not ctid: a concurrent writer can
 // replace a physical tuple while READ COMMITTED waits for its row lock.
 const result=await database.query(`WITH targets AS MATERIALIZED (
  SELECT x.* FROM jsonb_to_recordset($3::jsonb)
   AS x(id text,item_id text,sku_id text,location_id text,movement_ids text,quantity numeric,imported_at text)
  JOIN LATERAL (SELECT workspace_id,import_id FROM import_rows WHERE id=x.id OFFSET 0 FOR UPDATE) matched
   ON matched.workspace_id=$1 AND matched.import_id=$2
 ) UPDATE import_rows saved SET status='IMPORTED',item_id=x.item_id,sku_id=x.sku_id,location_id=x.location_id,
   movement_ids=x.movement_ids,quantity=x.quantity,imported_at=x.imported_at
  FROM targets x WHERE saved.id=x.id`,[workspaceId,importId,JSON.stringify(batch)]);
 if(result.rowCount!==rows.length)throw new Error('The imported row identities did not reconcile.');
}
module.exports={insert,revise,markImported,executionRows,executionPages};
