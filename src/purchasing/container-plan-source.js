'use strict';
const {ValidationError}=require('../domain/errors'),{hash}=require('../pricing/postgres-promotions'),exact=require('../domain/exact-quantity'),packing=require('./container-packing');
const identity=row=>({supplierId:row.supplier_id,warehouseId:row.destination_location_id,currency:row.currency,skuId:row.sku_id,code:row.code,unit:row.unit_label,precision:row.quantity_precision,purchaseUnit:row.purchase_unit,unitsPerPurchaseUnit:exact.canonical(row.units_per_purchase_unit)});
async function orders(db,ctx,chosen,{byNumber=false,lock=false}={}){
 if(!Array.isArray(chosen)||chosen.length<1||chosen.length>20||new Set(chosen).size!==chosen.length)throw new ValidationError('Choose one to twenty different purchase orders.');
 const column=byNumber?'po_number':'id',headers=(await db.query('SELECT p.*,s.name AS supplier_name FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id WHERE p.workspace_id=$1 AND p.'+column+'=ANY($2::text[]) ORDER BY p.id'+(lock?' FOR SHARE OF p':''),[ctx.workspaceId,chosen])).rows;
 if(headers.length!==chosen.length)throw new ValidationError('Every PO must match one purchase order in this inventory.');
 if(headers.some(p=>!['DRAFT','APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED'].includes(p.status)))throw new ValidationError('A selected purchase order was cancelled. Review this planning group.');
 const ids=headers.map(p=>p.id),lines=(await db.query(`SELECT l.id AS line_id,l.line_number,l.destination_location_id AS line_destination_location_id,l.purchase_order_id,l.sku_id,l.quantity_units::text,l.quantity_received_units::text,l.purchase_unit,l.units_per_purchase_unit::text,s.code,s.is_active AS sku_active,i.unit_label,i.quantity_precision::int,i.is_active AS item_active,i.tracking_mode
  FROM purchase_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE l.workspace_id=$1 AND l.purchase_order_id=ANY($2::text[]) ORDER BY l.purchase_order_id,l.line_number,l.id LIMIT 501`+(lock?' FOR SHARE OF l,s,i':''),[ctx.workspaceId,ids])).rows;
 if(!lines.length||lines.length>500)throw new ValidationError('Plan one to 500 purchase-order lines at a time.');
 const places=(await db.query('SELECT id,name,is_active,custody_agreement_id FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id'+(lock?' FOR SHARE':''),[ctx.workspaceId,[...new Set(lines.map(line=>line.line_destination_location_id||headers.find(p=>p.id===line.purchase_order_id).destination_location_id).filter(Boolean))]])).rows;
 const rows=lines.map(line=>{const po=headers.find(p=>p.id===line.purchase_order_id),locationId=line.line_destination_location_id||po.destination_location_id,place=places.find(p=>p.id===locationId),remaining=exact.canonical(exact.subtract(line.quantity_units,line.quantity_received_units),{signed:true});if(!place||!place.is_active||place.custody_agreement_id)throw new ValidationError('Every selected line needs an active owned receiving location before container planning.');if(Number(remaining)<0)throw new ValidationError('An over-received line needs a separate order review before planning.');if(Number(remaining)>0&&(!line.sku_active||!line.item_active))throw new ValidationError('An ordered product was deactivated. Review it before planning.');return {...line,supplier_id:po.supplier_id,supplier_name:po.supplier_name,destination_location_id:locationId,warehouse_name:place.name,currency:po.currency,order_number:po.po_number,remaining};});
 const snapshot={orders:headers.map(p=>({id:p.id,number:p.po_number,supplierId:p.supplier_id,warehouseId:p.destination_location_id,currency:p.currency,status:p.status})),lines:rows.map(row=>({lineId:row.line_id,lineNumber:row.line_number,orderId:row.purchase_order_id,orderNumber:row.order_number,identity:identity(row),ordered:row.quantity_units,received:row.quantity_received_units,remaining:row.remaining}))};
 return {headers,rows,snapshot,fingerprint:hash(snapshot)};
}
function packageInput(row,input){
 if(input.lineId!==row.line_id)throw new ValidationError('Every packing measurement must identify the exact selected PO line.');
 const units=exact.canonical(input.unitsPerCarton,{scale:row.quantity_precision}),profile=identity(row),source=String(input.sourceReference||'').trim();
 if(Number(units)<=0||Number(units)>1000000000||!source||source.length>500)throw new ValidationError('Enter the stock units per carton and the original packing measurement or supplier specification reference.');
 const pack={...packing.pack(input),unitsPerCarton:units},scopeHash=hash(profile),profileHash=hash({identity:profile,pack,sourceReference:source});
 return {lineId:row.line_id,scopeHash,identity:profile,pack,sourceReference:source,profileHash};
}
function cartons(row,profile){
 // BigInt division keeps fractional cartons explicit at every stock precision.
 const scale=text=>{const [a,b='']=exact.canonical(text).split('.');return BigInt(a)*1000000000n+BigInt(b.padEnd(9,'0'));};
 const quantity=scale(row.remaining),units=scale(profile.pack.unitsPerCarton);if(quantity%units!==0n)throw new ValidationError(row.code+' has '+row.remaining+' '+row.unit_label+' remaining, which is not a whole number of the confirmed cartons. Review its packaging or order quantity; no loose units were rounded.');
 const n=quantity/units;if(n>2000n)throw new ValidationError('Plan up to 2,000 cartons at a time. Split this order group.');
 return Number(n);
}
function loadLines(facts,profiles){
 if(profiles.length!==facts.rows.length||new Set(profiles.map(p=>p.lineId)).size!==profiles.length)throw new ValidationError('The selected order lines changed. Review every packing profile again.');
 return facts.rows.map(row=>{const profile=profiles.find(p=>p.lineId===row.line_id);if(!profile||hash(identity(row))!==profile.scopeHash||hash(profile.identity)!==profile.scopeHash||hash({identity:profile.identity,pack:profile.pack,sourceReference:profile.sourceReference})!==profile.profileHash)throw new ValidationError('The supplier, receiving warehouse, currency, SKU or purchase-unit profile changed. Review the packing measurements again.');return {lineId:row.line_id,skuId:row.sku_id,cartons:cartons(row,profile),pack:profile.pack};}).filter(row=>row.cartons>0);
}
function calculate(spec,facts,profiles){const lines=loadLines(facts,profiles);return lines.length?packing.calculate(spec,lines):{algorithm:'supported-guillotine-v1',placed:[],rows:[],loads:[],cartons:0,loaded:0,remaining:0};}
module.exports={identity,orders,packageInput,loadLines,calculate};
