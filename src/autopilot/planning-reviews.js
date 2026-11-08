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
  const rows=items.filter(r=>!r.planning_suppressed).map(r=>({
    SKU:r.code,Warehouse:r.location_name,Available:r.available,Incoming:r.incoming,
    'Issued in 90 days':r.issued,'Lead days':r.leadTimeDays,'Reorder point':r.effectiveReorder,
    'Units to order':r.shortage?requiredUnits(r):0,
    Reason:r.effectiveReorder===null?'Set a reorder point or record more demand':
      r.shortage?'Available plus incoming is at or below the reorder point':'Available plus incoming exceeds the reorder point',
    link:'/inventory/'+r.item_id
  }));
  return {rows,more,summary:'Planning quantities use recorded issues, stock available after reservations, incoming goods and supplier lead time. Review supplier pack sizes and order minimums before purchasing.'};
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
  {id:18,key:'reorder-explanation',label:'Explain what to order and why',readPage:reorder},
  {id:149,key:'demand-scenario',label:'Compare a change in sales demand',readPage:demandScenario,requiresChange:true}
];
