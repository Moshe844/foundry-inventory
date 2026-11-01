'use strict';
const {ValidationError,NotFoundError}=require('./errors'),{newId,trimOrNull}=require('../lib/util');
async function history(c,ctx,sku,action,before,after){await c.query('INSERT INTO catalogue_change_history(id,workspace_id,actor_id,item_id,sku_id,action,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('catlog'),ctx.workspaceId,ctx.actorId,sku.item_id,sku.id,action,before,after]);}
async function update(db,ctx,itemId,skuId,input){return db.transaction(async c=>{
 const actor=(await c.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];if(actor?.role!=='owner')throw new ValidationError('Only an owner can change variant identifiers or archive variants.');
 const sku=(await c.query('SELECT s.*,i.is_active AS item_active FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.item_id=$2 AND s.id=$3 FOR UPDATE OF s,i',[ctx.workspaceId,itemId,skuId])).rows[0];if(!sku)throw new NotFoundError('Choose a variant from this product.');
 if(Object.hasOwn(input,'barcode')){
  const barcode=trimOrNull(input.barcode);if(barcode&&(barcode.length>240||/[\x00-\x1f\x7f]/.test(barcode)))throw new ValidationError('Use a barcode of at most 240 printable characters.');
  if((sku.barcode||'')!==String(input.expectedBarcode||''))throw new ValidationError('This barcode changed. Reload the product before saving.');
  if(barcode&&(await c.query('SELECT 1 FROM skus WHERE workspace_id=$1 AND id<>$2 AND lower(barcode)=lower($3) LIMIT 1',[ctx.workspaceId,skuId,barcode])).rows.length)throw new ValidationError('Another variant already uses this barcode.');
  if(barcode!==sku.barcode){await c.query('UPDATE skus SET barcode=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,skuId,barcode]);await history(c,ctx,sku,'barcode',{barcode:sku.barcode},{barcode});}
 }
 if(Object.hasOwn(input,'active')){
  const active=input.active===true;if(active&&!Number(sku.item_active))throw new ValidationError('Restore the product before restoring a variant.');
  if(!active){
   if((await c.query('SELECT 1 FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND (on_hand<>0 OR coalesce(secondary_on_hand,0)<>0) LIMIT 1',[ctx.workspaceId,skuId])).rows.length)throw new ValidationError('Move or remove this variant’s remaining stock before archiving it.');
   const pending=(await c.query(`SELECT 1 FROM sales_order_lines l JOIN sales_orders o ON o.id=l.sales_order_id AND o.workspace_id=l.workspace_id WHERE l.workspace_id=$1 AND l.sku_id=$2 AND o.status NOT IN ('FULFILLED','CANCELLED')
    UNION ALL SELECT 1 FROM purchase_order_lines l JOIN purchase_orders o ON o.id=l.purchase_order_id AND o.workspace_id=l.workspace_id WHERE l.workspace_id=$1 AND l.sku_id=$2 AND o.status NOT IN ('COMPLETED','CANCELLED','RECEIVED')
    UNION ALL SELECT 1 FROM inventory_transfer_lines l JOIN inventory_transfers o ON o.id=l.transfer_id AND o.workspace_id=l.workspace_id WHERE l.workspace_id=$1 AND l.sku_id=$2 AND o.status NOT IN ('RECEIVED','CANCELLED') LIMIT 1`,[ctx.workspaceId,skuId])).rows.length;
   if(pending)throw new ValidationError('Finish or cancel open orders and transfers for this variant before archiving it.');
  }
  if(Number(sku.is_active)!==Number(active)){await c.query('UPDATE skus SET is_active=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,skuId,active?1:0]);await history(c,ctx,sku,active?'restore_variant':'archive_variant',{active:Boolean(Number(sku.is_active))},{active});}
 }
 return {skuId};
},{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={update,history};require('../commercial/enforcement').guardExports(module.exports,0,1,{update:'inventory.core'});
