'use strict';

const planning=require('./postgres-planning-service');
const {classify,THRESHOLDS}=require('./excess');
const {transferPlan,retainedUnits,COVER_DAYS}=require('../purchasing/replenishment-decision');
const {ValidationError}=require('../domain/errors');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');

async function candidates(db,ctx,{filter='',page=1,today,skuIds=null}){
  const {rows:items}=await db.query(`SELECT s.id FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR lower(s.code)=lower($2))
    AND ($4::text[] IS NULL OR s.id=ANY($4::text[]))
    AND EXISTS(SELECT 1 FROM balances b WHERE b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.on_hand>0)
    ORDER BY s.code,s.id LIMIT 26 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*25,skuIds]);
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
    rows.push({position,h,kind,since,moves,surplus,others:physical.filter(p=>p.sku_id===position.sku_id&&p.location_id!==position.location_id),
      units:Math.max(0,exact.safeNumber(exact.subtract(surplus,transferable),{signed:true}))});
  }
  return {rows,more:items.length>25};
}

// A location where the item sells and still has room under its stock target.
function sellingDestination(others){
  const need=p=>Math.max(0,(p.target??Math.ceil(p.rate*COVER_DAYS))-p.projected);
  return others.filter(p=>p.rate>0&&need(p)>0)
    .sort((a,b)=>b.rate-a.rate||a.location_id.localeCompare(b.location_id)).map(p=>({position:p,need:need(p)}))[0]||null;
}

// The exact units each finding can free up now. Surplus above the location's
// own target, less stock already held for transfers, rentals, returns or quality
// checks and units on an open supplier return. Part of it can move to a location
// where the item sells; the rest is what a return or a discount would clear.
async function findings(db,ctx,options,{all=false}={}){
  const result=await candidates(db,ctx,options);
  const selection=result.rows.filter(row=>row.surplus>0);
  const none=row=>({...row,clearable:0,move:null,rest:0});
  if(!selection.length)return {rows:all?result.rows.map(none):[],more:result.more};
  const keys=selection.map(({position})=>({skuId:position.sku_id,locationId:position.location_id}));
  const [available,returning]=await Promise.all([
    require('../domain/postgres-stock-availability').readMany(db,ctx.workspaceId,keys,{sellableOnly:true}),
    db.query(`SELECT l.sku_id,l.location_id,sum(l.quantity)::text AS quantity FROM supplier_return_lines l
      JOIN supplier_returns r ON r.workspace_id=l.workspace_id AND r.id=l.supplier_return_id
      WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND r.status IN ('REQUESTED','AUTHORIZED') GROUP BY l.sku_id,l.location_id`,
    [ctx.workspaceId,[...new Set(keys.map(k=>k.skuId))]])
  ]);
  const onReturn=new Map(returning.rows.map(r=>[JSON.stringify([r.sku_id,r.location_id]),r.quantity]));
  const rows=[];
  for(const row of all?result.rows:selection){
    const {position}=row,key=JSON.stringify([position.sku_id,position.location_id]),current=available.get(key);
    if(!current||current.onHand!==position.onHand){if(all)rows.push(none(row));continue;}
    const held=Math.max(0,exact.safeNumber(exact.subtract(position.available,current.available),{signed:true}));
    const clearable=Math.max(0,exact.safeNumber(exact.subtract(exact.subtract(row.surplus,String(held)),onReturn.get(key)||'0'),{signed:true}));
    if(clearable<=0){if(all)rows.push(none(row));continue;}
    // Batches, serials and measured weights need a person to pick the exact units.
    const destination=sellingDestination(row.others),exactUnits=position.tracking_mode==='quantity'&&!row.h.secondary_unit_label;
    const move=destination?{quantity:Math.min(clearable,destination.need),destination:destination.position,exact:exactUnits}:null;
    rows.push({...row,clearable,move,
      rest:exact.safeNumber(exact.subtract(String(clearable),String(move&&exactUnits?move.quantity:0)),{signed:true})});
  }
  return {rows,more:result.more};
}

async function slowStock(db,ctx,options){
  const result=await findings(db,ctx,options,{all:true}),steps=require('./agent-slow-stock-steps'),rows=[];
  for(const row of result.rows){
    const {position,h,kind}=row;
    rows.push({SKU:position.code,Location:position.location_name,Finding:kind.label,
      'Days with stock':h.held_days,'Days since recorded sale':h.days_since_sale,'Available units':position.available,'Clearance candidates':row.rest,
      'Suggested next step':await steps.nextStep(db,ctx,row),link:'/inventory/'+position.item_id});
  }
  return {more:result.more,rows,summary:'Uses sales and stock history at each location. Units kept for open orders, replenishment targets, transfers and returns are left out. Each finding gets a next step: move it to a location where it sells, send it back to its supplier, or discount it with a clearance plan.'};
}

async function cashInStock(db,ctx,options){
  const workspaceId=ctx.workspaceId;
  const [totalResult,result]=await Promise.all([
    db.query(`SELECT a.base_currency AS currency,coalesce(t.book_cost_minor,0)::text AS book_cost,
      EXISTS(SELECT 1 FROM inventory_cost_coverage_positions p WHERE p.workspace_id=a.workspace_id AND p.missing_units>0) AS missing_cost
      FROM accounting_settings a LEFT JOIN inventory_cost_coverage_totals t ON t.workspace_id=a.workspace_id
      WHERE a.workspace_id=$1 AND a.enabled=1`,[workspaceId]),
    candidates(db,ctx,options)
  ]);
  const total=totalResult.rows[0];
  if(!total)return {rows:[],more:false,summary:'Set up the inventory books to see the value tied up in stock.'};
  const value=money.format(money.integer(total.book_cost,'Recorded stock value',{signed:true}),total.currency);
  const summary='Recorded stock value across the inventory is '+value+'. '+
    (total.missing_cost?'Some physical stock has incomplete cost records. ':'')+
    'Clearance candidates exclude stock needed for orders, transfers, rentals, holds and replenishment. The allocated value estimates the recorded cost of those units.';
  const selection=result.rows.filter(row=>row.units>0);
  if(!selection.length)return {rows:[],more:result.more,summary};
  const positions=selection.map(({position})=>({skuId:position.sku_id,locationId:position.location_id}));
  const [available,costs]=await Promise.all([
    require('../domain/postgres-stock-availability').readMany(db,workspaceId,positions,{sellableOnly:true}),
    db.query(`SELECT c.sku_id,c.location_id,c.quantity_units,c.total_cost_minor FROM accounting_inventory_cost_balances c
      JOIN jsonb_to_recordset($2::jsonb) AS p("skuId" text,"locationId" text)
        ON c.sku_id=p."skuId" AND c.location_id=p."locationId" WHERE c.workspace_id=$1`,[workspaceId,JSON.stringify(positions)])
  ]);
  const costsByPosition=new Map(costs.rows.map(row=>[JSON.stringify([row.sku_id,row.location_id]),row]));
  const rows=[];
  for(const {position,kind,units} of selection){
    const key=JSON.stringify([position.sku_id,position.location_id]),current=available.get(key),cost=costsByPosition.get(key);
    if(!current||current.onHand!==position.onHand)continue;
    const extraUnavailable=Math.max(0,exact.safeNumber(exact.subtract(position.available,current.available),{signed:true}));
    const clearanceUnits=exact.safeNumber(exact.subtract(units,extraUnavailable),{signed:true});
    if(clearanceUnits<=0)continue;
    const costed=cost&&Number(cost.quantity_units)===current.onHand;
    const bookValue=costed?money.integer(cost.total_cost_minor,'Position book value'):null;
    rows.push({position,kind,clearanceUnits,bookValue,allocated:costed?exact.ratioMinor(bookValue,clearanceUnits,cost.quantity_units,{rounding:'floor'}):null});
  }
  rows.sort((a,b)=>(b.allocated??-1)-(a.allocated??-1)||a.position.code.localeCompare(b.position.code));
  return {more:result.more,summary,rows:rows.map(({position,kind,clearanceUnits,bookValue,allocated})=>({
    SKU:position.code,Location:position.location_name,Finding:kind.label,'Clearance units':clearanceUnits,
    'Recorded position value':bookValue===null?'Needs cost review':money.format(bookValue,total.currency),
    'Allocated book value':allocated===null?'Needs cost review':money.format(allocated,total.currency),
    'Suggested next step':allocated===null?'Complete the stock cost before deciding.':'Review a supplier return or markdown.',
    link:'/inventory/'+position.item_id
  }))};
}

async function clearance(db,ctx,options){
  const value=String(options.change??'').trim();
  if(!value)return {rows:[],more:false,summary:'Enter a markdown to estimate the proceeds if the listed units sell.'};
  if(!/^\d{1,3}(?:\.\d{1,2})?$/.test(value)||Number(value)>100)throw new ValidationError('Enter a markdown from 0% to 100%.');
  const result=await candidates(db,ctx,options);
  return {more:result.more,summary:'Gross proceeds assume all listed units sell at the entered markdown. They exclude tax, selling fees and shipping. Build a plan to see markdown steps, the cash each should bring back and when. A person approves every price.',
    rows:result.rows.filter(r=>r.units>0).map(({position,h,units})=>{
      const known=h.amount_minor!=null && !h.secondary_unit_label;
      const price=known?exact.ratioMinor(Number(h.amount_minor),10000-Math.round(Number(value)*100),10000):null;
      return {SKU:position.code,Location:position.location_name,'Clearance units':units,'Markdown':value+'%',
        'Proposed unit price':known?money.format(price,h.currency):null,'Gross proceeds if sold':known?money.format(exact.costMinor(units,price),h.currency):null,
        'Price basis':known?'Current catalog price':h.secondary_unit_label?'Requires a measured selling quantity':'Current price missing',
        link:'/autopilot/clearance-plans/new?'+new URLSearchParams({sku:position.code,markdown:value}),linkLabel:'Build a plan'};
    })};
}

module.exports={slowStock,clearance,cashInStock,candidates,findings,sellingDestination};
