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
    'Issued in 90 days':r.issued,'Daily sales speed':r.dailyRate,'Demand from':r.forecast?'Forecast · '+r.forecast.label:'Sales in the last 90 days','Lead days':r.lead_time_assumed?'Unknown':r.leadTimeDays,'Reorder point':r.effectiveReorder,'Target stock':target,
    'Open drafts':drafts.map(l=>l.po_number).join(', ')||null,'Incoming dates':pending.filter(l=>!['DRAFT','AWAITING_APPROVAL'].includes(l.status)).map(l=>l.po_number+': '+(l.expected_date||'Unknown')+' ('+l.remaining+')').join('; ')||null,
    'Units to order':!costKnown||uncertain.length||drafts.length||r.lead_time_assumed&&r.reorderPoint===null?null:short?Math.max(0,exact.safeNumber(exact.subtract(String(target??0),String(projected)),{signed:true})):0,
    Reason:!costKnown?'Complete the recorded stock cost before reordering':uncertain.length?'Confirm overdue or undated incoming and supplier availability before ordering again':drafts.length?'Review existing unsent purchase drafts':r.lead_time_assumed&&r.reorderPoint===null?'Record supplier lead time before deriving a stock target':r.effectiveReorder===null?'Set a reorder point or record more demand':short?'Usable available stock plus incoming is at or below the reorder point':'Usable available stock plus incoming exceeds the reorder point',link:'/inventory/'+r.item_id};
  });
  return {rows,more,reorderForm:true,summary:'Planning shows exact usable stock after commitments, dated incoming, recorded sales speed, supplier lead time and the saved target. Unknown delivery facts or existing unsent drafts hold a new order. Supplier packs, minimums and competitive choice are reviewed separately before native drafts are created.'};
}

async function demandScenario(db,ctx,options){
  const raw=String(options.change??'').trim();
  const delay=String(options.supplierDelayDays??'').trim();
  const scenarioOptions={supplierDelayDays:delay};
  if(!raw&&!delay)return {rows:[],more:false,scenarioOptions,summary:'Enter a change in sales, supplier lead time, or both to compare what happens to stock.'};
  if(raw&&(!/^[+-]?\d{1,4}(?:\.\d{1,2})?$/.test(raw)||Number(raw)<-100||Number(raw)>1000))
    throw new ValidationError('Enter a sales change between -100% and 1,000%.');
  if(delay&&(!/^[+-]?\d{1,3}$/.test(delay)||Math.abs(Number(delay))>365))
    throw new ValidationError('Enter a whole-day supplier lead-time change between -365 and 365 days.');
  const change=Number(raw),leadChange=Number(delay),{items,ids,more}=await positions(db,ctx,options);
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
    const base=units/3,scenario=base*(1+change/100),available=Math.max(0,r.available);
    const rounded=n=>Math.round(n*100)/100;
    const lead=r.lead_time_assumed?null:r.leadTimeDays;
    const adjustedLead=lead==null?null:Math.max(0,lead+leadChange);
    const leadShortfall=(days,rate)=>days==null?'Unknown':rounded(Math.max(0,days*rate-available));
    return {SKU:r.code,Warehouse:r.location_name,'Shipped in 90 days':units,'Available now':r.available,
      'Expected incoming':r.incoming,'Baseline 30-day sales':rounded(base),'Scenario 30-day sales':rounded(scenario),
      'Additional units needed from today’s stock':rounded(Math.max(0,scenario-available)),
      ...(delay?{'Recorded lead time (days)':lead??'Unknown','Scenario lead time (days)':adjustedLead??'Unknown',
        'Baseline units short before replenishment':leadShortfall(lead,base/30),
        'Scenario units short before replenishment':leadShortfall(adjustedLead,scenario/30)}:{}),
      Evidence:units?'Recorded shipments':'No shipments in the window',link:'/inventory/'+r.item_id};
  });
  const leadSummary=delay?' The scenario changes supplier lead time by '+leadChange+' days. Stock gaps before replenishment use current available stock and recorded lead times.':'';
  return {rows,more,scenarioOptions,summary:'With a '+change+'% change in demand, estimated sales use the last 90 days of customer shipments. Expected incoming is shown separately because its arrival date can change.'+leadSummary};
}

module.exports=[
  {id:144,key:'seasonal-demand',label:'Forecast sales by SKU',readPage:require('../forecasting/agent-demand-forecast').review},
  {id:146,key:'new-product-forecast',label:'Forecast a new product from similar items',readPage:require('../forecasting/agent-launch-forecast').review},
  {id:151,key:'stockout-cost',label:'Estimate stockout dates and margin at risk',readPage:(db,ctx,options)=>require('../forecasting/agent-runout').review(db,ctx,options)},
  {id:19,key:'reorder-drafts',label:'Draft reorders grouped by supplier',readPage:async(c,ctx,o)=>({...await reorder(c,ctx,o),reorderForm:true})},
  {id:18,key:'reorder-explanation',label:'Explain what to order and why',readPage:reorder},
  {id:149,key:'demand-scenario',label:'Compare a change in sales demand',readPage:demandScenario,requiresChange:true}
];
