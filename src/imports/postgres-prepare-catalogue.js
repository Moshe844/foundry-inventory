'use strict';
const {ValidationError}=require('../domain/errors'),catalog=require('../domain/postgres-catalog-service'),prices=require('../pricing/postgres-service'),identities=require('./postgres-execution-identities');

async function prepare(client,ctx,plan,options,deps,saved={}){
 const params=[ctx.workspaceId,plan.id];
 // Validate cross-page conflicts in PostgreSQL before creating any catalogue
 // records. These checks must not disappear when memory is bounded by pages.
 if(!saved.catalogueChecked){
 const conflicting=(await client.query(`SELECT 1 FROM import_execution_identities
  WHERE workspace_id=$1 AND import_id=$2 AND selling_price_minor IS NOT NULL
  GROUP BY product_key,variant_key HAVING min(selling_price_minor)<>max(selling_price_minor) OR min(currency)<>max(currency) LIMIT 1`,params)).rows.length;
 if(conflicting)throw new ValidationError('One imported variant has conflicting selling prices.');
 const conflictingNames=(await client.query(`SELECT 1 FROM import_execution_identities
  WHERE workspace_id=$1 AND import_id=$2 AND catalogue_update->>'itemId' IS NOT NULL
  GROUP BY catalogue_update->>'itemId' HAVING min(catalogue_update->>'name')<>max(catalogue_update->>'name') LIMIT 1`,params)).rows.length;
 if(conflictingNames)throw new ValidationError('One product has conflicting source names.');
 let lastItem='';
 for(;;){const updates=(await client.query(`SELECT DISTINCT ON(existing_item_id) existing_item_id,catalogue_update AS change
  FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2 AND existing_item_id>$3
  AND catalogue_update->>'itemId' IS NOT NULL ORDER BY existing_item_id,row_number,row_id LIMIT 500`,[...params,lastItem])).rows;
  if(!updates.length)break;await catalog.updateImportedNamesInTransaction(client,ctx,updates.map(r=>r.change));lastItem=updates.at(-1).existing_item_id;
 }
 }
 let lastProduct=saved.catalogueCursor?.product||'',lastVariant=saved.catalogueCursor?.variant||'',tailItem=saved.catalogueTail||null,itemsCreated=Number(saved.itemsCreated||0),skusCreated=Number(saved.skusCreated||0);
  const representatives=(await client.query(`WITH page AS MATERIALIZED(SELECT DISTINCT ON(product_key,variant_key) product_key,variant_key,row_id,row_number
   FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2 AND existing_sku_id IS NULL
   AND (product_key,variant_key)>($3::text,$4::text) ORDER BY product_key,variant_key,row_number,row_id LIMIT 500)
   SELECT page.*,r.parsed FROM page JOIN import_rows r ON r.id=page.row_id ORDER BY page.product_key,page.variant_key`,[...params,lastProduct,lastVariant])).rows;
  if(!representatives.length){const counts=await identities.counts(client,ctx,plan);return {cataloguePrepared:true,catalogueChecked:true,itemsCreated,skusCreated,itemsUpdated:counts.updated};}
  const products=[...new Set(representatives.map(r=>r.product_key))];
  const grouped=new Map(products.map(k=>[k,[]]));for(const row of representatives){row.parsed=typeof row.parsed==='string'?JSON.parse(row.parsed):row.parsed;grouped.get(row.product_key).push(row);}
  for(const group of grouped.values())group.sort((a,b)=>Number(a.row_number)-Number(b.row_number)||a.row_id.localeCompare(b.row_id));
  const firstRows=(await client.query(`WITH first_rows AS MATERIALIZED(SELECT wanted.product_key,first.row_id FROM unnest($3::text[]) wanted(product_key)
   CROSS JOIN LATERAL(SELECT row_id FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2 AND product_key=wanted.product_key ORDER BY row_number,row_id LIMIT 1)first)
   SELECT first_rows.product_key,r.parsed FROM first_rows JOIN import_rows r ON r.id=first_rows.row_id`,[...params,products.filter(p=>p!==lastProduct)])).rows;
  const firstByProduct=new Map(firstRows.map(r=>[r.product_key,typeof r.parsed==='string'?JSON.parse(r.parsed):r.parsed]));
  const quotedPrices=(await client.query(`SELECT wanted.product_key,wanted.variant_key,quote.amount,quote.currency
   FROM jsonb_to_recordset($3::jsonb) wanted(product_key text,variant_key text)
   CROSS JOIN LATERAL(SELECT max(e.selling_price_minor)::text amount,max(e.currency) currency FROM import_execution_identities e
    WHERE e.workspace_id=$1 AND e.import_id=$2 AND e.product_key=wanted.product_key AND e.variant_key=wanted.variant_key
      AND e.selling_price_minor IS NOT NULL)quote WHERE quote.amount IS NOT NULL`,[...params,JSON.stringify(representatives.map(r=>({product_key:r.product_key,variant_key:r.variant_key})))])).rows;
  const priceByIdentity=new Map(quotedPrices.map(r=>[r.product_key+':'+r.variant_key,r]));
  const definitions=[];
  for(const [product,group]of grouped){
   const continuing=product===lastProduct;
   if(!continuing)await options.beforeGroup?.({key:deps.productKey(group[0].parsed),group:group.map(r=>({id:r.row_id,rowNumber:Number(r.row_number),parsed:r.parsed})),itemsCreated});
   const first=continuing?tailItem.first:firstByProduct.get(product);definitions.push({...(continuing?{appendToItemId:tailItem.id,importPlanId:plan.id,importIntegrityHash:plan.integrityHash,importProductKey:product}:{}),name:first.name,description:first.description,unitLabel:first.unitLabel,trackingMode:first.trackingMode,
    variants:group.map(r=>({key:r.variant_key,code:r.parsed.code,barcode:r.parsed.barcode,options:r.parsed.variants}))});
  }
  const created=await catalog.createImportedItemsInTransaction(client,ctx,definitions),bindings=[],initialPrices=[];
  for(let i=0;i<products.length;i++){
   const group=grouped.get(products[i]),result=created[i],byVariant=new Map(result.skus.map(s=>[s.key,s.skuId]));if(products[i]!==lastProduct)itemsCreated++;skusCreated+=result.skus.length;
   for(const row of group){const skuId=byVariant.get(row.variant_key);bindings.push({product_key:products[i],variant_key:row.variant_key,item_id:result.itemId,sku_id:skuId});
    const price=priceByIdentity.get(products[i]+':'+row.variant_key);
    if(price)initialPrices.push({skuId,amountMinor:Number(price.amount),currency:price.currency,source:'opening_import',sourceDetail:{importId:plan.id,importRowId:row.row_id}});}
  }
  for(let offset=0;offset<initialPrices.length;offset+=500)await prices.setPricesInTransaction(client,ctx,initialPrices.slice(offset,offset+500),{initialize:true});
  for(let offset=0;offset<bindings.length;offset+=500)await client.query(`INSERT INTO import_catalogue_bindings(workspace_id,import_id,product_key,variant_key,item_id,sku_id)
   SELECT $1,$2,x.product_key,x.variant_key,x.item_id,x.sku_id FROM jsonb_to_recordset($3::jsonb) x(product_key text,variant_key text,item_id text,sku_id text)`,[...params,JSON.stringify(bindings.slice(offset,offset+500))]);
  tailItem={id:created.at(-1).itemId,first:products.at(-1)===lastProduct?tailItem.first:firstByProduct.get(products.at(-1))};
  lastProduct=representatives.at(-1).product_key;lastVariant=representatives.at(-1).variant_key;
  return {cataloguePrepared:false,catalogueChecked:true,catalogueCursor:{product:lastProduct,variant:lastVariant},catalogueTail:tailItem,itemsCreated,skusCreated,itemsUpdated:Number(saved.itemsUpdated||0)};
}
module.exports={prepare};
