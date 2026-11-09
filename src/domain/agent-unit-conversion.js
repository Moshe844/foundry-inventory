'use strict';
const exact=require('./exact-quantity'),policy=require('../commercial/agent-plan');
const {ValidationError}=require('./errors');
// Exact SI definitions. The stored stock precision is checked separately.
const measures={kg:['mass','1000'],g:['mass','1'],lb:['mass','453.59237'],oz:['mass','28.349523125'],
  m:['length','1000'],cm:['length','10'],mm:['length','1'],in:['length','25.4'],ft:['length','304.8'],
  l:['volume','1000'],ml:['volume','1']};
async function read(db,ctx,args){
  await policy.requireWorkspaceJob(db,ctx.workspaceId,134,'automatic');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
  const permissions=require('../actions/permissions'),actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  permissions.assertCan(actor,permissions.VIEW,'convert product units');
  const code=String(args.sku||'').trim(),unit=String(args.fromUnit||'').trim().toLowerCase();
  const rows=(await db.query(`SELECT s.id,s.item_id,s.code,i.unit_label,i.quantity_precision,i.quantity_increment,i.tracking_mode
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND lower(s.code)=lower($2) AND s.is_active=1 AND i.is_active=1 LIMIT 2`,[ctx.workspaceId,code])).rows;
  if(rows.length!==1)throw new ValidationError('Choose one active SKU for this unit conversion.');
  const product=rows[0],quantity=exact.canonical(args.unitQuantity),base=product.unit_label.toLowerCase();
  let converted,basis;
  if(unit===base){converted=quantity;basis='Product stocking unit';}
  else if(measures[unit]&&measures[base]&&measures[unit][0]===measures[base][0]){
    converted=exact.convert(quantity,{numerator:measures[unit][1],denominator:measures[base][1]});basis='Exact unit definition';
  }else{
    const packs=(await db.query(`SELECT si.purchase_unit,si.units_per_purchase_unit,v.name FROM supplier_items si
      JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id
      WHERE si.workspace_id=$1 AND si.sku_id=$2 AND si.is_active=1 AND v.status='active'
        AND lower(si.purchase_unit)=lower($3) AND ($4='' OR lower(v.name)=lower($4)) ORDER BY v.name,si.id LIMIT 2`,
      [ctx.workspaceId,product.id,unit,String(args.supplier||'').trim()])).rows;
    if(packs.length!==1)throw new ValidationError(packs.length?'Choose the supplier whose pack size applies.':'Save the supplier pack size or choose a compatible measured unit.');
    converted=exact.convert(quantity,{numerator:packs[0].units_per_purchase_unit});basis=packs[0].name+' · '+packs[0].units_per_purchase_unit+' '+product.unit_label+' per '+packs[0].purchase_unit;
  }
  let usable=true,explanation='Matches the product stocking precision and increment.';
  try{require('./stock-quantity').validate(product,converted,{positive:false});}
  catch(error){if(!(error instanceof ValidationError))throw error;usable=false;explanation=error.message;}
  return {rows:[{SKU:product.code,'Source quantity':quantity,'Source unit':unit,'Stock quantity':converted,'Stock unit':product.unit_label,
    Basis:basis,'Ready to record':usable?'Yes':'Review quantity',Review:explanation}],
    sources:[{kind:'page',href:'/inventory/'+product.item_id,label:product.code}],coverage:'Exact conversion using current saved product and supplier units.'};
}
module.exports={read};
