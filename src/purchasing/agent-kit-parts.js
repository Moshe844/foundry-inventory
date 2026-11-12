'use strict';
const {ValidationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),exact=require('../domain/exact-quantity');
const kits=require('../domain/postgres-kit-service'),availability=require('../domain/postgres-kit-availability');
const {hash}=require('../pricing/postgres-promotions');
async function build(db,ctx,_row,args){
  await policy.requireWorkspaceJob(db,ctx.workspaceId,13,'draft');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
  const target=Number(args.quantity);
  if(!Number.isSafeInteger(target)||target<1||target>1000000)throw new ValidationError('Choose one to one million complete kits.');
  const kit=(await db.query(`SELECT s.id,s.code FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND lower(s.code)=lower($2) AND s.is_active=1 AND i.is_active=1 LIMIT 2`,[ctx.workspaceId,String(args.sku||'').trim()])).rows;
  const locations=(await db.query("SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL AND lower(name)=lower($2) LIMIT 2",[ctx.workspaceId,String(args.location||'').trim()])).rows;
  if(kit.length!==1||locations.length!==1)throw new ValidationError('Choose one active kit SKU and one receiving warehouse by exact name.');
  const definition=await kits.definition(db,ctx.workspaceId,kit[0].id);
  if(!definition.isKit||definition.stockBasis!=='components')throw new ValidationError('Choose a kit assembled from component stock.');
  const parts=await kits.explode(db,ctx.workspaceId,kit[0].id),stock=await availability.stock(db,ctx.workspaceId,parts.map(p=>p.skuId));
  const orders=new Map(),evidence=[];
  for(const part of parts){
    const available=stock.get(JSON.stringify([part.skuId,locations[0].id]))||0;
    const supply=(await db.query(`SELECT coalesce(sum(greatest(l.quantity_units-l.quantity_received_units,0))
        FILTER (WHERE to_jsonb(l)->>'supplier_supply_hold_id' IS NULL),0) AS units,
      min(o.po_number) FILTER (WHERE to_jsonb(l)->>'supplier_supply_hold_id' IS NOT NULL
        AND l.quantity_units>l.quantity_received_units) AS held_order
      FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
      WHERE l.workspace_id=$1 AND l.sku_id=$2 AND l.destination_location_id=$3
      AND coalesce(to_jsonb(o)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
      AND (o.status IN ('ORDERED','PARTIALLY_RECEIVED') OR o.status IN ('DRAFT','AWAITING_APPROVAL')
        AND o.source='foundry_recommendation' AND o.source_detail::jsonb->>'kit'=$4)`,[ctx.workspaceId,part.skuId,locations[0].id,kit[0].code])).rows[0];
    const incoming=Number(supply.units);
    const required=exact.convert(target,{numerator:part.quantity}),short=Math.max(0,exact.safeNumber(exact.subtract(exact.subtract(required,available),incoming),{signed:true}));
    const offers=(await db.query(`SELECT si.*,v.name,v.currency,v.minimum_order_amount,v.freight_terms_currency,v.free_freight_threshold_minor,v.ordinary_freight_minor,s.code
      FROM supplier_items si JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id JOIN skus s ON s.workspace_id=si.workspace_id AND s.id=si.sku_id
      WHERE si.workspace_id=$1 AND si.sku_id=$2 AND si.is_active=1 AND v.status='active'
      ORDER BY si.is_preferred DESC,si.id LIMIT 2`,[ctx.workspaceId,part.skuId])).rows;
    evidence.push({part,available,incoming,offers});
    if(!short)continue;
    if(supply.held_order)throw new ValidationError('Review supplier availability on '+supply.held_order+' before buying this kit component again.');
    if(!offers.length||offers.length>1&&Number(offers[0].is_preferred)===Number(offers[1].is_preferred)||offers[0].last_unit_cost==null)
      throw new ValidationError('Save one preferred supplier and its current cost for each missing component.');
    const offer=offers[0],quantity=require('./agent-order-quantities').quantities(offer,short,true);
    if(quantity.blocked)throw new ValidationError(quantity.blocked);
    const profile=await require('../domain/stock-quantity').forSku(db,ctx,part.skuId);
    require('../domain/stock-quantity').validate(profile,quantity.quantity,{positive:true});
    if(!orders.has(offer.supplier_id))orders.set(offer.supplier_id,{supplierId:offer.supplier_id,currency:offer.currency,destinationLocationId:locations[0].id,lines:[]});
    orders.get(offer.supplier_id).lines.push({skuId:part.skuId,quantityUnits:quantity.quantity,quantityPurchaseUnits:quantity.purchaseUnits,
      unitsPerPurchaseUnit:quantity.unitsPer,purchaseUnit:offer.purchase_unit,unitCost:quantity.unitCost,destinationLocationId:locations[0].id});
  }
  if(!orders.size)throw new ValidationError('Available parts and incoming or drafted purchases already cover this kit target.');
  const input={sku:kit[0].code,location:locations[0].name,quantity:target},output=[...orders.values()];
  return {payload:{input,reviewedHash:hash({input,evidence,output})},output,
    summary:'Prepare '+output.length+' supplier draft orders for missing parts to build '+target+' '+kit[0].code+' kits at '+locations[0].name+'. '+
      output.flatMap(o=>o.lines.map(l=>l.quantityUnits+' component units')).join(', ')+'.'};
}
const spec={name:'kit.replenish_parts',description:'Prepare supplier purchase drafts for the missing parts of an exact kit target at one warehouse. Deduct usable stock and incoming purchases and respect supplier packs.',
  fields:['sku','location','quantity'],permission:require('../actions/permissions').APPROVE_PO,ownerOnly:true,capability:'purchasing.core',build,
  execute:async(db,ctx,p)=>{
    const current=await build(db,ctx,null,p.input);
    if(current.payload.reviewedHash!==p.reviewedHash)throw new ValidationError('The kit recipe, stock, incoming orders or supplier terms changed. Review the parts again.');
    const drafts=[];
    for(const [index,input] of current.output.entries())drafts.push((await require('../operations/postgres-business-workflows').createPurchaseOrderInTransaction(db,ctx,
      {...input,source:'foundry_recommendation',sourceDetail:{kit:p.input.sku,target:p.input.quantity},idempotencyKey:'kit-parts:'+p.reviewedHash+':'+index})).purchaseOrderId);
    return {drafts};
  },verify:async(db,ctx,result)=>{
    const rows=(await db.query("SELECT id,status FROM purchase_orders WHERE workspace_id=$1 AND id=ANY($2::text[])",[ctx.workspaceId,result.drafts])).rows;
    return rows.length===result.drafts.length&&rows.every(r=>r.status==='DRAFT');
  }};
// The kit review lives in agent-kit-reorders; this Ask action drafts the parts
// for an exact number of kits at one warehouse.
module.exports={review:(...args)=>require('./agent-kit-reorders').review(...args),spec};
