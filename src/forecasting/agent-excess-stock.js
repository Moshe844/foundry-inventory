'use strict';

const planning=require('./postgres-planning-service');
const {classify,THRESHOLDS}=require('./excess');
const {transferPlan,retainedUnits}=require('../purchasing/replenishment-decision');
const {ValidationError}=require('../domain/errors');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');

async function candidates(db,ctx,{filter,page,today}){
  const {rows:items}=await db.query(`SELECT s.id FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR lower(s.code)=lower($2))
    AND EXISTS(SELECT 1 FROM balances b WHERE b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.on_hand>0)
    ORDER BY s.code,s.id LIMIT 26 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*25]);
  const ids=items.slice(0,25).map(r=>r.id);
  if(!ids.length)return {rows:[],more:false};
  const positions=await planning.position(db,ctx.workspaceId,{onlySkuIds:ids});
  const goals=await planning.goals(db,ctx.workspaceId);
  const physical=positions.filter(p=>p.location_id && !p.planning_suppressed);
  const transfers=transferPlan(physical);
  const {rows:history}=await db.query(`WITH shelf AS (
      SELECT m.sku_id,m.location_id,max(m.occurred_at::timestamptz) FILTER (WHERE m.balance_after>0 AND m.balance_after-m.quantity_delta<=0) AS stocked,
        max(m.occurred_at::timestamptz) FILTER (WHERE m.operation='issue' AND m.reason_code IN ('sale','sold')) AS sold
      FROM movements m WHERE m.workspace_id=$1 AND m.sku_id=ANY($2::text[]) AND m.occurred_at::timestamptz<=now() GROUP BY m.sku_id,m.location_id)
    SELECT h.*, $3::date-(h.stocked AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC'))::date AS held_days,
      $3::date-(h.sold AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC'))::date AS days_since_sale,
      p.amount_minor,p.currency,i.secondary_unit_label
    FROM shelf h JOIN workspaces w ON w.id=$1 JOIN accounts a ON a.id=w.owner_account_id
      JOIN skus s ON s.workspace_id=w.id AND s.id=h.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      LEFT JOIN LATERAL(SELECT amount_minor,currency FROM sku_prices WHERE workspace_id=w.id AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) p ON true`,[ctx.workspaceId,ids,today]);
  const historyByKey=new Map(history.map(h=>[JSON.stringify([h.sku_id,h.location_id]),h]));
  const rows=[];
  for(const position of physical){
    const h=historyByKey.get(JSON.stringify([position.sku_id,position.location_id]));
    if(!h || !h.stocked || position.available<=0)continue;
    const since=Math.min(h.held_days,h.days_since_sale??h.held_days);
    const kind=classify({item:{onHand:position.onHand,lastSoldAt:h.sold,daysHeld:h.held_days,daysSinceSold:since},
      dailyRate:position.rate,daysOfSupply:position.daysOfSupply,overstockDays:goals.maxDaysOfSupply??THRESHOLDS.overstockDays,thresholds:THRESHOLDS});
    if(!kind)continue;
    const moves=transfers.filter(t=>t.skuId===position.sku_id&&t.source.location_id===position.location_id);
    const retained=Math.max(retainedUnits(position),position.targetStock??0);
    const surplus=Math.max(0,exact.safeNumber(exact.subtract(position.available,retained),{signed:true}));
    const transferable=moves.reduce((n,t)=>n+t.quantity,0);
    rows.push({position,h,kind,since,moves,units:Math.max(0,exact.safeNumber(exact.subtract(surplus,transferable),{signed:true}))});
  }
  return {rows,more:items.length>25};
}

async function slowStock(db,ctx,options){
  const result=await candidates(db,ctx,options);
  return {more:result.more,summary:'Uses sales and stock history at each location. Units kept for open orders, replenishment targets and internal transfers are excluded from clearance.',
    rows:result.rows.map(({position,h,kind,moves,units})=>({SKU:position.code,Location:position.location_name,Finding:kind.label,
      'Days with stock':h.held_days,'Days since recorded sale':h.days_since_sale,'Available units':position.available,'Clearance candidates':units,
      'Suggested next step':moves.length?moves.map(t=>'Move '+t.quantity+' to '+t.destination.location_name).join(', '):
        units?'Check supplier return eligibility or review a markdown.':'Keep stock for existing commitments or the saved target.',
      link:'/inventory/'+position.item_id}))};
}

async function clearance(db,ctx,options){
  const value=String(options.change??'').trim();
  if(!value)return {rows:[],more:false,summary:'Enter a markdown to estimate the proceeds if the listed units sell.'};
  if(!/^\d{1,3}(?:\.\d{1,2})?$/.test(value)||Number(value)>100)throw new ValidationError('Enter a markdown from 0% to 100%.');
  const result=await candidates(db,ctx,options);
  return {more:result.more,summary:'Gross proceeds assume all listed units sell at the entered markdown. They exclude tax, selling fees and shipping. A person must approve any change to selling prices.',
    rows:result.rows.filter(r=>r.units>0).map(({position,h,units})=>{
      const known=h.amount_minor!=null && !h.secondary_unit_label;
      const price=known?exact.ratioMinor(Number(h.amount_minor),10000-Math.round(Number(value)*100),10000):null;
      return {SKU:position.code,Location:position.location_name,'Clearance units':units,'Markdown':value+'%',
        'Proposed unit price':known?money.format(price,h.currency):null,'Gross proceeds if sold':known?money.format(exact.costMinor(units,price),h.currency):null,
        'Price basis':known?'Current catalog price':h.secondary_unit_label?'Requires a measured selling quantity':'Current price missing',link:'/inventory/'+position.item_id};
    })};
}

module.exports={slowStock,clearance};
