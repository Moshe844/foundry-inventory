'use strict';
const {createHash}=require('node:crypto'),rows=require('./postgres-row-store'),{ValidationError}=require('../domain/errors');
const hash=value=>createHash('sha256').update(value).digest('hex');
async function stage(client,ctx,plan,deps,onProgress){
 const existing=(await client.query('SELECT execution_identity_hash FROM import_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,plan.id])).rows[0];
 if(existing?.execution_identity_hash===plan.integrityHash)return;
 await client.query('DELETE FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id]);
 let count=0;
 for await(const page of rows.executionPages(client,ctx.workspaceId,plan.id,{includeImported:true})){
  await insertPage(client,ctx,plan,page,deps);
  count+=page.length;await onProgress?.(count);
 }
 if(count!==plan.recordsValid)throw new ValidationError('The frozen approved row count changed.');
 await mark(client,ctx,plan);
}
async function insertPage(client,ctx,plan,page,deps){
 const values=page.filter(r=>!r.status||['VALID','NEEDS_REVIEW','IMPORTED'].includes(r.status)).map(r=>({row_id:r.id,row_number:r.rowNumber,product_key:hash(deps.productKey(r.parsed)),variant_key:hash(deps.variantKey(r.parsed)),existing_sku_id:r.parsed.existingSkuId||null,existing_item_id:r.parsed.existingItemId||null,selling_price_minor:r.parsed.sellingPriceMinor??null,currency:r.parsed.currency||null,catalogue_update:r.parsed.catalogueUpdate||null}));
 if(!values.length)return;
 await client.query(`INSERT INTO import_execution_identities(workspace_id,import_id,row_id,row_number,product_key,variant_key,existing_sku_id,existing_item_id,selling_price_minor,currency,catalogue_update)
 SELECT $1,$2,x.row_id,x.row_number,x.product_key,x.variant_key,x.existing_sku_id,x.existing_item_id,x.selling_price_minor,x.currency,x.catalogue_update
 FROM jsonb_to_recordset($3::jsonb) x(row_id text,row_number bigint,product_key text,variant_key text,existing_sku_id text,existing_item_id text,selling_price_minor bigint,currency text,catalogue_update jsonb)`,[ctx.workspaceId,plan.id,JSON.stringify(values)]);
}
async function mark(client,ctx,plan){await client.query('UPDATE import_plans SET execution_identity_hash=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,plan.id,plan.integrityHash]);}
async function counts(client,ctx,plan){return (await client.query(`SELECT count(DISTINCT product_key) FILTER(WHERE existing_sku_id IS NULL)::int products,
 count(DISTINCT (product_key,variant_key)) FILTER(WHERE existing_sku_id IS NULL)::int skus,
 count(DISTINCT existing_item_id)::int updated FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2`,[ctx.workspaceId,plan.id])).rows[0];}
async function hydrate(client,ctx,plan,page,checkpoint){
 const bindings=(await client.query(`SELECT e.row_id,b.item_id,b.sku_id FROM import_execution_identities e
 LEFT JOIN import_catalogue_bindings b ON b.workspace_id=e.workspace_id AND b.import_id=e.import_id AND b.product_key=e.product_key AND b.variant_key=e.variant_key
 WHERE e.workspace_id=$1 AND e.import_id=$2 AND e.row_id=ANY($3::text[])`,[ctx.workspaceId,plan.id,page.map(r=>r.id)])).rows;
 const byId=new Map(bindings.map(r=>[r.row_id,r]));
 for(const row of page){const p=row.parsed;if(!p.existingSkuId){const b=byId.get(row.id);if(!b?.sku_id)throw new ValidationError('A prepared imported product is missing. Saved stock remains recorded.');p.createdSkuId=b.sku_id;p.createdItemId=b.item_id;}
  if(p.proposedLocationName){p.locationId=checkpoint.locations?.[p.proposedLocationName];if(!p.locationId)throw new ValidationError('A prepared source location is missing.');}}
 return page;
}
module.exports={stage,counts,hydrate,hash,insertPage,mark};
