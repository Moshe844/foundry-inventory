'use strict';
const calc=require('./supplier-shutdown-calculation'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const {ValidationError}=require('../domain/errors'),owner=require('../autopilot/team-procedure-source').owner;
async function readFacts(db,ctx,raw){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,147,'suggest');
 const scope=calc.input(raw),supplier=(await db.query("SELECT id,name,email,currency,minimum_order_amount FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,scope.supplierId])).rows[0];
 if(!supplier?.currency)throw new ValidationError('Choose an active known supplier with its recorded currency.');
 await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[scope.locationId]);
 const location=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,scope.locationId])).rows[0];
 if(!location)throw new ValidationError('Choose an active owned warehouse or stock location.');
 const accessible=await require('../operations/postgres-warehouse-access').locations(db,ctx.workspaceId,[location.id]);
 const covered=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active=1 AND custody_agreement_id IS NULL ORDER BY id',[ctx.workspaceId,accessible.map(l=>l.id)])).rows;
 if(covered.length>50)throw new ValidationError('Choose a smaller warehouse scope with at most fifty stock locations per plan.');
 const locationIds=covered.map(l=>l.id),clock=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId),from=require('../accounting/customer-money').addDays(clock.calendarDate,-90);
 if(scope.nextArrivalDate<=clock.calendarDate)throw new ValidationError('This shutdown planning window has ended. Record the next actual supplier dates.');
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
 const incoming=(await db.query(`SELECT l.id,l.sku_id,p.id AS purchase_order_id,p.po_number,p.status,p.expected_date,(l.quantity_units-l.quantity_received_units)::text remaining
  FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
  WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND coalesce(l.destination_location_id,p.destination_location_id)=ANY($3::text[])
   AND p.status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED') AND l.quantity_units>l.quantity_received_units ORDER BY p.id,l.id LIMIT 2501`,[ctx.workspaceId,scope.skuIds,locationIds])).rows;
 if(incoming.length>2500)throw new ValidationError('This supplier plan has more than 2,500 open purchase lines. Review a smaller product scope.');
 const transfer=(await db.query(`SELECT l.sku_id,count(*)::int n FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
  WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND t.destination_location_id=ANY($3::text[]) AND t.status NOT IN ('RECEIVED','CANCELLED') GROUP BY l.sku_id`,[ctx.workspaceId,scope.skuIds,locationIds])).rows;
 const money=require('../domain/currency'),exact=require('../domain/exact-quantity'),warnings=[];
 const rows=products.map(p=>{
  const positions=locationIds.map(id=>stock.get(availability.key(p.sku_id,id))).filter(Boolean);
  if(positions.some(s=>s.onHand<0))throw new ValidationError('Resolve negative stock for '+p.code+' before preparing a shutdown plan.');
  const sum=key=>positions.reduce((n,s)=>exact.add(n,String(s[key]||0)),'0'),d=demand.find(d=>d.sku_id===p.sku_id),open=incoming.filter(l=>l.sku_id===p.sku_id);
  const timely=open.filter(l=>['APPROVED','ORDERED','PARTIALLY_RECEIVED'].includes(l.status)&&l.expected_date&&l.expected_date>=clock.calendarDate&&l.expected_date<=scope.nextArrivalDate);
  const unresolved=open.filter(l=>['DRAFT','AWAITING_APPROVAL'].includes(l.status)||!l.expected_date||l.expected_date<clock.calendarDate);
  if(unresolved.length)warnings.push({skuId:p.sku_id,sku:p.code,reason:'Review existing drafts, missing delivery dates or overdue supplier orders before making another purchase.'});
  if(transfer.some(t=>t.sku_id===p.sku_id))warnings.push({skuId:p.sku_id,sku:p.code,reason:'An incoming internal transfer needs separate review. It is not counted as a supplier delivery.'});
  return {skuId:p.sku_id,issued:d?.issued||'0',issueEvents:d?.issue_events||0,onHand:sum('onHand'),committed:exact.add(sum('committed'),sum('reserved')),incoming:timely.reduce((n,l)=>exact.add(n,l.remaining),'0'),unitsPerPurchaseUnit:String(p.units_per_purchase_unit),orderMultiple:String(p.order_multiple),minimumOrderQuantity:String(p.minimum_order_quantity),unitCostMinor:money.toMinor(String(p.last_unit_cost),supplier.currency)};
 });
 const calculated=calc.calculate(scope,clock.calendarDate,rows);
 if(calculated.deadlinePassed)warnings.push({reason:'The supplier’s last order date has passed. Confirm a new delivery arrangement before preparing a purchase order.'});
 if(supplier.minimum_order_amount!=null&&calculated.rows.some(r=>r.quantityUnits>0)&&calculated.totalMinor<money.toMinor(String(supplier.minimum_order_amount),supplier.currency))warnings.push({reason:'The planned order is below the recorded supplier minimum value. Review the quantity or arrangement separately.'});
 const core={scope,supplier,location,locationIds,today:clock.calendarDate,historyFrom:from,products,rows,incoming,transfer,calculated,warnings};
 return {...core,sourceFingerprint:hash(core)};
}
async function facts(db,ctx,raw){return typeof db.transaction==='function'?db.transaction(c=>readFacts(c,ctx,raw),{isolation:'REPEATABLE READ',retrySafe:true}):readFacts(db,ctx,raw);}
module.exports={facts,owner};
