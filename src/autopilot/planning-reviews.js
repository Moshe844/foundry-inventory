'use strict';

const {ValidationError}=require('../domain/errors');
const planning=require('../forecasting/postgres-planning-service');
const {requiredUnits}=require('../purchasing/replenishment-decision');

// Read at most 25 complete SKUs per page. Locations for a SKU stay together.
async function positions(db,ctx,{page,filter}){
  const result=await db.query(`SELECT s.id FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR lower(s.code)=lower($2))
    ORDER BY s.code,s.id LIMIT 26 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*25]);
  const ids=result.rows.slice(0,25).map(r=>r.id);
  return {items:ids.length?await planning.position(db,ctx.workspaceId,{onlySkuIds:ids}):[],ids,more:result.rows.length>25};
}

async function reorder(db,ctx,options){
  const {items,more}=await positions(db,ctx,options);
  const ids=[...new Set(items.map(r=>r.sku_id))],usable=await require('../domain/postgres-kit-availability').stock(db,ctx.workspaceId,ids);
  const incoming=(await db.query(`SELECT l.sku_id,coalesce(l.destination_location_id,o.destination_location_id) location_id,o.po_number,o.expected_date,o.status,
   (l.quantity_units-l.quantity_received_units)::text remaining,to_jsonb(l)->>'supplier_supply_hold_id' AS supply_hold
   FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id
   WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND o.status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED')
   AND coalesce(to_jsonb(o)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
   AND l.quantity_units>l.quantity_received_units
   UNION ALL SELECT l.sku_id,t.destination_location_id,coalesce(t.reference,t.id),t.expected_arrival_date,t.status,
   (CASE t.status WHEN 'REQUESTED' THEN l.requested_quantity WHEN 'APPROVED' THEN l.approved_quantity WHEN 'PICKED' THEN l.picked_quantity ELSE l.shipped_quantity-l.received_quantity-l.lost_quantity-l.damaged_quantity END)::text,NULL
   FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
   WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND t.status IN ('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')
   ORDER BY expected_date NULLS LAST,po_number`,[ctx.workspaceId,ids])).rows;
  const cost=(await db.query('SELECT sku_id,location_id,quantity_units::text FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[])',[ctx.workspaceId,ids])).rows;
  const kitCapacity=await require('../domain/postgres-kit-availability').read(db,ctx.workspaceId,ids);
  const exact=require('../domain/exact-quantity'),key=require('../domain/postgres-stock-availability').key;
  const rows=items.filter(r=>!r.planning_suppressed).map(r=>{
   const pending=incoming.filter(l=>l.sku_id===r.sku_id&&(!r.location_id||r.location_id===l.location_id)),drafts=pending.filter(l=>['DRAFT','AWAITING_APPROVAL'].includes(l.status));
   const uncertain=pending.filter(l=>!['DRAFT','AWAITING_APPROVAL'].includes(l.status)&&(l.supply_hold||!l.expected_date||l.expected_date<options.today));
   const kit=kitCapacity.get(r.sku_id),available=kit?(r.location_id?kit.locations.find(l=>l.locationId===r.location_id)?.buildable||0:kit.buildable):r.location_id?usable.get(key(r.sku_id,r.location_id))||0:items.filter(p=>p.sku_id===r.sku_id&&p.location_id).reduce((n,p)=>n+(usable.get(key(p.sku_id,p.location_id))||0),0);
   const costKnown=r.onHand<=0||cost.filter(v=>v.sku_id===r.sku_id&&(!r.location_id||v.location_id===r.location_id)).reduce((n,v)=>n+Number(v.quantity_units),0)>=r.onHand;
   const target=r.targetStock??r.effectiveReorder,projected=exact.safeNumber(exact.add(String(available),String(r.incoming))),short=r.effectiveReorder!==null&&projected<=r.effectiveReorder;
   return {SKU:r.code,Warehouse:r.location_name,Available:available,Incoming:r.incoming,
    'Issued in 90 days':r.issued,'Daily sales speed':r.dailyRate,'Lead days':r.lead_time_assumed?'Unknown':r.leadTimeDays,'Reorder point':r.effectiveReorder,'Target stock':target,
    'Open drafts':drafts.map(l=>l.po_number).join(', ')||null,'Incoming dates':pending.filter(l=>!['DRAFT','AWAITING_APPROVAL'].includes(l.status)).map(l=>l.po_number+': '+(l.expected_date||'Unknown')+' ('+l.remaining+')').join('; ')||null,
    'Units to order':!costKnown||uncertain.length||drafts.length||r.lead_time_assumed&&r.reorderPoint===null?null:short?Math.max(0,exact.safeNumber(exact.subtract(String(target??0),String(projected)),{signed:true})):0,
    Reason:!costKnown?'Complete the recorded stock cost before reordering':uncertain.length?'Confirm overdue or undated incoming and supplier availability before ordering again':drafts.length?'Review existing unsent purchase drafts':r.lead_time_assumed&&r.reorderPoint===null?'Record supplier lead time before deriving a stock target':r.effectiveReorder===null?'Set a reorder point or record more demand':short?'Usable available stock plus incoming is at or below the reorder point':'Usable available stock plus incoming exceeds the reorder point',link:'/inventory/'+r.item_id};
  });
  return {rows,more,reorderForm:true,summary:'Planning shows exact usable stock after commitments, dated incoming, recorded sales speed, supplier lead time and the saved target. Unknown delivery facts or existing unsent drafts hold a new order. Supplier packs, minimums and competitive choice are reviewed separately before native drafts are created.'};
}

async function demandScenario(db,ctx,options){
  const raw=String(options.change??'').trim();
  if(!raw)return {rows:[],more:false,summary:'Enter the percentage change in sales to compare the next 30 days with recent shipments.'};
  if(!/^[+-]?\d{1,4}(?:\.\d{1,2})?$/.test(raw)||Number(raw)<-100||Number(raw)>1000)throw new ValidationError('Enter a sales change between -100% and 1,000%.');
  const change=Number(raw),{items,ids,more}=await positions(db,ctx,options);
  const shipments=await db.query(`SELECT l.sku_id,l.location_id,sum(l.quantity) AS units
    FROM sales_shipment_lines l JOIN sales_shipments h ON h.workspace_id=l.workspace_id AND h.id=l.shipment_id
    WHERE l.workspace_id=$1 AND l.sku_id=ANY($2) AND h.status IN ('SHIPPED','DELIVERED') AND h.customer_return_id IS NULL
      AND h.shipped_at::timestamptz BETWEEN now()-interval '90 days' AND now() GROUP BY l.sku_id,l.location_id`,[ctx.workspaceId,ids]);
  const byLocation=new Map();
  for(const s of shipments.rows){
    if(!byLocation.has(s.sku_id))byLocation.set(s.sku_id,new Map());
    byLocation.get(s.sku_id).set(s.location_id,Number(s.units));
  }
  const rows=items.filter(r=>r.location_id).map(r=>{
    const units=byLocation.get(r.sku_id)?.get(r.location_id)||0;
    const base=units/3,scenario=base*(1+change/100);
    const rounded=n=>Math.round(n*100)/100;
    return {SKU:r.code,Warehouse:r.location_name,'Shipped in 90 days':units,'Available now':r.available,
      'Expected incoming':r.incoming,'Baseline 30-day sales':rounded(base),'Scenario 30-day sales':rounded(scenario),
      'Additional units needed from today’s stock':rounded(Math.max(0,scenario-Math.max(0,r.available))),
      Evidence:units?'Recorded shipments':'No shipments in the window',link:'/inventory/'+r.item_id};
  });
  return {rows,more,summary:'With a '+change+'% change in demand, estimated sales use the last 90 days of customer shipments. Expected incoming is shown separately because its arrival date can change.'};
}

module.exports=[
  {id:144,key:'seasonal-demand',label:'Forecast sales by SKU',readPage:require('../forecasting/postgres-agent-forecast').demand},
  {id:146,key:'new-product-forecast',label:'Forecast a new product from similar items',readPage:require('../forecasting/postgres-agent-forecast').similarProducts},
  {id:151,key:'stockout-cost',label:'Estimate stockout dates and margin at risk',readPage:stockout},
  {id:19,key:'reorder-drafts',label:'Draft reorders grouped by supplier',readPage:async(c,ctx,o)=>({...await reorder(c,ctx,o),reorderForm:true})},
  {id:18,key:'reorder-explanation',label:'Explain what to order and why',readPage:reorder},
  {id:149,key:'demand-scenario',label:'Compare a change in sales demand',readPage:demandScenario,requiresChange:true}
];

async function stockout(db,ctx,options){
  const {items,ids,more}=await positions(db,ctx,options);
  const values=await db.query(`SELECT s.id,book.base_currency,price.amount_minor AS sale,price.currency AS sale_currency,
    cost.amount_minor AS cost,cost.currency AS cost_currency FROM skus s
    LEFT JOIN accounting_settings book ON book.workspace_id=s.workspace_id AND book.enabled=1
    LEFT JOIN LATERAL (SELECT amount_minor,currency FROM sku_prices p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id
      ORDER BY created_at DESC,id DESC LIMIT 1) price ON true
    LEFT JOIN LATERAL (SELECT amount_minor,currency FROM sku_purchase_costs p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id
      ORDER BY created_at DESC,id DESC LIMIT 1) cost ON true
    WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])`,[ctx.workspaceId,ids]);
  const terms=new Map(values.rows.map(row=>[row.id,row]));
  const money=require('../domain/currency'),{addDays}=require('../accounting/customer-money');
  const rows=items.filter(r=>r.location_id).map(row=>{
    const days=row.dailyRate>0?Math.max(0,Math.floor(row.available/row.dailyRate)):null;
    const t=terms.get(row.sku_id);
    const known=t.sale!=null && t.cost!=null && t.sale_currency===t.base_currency && t.cost_currency===t.base_currency;
    const margin=known?Math.max(0,Number(t.sale)-Number(t.cost)):null;
    const dailyMargin=margin==null?null:Math.round(row.dailyRate*margin);
    return {SKU:row.code,Warehouse:row.location_name,'Available now':row.available,'Expected incoming':row.incoming,
      'Estimated runout':days==null||days>36525?null:addDays(options.today,days),
      'Estimated daily gross margin at risk':days!=null && Number.isSafeInteger(dailyMargin)?money.format(dailyMargin,t.base_currency):null,
      Evidence:days==null?'No recorded demand in 90 days':days>36525?'Beyond the 100-year projection window':!known?'Selling price or purchase cost unavailable in the inventory currency':'Current selling price less purchase cost',link:'/inventory/'+row.item_id};
  });
  return {rows,more,summary:'Runout uses available stock and the last 90 days of recorded issues. Incoming units are shown separately. Margin at risk estimates a full day of unmet demand at current prices before discounts and fees.'};
}
