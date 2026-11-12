'use strict';

const { ValidationError } = require('../domain/errors');
const { hash } = require('../pricing/postgres-promotions');
const availability = require('../domain/postgres-stock-availability');
const units = require('../domain/stock-quantity');
const { MAX_QUANTITY } = require('../domain/physical-stock-input');
const { add, sub, min, cmp, canonical, sum, floor, selection } = require('../transfers/agent-transfer-balance-source');
const time = require('../lib/business-time');
const { addDays } = require('../accounting/customer-money');

const capacities = 'stockchief_runtime.agent_slotting_capacities';
const profileHash = sku => hash([sku.tracking_mode, units.profile({},sku)]);
const openTransfer = "('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')";
const incomingPurchase = "('APPROVED','ORDERED','PARTIALLY_RECEIVED')";

// Stock that must never move without a person, in the words shown to owners.
const reasons = {
  tracked: 'This product is tracked by batch, serial number or expiry date.',
  reserved: 'Some stock in this bin is reserved for orders or on hold.',
  picking: 'Stock in this bin is being picked.',
  counting: 'A count is in progress in one of these bins.',
};

async function warehouses(db,workspaceId) {
  return (await db.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND parent_location_id IS NULL
    AND kind='warehouse' AND is_active=1 AND custody_agreement_id IS NULL ORDER BY lower(name),id`,[workspaceId])).rows;
}

// Every active bin under one warehouse, with its measured distance, whether it
// is free to receive a whole re-slot, and whether a count is in progress there.
async function bins(db,workspaceId,warehouseId,{selectedIds=null}={}) {
  return (await db.query(`WITH RECURSIVE layout(id,path) AS (
    SELECT l.id,ARRAY[l.id] FROM locations l WHERE l.workspace_id=$1 AND l.id=$2 AND l.parent_location_id IS NULL
      AND l.kind='warehouse' AND l.is_active=1 AND l.custody_agreement_id IS NULL
    UNION ALL
    SELECT l.id,p.path||l.id FROM layout p JOIN locations l ON l.workspace_id=$1 AND l.parent_location_id=p.id
      WHERE l.is_active=1 AND l.custody_agreement_id IS NULL AND NOT l.id=ANY(p.path))
    SELECT l.id,l.name,d.metres::text,p.path,
      NOT EXISTS(SELECT 1 FROM balances b WHERE b.workspace_id=$1 AND b.location_id=l.id
        AND (b.on_hand<>0 OR b.secondary_on_hand<>0 OR b.quality_held<>0))
      AND NOT EXISTS(SELECT 1 FROM inventory_transfers t WHERE t.workspace_id=$1 AND t.destination_location_id=l.id
        AND t.status IN ${openTransfer})
      AND NOT EXISTS(SELECT 1 FROM purchase_orders po JOIN purchase_order_lines pl ON pl.workspace_id=po.workspace_id AND pl.purchase_order_id=po.id
        WHERE po.workspace_id=$1 AND po.status IN ${incomingPurchase} AND po.delivery_kind='WAREHOUSE'
        AND coalesce(pl.destination_location_id,po.destination_location_id)=l.id AND pl.quantity_units>pl.quantity_received_units) AS empty,
      (l.annual_count_freeze_id IS NOT NULL
        OR EXISTS(SELECT 1 FROM warehouse_count_campaign_lines q JOIN warehouse_count_campaigns c ON c.workspace_id=q.workspace_id AND c.id=q.campaign_id
          WHERE q.workspace_id=$1 AND q.location_id=l.id AND q.applied_at IS NULL AND c.status<>'COMPLETED')
        OR EXISTS(SELECT 1 FROM physical_count_reviews r WHERE r.workspace_id=$1 AND r.status='PENDING' AND r.payload->'location'->>'id'=l.id)) AS counting
    FROM layout p JOIN locations l ON l.workspace_id=$1 AND l.id=p.id
    LEFT JOIN stockchief_runtime.bin_packing_distances d ON d.workspace_id=l.workspace_id AND d.location_id=l.id
    WHERE l.kind='bin' AND ($3::text[] IS NULL OR l.id=ANY($3)) ORDER BY d.metres NULLS LAST,lower(l.name),l.id`,
  [workspaceId,warehouseId,selectedIds])).rows;
}

async function loads(db,workspaceId,binIds) {
  if(!binIds.length)return [];
  return (await db.query(`SELECT location_id,sku_id,primary_limit::text,secondary_limit::text,profile_hash,revision
    FROM ${capacities} WHERE workspace_id=$1 AND location_id=ANY($2::text[]) ORDER BY location_id,sku_id`,[workspaceId,binIds])).rows;
}

// Recorded sale picks over the last 90 business days, one row per stocked
// product and bin, busiest first.
async function picks(db,workspaceId,binIds,minimumVisits,calendar,skuId=null) {
  if(!binIds.length)return [];
  const from=time.dayBoundary(addDays(calendar.calendarDate,-89),calendar.timeZone);
  const until=time.dayBoundary(calendar.calendarDate,calendar.timeZone,{nextDay:true});
  return (await db.query(`WITH activity AS (
    SELECT m.sku_id,m.location_id,count(DISTINCT coalesce(nullif(m.reference,''),m.id))::int AS visits
    FROM movements m WHERE m.workspace_id=$1 AND m.location_id=ANY($2::text[]) AND ($6::text IS NULL OR m.sku_id=$6)
      AND m.operation='issue' AND m.reason_code IN ('sale','sold') AND m.quantity_delta<0
      AND stockchief_movement_instant(m.occurred_at)>=$3::timestamptz
      AND stockchief_movement_instant(m.occurred_at)<least(now(),$4::timestamptz)
    GROUP BY m.sku_id,m.location_id HAVING count(DISTINCT coalesce(nullif(m.reference,''),m.id)) >= $5)
    SELECT a.sku_id,a.location_id,a.visits,s.code,i.name,s.variant_label,i.tracking_mode,i.unit_label,i.quantity_precision,
      i.quantity_increment::text,i.secondary_unit_label,i.secondary_precision,i.secondary_increment::text,
      b.on_hand::text,b.secondary_on_hand::text,b.quality_held::text,c.secondary_quantity_units::text AS costed_secondary,
      EXISTS(SELECT 1 FROM kit_components k WHERE k.workspace_id=$1 AND k.kit_sku_id=a.sku_id AND k.stock_basis='components') AS component_kit,
      (EXISTS(SELECT 1 FROM fulfillment_wave_lines wl JOIN fulfillment_waves w ON w.workspace_id=wl.workspace_id AND w.id=wl.wave_id
          WHERE wl.workspace_id=$1 AND wl.sku_id=a.sku_id AND wl.location_id=a.location_id AND w.status IN ('RELEASED','PICKING','BLOCKED','PACKED'))
        OR EXISTS(SELECT 1 FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.workspace_id=tl.workspace_id AND t.id=tl.transfer_id
          WHERE tl.workspace_id=$1 AND tl.sku_id=a.sku_id AND t.source_location_id=a.location_id AND t.status IN ('APPROVED','PICKED'))) AS picking
    FROM activity a JOIN balances b ON b.workspace_id=$1 AND b.sku_id=a.sku_id AND b.location_id=a.location_id AND b.on_hand>0
    JOIN skus s ON s.workspace_id=$1 AND s.id=a.sku_id AND s.is_active=1
    JOIN items i ON i.workspace_id=$1 AND i.id=s.item_id AND i.is_active=1
    LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=$1 AND c.sku_id=a.sku_id AND c.location_id=a.location_id
    ORDER BY a.visits DESC,s.code,a.location_id,a.sku_id`,[workspaceId,binIds,from,until,minimumVisits,skuId])).rows;
}

async function freeStock(db,workspaceId,rows) {
  const positions=new Map();
  for(let start=0;start<rows.length;start+=500){
    const batch=rows.slice(start,start+500).map(p=>({skuId:p.sku_id,locationId:p.location_id}));
    for(const [key,value] of await availability.readMany(db,workspaceId,batch,{sellableOnly:true}))positions.set(key,value);
  }
  return positions;
}

const unheld=(sku,stock)=>stock?sub(canonical(stock.available),sku.quality_held):'0';

// One exact move of the free stock in a busy bin to one closer empty bin.
// A recorded bin fit limits the quantity; without one the move is unchecked.
async function planMove(db,ctx,sku,stock,from,to,capacity,today) {
  if(!stock||sku.component_kit||!to.empty||from.metres==null||to.metres==null||cmp(to.metres,from.metres)>=0)return null;
  if(capacity&&(capacity.profile_hash!==profileHash(sku)||Boolean(capacity.secondary_limit)!==Boolean(sku.secondary_unit_label)))return null;
  const free=unheld(sku,stock);
  if(cmp(free,'0')<=0)return null;
  const wanted=floor(min(free,capacity?capacity.primary_limit:free,String(MAX_QUANTITY)),sku);
  if(cmp(wanted,'0')<=0)return null;
  const source={id:from.id,stock:sku,rentalHeld:stock.rentalReserved,returnHeld:stock.returnHeld};
  const chosen=await selection(db,ctx,sku,source,wanted,today,[],{maximumSecondary:capacity?.secondary_limit??null});
  if(!chosen.length)return null;
  const lines=chosen.map(({evidence,...line})=>line);
  const plain=sku.tracking_mode==='quantity'&&!sku.secondary_unit_label;
  const protections=[];
  if(sku.tracking_mode!=='quantity')protections.push('tracked');
  if(cmp(stock.committed,'0')>0||cmp(stock.reserved,'0')>0||cmp(sku.quality_held,'0')>0)protections.push('reserved');
  if(sku.picking)protections.push('picking');
  if(from.counting||to.counting)protections.push('counting');
  const position=bin=>({id:bin.id,name:bin.name,metres:canonical(bin.metres),path:bin.path});
  // The fingerprint holds the facts a person approves. Plain stock may grow
  // or shrink above the planned quantity; tracked or weighed goods must be
  // the exact units shown.
  const facts={skuId:sku.sku_id,profileHash:profileHash(sku),from:[from.id,canonical(from.metres)],to:[to.id,canonical(to.metres)],
    capacity:capacity?capacity.revision:null,...(plain?{}:{lines})};
  return {skuId:sku.sku_id,code:sku.code,name:sku.variant_label?sku.name+' · '+sku.variant_label:sku.name,
    unit:sku.unit_label,secondaryUnit:sku.secondary_unit_label,visits:sku.visits,quantity:sum(lines.map(l=>l.quantity)),
    secondaryQuantity:sku.secondary_unit_label?sum(lines.map(l=>l.secondaryQuantity)):null,
    from:position(from),to:position(to),metresSaved:sub(from.metres,to.metres),lines,
    onHand:canonical(sku.on_hand),free,committed:canonical(stock.committed),held:add(stock.reserved,sku.quality_held),
    checked:Boolean(capacity),capacity:capacity?canonical(capacity.primary_limit):null,
    weightCapacity:capacity?.secondary_limit==null?null:canonical(capacity.secondary_limit),
    protections,fingerprint:hash(facts)};
}

async function snapshot(db,ctx,warehouse,options) {
  const calendar=await time.forWorkspace(db,ctx.workspaceId);
  const layout=await bins(db,ctx.workspaceId,warehouse.id);
  const byId=new Map(layout.map(b=>[b.id,b]));
  const open=layout.filter(b=>b.empty&&b.metres!=null);
  const fits=await loads(db,ctx.workspaceId,open.map(b=>b.id));
  const byKey=new Map(fits.map(c=>[availability.key(c.sku_id,c.location_id),c])),reservedFor=new Map();
  // A bin with a recorded fit is kept for the products it was checked for.
  for(const c of fits)reservedFor.set(c.location_id,(reservedFor.get(c.location_id)||new Set()).add(c.sku_id));
  const candidates=await picks(db,ctx.workspaceId,layout.filter(b=>!b.empty&&b.metres!=null).map(b=>b.id),options.minimumVisits,calendar);
  const stock=await freeStock(db,ctx.workspaceId,candidates);
  const moves=[],held=[],used=new Set();
  let heldCount=0,deferred=0,placed=0;
  for(const sku of candidates){
    if(moves.length>=options.maximumMoves){deferred++;continue;}
    const from=byId.get(sku.location_id),position=stock.get(availability.key(sku.sku_id,from.id));
    const closer=open.filter(to=>!used.has(to.id)&&cmp(to.metres,from.metres)<0&&(!reservedFor.has(to.id)||reservedFor.get(to.id).has(sku.sku_id)));
    if(!closer.length){placed++;continue;}
    let move=null;
    if(!sku.component_kit&&cmp(unheld(sku,position),'0')>0){
      for(const to of closer){
        move=await planMove(db,ctx,sku,position,from,to,byKey.get(availability.key(sku.sku_id,to.id))||null,calendar.calendarDate);
        if(move)break;
      }
    }
    if(move){moves.push(move);used.add(move.to.id);continue;}
    heldCount++;
    if(held.length<options.maximumMoves)held.push({code:sku.code,from:from.name,visits:sku.visits,reason:sku.component_kit
      ?'This kit is built from parts. Move the parts instead.'
      :cmp(unheld(sku,position),'0')<=0?'All of this stock is reserved, on hold or already moving.'
      :'The checked bin fit no longer matches this product, or no exact units fit.'});
  }
  return {warehouse,asOf:calendar.calendarDate,maximumMoves:options.maximumMoves,minimumVisits:options.minimumVisits,
    measuredBins:layout.filter(b=>b.metres!=null).length,examined:candidates.length,placed,heldCount,deferred,moves,held};
}

// Re-reads the live facts behind one saved move, just before stock is reserved.
async function currentMove(db,ctx,warehouseId,move,minimumVisits) {
  const layout=await bins(db,ctx.workspaceId,warehouseId,{selectedIds:[move.from.id,move.to.id]});
  const from=layout.find(b=>b.id===move.from.id),to=layout.find(b=>b.id===move.to.id);
  if(!from||!to)return null;
  const calendar=await time.forWorkspace(db,ctx.workspaceId);
  const [sku]=await picks(db,ctx.workspaceId,[from.id],minimumVisits,calendar,move.skuId);
  if(!sku)return null;
  const fits=await loads(db,ctx.workspaceId,[to.id]);
  if(fits.length&&!fits.some(c=>c.sku_id===sku.sku_id))return null;
  const stock=(await freeStock(db,ctx.workspaceId,[sku])).get(availability.key(sku.sku_id,from.id));
  return planMove(db,ctx,sku,stock,from,to,fits.find(c=>c.sku_id===sku.sku_id)||null,calendar.calendarDate);
}

function limits(sku,input) {
  const primary=units.validate(sku,String(input.primaryLimit??''),{label:'Most it holds',total:true});
  if(primary>MAX_QUANTITY)throw new ValidationError('That bin limit is larger than StockChief can move at once.');
  const secondary=units.secondary(sku,input.secondaryLimit,{label:'Most weight it holds',total:true});
  return {primary:String(primary),secondary:secondary==null?null:String(secondary)};
}

async function lockBins(db,workspaceId,ids) {
  await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[workspaceId,ids]);
}

module.exports={warehouses,bins,capacities,limits,profileHash,snapshot,currentMove,lockBins,reasons};
