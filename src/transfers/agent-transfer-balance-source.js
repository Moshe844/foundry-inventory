'use strict';

const exact = require('../domain/exact-quantity');
const units = require('../domain/stock-quantity');
const availability = require('../domain/postgres-stock-availability');
const { ValidationError } = require('../domain/errors');
const { hash } = require('../pricing/postgres-promotions');
const add = (a, b) => exact.add(String(a ?? 0), String(b ?? 0));
const sub = (a, b) => exact.subtract(String(a ?? 0), String(b ?? 0));
const cmp = (a,b) => { const d=sub(a,b); return d==='0'?0:d.startsWith('-')?-1:1; };
const min = (...values) => values.reduce((a,b)=>cmp(a,b)<=0?a:b);
const max = (...values) => values.reduce((a,b)=>cmp(a,b)>=0?a:b);
const sum = values => values.reduce(add,'0');
const canonical = value => exact.canonical(String(value??0),{signed:true});
const stockKey = availability.key;
const {MAX_QUANTITY} = require('../domain/physical-stock-input');
const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10)===day;

function floor(value, profile) {
  const atoms = BigInt(exact.atoms(max('0',canonical(value)),6));
  const increment = BigInt(exact.atoms(String(profile.quantity_increment),6,{positive:true}));
  return exact.fromAtoms(Number(atoms / increment * increment),6);
}

async function product(db,ctx,value) {
  const matches = (await db.query(`SELECT i.*,s.id AS sku_id,s.code,s.variant_label
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND (s.id=$2 OR lower(s.code)=lower($2))
    ORDER BY s.id LIMIT 2`,[ctx.workspaceId,String(value||'').trim()])).rows;
  if(matches.length!==1)throw new ValidationError('Choose one exact active product or variant code.');
  return matches[0];
}

async function locations(db,ctx,source,destination) {
  const rows = (await db.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1
    AND custody_agreement_id IS NULL AND (id=ANY($2::text[]) OR lower(name)=ANY($3::text[])) ORDER BY id`,
  [ctx.workspaceId,[source,destination],[String(source).toLowerCase(),String(destination).toLowerCase()]])).rows;
  const find = value => rows.filter(l=>l.id===value||l.name.toLowerCase()===String(value).toLowerCase());
  const from=find(source),to=find(destination);
  if(from.length!==1||to.length!==1||from[0].id===to[0].id)throw new ValidationError('Choose different, exact active owned source and destination locations.');
  return {from:from[0],to:to[0]};
}

async function inbound(db, workspaceId, ids) {
  return (await db.query(`SELECT l.sku_id,coalesce(l.destination_location_id,p.destination_location_id) location_id,
    p.id,p.po_number reference,p.status,p.expected_date due,(l.quantity_units-l.quantity_received_units)::text quantity,
    l.supplier_supply_hold_id IS NOT NULL held, NULL::text source_location_id, false balance_draft, false routine_transfer
    FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND l.quantity_units>l.quantity_received_units
    AND p.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') AND p.delivery_kind='WAREHOUSE'
    UNION ALL SELECT l.sku_id,t.destination_location_id,t.id,t.transfer_number,t.status,t.expected_arrival_date,
      (CASE t.status WHEN 'REQUESTED' THEN l.requested_quantity WHEN 'APPROVED' THEN l.approved_quantity
       WHEN 'PICKED' THEN l.picked_quantity ELSE l.shipped_quantity-l.received_quantity-l.lost_quantity-l.damaged_quantity END)::text,
       false,t.source_location_id,t.status='REQUESTED' AND t.decision_detail::jsonb->>'kind'='agent_balance_request',
       t.decision_detail::jsonb->>'kind'='agent_routine_transfer'
    FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.workspace_id=l.workspace_id AND t.id=l.transfer_id
    WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND t.status IN ('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')
    ORDER BY sku_id,location_id,id`,[workspaceId,ids])).rows.filter(r=>cmp(r.quantity,'0')>0);
}

async function snapshot(db,ctx,profiles) {
  const ids=profiles.map(p=>p.sku_id),today=await require('../lib/business-time').today(db,ctx.workspaceId);
  if(!ids.length)return {today,bySku:new Map(),componentKits:new Set()};
  const positionRows = await require('../forecasting/postgres-planning-service').position(db,ctx.workspaceId,{onlySkuIds:ids});
  const incoming = await inbound(db,ctx.workspaceId,ids);
  const stockRows = await db.query(`SELECT b.sku_id,b.location_id,b.on_hand::text,b.secondary_on_hand::text,b.quality_held::text,
      coalesce(c.quantity_units,0)::text AS costed, c.total_cost_minor,c.secondary_quantity_units::text AS costed_secondary,
      CASE i.tracking_mode WHEN 'lot' THEN coalesce((SELECT sum(lb.quantity) FROM lot_balances lb
        JOIN lots l ON l.workspace_id=lb.workspace_id AND l.id=lb.lot_id
        WHERE lb.workspace_id=b.workspace_id AND lb.location_id=b.location_id AND l.sku_id=b.sku_id
        AND l.recalled_at IS NULL AND (l.expires_at IS NULL OR l.expires_at::date>=$3::date)),0)
      WHEN 'serial' THEN (SELECT count(*) FROM serial_units u LEFT JOIN lots l ON l.workspace_id=u.workspace_id AND l.id=u.lot_id
        WHERE u.workspace_id=b.workspace_id AND u.location_id=b.location_id AND u.sku_id=b.sku_id AND u.status='in_stock' AND u.condition='good'
        AND l.recalled_at IS NULL AND (l.expires_at IS NULL OR l.expires_at::date>=$3::date))
      ELSE b.on_hand END::text AS usable
      FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id
      JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
      WHERE b.workspace_id=$1 AND b.sku_id=ANY($2::text[]) ORDER BY b.sku_id,b.location_id`,[ctx.workspaceId,ids,today]);
  const componentKits = await db.query("SELECT DISTINCT kit_sku_id FROM kit_components WHERE workspace_id=$1 AND kit_sku_id=ANY($2::text[]) AND stock_basis='components'",[ctx.workspaceId,ids]);
  const positions=positionRows.filter(p=>p.location_id);
  const held=await availability.readMany(db,ctx.workspaceId,positions.map(p=>({skuId:p.sku_id,locationId:p.location_id})));
  const balances=new Map(stockRows.rows.map(r=>[stockKey(r.sku_id,r.location_id),r]));
  const bySku=new Map();
  for(const p of positions){
    const key=stockKey(p.sku_id,p.location_id),stock=balances.get(key),holds=held.get(key);
    const records=incoming.filter(r=>r.sku_id===p.sku_id&&r.location_id===p.location_id);
    const currentFree=sub(stock?.usable||'0',add(holds?.committed,holds?.reserved));
    const trustworthy=r=>!r.held&&r.status!=='REQUESTED'&&validDay(r.due)&&r.due>=today;
    const timely=sum(records.filter(trustworthy).map(r=>r.quantity));
    const drafts=records.filter(r=>r.balance_draft);
    const draftUnits=sum(drafts.map(r=>r.quantity));
    const recordedTarget=p.target_stock!=null||p.reorderPoint!=null;
    const evidencedTarget=recordedTarget||!p.lead_time_assumed&&p.issueEvents>=2;
    const target=p.planning_suppressed||!evidencedTarget?null:p.targetStock;
    const reserve=max('0',canonical(p.safetyStock),canonical(p.effectiveReorder),canonical(target));
    const position={id:p.location_id,name:p.location_name,stock,committed:canonical(holds?.committed),held:canonical(holds?.reserved),
      free:currentFree,reserve,rentalHeld:canonical(holds?.rentalReserved),returnHeld:canonical(holds?.returnHeld),
      spare:stock&&cmp(stock.costed,stock.on_hand)===0?max('0',sub(currentFree,reserve)):'0',
      target:target==null?null:canonical(target),sourceVersion:p.source_version,policyId:p.policy_id,daysOfSupply:p.daysOfSupply,
      incoming:records,datedIncoming:timely,projected:add(currentFree,timely),drafts,draftUnits,
      openProjection:add(add(currentFree,timely),draftUnits),uncertainty:records.filter(r=>!r.balance_draft&&!trustworthy(r))};
    if(!bySku.has(p.sku_id))bySku.set(p.sku_id,[]);
    bySku.get(p.sku_id).push(position);
  }
  return {today,bySku,componentKits:new Set(componentKits.rows.map(k=>k.kit_sku_id))};
}

async function tracked(db,ctx,profile,from,today,maximum,previous,maximumSecondary=null) {
  const sku=profile.sku_id,location=from.id,params=[ctx.workspaceId,sku,location,today];
  if(profile.tracking_mode==='serial')return (await db.query(`SELECT u.id,u.serial,u.secondary_quantity::text AS weight,
    u.received_at,l.code AS lot,l.expires_at AS expiry
    FROM serial_units u LEFT JOIN lots l ON l.workspace_id=u.workspace_id AND l.id=u.lot_id
    WHERE u.workspace_id=$1 AND u.sku_id=$2 AND u.location_id=$3 AND u.status='in_stock' AND u.condition='good'
      AND l.recalled_at IS NULL AND (l.expires_at IS NULL OR l.expires_at::date>=$4::date)
      AND NOT u.id=ANY($5::text[]) AND ($6::boolean=false OR u.secondary_quantity>0)
      AND ($8::numeric IS NULL OR u.secondary_quantity<=$8::numeric)
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.sales_rotation_entries r WHERE r.workspace_id=u.workspace_id AND r.serial_unit_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM inventory_transfer_serials x JOIN inventory_transfer_lines line
        ON line.workspace_id=x.workspace_id AND line.id=x.transfer_line_id JOIN inventory_transfers t ON t.workspace_id=line.workspace_id AND t.id=line.transfer_id
        WHERE x.workspace_id=u.workspace_id AND x.serial_unit_id=u.id AND t.status IN ('REQUESTED','APPROVED','PICKED'))
      AND NOT EXISTS(SELECT 1 FROM fulfillment_wave_scans x JOIN fulfillment_wave_lines line
        ON line.workspace_id=x.workspace_id AND line.id=x.line_id JOIN sales_shipments h ON h.workspace_id=line.workspace_id AND h.id=line.shipment_id
        WHERE x.workspace_id=u.workspace_id AND x.serial_unit_id=u.id AND x.status='ACCEPTED' AND h.status NOT IN ('SHIPPED','DELIVERED','CANCELLED'))
    ORDER BY l.expires_at::date NULLS LAST,u.received_at,u.id LIMIT $7`,
  [...params,previous.flatMap(l=>l.serialUnitIds||[]),Boolean(profile.secondary_unit_label),
    maximumSecondary==null?Number(maximum):null,maximumSecondary])).rows;
  return (await db.query(`SELECT l.id,l.code,l.expires_at AS expiry,l.received_at,b.quantity::text,b.secondary_quantity::text AS weight,
    greatest(0,b.quantity
      -coalesce((SELECT sum(r.quantity) FROM stockchief_runtime.sales_rotation_entries r WHERE r.workspace_id=l.workspace_id AND r.location_id=b.location_id AND r.lot_id=l.id),0)
      -coalesce((SELECT sum(CASE WHEN t.status='REQUESTED' THEN tl.requested_quantity ELSE tl.approved_quantity END)
        FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.workspace_id=tl.workspace_id AND t.id=tl.transfer_id
        WHERE tl.workspace_id=l.workspace_id AND tl.lot_id=l.id AND t.source_location_id=b.location_id AND t.status IN ('REQUESTED','APPROVED','PICKED')),0)
      -coalesce((SELECT sum(x.quantity) FROM fulfillment_wave_scans x JOIN fulfillment_wave_lines wl ON wl.workspace_id=x.workspace_id AND wl.id=x.line_id
        JOIN sales_shipments h ON h.workspace_id=wl.workspace_id AND h.id=wl.shipment_id
        JOIN sales_shipment_lines sl ON sl.workspace_id=wl.workspace_id AND sl.id=wl.shipment_line_id
        WHERE x.workspace_id=l.workspace_id AND x.lot_id=l.id AND wl.location_id=b.location_id AND x.status='ACCEPTED'
        AND h.status NOT IN ('SHIPPED','DELIVERED','CANCELLED') AND NOT EXISTS(SELECT 1 FROM sales_order_allocations a
          WHERE a.workspace_id=sl.workspace_id AND a.sales_order_line_id=sl.sales_order_line_id AND a.location_id=wl.location_id AND a.rotation_selection IS NOT NULL)),0)
    )::text AS free
    FROM lots l JOIN lot_balances b ON b.workspace_id=l.workspace_id AND b.lot_id=l.id
    WHERE l.workspace_id=$1 AND l.sku_id=$2 AND b.location_id=$3 AND b.quantity>0 AND l.recalled_at IS NULL
      AND (l.expires_at IS NULL OR l.expires_at::date>=$4::date)
    ORDER BY l.expires_at::date NULLS LAST,l.received_at,l.id`,params)).rows;
}

// maximumSecondary caps the total measured weight chosen, for a destination
// with a checked weight limit.
async function selection(db,ctx,profile,from,maximum,today,previous=[],{maximumSecondary=null}={}) {
  const skuId=profile.sku_id,weighted=Boolean(profile.secondary_unit_label);
  if((profile.tracking_mode!=='quantity'||weighted)&&(cmp(from.stock.quality_held,'0')>0||cmp(from.rentalHeld,'0')>0))return [];
  if(profile.tracking_mode==='serial'&&cmp(from.returnHeld,'0')>0)return [];
  if(weighted&&cmp(from.stock.costed_secondary,from.stock.secondary_on_hand)!==0)return [];
  if(profile.tracking_mode==='quantity'){
    if(!weighted)return [{skuId,quantity:maximum}];
    // Aggregate weight describes a whole known position, not a partial pick.
    if(cmp(maximum,from.stock.on_hand)!==0||!from.stock.secondary_on_hand||
      maximumSecondary!=null&&cmp(from.stock.secondary_on_hand,maximumSecondary)>0)return [];
    return [{skuId,quantity:maximum,secondaryQuantity:String(units.secondary(profile,from.stock.secondary_on_hand))}];
  }
  const candidates=await tracked(db,ctx,profile,from,today,maximum,previous,maximumSecondary);
  if(profile.tracking_mode==='serial'){
    const selected=[];let usedWeight='0';
    for(const s of candidates){
      if(selected.length>=Number(maximum))break;
      if(weighted&&(s.weight==null||cmp(s.weight,'0')<=0||maximumSecondary!=null&&cmp(add(usedWeight,s.weight),maximumSecondary)>0))continue;
      selected.push(s);
      if(weighted)usedWeight=add(usedWeight,s.weight);
    }
    if(!selected.length)return [];
    const weight=weighted?String(units.secondary(profile,usedWeight)):null;
    return [{skuId,quantity:String(selected.length),serialUnitIds:selected.map(s=>s.id),serials:selected.map(s=>s.serial),...(weighted?{secondaryQuantity:weight}:{}),evidence:selected}];
  }
  const returned=await require('../operations/postgres-return-holds').heldLots(db,ctx.workspaceId,skuId,from.id);
  const result=[];let remaining=maximum,remainingWeight=maximumSecondary;
  for(const lot of candidates){
    if(cmp(remaining,'0')<=0)break;
    const earlier=sum(previous.filter(line=>line.lotId===lot.id).map(line=>line.quantity));
    const free=floor(sub(lot.free,add(returned.get(lot.id),earlier)),profile),quantity=floor(min(remaining,free),profile);
    if(cmp(quantity,'0')<=0)continue;
    if(weighted&&(cmp(quantity,lot.quantity)!==0||lot.weight==null||cmp(lot.weight,'0')<=0||
      remainingWeight!=null&&cmp(lot.weight,remainingWeight)>0))continue;
    const weight=weighted?String(units.secondary(profile,lot.weight)):null;
    result.push({skuId,quantity,lotId:lot.id,lot:lot.code,expiresOn:lot.expiry?.slice(0,10)||null,...(weighted?{secondaryQuantity:weight}:{}),evidence:lot});
    remaining=sub(remaining,quantity);
    if(weighted&&remainingWeight!=null)remainingWeight=sub(remainingWeight,weight);
  }
  return result;
}

function scopeKey(profile,from,to) {
  return hash([profile.sku_id,from.id,to.id,profile.tracking_mode,units.profile({},profile)]);
}

async function exactRoute(db,ctx,profile,from,to,maximum=null,provided=null,previous=[],{routine=false,target=null}={}) {
  const f=provided||await snapshot(db,ctx,[profile]),positions=f.bySku.get(profile.sku_id)||[];
  if(f.componentKits.has(profile.sku_id))throw new ValidationError('This kit is built from components. Balance the actual stock components between locations.');
  const source=positions.find(p=>p.id===from.id),recorded=positions.find(p=>p.id===to.id);
  const outstanding=routine&&recorded?recorded.uncertainty.filter(r=>r.routine_transfer&&!r.due):[];
  const destination=recorded&&{...recorded,target:target??recorded.target,
    openProjection:add(recorded.openProjection,sum(outstanding.map(r=>r.quantity))),
    uncertainty:recorded.uncertainty.filter(r=>!outstanding.includes(r))};
  if(!source||!destination||destination.target===null)throw new ValidationError('Record a destination stock target and source stock before balancing this route.');
  const shortage=max('0',sub(destination.target,destination.openProjection));
  if(destination.drafts.some(d=>d.source_location_id===from.id))
    throw new ValidationError('Review the existing draft for this balancing route before requesting more.');
  if(routine&&destination.incoming.some(d=>d.routine_transfer&&d.source_location_id===from.id))
    throw new ValidationError('Review the existing open transfer for this route before requesting more.');
  if(destination.uncertainty.length)throw new ValidationError('Check the existing draft, held, undated or overdue incoming stock: '+destination.uncertainty.map(r=>r.reference).join(', ')+'.');
  if(cmp(shortage,'0')<=0)throw new ValidationError('Current stock, dated incoming and already prepared balancing requests cover this target.');
  if(!source.stock||cmp(source.stock.costed,source.stock.on_hand)!==0)throw new ValidationError('Reconcile the source inventory cost quantities before balancing this product.');
  const wanted=floor(min(shortage,source.spare,maximum??shortage,String(MAX_QUANTITY)),profile);
  if(cmp(wanted,'0')<=0)throw new ValidationError('No eligible source stock remains above the protected local stock target and existing commitments.');
  const lines=await selection(db,ctx,profile,source,wanted,f.today,previous),quantity=sum(lines.map(l=>l.quantity));
  if(cmp(quantity,'0')<=0)throw new ValidationError('No eligible lot, serial or independently weighed stock covers this request. Confirm the exact physical identities and measures.');
  const scope=scopeKey(profile,from,to);
  return {skuId:profile.sku_id,code:profile.code,name:profile.name,unit:profile.unit_label,secondaryUnit:profile.secondary_unit_label,
    source,destination,quantity,shortage,afterSource:sub(source.free,quantity),afterDestination:add(destination.openProjection,quantity),lines,scope,
    fingerprint:hash([scope,f.today,source,destination,shortage,lines])};
}

module.exports={product,locations,snapshot,exactRoute,scopeKey,selection,floor,cmp,min,max,add,sub,sum,canonical};
