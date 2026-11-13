'use strict';
const policy=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors'),owner=require('../autopilot/team-procedure-source').owner;
async function inventoryFacts(db,ctx,scope,{jobId,incomingBy}){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,jobId,'suggest');
 const supplier=(await db.query("SELECT id,name,email,currency,minimum_order_amount FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,scope.supplierId])).rows[0];
 if(!supplier?.currency)throw new ValidationError('Choose an active known supplier with its recorded currency.');
 await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[scope.locationId]);
 const location=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,scope.locationId])).rows[0];
 if(!location)throw new ValidationError('Choose an active owned warehouse or stock location.');
 const accessible=await require('../operations/postgres-warehouse-access').locations(db,ctx.workspaceId,[location.id]);
 const covered=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active=1 AND custody_agreement_id IS NULL ORDER BY id',[ctx.workspaceId,accessible.map(l=>l.id)])).rows;
 if(covered.length>50)throw new ValidationError('Choose a smaller warehouse scope with at most fifty stock locations per plan.');
 const locationIds=covered.map(l=>l.id),clock=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId),from=require('../accounting/customer-money').addDays(clock.calendarDate,-90);
 const products=(await db.query(`SELECT s.id AS sku_id,s.code,i.name,i.unit_label,i.quantity_precision,i.secondary_unit_label,i.tracking_mode,
  si.id AS supplier_item_id,si.purchase_unit,si.units_per_purchase_unit,si.minimum_order_quantity,si.order_multiple,si.last_unit_cost
  FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  JOIN supplier_items si ON si.workspace_id=s.workspace_id AND si.sku_id=s.id AND si.supplier_id=$3 AND si.is_active=1
  WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 ORDER BY s.id`,[ctx.workspaceId,scope.skuIds,supplier.id])).rows;
 if(products.length!==scope.skuIds.length||new Set(products.map(p=>p.sku_id)).size!==scope.skuIds.length)throw new ValidationError('Every selected product needs one current supplier link in this inventory.');
 if(products.some(p=>p.tracking_mode!=='quantity'||Number(p.quantity_precision)!==0||p.secondary_unit_label))throw new ValidationError('This planning workflow currently covers whole-unit quantity stock. Review lots, serials and measured stock separately.');
 if(products.some(p=>p.units_per_purchase_unit==null||p.minimum_order_quantity==null||p.order_multiple==null||p.last_unit_cost==null||!p.purchase_unit))throw new ValidationError('Record each product’s supplier pack, minimum, order multiple, purchase unit and current cost before planning. Missing terms are never assumed.');
 const positions=products.flatMap(p=>locationIds.map(locationId=>({skuId:p.sku_id,locationId}))),availability=require('../domain/postgres-stock-availability'),stock=await availability.readMany(db,ctx.workspaceId,positions);
 const demand=(await db.query(`SELECT sku_id,count(*)::int issue_events,sum(issued)::text issued FROM stockchief_runtime.replenishment_demand_events
  WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND location_id=ANY($3::text[]) AND occurred_at>=$4::timestamptz AND occurred_at<$5::timestamptz GROUP BY sku_id`,[ctx.workspaceId,scope.skuIds,locationIds,require('../lib/business-time').dayBoundary(from,clock.timeZone),require('../lib/business-time').dayBoundary(clock.calendarDate,clock.timeZone)])).rows;
 const incoming=(await db.query(`SELECT l.id,l.sku_id,p.id AS purchase_order_id,p.po_number,p.status,p.expected_date,
   to_jsonb(l)->>'supplier_supply_hold_id' AS supply_hold,(l.quantity_units-l.quantity_received_units)::text remaining
  FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
  WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND coalesce(l.destination_location_id,p.destination_location_id)=ANY($3::text[])
   AND p.status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED')
   AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
   AND l.quantity_units>l.quantity_received_units ORDER BY p.id,l.id LIMIT 2501`,[ctx.workspaceId,scope.skuIds,locationIds])).rows;
 if(incoming.length>2500)throw new ValidationError('This supplier plan has more than 2,500 open purchase lines. Review a smaller product scope.');
 const transfer=(await db.query(`SELECT l.sku_id,count(*)::int n FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
  WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND t.destination_location_id=ANY($3::text[]) AND t.status NOT IN ('RECEIVED','CANCELLED') GROUP BY l.sku_id`,[ctx.workspaceId,scope.skuIds,locationIds])).rows;
 const money=require('../domain/currency'),exact=require('../domain/exact-quantity'),warnings=[];
 const rows=products.map(p=>{
  const positions=locationIds.map(id=>stock.get(availability.key(p.sku_id,id))).filter(Boolean);
  if(positions.some(s=>s.onHand<0))throw new ValidationError('Resolve negative stock for '+p.code+' before preparing a stock plan.');
  const sum=key=>positions.reduce((n,s)=>exact.add(n,String(s[key]||0)),'0'),d=demand.find(d=>d.sku_id===p.sku_id),open=incoming.filter(l=>l.sku_id===p.sku_id);
  const timely=open.filter(l=>!l.supply_hold&&['APPROVED','ORDERED','PARTIALLY_RECEIVED'].includes(l.status)&&l.expected_date&&l.expected_date>=clock.calendarDate&&l.expected_date<=incomingBy);
  const unresolved=open.filter(l=>l.supply_hold||['DRAFT','AWAITING_APPROVAL'].includes(l.status)||!l.expected_date||l.expected_date<clock.calendarDate);
  if(unresolved.length)warnings.push({skuId:p.sku_id,sku:p.code,reason:'Review supplier availability, existing drafts, missing delivery dates or overdue orders before making another purchase.'});
  if(transfer.some(t=>t.sku_id===p.sku_id))warnings.push({skuId:p.sku_id,sku:p.code,reason:'An incoming internal transfer needs separate review. It is not counted as a supplier delivery.'});
  return {skuId:p.sku_id,issued:d?.issued||'0',issueEvents:d?.issue_events||0,onHand:sum('onHand'),committed:exact.add(sum('committed'),sum('reserved')),incoming:timely.reduce((n,l)=>exact.add(n,l.remaining),'0'),unitsPerPurchaseUnit:String(p.units_per_purchase_unit),orderMultiple:String(p.order_multiple),minimumOrderQuantity:String(p.minimum_order_quantity),unitCostMinor:money.toMinor(String(p.last_unit_cost),supplier.currency)};
 });
 const sourceOrders=incoming.map(({supply_hold,...line})=>supply_hold?{...line,supply_hold}:line);
 return {scope,supplier,location,locationIds,today:clock.calendarDate,historyFrom:from,products,rows,incoming:sourceOrders,transfer,warnings};
}
// Turns what the owner typed into one exact plan scope per supplier.
//   - Several suppliers, one per line, share one closure or promotion
//     (for example Chinese New Year for every supplier in China).
//   - With no SKU codes, each supplier's own products are planned: products
//     it is the main supplier for (preferred, or the only one) that had at
//     least two recorded issues in this warehouse in the last 90 days.
//     Products that need their supplier terms first are listed, not guessed.
//   - With SKU codes and no supplier (allowNoSupplier), each product goes to
//     its main supplier, so one promotion drafts one order per supplier.
async function scopes(db,ctx,input,{allowNoSupplier=false}={}){
 const resolved={...input};
 if(!resolved.locationId){
  const text=String(input.locationName||'').trim();if(!text||text.length>240)throw new ValidationError('Enter the exact name of a warehouse you own.');
  const rows=(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND lower(name)=lower($2) AND is_active=1 AND custody_agreement_id IS NULL LIMIT 2',[ctx.workspaceId,text])).rows;
  if(rows.length!==1)throw new ValidationError('The stock location name must match one active record in this inventory.');resolved.locationId=rows[0].id;
 }
 if(resolved.skuIds){if(!resolved.supplierId)throw new ValidationError('Choose the supplier for these products.');return {scopes:[resolved],notes:[]};}
 let suppliers=resolved.supplierId?[String(resolved.supplierId)]:null;
 if(!suppliers){
  const names=[...new Map(String(input.supplierName||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(n=>[n.toLowerCase(),n])).values()];
  if(names.length>20||names.some(n=>n.length>240))throw new ValidationError('Enter up to 20 exact supplier names, one per line.');
  if(!names.length&&!allowNoSupplier)throw new ValidationError('Enter the exact known supplier and owned warehouse names.');
  if(names.length){
   suppliers=[];
   for(const name of names){
    const rows=(await db.query("SELECT id FROM suppliers WHERE workspace_id=$1 AND lower(name)=lower($2) AND status='active' LIMIT 2",[ctx.workspaceId,name])).rows;
    if(rows.length!==1)throw new ValidationError('The supplier name '+name+' must match one active record in this inventory.');
    suppliers.push(rows[0].id);
   }
  }
 }
 const codes=String(input.skuCodes||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 if(codes.length>250||new Set(codes.map(s=>s.toLowerCase())).size!==codes.length)throw new ValidationError('Enter one to 250 distinct StockChief SKU codes, one per line.');
 if(!codes.length&&!suppliers)throw new ValidationError('Enter the products to plan, one SKU code per line.');
 let skuIds=[];
 if(codes.length){
  const rows=(await db.query('SELECT id FROM skus WHERE workspace_id=$1 AND lower(code)=ANY($2::text[]) AND is_active=1 ORDER BY code,id',[ctx.workspaceId,codes.map(s=>s.toLowerCase())])).rows;
  if(rows.length!==codes.length)throw new ValidationError('Match each entered SKU to one active product in this inventory.');skuIds=rows.map(r=>r.id);
 }
 const linkSql=`SELECT si.sku_id,si.supplier_id,si.is_preferred,s.code FROM supplier_items si JOIN suppliers p ON p.workspace_id=si.workspace_id AND p.id=si.supplier_id AND p.status='active'
  JOIN skus s ON s.workspace_id=si.workspace_id AND s.id=si.sku_id WHERE si.workspace_id=$1 AND si.is_active=1 AND si.sku_id=ANY($2::text[]) ORDER BY si.sku_id,si.supplier_id`;
 if(!codes.length)skuIds=(await db.query('SELECT DISTINCT sku_id FROM supplier_items WHERE workspace_id=$1 AND is_active=1 AND supplier_id=ANY($2::text[])',[ctx.workspaceId,suppliers])).rows.map(r=>r.sku_id);
 const links=(await db.query(linkSql,[ctx.workspaceId,skuIds])).rows;
 const main=id=>{const own=links.filter(l=>l.sku_id===id);return (own.find(l=>Number(l.is_preferred))||(own.length===1?own[0]:null))?.supplier_id||null;};
 const groups=new Map((suppliers||[]).map(id=>[id,[]])),notes=[];
 if(codes.length){
  for(const id of skuIds){
   const code=links.find(l=>l.sku_id===id)?.code||(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0].code;
   let supplierId=null;
   if(!suppliers){supplierId=main(id);if(!supplierId)throw new ValidationError('Record the supplier you buy '+code+' from, or enter the supplier name.');}
   else if(suppliers.length===1)supplierId=suppliers[0];
   else{
    const chosen=links.filter(l=>l.sku_id===id&&suppliers.includes(l.supplier_id));
    supplierId=chosen.length===1?chosen[0].supplier_id:chosen.some(l=>l.supplier_id===main(id))?main(id):null;
    if(!supplierId)throw new ValidationError(chosen.length?code+' comes from more than one of these suppliers. Plan it with one supplier at a time.':code+' is not bought from any of these suppliers.');
   }
   if(!groups.has(supplierId))groups.set(supplierId,[]);groups.get(supplierId).push(id);
  }
 }else{
  const clock=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId),time=require('../lib/business-time');
  const from=require('../accounting/customer-money').addDays(clock.calendarDate,-90);
  const scope=(await require('../operations/postgres-warehouse-access').locations(db,ctx.workspaceId,[resolved.locationId])).map(l=>l.id);
  const owned=skuIds.filter(id=>suppliers.includes(main(id)));
  const sold=new Set((await db.query(`SELECT sku_id FROM stockchief_runtime.replenishment_demand_events WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND location_id=ANY($3::text[])
   AND occurred_at>=$4::timestamptz AND occurred_at<$5::timestamptz GROUP BY sku_id HAVING count(*)>=2`,[ctx.workspaceId,owned,scope,time.dayBoundary(from,clock.timeZone),time.dayBoundary(clock.calendarDate,clock.timeZone)])).rows.map(r=>r.sku_id));
  const facts=(await db.query(`SELECT s.id,s.code,si.supplier_id,i.tracking_mode,i.quantity_precision,i.secondary_unit_label,si.units_per_purchase_unit,si.minimum_order_quantity,si.order_multiple,si.last_unit_cost,si.purchase_unit
   FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id JOIN supplier_items si ON si.workspace_id=s.workspace_id AND si.sku_id=s.id AND si.is_active=1
   WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 ORDER BY s.code,s.id`,[ctx.workspaceId,[...sold]])).rows;
  for(const p of facts){
   if(p.supplier_id!==main(p.id))continue;
   const reason=p.tracking_mode!=='quantity'||Number(p.quantity_precision)!==0||p.secondary_unit_label?'Plan lots, serials and measured stock separately.':
    p.units_per_purchase_unit==null||p.minimum_order_quantity==null||p.order_multiple==null||p.last_unit_cost==null||!p.purchase_unit?'Record its supplier pack, minimum, order multiple and cost first.':null;
   if(reason)notes.push({supplierId:p.supplier_id,sku:p.code,reason});else groups.get(p.supplier_id).push(p.id);
  }
 }
 const result=[];
 for(const [supplierId,ids] of groups){
  if(ids.length>250)throw new ValidationError('One supplier has more than 250 products to plan. Enter the SKU codes to plan in smaller groups.');
  if(!ids.length){notes.push({supplierId,reason:codes.length?'None of the SKU codes entered come from this supplier.':'None of its products sold at least twice in this warehouse in the last 90 days, so there is nothing to plan.'});continue;}
  result.push({...input,supplierId,locationId:resolved.locationId,skuIds:[...ids].sort()});
 }
 if(notes.length){const names=new Map((await db.query('SELECT id,name FROM suppliers WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,notes.map(n=>n.supplierId)])).rows.map(r=>[r.id,r.name]));for(const n of notes)n.supplier=names.get(n.supplierId);}
 return {scopes:result,notes};
}
module.exports={inventoryFacts,owner,scopes};
