'use strict';

// Reads who is waiting at one dispatch warehouse and works out who gets the
// stock that is free there now. Planning never writes; the native allocation
// service applies a reviewed plan. Orders a person must look at first are
// skipped with a plain reason, so they never hold up the orders behind them.
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError}=require('../domain/errors');
const OPEN=['CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'];
const SAVED_ORDER='o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id';
const waiting=l=>`(${l}.quantity_ordered-${l}.quantity_fulfilled-coalesce((to_jsonb(${l})->>'direct_committed_quantity')::numeric,0)
  -coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=${l}.workspace_id AND a.sales_order_line_id=${l}.id),0))`;
const ORDER_LIMIT=200;

async function location(c,ctx,id){
  const row=(await c.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',
    [ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new ValidationError('Choose an active warehouse you own.');
  return row;
}

// Warehouses where a confirmed order waits for stock that is physically there.
async function candidates(c,workspaceId,{locationIds=null,limit=20}={}){
  return (await c.query(`SELECT loc.id,loc.name FROM locations loc WHERE loc.workspace_id=$1 AND loc.is_active=1 AND loc.custody_agreement_id IS NULL
    AND ($2::text[] IS NULL OR loc.id=ANY($2::text[])) AND EXISTS(SELECT 1 FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
      JOIN balances b ON b.workspace_id=l.workspace_id AND b.sku_id=l.sku_id AND b.location_id=loc.id AND b.on_hand>0
      WHERE o.workspace_id=loc.workspace_id AND o.fulfillment_location_id=loc.id AND o.status=ANY($3::text[]) AND o.confirmed_at IS NOT NULL AND ${waiting('l')}>0)
    ORDER BY loc.name,loc.id LIMIT $4`,[workspaceId,locationIds,OPEN,limit])).rows;
}

function hold(o){
  if(o.record_state!=='ACTIVE')return 'This customer is archived.';
  if(o.customer_decision||o.delivery_decision)return 'Confirm the customer and delivery details first.';
  if(o.picking)return 'A pick is already open for this order.';
  if(o.delegated)return 'ShipBob handles this order.';
  if(o.lines.length>100)return 'Orders with more than 100 lines need a person.';
  if(o.lines.some(l=>!l.supported&&l.waiting>0))return 'Kits, batch or serial items and measured goods need a person.';
  return null;
}

// Orders at one warehouse waiting for any of skuIds, best first.
async function orders(c,ctx,locationId,skuIds,{rank=SAVED_ORDER,join='',limit=ORDER_LIMIT,extra=''}={}){
  if(!skuIds.length)return [];
  const heads=(await c.query(`WITH ranked AS MATERIALIZED(SELECT o.id FROM sales_orders o ${join}
      WHERE o.workspace_id=$1 AND o.fulfillment_location_id=$2 AND o.status=ANY($3::text[]) AND o.confirmed_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND l.sku_id=ANY($4::text[])
        AND (${waiting('l')}>0${extra}))
      ORDER BY ${rank} LIMIT $5)
    SELECT o.id,o.order_number,o.status,o.version,o.customer_id,c.name customer,c.record_state,o.allocation_priority,o.needed_by,o.order_date,
      o.created_at,o.delivery_method,o.currency,coalesce(o.customer_decision_required,0)::int customer_decision,coalesce(o.delivery_decision_required,0)::int delivery_decision,
      EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status IN ('PICKING','PACKED')) picking,
      EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status<>'CANCELLED') boxed,
      EXISTS(SELECT 1 FROM stockchief_runtime.shipbob_sandbox_orders d WHERE d.workspace_id=o.workspace_id AND d.sales_order_id=o.id) delegated
      ${join?',tier.tier':''}
    FROM ranked r JOIN sales_orders o ON o.workspace_id=$1 AND o.id=r.id JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id ${join}
    ORDER BY ${rank}`,[ctx.workspaceId,locationId,OPEN,skuIds,limit])).rows;
  if(!heads.length)return [];
  const lines=(await c.query(`SELECT l.id,l.sales_order_id,l.sku_id,s.code,i.name item,i.unit_label,l.quantity_ordered::text ordered,
      l.quantity_fulfilled::text fulfilled,coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)::text direct,
      coalesce(a.total,0)::text allocated,coalesce(a.here,0)::text here,coalesce(a.plain,0)::text plain,
      (i.tracking_mode='quantity' AND i.quantity_precision=0 AND i.secondary_unit_label IS NULL AND s.is_active=1 AND i.is_active=1
        AND NOT EXISTS(SELECT 1 FROM sales_order_kit_components k WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id)) supported
    FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    LEFT JOIN LATERAL(SELECT sum(a.quantity) total,sum(a.quantity) FILTER(WHERE a.location_id=$2) here,
      sum(a.quantity) FILTER(WHERE a.location_id=$2 AND to_jsonb(a)->>'rotation_selection' IS NULL) plain
      FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id) a ON true
    WHERE l.workspace_id=$1 AND l.sales_order_id=ANY($3::text[]) ORDER BY l.sales_order_id,s.code,l.id`,[ctx.workspaceId,locationId,heads.map(o=>o.id)])).rows;
  const result=heads.map(o=>({...o,version:Number(o.version),lines:[]})),byId=new Map(result.map(o=>[o.id,o]));
  for(const l of lines){
    const n=k=>Number(l[k]);
    const line={lineId:l.id,skuId:l.sku_id,code:l.code,item:l.item,unit:l.unit_label,supported:Boolean(l.supported),
      remaining:n('ordered')-n('fulfilled')-n('direct'),allocated:n('allocated'),here:n('here'),plain:n('plain'),fulfilled:n('fulfilled')};
    line.waiting=line.remaining-line.allocated;
    if(line.supported&&![line.remaining,line.allocated,line.plain].every(Number.isSafeInteger))line.supported=false;
    byId.get(l.sales_order_id).lines.push(line);
  }
  for(const o of result){
    o.hold=hold(o);
    if(!o.hold){
      try{await require('./agent-order-checks').assertCanRelease(c,ctx.workspaceId,o.id);}
      catch(error){if(!(error instanceof ValidationError))throw error;o.hold=error.message;}
    }
  }
  return result;
}

// Stock free at the warehouse for each product, after every customer, transfer,
// rental and return commitment.
async function free(c,ctx,locationId,skuIds){
  const read=await require('../domain/postgres-stock-availability').readMany(c,ctx.workspaceId,skuIds.map(skuId=>({skuId,locationId})));
  return new Map(skuIds.map(id=>[id,Math.max(0,Math.floor(Number(read.get(JSON.stringify([id,locationId]))?.available||0)))]));
}

// Products at the warehouse that orders wait for and that are physically there.
async function waitingSkus(c,ctx,locationId){
  return (await c.query(`SELECT DISTINCT l.sku_id FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
    JOIN balances b ON b.workspace_id=l.workspace_id AND b.sku_id=l.sku_id AND b.location_id=$2 AND b.on_hand>0
    WHERE o.workspace_id=$1 AND o.fulfillment_location_id=$2 AND o.status=ANY($3::text[]) AND o.confirmed_at IS NOT NULL AND ${waiting('l')}>0
    ORDER BY l.sku_id LIMIT 500`,[ctx.workspaceId,locationId,OPEN])).rows.map(r=>r.sku_id);
}

// Saved order priority: each order in turn takes what it still waits for.
function fill(list,stock,{skip=new Set()}={}){
  const left=new Map(stock),gives=[];
  for(const o of list){
    if(o.hold)continue;
    const lines=[];
    for(const l of o.lines){
      if(!l.supported||l.waiting<=0||skip.has(l.skuId))continue;
      const n=Math.min(l.waiting,left.get(l.skuId)||0);
      if(n>0){lines.push({lineId:l.lineId,skuId:l.skuId,code:l.code,item:l.item,unit:l.unit,quantity:n,waiting:l.waiting});left.set(l.skuId,left.get(l.skuId)-n);}
    }
    if(lines.length)gives.push(summary(o,lines));
  }
  return {gives,left};
}
function summary(o,lines){
  const given=new Map(lines.map(l=>[l.lineId,l.quantity]));
  return {orderId:o.id,orderNumber:o.order_number,customer:o.customer,version:o.version,status:o.status,neededBy:o.needed_by||null,
    priority:Number(o.allocation_priority),delivery:o.delivery_method,lines,units:lines.reduce((n,l)=>n+l.quantity,0),
    complete:o.lines.every(l=>l.waiting-(given.get(l.lineId)||0)<=0)};
}

async function plan(c,ctx,locationId,{skip=new Set()}={}){
  const place=await location(c,ctx,locationId);
  const skus=await waitingSkus(c,ctx,place.id),stock=await free(c,ctx,place.id,skus);
  const usable=skus.filter(id=>stock.get(id)>0&&!skip.has(id));
  const list=await orders(c,ctx,place.id,usable);
  const {gives}=fill(list,stock,{skip});
  const held=list.filter(o=>o.hold&&o.lines.some(l=>usable.includes(l.skuId)&&l.waiting>0)).map(o=>({orderId:o.id,orderNumber:o.order_number,customer:o.customer,reason:o.hold}));
  const result={location:place,gives,held,free:usable.map(id=>[id,stock.get(id)]),units:gives.reduce((n,g)=>n+g.units,0)};
  result.fingerprint=hash({location:place.id,gives:gives.map(g=>[g.orderId,g.version,g.lines.map(l=>[l.lineId,l.quantity])]),free:result.free,held:held.map(h=>[h.orderId,h.reason])});
  return result;
}

module.exports={OPEN,SAVED_ORDER,waiting,location,candidates,orders,free,waitingSkus,fill,summary,plan};
