'use strict';
const {ValidationError,NotFoundError}=require('./errors'),exact=require('./exact-quantity'),{newId,nowIso}=require('../lib/util');
async function owner(c,ctx){const actor=(await c.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];if(actor?.role!=='owner')throw new ValidationError('Only an owner can change a kit recipe.');}
async function definition(c,workspaceId,skuId){
 const sku=(await c.query('SELECT s.*,i.name,i.is_active AS item_active,i.tracking_mode,i.quantity_precision,i.secondary_unit_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$2',[workspaceId,skuId])).rows[0];if(!sku)throw new NotFoundError('That kit is not in this inventory.');
 const components=(await c.query('SELECT k.*,s.code,s.variant_label,i.name,i.tracking_mode FROM kit_components k JOIN skus s ON s.workspace_id=k.workspace_id AND s.id=k.component_sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE k.workspace_id=$1 AND k.kit_sku_id=$2 ORDER BY k.component_sku_id',[workspaceId,skuId])).rows;
 return {sku,components,isKit:components.length>0,stockBasis:components[0]?.stock_basis||null};
}
async function explode(c,workspaceId,skuId,{multiplier='1',path=new Set(),budget={remaining:2000},depth=0}={}){
 if(path.has(skuId))throw new ValidationError('A kit cannot contain itself, including through another kit.');if(depth>16||--budget.remaining<0)throw new ValidationError('This kit recipe is too large or deeply nested. Use at most 16 levels and 1,000 component variants.');
 const current=await definition(c,workspaceId,skuId);if(!Number(current.sku.is_active)||!Number(current.sku.item_active))throw new ValidationError('Restore archived kit components before accepting a new order.');
 if(!current.isKit||current.stockBasis==='preassembled')return [{skuId,quantity:exact.canonical(multiplier)}];
 const next=new Set(path).add(skuId),totals=new Map();
 for(const part of current.components){const quantity=exact.convert(multiplier,{numerator:part.quantity,precision:6});for(const leaf of await explode(c,workspaceId,part.component_sku_id,{multiplier:quantity,path:next,budget,depth:depth+1}))totals.set(leaf.skuId,exact.add(totals.get(leaf.skuId)||'0',leaf.quantity));if(totals.size>1000)throw new ValidationError('A kit supports up to 1,000 distinct component variants.');}
 return [...totals].sort(([a],[b])=>a.localeCompare(b)).map(([skuId,quantity])=>({skuId,quantity}));
}
async function define(db,ctx,input){return db.transaction(async c=>{
 await owner(c,ctx);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['kits:'+ctx.workspaceId]);
 const current=await definition(c,ctx.workspaceId,input.kitSkuId);if(!Number(current.sku.is_active)||!Number(current.sku.item_active))throw new ValidationError('Restore the kit before changing its recipe.');if(current.sku.tracking_mode!=='quantity'||Number(current.sku.quantity_precision)!==0||current.sku.secondary_unit_label)throw new ValidationError('The kit sold to a customer must use whole units. Its components may use their own tracking and measured units.');
 if(!Array.isArray(input.components)||!input.components.length||input.components.length>500)throw new ValidationError('Choose one to 500 component variants.');
 const basis=input.stockBasis||'components';if(!['components','preassembled'].includes(basis))throw new ValidationError('Choose component stock or preassembled kit stock.');
 const parts=new Map();for(const raw of input.components){const quantity=exact.safeNumber(raw.quantity,{positive:true,label:'Component quantity'});if(parts.has(raw.skuId))throw new ValidationError('List each component variant once.');if(raw.skuId===input.kitSkuId)throw new ValidationError('A kit cannot contain itself.');const profile=await require('./stock-quantity').forSku(c,ctx,raw.skuId);require('./stock-quantity').validate(profile,quantity,{label:'Component quantity'});parts.set(raw.skuId,exact.canonical(quantity));}
 const before=current.components.map(p=>({skuId:p.component_sku_id,quantity:p.quantity,stockBasis:p.stock_basis})),at=nowIso();await c.query('DELETE FROM kit_components WHERE workspace_id=$1 AND kit_sku_id=$2',[ctx.workspaceId,input.kitSkuId]);
 for(const [skuId,quantity]of [...parts].sort(([a],[b])=>a.localeCompare(b)))await c.query('INSERT INTO kit_components(id,workspace_id,kit_sku_id,component_sku_id,quantity,stock_basis,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',[newId('kitc'),ctx.workspaceId,input.kitSkuId,skuId,quantity,basis,at]);
 // Validate the new graph before committing any recipe or audit change.
 if(basis==='components')await explode(c,ctx.workspaceId,input.kitSkuId);
 await require('./postgres-sku-maintenance').history(c,ctx,{id:input.kitSkuId,item_id:current.sku.item_id},'kit_recipe',{components:before},{components:[...parts].map(([skuId,quantity])=>({skuId,quantity,stockBasis:basis}))});return definition(c,ctx.workspaceId,input.kitSkuId);
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function snapshotOrderLine(c,ctx,lineId,skuId,quantity){
 const current=await definition(c,ctx.workspaceId,skuId);if(!current.isKit||current.stockBasis==='preassembled')return [];
 const line=(await c.query('SELECT quantity_ordered FROM sales_order_lines WHERE workspace_id=$1 AND id=$2 AND sku_id=$3',[ctx.workspaceId,lineId,skuId])).rows[0];if(!line||exact.canonical(line.quantity_ordered)!==exact.canonical(quantity))throw new ValidationError('The kit snapshot must match this inventory’s exact order line.');if(!Number.isSafeInteger(Number(quantity))||Number(quantity)<1)throw new ValidationError('Order whole kits above zero.');
 const prior=(await c.query('SELECT * FROM sales_order_kit_components WHERE workspace_id=$1 AND sales_order_line_id=$2 ORDER BY component_sku_id',[ctx.workspaceId,lineId])).rows;if(prior.length)return prior;
 const components=await explode(c,ctx.workspaceId,skuId),at=nowIso();for(const part of components)await c.query('INSERT INTO sales_order_kit_components(id,workspace_id,sales_order_line_id,component_sku_id,quantity_per_kit,quantity_required,quantity_fulfilled,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,0,$7,$7)',[newId('sokc'),ctx.workspaceId,lineId,part.skuId,part.quantity,exact.convert(quantity,{numerator:part.quantity,precision:6}),at]);
 return (await c.query('SELECT * FROM sales_order_kit_components WHERE workspace_id=$1 AND sales_order_line_id=$2 ORDER BY component_sku_id',[ctx.workspaceId,lineId])).rows;
}
async function captureOrder(c,ctx,orderId){const lines=(await c.query("SELECT l.id,l.sku_id,l.quantity_ordered FROM sales_order_lines l WHERE l.workspace_id=$1 AND l.sales_order_id=$2 AND EXISTS(SELECT 1 FROM kit_components k WHERE k.workspace_id=l.workspace_id AND k.kit_sku_id=l.sku_id AND k.stock_basis='components')",[ctx.workspaceId,orderId])).rows;for(const line of lines)await snapshotOrderLine(c,ctx,line.id,line.sku_id,line.quantity_ordered);}
module.exports={definition,define,explode,snapshotOrderLine,captureOrder};
