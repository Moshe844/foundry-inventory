'use strict';
const {ValidationError}=require('../domain/errors'),{newId}=require('../lib/util');
async function apply(client,ctx,rows){
 const bySku=new Map();for(const row of rows){const p=row.parsed;if(!p.existingSkuId||!p.barcode)continue;const previous=bySku.get(p.existingSkuId);if(previous&&previous.barcode!==p.barcode)throw new ValidationError('The file gives different barcodes for the same variant.');bySku.set(p.existingSkuId,p);}
 if(!bySku.size)return;
 const current=(await client.query('SELECT id,item_id,barcode FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,[...bySku.keys()]])).rows;if(current.length!==bySku.size)throw new ValidationError('An imported variant is no longer available.');const updates=[];
 for(const sku of current){const p=bySku.get(sku.id);if(sku.barcode===p.barcode)continue;if((sku.barcode||null)!==(p.existingBarcode||null))throw new ValidationError('A barcode changed after this preview. Recheck the file before replacing it.');updates.push({id:sku.id,item_id:sku.item_id,barcode:p.barcode,before:sku.barcode,audit_id:newId('catlog')});}
 if(!updates.length)return;
 await client.query(`UPDATE skus s SET barcode=x.barcode FROM jsonb_to_recordset($2::jsonb) x(id text,barcode text) WHERE s.workspace_id=$1 AND s.id=x.id`,[ctx.workspaceId,JSON.stringify(updates)]);
 await client.query(`INSERT INTO catalogue_change_history(id,workspace_id,actor_id,item_id,sku_id,action,before_state,after_state)
 SELECT x.audit_id,$1,$3,x.item_id,x.id,'import_barcode',jsonb_build_object('barcode',x.before),jsonb_build_object('barcode',x.barcode) FROM jsonb_to_recordset($2::jsonb) x(id text,item_id text,barcode text,before text,audit_id text)`,[ctx.workspaceId,JSON.stringify(updates),ctx.actorId]);
}
module.exports={apply};
