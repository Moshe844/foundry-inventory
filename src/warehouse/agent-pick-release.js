'use strict';

// Job 56: releases orders to the warehouse in the best pick order.
//
// An order is ready when it is confirmed for shipping, its ship-from warehouse
// is chosen (by job 121 or a person, with no warehouse question still open),
// every line is fully reserved inside that warehouse (at the warehouse or in
// its bins and zones), its delivery address is complete, the customer has no
// overdue-invoice hold (job 55) and nothing else holds it: no customer or
// delivery question, no box already made, no ShipBob order, and the reserved
// stock and batches are still really there. Ready orders go out by the
// owner's saved priority, then the ship-by date, then the warehouse's carrier
// cut-off on that date, then order age.
//
// Each warehouse has the owner's release rule: how many orders go out at a
// time, how many may wait in the warehouse to be picked, and its carrier
// cut-off times. Without a rule the warehouse's own record sizes a batch: the
// most orders it shipped in one day over the last 30 days. Growth proposes
// each release until the owner teaches it (a saved rule that releases on its
// own, or "release like this" after approving one). Pro and Custom release on
// their own. Pause, Watch only, Ask me first and the first 14 days propose or
// only watch. A release moves no stock and makes no box: picking waves, scans,
// packing and handoff follow. Every release is audited and can be undone
// until picking starts.
const {newId}=require('../lib/util');
const {ValidationError,NotFoundError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const addresses=require('../shipping/address');
const time=require('../lib/business-time');
const exact=require('../domain/exact-quantity');
const {has}=require('../db/schema-installed');
const {hash}=require('../pricing/postgres-promotions');
const {sublocationPredicate}=require('../commercial/location-capacity');

const JOB=56,ACTION='warehouse.release_orders',href='/autopilot/pick-release';
const RULES='stockchief_runtime.agent_pick_release_rules',RELEASES='stockchief_runtime.agent_pick_releases';
const MEMBERS='stockchief_runtime.agent_pick_release_orders',CHECKS='stockchief_runtime.agent_pick_release_checks';
const ROUTINGS='stockchief_runtime.agent_warehouse_routings';
// One release stays one bounded transaction. A batch without any size from the
// owner or the warehouse's record is a proposal for a person to review.
const MAX_BATCH=500,UNSIZED_PROPOSAL=50,SCAN=1000,MAX_SITES=10,HOLD_MINUTES=15;
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>['validation_error','entitlement_required','forbidden','not_found'].includes(error?.code);
const included=state=>policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'draft');
const DATE=/^\d{4}-\d{2}-\d{2}$/;

async function installed(db){return has(db,RELEASES);}

// Every owned site that ships, with each of its active bins, zones and areas.
const TREE=`tree(root,id,path) AS (
  SELECT l.id,l.id,ARRAY[l.id] FROM locations l WHERE l.workspace_id=$1 AND l.is_active=1 AND l.custody_agreement_id IS NULL
    AND NOT ${sublocationPredicate('l')}
  UNION ALL
  SELECT t.root,c.id,t.path||c.id FROM tree t JOIN locations c ON c.workspace_id=$1 AND c.parent_location_id=t.id
    AND c.is_active=1 AND c.custody_agreement_id IS NULL AND NOT c.id=ANY(t.path))`;

async function read(c,workspaceId,locationId,{lock=false}={}){
  return (await c.query(`SELECT * FROM ${RULES} WHERE workspace_id=$1 AND location_id=$2${lock?' FOR UPDATE':''}`,[workspaceId,locationId])).rows[0]||null;
}
async function currentOwner(c,workspaceId){return require('../sales/agent-backorders').currentOwner(c,workspaceId);}

function cutoffs(rule){return Array.isArray(rule?.cutoffs)?rule.cutoffs.filter(x=>/^\d{2}:\d{2}$/.test(x?.time)):[];}
function firstCutoff(rule){return cutoffs(rule).map(x=>x.time).sort()[0]||null;}

// Confirmed shipping orders in pick order, before the address, credit and
// stock checks that need more than SQL. Orders already released are not ready.
async function candidates(c,workspaceId,{locationId=null,orderIds=null,filter='',limit=SCAN,offset=0,released=false,skipUndone=false}={}){
  const routed=await has(c,ROUTINGS);
  return (await c.query(`WITH RECURSIVE ${TREE},
   cut AS (SELECT r.location_id,(SELECT min((x->>'time')::time) FROM jsonb_array_elements(r.cutoffs) x WHERE x->>'time' ~ '^\\d{2}:\\d{2}$') first_cutoff
     FROM ${RULES} r WHERE r.workspace_id=$1 AND r.enabled)
   SELECT o.id,o.order_number,o.customer_id,c.name customer,o.ship_to_address,o.currency,o.version,o.needed_by,o.order_date,o.allocation_priority,
    o.created_at,o.fulfillment_location_id location_id,site.name location,left(cut.first_cutoff::text,5) cutoff,
    CASE WHEN o.needed_by ~ '^\\d{4}-\\d{2}-\\d{2}$' AND cut.first_cutoff IS NOT NULL THEN o.needed_by::date+cut.first_cutoff END cutoff_at,
    m.release_id
   FROM sales_orders o
   JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id AND c.record_state='ACTIVE'
   JOIN locations site ON site.workspace_id=o.workspace_id AND site.id=o.fulfillment_location_id AND site.is_active=1
    AND site.custody_agreement_id IS NULL AND NOT ${sublocationPredicate('site')}
   LEFT JOIN cut ON cut.location_id=o.fulfillment_location_id
   LEFT JOIN ${MEMBERS} m ON m.workspace_id=o.workspace_id AND m.sales_order_id=o.id AND m.state='RELEASED'
   WHERE o.workspace_id=$1 AND o.status='CONFIRMED' AND o.delivery_method='SHIP'
    AND coalesce(o.customer_decision_required,0)=0 AND coalesce(o.delivery_decision_required,0)=0
    AND ($2::text IS NULL OR o.fulfillment_location_id=$2) AND ($3::text[] IS NULL OR o.id=ANY($3))
    AND (m.release_id IS NULL)<>$4
    AND EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
      JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
       AND (l.quantity_fulfilled<>0 OR s.is_active<>1 OR i.is_active<>1 OR i.quantity_precision<>0
        OR EXISTS(SELECT 1 FROM sales_order_kit_components k WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id)
        OR l.quantity_ordered<>(SELECT coalesce(sum(a.quantity),0) FROM sales_order_allocations a JOIN tree t ON t.root=o.fulfillment_location_id AND t.id=a.location_id
          WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id)
        OR EXISTS(SELECT 1 FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id AND a.quantity>0
          AND NOT EXISTS(SELECT 1 FROM tree t WHERE t.root=o.fulfillment_location_id AND t.id=a.location_id))))
    AND NOT EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status<>'CANCELLED')
    AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.shipbob_sandbox_orders d WHERE d.workspace_id=o.workspace_id AND d.sales_order_id=o.id)
    ${routed?`AND NOT EXISTS(SELECT 1 FROM ${ROUTINGS} q WHERE q.workspace_id=o.workspace_id AND q.sales_order_id=o.id AND q.status IN ('DRAFT','ASK'))`:''}
    AND ($5='' OR lower(site.name)=lower($5) OR lower(o.order_number)=lower($5))
    AND (NOT $8 OR NOT EXISTS(SELECT 1 FROM ${MEMBERS} u WHERE u.workspace_id=o.workspace_id AND u.sales_order_id=o.id AND u.state='UNDONE' AND u.undone_version=o.version))
   ORDER BY o.allocation_priority,CASE WHEN o.needed_by ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN o.needed_by END NULLS LAST,cutoff_at NULLS LAST,
    o.order_date,o.created_at,o.id LIMIT $6 OFFSET $7`,
  [workspaceId,locationId,orderIds,released,String(filter||'').trim(),limit,offset,skipUndone])).rows;
}

// Why one order position is where it is, in the owner's words.
function why(o){
  const parts=['Priority '+o.allocation_priority];
  parts.push(DATE.test(String(o.needed_by||''))?'ship by '+o.needed_by:'no ship-by date');
  if(o.cutoff&&o.cutoff_at)parts.push('carrier cut-off '+o.cutoff);
  parts.push('ordered '+String(o.order_date||o.created_at).slice(0,10));
  return parts.join(' · ');
}

// Holds that need more than SQL: the address and the customer's overdue invoices.
async function hold(c,workspaceId,o,creditRule){
  if(!addresses.parse(o.ship_to_address||'').complete)return 'The delivery address is missing or incomplete.';
  if(creditRule){
    try{await require('../sales/agent-order-checks').assertCanRelease(c,workspaceId,o.id);}
    catch(error){if(error instanceof ValidationError)return 'On hold: the customer has an overdue invoice.';throw error;}
  }
  return null;
}

// The reserved stock and batches behind each order must still be there.
async function stockFacts(c,workspaceId,orderIds,{lock=false}={}){
  if(!orderIds.length)return {lines:[],problems:new Map()};
  const lines=(await c.query(`SELECT l.id line_id,l.sales_order_id,l.sku_id,s.code,i.name item,i.tracking_mode,i.secondary_unit_label,
    l.quantity_ordered::text quantity,coalesce(l.unit_price_minor,0)::text price,a.id allocation_id,a.location_id,loc.name location_name,
    a.quantity::text allocated,a.rotation_selection
    FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN sales_order_allocations a ON a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id AND a.quantity>0
    JOIN locations loc ON loc.workspace_id=a.workspace_id AND loc.id=a.location_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=ANY($2::text[]) ORDER BY l.sales_order_id,l.id,a.location_id`,[workspaceId,orderIds])).rows;
  const problems=new Map(),flag=(orderId,reason)=>{if(!problems.has(orderId))problems.set(orderId,reason);};
  const positions=[...new Map(lines.map(l=>[l.sku_id+'|'+l.location_id,{skuId:l.sku_id,locationId:l.location_id}])).values()]
    .sort((a,b)=>(a.skuId+a.locationId).localeCompare(b.skuId+b.locationId));
  if(lock)for(const p of positions)await c.query('SELECT sku_id FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR SHARE',[workspaceId,p.skuId,p.locationId]);
  const stock=await require('../domain/postgres-stock-availability').readMany(c,workspaceId,positions);
  for(const l of lines){
    const p=stock.get(JSON.stringify([l.sku_id,l.location_id]));
    if(!p||p.onHand<p.committed+p.reserved)flag(l.sales_order_id,'Stock of '+l.code+' at '+l.location_name+' no longer covers what is reserved. Count or move it first.');
  }
  // Batches and serial numbers already chosen for the order (FIFO/FEFO) must
  // still be usable: not recalled, not expired, and still in that place.
  const chosen=lines.filter(l=>Array.isArray(l.rotation_selection));
  if(chosen.length){
    const lotIds=[...new Set(chosen.flatMap(l=>l.rotation_selection.map(s=>s.lotId).filter(Boolean)))];
    const serialIds=[...new Set(chosen.flatMap(l=>l.rotation_selection.map(s=>s.serialUnitId).filter(Boolean)))];
    const today=await time.today(c,workspaceId);
    const lots=new Map((lotIds.length?(await c.query('SELECT id,code,expires_at,recalled_at FROM lots WHERE workspace_id=$1 AND id=ANY($2::text[])',[workspaceId,lotIds])).rows:[]).map(r=>[r.id,r]));
    const serials=new Map((serialIds.length?(await c.query('SELECT id,serial,location_id,status,condition FROM serial_units WHERE workspace_id=$1 AND id=ANY($2::text[])',[workspaceId,serialIds])).rows:[]).map(r=>[r.id,r]));
    for(const l of chosen)for(const s of l.rotation_selection){
      const lot=s.lotId?lots.get(s.lotId):null,unit=s.serialUnitId?serials.get(s.serialUnitId):null;
      if(s.lotId&&(!lot||lot.recalled_at))flag(l.sales_order_id,'Batch '+(lot?.code||s.lotCode||'')+' reserved for '+l.code+' was recalled. Reserve another batch first.');
      else if(s.lotId&&lot.expires_at&&String(lot.expires_at).slice(0,10)<today)flag(l.sales_order_id,'Batch '+lot.code+' reserved for '+l.code+' has expired. Reserve another batch first.');
      if(s.serialUnitId&&(!unit||unit.status!=='in_stock'||unit.condition!=='good'||unit.location_id!==l.location_id))
        flag(l.sales_order_id,'Serial '+(unit?.serial||s.serial||'')+' reserved for '+l.code+' is no longer in '+l.location_name+'. Reserve it again first.');
    }
  }
  return {lines,problems,positions:[...stock].sort((a,b)=>a[0].localeCompare(b[0]))};
}

// The next batch of ready orders at one warehouse, and why others wait.
async function preview(c,ctx,{locationId,count,orderIds=null,lock=false,skipUndone=false,released=false}){
  const want=Math.max(0,Math.min(Number(count)||0,MAX_BATCH));
  const site=(await c.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL
    AND NOT ${sublocationPredicate('locations')}`,[ctx.workspaceId,locationId])).rows[0];
  if(!site)throw new ValidationError('Choose an active warehouse that ships orders.');
  const creditRule=await require('../sales/agent-order-checks').rule(c,ctx.workspaceId);
  const rows=await candidates(c,ctx.workspaceId,{locationId,orderIds,skipUndone,released});
  const eligible=[],held=[];
  for(const o of rows){
    if(eligible.length>=want+25)break;
    const reason=await hold(c,ctx.workspaceId,o,creditRule);
    if(reason)held.push({id:o.id,orderNumber:o.order_number,customer:o.customer,reason});else eligible.push(o);
  }
  const facts=await stockFacts(c,ctx.workspaceId,eligible.map(o=>o.id),{lock});
  const orders=[];
  for(const o of eligible){
    const problem=facts.problems.get(o.id);
    if(problem)held.push({id:o.id,orderNumber:o.order_number,customer:o.customer,reason:problem});
    else if(orders.length<want)orders.push(o);
  }
  const ids=new Set(orders.map(o=>o.id)),lines=facts.lines.filter(l=>ids.has(l.sales_order_id));
  const fingerprint=hash({location:site.id,orders:orders.map(o=>[o.id,o.version]),lines:lines.map(l=>[l.line_id,l.allocation_id,l.location_id,l.allocated,l.rotation_selection]),
    positions:facts.positions.filter(([key])=>lines.some(l=>key===JSON.stringify([l.sku_id,l.location_id])))});
  let value=0;for(const l of lines)value=require('../domain/currency').integer(value+exact.costMinor(l.allocated,l.price));
  return {location:site,locationId:site.id,fingerprint,lines,goodsMinor:value,currency:orders[0]?.currency||null,held,
    orders:orders.map((o,i)=>({id:o.id,orderNumber:o.order_number,customer:o.customer,version:Number(o.version),position:i+1,
      priority:o.allocation_priority,neededBy:DATE.test(String(o.needed_by||''))?o.needed_by:null,cutoff:o.cutoff_at?o.cutoff:null,why:why(o)}))};
}

// Orders released here and not yet packed or shipped: work waiting in the warehouse.
async function openWork(c,workspaceId,locationId){
  return Number((await c.query(`SELECT count(*) n FROM ${MEMBERS} m JOIN ${RELEASES} r ON r.workspace_id=m.workspace_id AND r.id=m.release_id
    JOIN sales_orders o ON o.workspace_id=m.workspace_id AND o.id=m.sales_order_id
    WHERE m.workspace_id=$1 AND r.location_id=$2 AND m.state='RELEASED' AND o.status IN ('CONFIRMED','PARTIALLY_FULFILLED')
     AND NOT EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status IN ('PACKED','SHIPPED','DELIVERED'))`,
  [workspaceId,locationId])).rows[0].n);
}
// The warehouse's own record: the most orders it shipped in one business day
// over the last 30 days. Nothing recorded means nothing to size a batch by.
async function shippedPerDay(c,workspaceId,locationId){
  const {timeZone}=await time.forWorkspace(c,workspaceId);
  const n=(await c.query(`SELECT max(n)::int n FROM (SELECT (h.shipped_at::timestamptz AT TIME ZONE $3)::date,count(DISTINCT h.sales_order_id) n
    FROM sales_shipments h WHERE h.workspace_id=$1 AND h.ship_from_location_id=$2 AND h.status IN ('SHIPPED','DELIVERED') AND h.customer_return_id IS NULL
     AND h.shipped_at IS NOT NULL AND h.shipped_at::timestamptz>=now()-interval '30 days' GROUP BY 1) x`,[workspaceId,locationId,timeZone])).rows[0].n;
  return n?Number(n):null;
}

// How many orders may go out now: the owner's rule, else the warehouse's record.
async function sizing(c,workspaceId,locationId,rule){
  const open=await openWork(c,workspaceId,locationId),record=rule?null:await shippedPerDay(c,workspaceId,locationId);
  const batch=rule?Number(rule.batch_orders):record,capacity=rule?(rule.capacity_orders==null?null:Number(rule.capacity_orders)):record;
  const room=capacity==null?Infinity:Math.max(0,capacity-open);
  return {open,record,batch,capacity,room,count:Math.min(batch??UNSIZED_PROPOSAL,room,MAX_BATCH),sized:batch!=null,
    source:rule?'rule':record?'record':null};
}

function taught(rule){return Boolean(rule?.enabled&&rule.automatic);}
async function trained(db,workspaceId,payload){
  if(!payload?.locationId||!await installed(db))return false;
  return taught(await read(db,workspaceId,payload.locationId));
}

// Why StockChief must propose instead of releasing on its own, or null.
async function automaticStop(c,ctx,state,rule,size){
  if(!policy.permits(state.plan,JOB,'automatic',{trained:taught(rule)}))
    return 'Growth proposes each release until you teach it: save this warehouse’s release rule to release on its own, or approve a release and teach it.';
  if(!size.sized)return 'Save how many orders this warehouse takes at a time. It has no shipping record to size a batch by.';
  const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,true);
  if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)
    return 'Automatic work is off for this inventory, so each release waits for your approval.';
  return null;
}

async function insert(c,ctx,{status,kind=null,p,reason=null,requestKey,ruleRevision=null}){
  const id=newId('pick-release'),released=status==='RELEASED';
  await storage.reserve(c,ctx.workspaceId,'pick-release:'+id,Buffer.byteLength(JSON.stringify(p.orders))*2+4096,{finished:true});
  return (await c.query(`INSERT INTO ${RELEASES}(id,workspace_id,location_id,status,authorization_kind,plan,fingerprint,rule_revision,request_key,reason,
     prepared_by,released_by,released_at)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,CASE WHEN $13 THEN now() END) ON CONFLICT(workspace_id,request_key) DO NOTHING RETURNING *`,
  [id,ctx.workspaceId,p.locationId,status,kind,JSON.stringify(planOf(p)),p.fingerprint,ruleRevision,requestKey,reason,ctx.actorId,released?ctx.actorId:null,released])).rows[0]||null;
}
function planOf(p){
  return {location:p.location.name,orders:p.orders,goodsMinor:p.goodsMinor,currency:p.currency,
    summary:p.orders.length+' order'+(p.orders.length===1?'':'s')+' at '+p.location.name+': '+p.orders.slice(0,5).map(o=>o.orderNumber).join(', ')+(p.orders.length>5?' and '+(p.orders.length-5)+' more':'')};
}

// One proposal per warehouse; a changed situation replaces it.
async function propose(c,ctx,p,reason,rule){
  const open=(await c.query(`SELECT * FROM ${RELEASES} WHERE workspace_id=$1 AND location_id=$2 AND status='PROPOSED' FOR UPDATE`,[ctx.workspaceId,p.locationId])).rows[0];
  if(open&&open.fingerprint===p.fingerprint){
    if(open.reason!==reason)await c.query(`UPDATE ${RELEASES} SET reason=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,open.id,reason]);
    return {id:open.id,created:false};
  }
  if(open)await c.query(`UPDATE ${RELEASES} SET status='STALE' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,open.id]);
  const row=await insert(c,ctx,{status:'PROPOSED',p,reason,requestKey:'proposed:'+newId('key'),ruleRevision:rule?.revision||null});
  return {id:row.id,created:true};
}

// Releases exactly the reviewed orders, in the reviewed order. Stock, cartons
// and money stay unchanged; picking waves follow.
async function apply(c,ctx,{locationId,orderIds,fingerprint,kind,requestKey,proposal=null,ruleRevision=null,count=null}){
  const prior=(await c.query(`SELECT * FROM ${RELEASES} WHERE workspace_id=$1 AND request_key=$2`,[ctx.workspaceId,requestKey])).rows[0];
  if(prior?.status==='RELEASED'||prior?.status==='UNDONE')return {releaseId:prior.id,orderIds:prior.plan.orders.map(o=>o.id),replayed:true};
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
  await c.query('SELECT id FROM sales_orders WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,orderIds]);
  const now=await preview(c,ctx,{locationId,orderIds,count:count??orderIds.length,lock:true});
  if(now.fingerprint!==fingerprint||now.orders.map(o=>o.id).join()!==orderIds.join())
    throw new ValidationError('The orders, their reserved stock or the warehouse changed. Review a fresh release.');
  if(!now.orders.length)throw new ValidationError('No ready orders are left to release here.');
  let row;
  if(proposal){
    row=(await c.query(`UPDATE ${RELEASES} SET status='RELEASED',authorization_kind=$3,released_by=$4,released_at=now(),request_key=$5,plan=$6::jsonb
      WHERE workspace_id=$1 AND id=$2 AND status='PROPOSED' RETURNING *`,[ctx.workspaceId,proposal.id,kind,ctx.actorId,requestKey,JSON.stringify(planOf(now))])).rows[0];
    if(!row)throw new ValidationError('This release is no longer waiting. Review the warehouse again.');
  }else{
    row=await insert(c,ctx,{status:'RELEASED',kind,p:now,requestKey,ruleRevision});
    if(!row)throw new ValidationError('That release is already being recorded.');
    await c.query(`UPDATE ${RELEASES} SET status='STALE' WHERE workspace_id=$1 AND location_id=$2 AND status='PROPOSED'`,[ctx.workspaceId,locationId]);
  }
  for(const o of now.orders)await c.query(`INSERT INTO ${MEMBERS}(workspace_id,release_id,sales_order_id,position,order_version) VALUES($1,$2,$3,$4,$5)`,
    [ctx.workspaceId,row.id,o.id,o.position,o.version]);
  await audit.record(c,ctx,{action:kind==='AUTOMATIC'?'StockChief released orders to the warehouse':'Released orders to the warehouse',reference:now.location.name,
    after:{release:row.id,orders:now.orders.map(o=>[o.orderNumber,o.why]),kind}});
  // Job 57 groups the released orders into zone waves at once.
  const waves=await require('./agent-pick-waves').afterRelease(c,ctx,locationId);
  return {releaseId:row.id,orderIds:now.orders.map(o=>o.id),orderNumbers:now.orders.map(o=>o.orderNumber),location:now.location.name,waves,replayed:false};
}

async function owner(c,ctx,{lock=false}={}){
  const row=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=w.owner_account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF w,u':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the current inventory owner can release orders to the warehouse.');
}
// A person releasing or approving: the plan must include the job and nothing
// may be on Watch only or in the first 14 days.
async function manual(c,ctx){
  await owner(c,ctx,{lock:true});
  const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
  const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
  if(stop)throw new ValidationError(stop);
  return state;
}
async function locked(c,ctx,id){
  const row=(await c.query(`SELECT * FROM ${RELEASES} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That release is not in this inventory.');
  return row;
}

// A person releases the next ready orders at one warehouse from the page.
async function releaseNow(db,ctx,input={}){
  return tx(db,async c=>{
    await manual(c,ctx);
    const count=whole(input.count,'Orders to release',1,MAX_BATCH);
    const ids=String(input.orders||'').split(',').filter(Boolean);
    if(!ids.length||ids.length!==count)throw new ValidationError('Review the orders to release again.');
    const done=await apply(c,ctx,{locationId:String(input.locationId||''),orderIds:ids,fingerprint:String(input.fingerprint||''),kind:'INDIVIDUAL',
      requestKey:'manual:'+String(input.requestKey||newId('key'))});
    return done;
  });
}

async function approve(db,ctx,id,input={}){
  return tx(db,async c=>{
    await manual(c,ctx);
    const r=await locked(c,ctx,id);
    if(r.status==='RELEASED')return {releaseId:r.id,replayed:true};
    if(r.status!=='PROPOSED')throw new ValidationError('This release is no longer waiting for approval. Review the warehouse again.');
    if(input.confirmed!=='yes'||input.fingerprint!==r.fingerprint)throw new ValidationError('Review and approve this exact release.');
    const ids=r.plan.orders.map(o=>o.id);
    try{
      await c.query('SAVEPOINT approve_release');
      const done=await apply(c,ctx,{locationId:r.location_id,orderIds:ids,fingerprint:r.fingerprint,kind:'INDIVIDUAL',requestKey:'approve:'+r.id,proposal:r});
      await c.query('RELEASE SAVEPOINT approve_release');
      return done;
    }catch(error){
      if(!expected(error))throw error;
      await c.query('ROLLBACK TO SAVEPOINT approve_release');
      await c.query(`UPDATE ${RELEASES} SET status='STALE' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id]);
      return {releaseId:r.id,stale:true,reason:error.message};
    }
  });
}

async function discard(db,ctx,id){
  return tx(db,async c=>{
    await owner(c,ctx);
    const r=await locked(c,ctx,id);
    if(r.status==='DISCARDED')return {releaseId:r.id,replayed:true};
    if(r.status!=='PROPOSED')throw new ValidationError('Only a release waiting for you can be dismissed.');
    await c.query(`UPDATE ${RELEASES} SET status='DISCARDED' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id]);
    await audit.record(c,ctx,{action:'Dismissed a proposed release',reference:r.plan.location,after:{release:r.id}});
    return {releaseId:r.id};
  });
}

// Undo until picking starts: unstarted boxes are cancelled and the orders go
// back to ready. StockChief will not release them on its own again until
// something about them changes.
async function undo(db,ctx,id){
  return tx(db,async c=>{
    await owner(c,ctx,{lock:true});
    const r=await locked(c,ctx,id);
    if(r.status==='UNDONE')return {releaseId:r.id,replayed:true};
    if(r.status!=='RELEASED')throw new ValidationError('Only a release can be undone.');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
    const members=(await c.query(`SELECT m.sales_order_id,o.order_number FROM ${MEMBERS} m JOIN sales_orders o ON o.workspace_id=m.workspace_id AND o.id=m.sales_order_id
      WHERE m.workspace_id=$1 AND m.release_id=$2 AND m.state='RELEASED' ORDER BY m.position FOR UPDATE OF m,o`,[ctx.workspaceId,r.id])).rows;
    const boxes=await startedBoxes(c,ctx.workspaceId,members.map(m=>m.sales_order_id));
    const started=boxes.find(b=>b.started);
    if(started)throw new ValidationError('Picking has started for '+started.order_number+'. This release can no longer be undone.');
    for(const b of boxes)await require('../shipping/postgres-service').cancel(scoped(c),ctx,b.shipment_id,{reason:'Release undone before picking started'});
    await afterUndo(c,ctx,r,boxes);
    for(const m of members){
      const version=(await c.query('SELECT version FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,m.sales_order_id])).rows[0].version;
      await c.query(`UPDATE ${MEMBERS} SET state='UNDONE',undone_version=$4 WHERE workspace_id=$1 AND release_id=$2 AND sales_order_id=$3`,[ctx.workspaceId,r.id,m.sales_order_id,version]);
    }
    await c.query(`UPDATE ${RELEASES} SET status='UNDONE',undone_by=$3,undone_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Undid a release to the warehouse',reference:r.plan.location,before:{release:r.id,orders:members.map(m=>m.order_number)},after:{cancelledBoxes:boxes.length}});
    return {releaseId:r.id,orders:members.length,cancelledBoxes:boxes.length};
  });
}
// Unshipped boxes for these orders, and whether anyone has started picking them.
async function startedBoxes(c,workspaceId,orderIds){
  if(!orderIds.length)return [];
  return (await c.query(`SELECT h.id shipment_id,h.sales_order_id,o.order_number,(h.status='PACKED' OR EXISTS(SELECT 1 FROM fulfillment_wave_scans s JOIN fulfillment_wave_lines w
      ON w.workspace_id=s.workspace_id AND w.id=s.line_id WHERE s.workspace_id=h.workspace_id AND w.shipment_id=h.id AND s.status='ACCEPTED')
      OR EXISTS(SELECT 1 FROM fulfillment_wave_lines w WHERE w.workspace_id=h.workspace_id AND w.shipment_id=h.id AND w.picked_quantity>0)) started
    FROM sales_shipments h JOIN sales_orders o ON o.workspace_id=h.workspace_id AND o.id=h.sales_order_id
    WHERE h.workspace_id=$1 AND h.sales_order_id=ANY($2::text[]) AND h.status IN ('PICKING','PACKED') ORDER BY h.id FOR UPDATE OF h`,[workspaceId,orderIds])).rows;
}
// Picking waves built from this release end with it (job 57).
async function afterUndo(c,ctx,r,boxes){
  const orders=[...new Set(boxes.map(b=>b.sales_order_id).filter(Boolean))];
  await require('./agent-pick-waves').releaseUndone(c,ctx,orders);
}

function whole(value,label,min,max){
  const n=Number(String(value??'').trim());
  if(String(value??'').trim()===''||!Number.isSafeInteger(n)||n<min||n>max)throw new ValidationError(label+' must be a whole number from '+min.toLocaleString('en-US')+' to '+max.toLocaleString('en-US')+'.');
  return n;
}
// "UPS 16:00, FedEx 17:30" or one per line.
function parseCutoffs(text){
  const entries=String(text||'').split(/[\n,;]+/).map(s=>s.trim()).filter(Boolean);
  if(entries.length>10)throw new ValidationError('Record up to 10 carrier cut-off times.');
  return entries.map(entry=>{
    const m=/^(.*?)\s*(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(entry);
    if(!m)throw new ValidationError('Write each cut-off as a carrier and a time, like UPS 16:00.');
    let hour=Number(m[2]);const minute=Number(m[3]),half=(m[4]||'').toLowerCase();
    if(half==='pm'&&hour<12)hour+=12;if(half==='am'&&hour===12)hour=0;
    if(hour>23||minute>59||(half&&Number(m[2])>12))throw new ValidationError('Choose a real time of day for '+entry+'.');
    const carrier=m[1].replace(/[\s:-]+$/,'').trim().slice(0,40)||'Carrier';
    return {carrier,time:String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0')};
  });
}

async function site(c,workspaceId,id){
  const row=(await c.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL
    AND NOT ${sublocationPredicate('locations')}`,[workspaceId,String(id||'')])).rows[0];
  if(!row)throw new ValidationError('Choose an active warehouse that ships orders.');
  return row;
}

// The owner's release rule for one warehouse. On Growth, letting it release
// on its own is what teaches StockChief.
async function configure(db,ctx,input={}){
  return tx(db,async c=>{
    await owner(c,ctx,{lock:true});
    const place=await site(c,ctx.workspaceId,input.locationId);
    const prior=await read(c,ctx.workspaceId,place.id,{lock:true});
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the release rule before changing it.');
    if(input.stop==='yes'){
      if(prior?.enabled){
        await c.query(`UPDATE ${RULES} SET enabled=false,automatic=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND location_id=$2`,[ctx.workspaceId,place.id]);
        await audit.record(c,ctx,{action:'Turned off a warehouse release rule',reference:place.name,before:{revision:prior.revision}});
      }
      return {stopped:true};
    }
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const batch=whole(input.batchOrders,'Orders released at a time',1,MAX_BATCH);
    const capacity=String(input.capacityOrders??'').trim()===''?null:whole(input.capacityOrders,'Most orders waiting to be picked',1,100000);
    if(capacity!=null&&capacity<batch)throw new ValidationError('The most orders waiting to be picked must be at least the orders released at a time.');
    const list=parseCutoffs(input.cutoffs);
    // Only Growth is taught; Pro and Custom release on their own by plan.
    const growth=policy.allowance(state.plan,JOB)==='trained';
    const automatic=growth?input.automatic==='yes':Boolean(prior?.automatic);
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await storage.reserve(c,ctx.workspaceId,'pick-release-rule:'+place.id+':'+((prior?.revision||0)+1),2048,{finished:true});
    await c.query(`INSERT INTO ${RULES}(workspace_id,location_id,batch_orders,capacity_orders,cutoffs,automatic,authorized_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
      ON CONFLICT(workspace_id,location_id) DO UPDATE SET batch_orders=EXCLUDED.batch_orders,capacity_orders=EXCLUDED.capacity_orders,cutoffs=EXCLUDED.cutoffs,
       automatic=EXCLUDED.automatic,authorized_by=EXCLUDED.authorized_by,enabled=true,revision=agent_pick_release_rules.revision+1,updated_at=now()`,
    [ctx.workspaceId,place.id,batch,capacity,JSON.stringify(list),automatic,ctx.actorId]);
    await audit.record(c,ctx,{action:'Saved a warehouse release rule',reference:place.name,
      before:prior?{batch:prior.batch_orders,capacity:prior.capacity_orders,cutoffs:prior.cutoffs,automatic:prior.automatic,enabled:prior.enabled}:{},
      after:{batch,capacity,cutoffs:list,automatic}});
    return {saved:true,automatic,growth};
  });
}

// Growth: "release like this on its own" after approving a release here.
async function teach(db,ctx,id){
  return tx(db,async c=>{
    await owner(c,ctx,{lock:true});
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    if(!policy.permits(state.plan,JOB,'automatic',{trained:true}))throw new ValidationError('Your plan prepares each release for your approval.');
    if(state.shadow)throw new ValidationError('StockChief is watching during the first 14 days. Teach it after shadow mode ends.');
    const r=await locked(c,ctx,id);
    if(r.status!=='RELEASED'||r.authorization_kind!=='INDIVIDUAL')throw new ValidationError('Teach StockChief from a release you approved yourself.');
    const prior=await read(c,ctx.workspaceId,r.location_id,{lock:true});
    if(taught(prior))return {taught:true,replayed:true};
    const batch=prior?.enabled?Number(prior.batch_orders):Math.min(Math.max(r.plan.orders.length,1),MAX_BATCH);
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await c.query(`INSERT INTO ${RULES}(workspace_id,location_id,batch_orders,automatic,authorized_by) VALUES($1,$2,$3,true,$4)
      ON CONFLICT(workspace_id,location_id) DO UPDATE SET automatic=true,enabled=true,batch_orders=CASE WHEN agent_pick_release_rules.enabled THEN agent_pick_release_rules.batch_orders ELSE EXCLUDED.batch_orders END,
       authorized_by=EXCLUDED.authorized_by,revision=agent_pick_release_rules.revision+1,updated_at=now()`,[ctx.workspaceId,r.location_id,batch,ctx.actorId]);
    await audit.record(c,ctx,{action:'Taught StockChief to release orders on its own',reference:r.plan.location,after:{example:r.id,batch}});
    return {taught:true};
  });
}

async function checked(c,workspaceId,locationId,problem){
  await c.query(`INSERT INTO ${CHECKS}(workspace_id,location_id,checked_at,retry_after,problem)
    VALUES($1,$2,clock_timestamp(),clock_timestamp()+CASE WHEN $3::text IS NULL THEN interval '0' ELSE make_interval(mins=>$4) END,$3)
    ON CONFLICT(workspace_id,location_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,retry_after=EXCLUDED.retry_after,problem=EXCLUDED.problem,wave_id=NULL`,
  [workspaceId,locationId,problem,HOLD_MINUTES]);
}

// Warehouses with ready orders, the soonest carrier cut-off still ahead today first.
async function waitingSites(c,workspaceId,now){
  const ready=await candidates(c,workspaceId,{limit:SCAN,skipUndone:true});
  const sites=new Map();
  for(const [i,o] of ready.entries())if(!sites.has(o.location_id))sites.set(o.location_id,{id:o.location_id,name:o.location,rank:i});
  if(!sites.size)return [];
  const ids=[...sites.keys()];
  const cooling=new Set((await c.query(`SELECT location_id FROM ${CHECKS} WHERE workspace_id=$1 AND location_id=ANY($2::text[]) AND retry_after>clock_timestamp()`,[workspaceId,ids])).rows.map(r=>r.location_id));
  const rules=new Map((await c.query(`SELECT * FROM ${RULES} WHERE workspace_id=$1 AND location_id=ANY($2::text[]) AND enabled`,[workspaceId,ids])).rows.map(r=>[r.location_id,r]));
  const {timeZone}=await time.forWorkspace(c,workspaceId),clock=time.parts(now,timeZone),at=String(clock.hour).padStart(2,'0')+':'+String(clock.minute).padStart(2,'0');
  const next=id=>cutoffs(rules.get(id)).map(x=>x.time).filter(t=>t>at).sort()[0]||'99:99';
  return [...sites.values()].filter(s=>!cooling.has(s.id)).sort((a,b)=>next(a.id).localeCompare(next(b.id))||a.rank-b.rank).slice(0,MAX_SITES);
}

async function handle(c,ctx,state,place){
  const rule=await read(c,ctx.workspaceId,place.id);
  const size=await sizing(c,ctx.workspaceId,place.id,rule?.enabled?rule:null);
  if(size.room<=0)return {held:true,problem:place.name+' already has '+size.open+' orders waiting to be picked, its limit. StockChief releases more as they are packed.'};
  const p=await preview(c,ctx,{locationId:place.id,count:size.count,skipUndone:true});
  if(!p.orders.length)return {nothing:true,problem:p.held.length?p.held[0].orderNumber+': '+p.held[0].reason:null};
  const stop=await automaticStop(c,ctx,state,rule?.enabled?rule:null,size);
  if(stop){const made=await propose(c,ctx,p,stop,rule);return {proposed:made.created||true,problem:null};}
  const done=await apply(c,ctx,{locationId:place.id,orderIds:p.orders.map(o=>o.id),fingerprint:p.fingerprint,kind:'AUTOMATIC',
    requestKey:'auto:'+p.fingerprint,ruleRevision:rule?.revision||null,count:size.count});
  return {released:done.replayed?0:done.orderIds.length,release:done.releaseId,problem:null};
}

// The routine, every 15 minutes: each warehouse with ready orders in turn.
async function run(db,workspaceId,{now=new Date()}={}){
  const result={released:0,releases:0,proposed:0,held:0,watching:false};
  if(!await installed(db))return result;
  const state=await policy.accountState(db,workspaceId);
  if(!included(state))return result;
  const actorId=await currentOwner(db,workspaceId);
  if(!actorId)return result;
  // Shadow mode, Watch only and the job's own Watch setting only watch.
  if(await policy.stopped(db,workspaceId,state,ACTION,false)){result.watching=true;return result;}
  const ctx={workspaceId,actorId};
  const places=await db.transaction(c=>waitingSites(c,workspaceId,now),{isolation:'REPEATABLE READ',retrySafe:true});
  for(const place of places){
    const outcome=await tx(db,async c=>{
      if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',['agent-pick-release:'+workspaceId+':'+place.id])).rows[0].locked)return {skipped:true};
      await c.query('SAVEPOINT pick_release');
      try{
        const done=await handle(c,ctx,state,place);
        await c.query('RELEASE SAVEPOINT pick_release');
        await checked(c,workspaceId,place.id,done.held?done.problem:null);
        return done;
      }catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT pick_release');await c.query('RELEASE SAVEPOINT pick_release');
        await checked(c,workspaceId,place.id,error.message);
        return {held:true};
      }
    });
    if(outcome.released){result.released+=outcome.released;result.releases++;}
    if(outcome.proposed)result.proposed++;
    if(outcome.held)result.held++;
  }
  return result;
}

// Let held warehouses be checked again now.
async function recheck(db,ctx){
  return tx(db,async c=>{
    await owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    await c.query(`UPDATE ${CHECKS} SET retry_after=clock_timestamp() WHERE workspace_id=$1`,[ctx.workspaceId]);
    await audit.record(c,ctx,{action:'Requested another routine pick-release check'});
  });
}

// Shipping orders StockChief cannot release at all, and what a person does instead.
async function notReady(c,workspaceId,filter=''){
  return (await c.query(`WITH RECURSIVE ${TREE},
   flagged AS (SELECT o.id,o.order_number,c.name customer,site.name location,
     CASE WHEN EXISTS(SELECT 1 FROM sales_order_lines l JOIN sales_order_kit_components k ON k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id
        WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id) THEN 'Kits are picked from their parts. Release this order yourself as a wave.'
      WHEN o.status='PARTIALLY_FULFILLED' OR EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND l.quantity_fulfilled<>0)
       THEN 'Part of this order has shipped. Send the rest with a partial release.'
      WHEN EXISTS(SELECT 1 FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
        WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND i.quantity_precision<>0) THEN 'Boxes take whole units and this order has a measured quantity. Ship it yourself.'
      WHEN EXISTS(SELECT 1 FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
        WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND (s.is_active<>1 OR i.is_active<>1)) THEN 'A product on this order is archived.'
      WHEN EXISTS(SELECT 1 FROM sales_order_lines l JOIN sales_order_allocations a ON a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id AND a.quantity>0
        WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND NOT EXISTS(SELECT 1 FROM tree t WHERE t.root=o.fulfillment_location_id AND t.id=a.location_id))
       THEN 'Some of its stock is reserved at another warehouse. Reserve it all at '||site.name||' first.'
     END reason
    FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    JOIN locations site ON site.workspace_id=o.workspace_id AND site.id=o.fulfillment_location_id
    WHERE o.workspace_id=$1 AND o.status IN ('CONFIRMED','PARTIALLY_FULFILLED') AND o.delivery_method='SHIP'
     AND ($2='' OR lower(site.name)=lower($2) OR lower(o.order_number)=lower($2))
     AND NOT EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status IN ('PICKING','PACKED'))
     AND NOT EXISTS(SELECT 1 FROM ${MEMBERS} m WHERE m.workspace_id=o.workspace_id AND m.sales_order_id=o.id AND m.state='RELEASED'))
   SELECT * FROM flagged WHERE reason IS NOT NULL ORDER BY order_number LIMIT 50`,[workspaceId,String(filter||'').trim()])).rows;
}

async function page(db,ctx,{filter='',location=''}={}){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const mode=included(state)?policy.allowance(state.plan,JOB):'excluded';
  if(mode==='excluded')return {mode,href};
  return db.transaction(async c=>{
    const blocked=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    const sites=(await c.query(`SELECT l.id,l.name,r.batch_orders,r.capacity_orders,r.cutoffs,r.automatic,r.enabled,r.revision,
        k.problem,k.checked_at,k.retry_after
      FROM locations l LEFT JOIN ${RULES} r ON r.workspace_id=l.workspace_id AND r.location_id=l.id
      LEFT JOIN ${CHECKS} k ON k.workspace_id=l.workspace_id AND k.location_id=l.id
      WHERE l.workspace_id=$1 AND l.is_active=1 AND l.custody_agreement_id IS NULL AND NOT ${sublocationPredicate('l')}
      ORDER BY l.pick_sequence,lower(l.name),l.id LIMIT 50`,[ctx.workspaceId])).rows;
    const ready=await candidates(c,ctx.workspaceId,{filter,limit:101});
    const creditRule=await require('../sales/agent-order-checks').rule(c,ctx.workspaceId),listed=[],held=[];
    for(const o of ready.slice(0,100)){const reason=await hold(c,ctx.workspaceId,o,creditRule);(reason?held:listed).push({...o,reason,why:why(o)});}
    const facts=await stockFacts(c,ctx.workspaceId,listed.map(o=>o.id));
    for(const o of listed.filter(o=>facts.problems.has(o.id)))held.push({...o,reason:facts.problems.get(o.id)});
    const readyRows=listed.filter(o=>!facts.problems.has(o.id));
    held.push(...await notReady(c,ctx.workspaceId,filter));
    for(const s of sites){
      const rule=s.enabled?s:null;
      s.size=await sizing(c,ctx.workspaceId,s.id,rule);
      s.ready=readyRows.filter(o=>o.location_id===s.id).length;
      s.cutoffText=cutoffs(s).map(x=>x.carrier+' '+x.time).join(', ');
      s.automaticStop=mode==='excluded'?null:await automaticStop(c,ctx,state,rule,s.size);
    }
    const chosen=sites.find(s=>s.id===location)||sites.find(s=>s.ready)||null;
    const next=chosen&&chosen.ready&&!blocked?await preview(c,ctx,{locationId:chosen.id,count:Math.min(chosen.size.count||UNSIZED_PROPOSAL,MAX_BATCH)}):null;
    const releases=status=>c.query(`SELECT r.*,l.name location_name,(SELECT count(*) FROM ${MEMBERS} m WHERE m.workspace_id=r.workspace_id AND m.release_id=r.id) orders,
        NOT EXISTS(SELECT 1 FROM ${MEMBERS} m JOIN sales_shipments h ON h.workspace_id=m.workspace_id AND h.sales_order_id=m.sales_order_id
          AND (h.status IN ('PACKED','SHIPPED','DELIVERED') OR EXISTS(SELECT 1 FROM fulfillment_wave_lines w WHERE w.workspace_id=h.workspace_id AND w.shipment_id=h.id AND w.picked_quantity>0))
          WHERE m.workspace_id=r.workspace_id AND m.release_id=r.id AND m.state='RELEASED') can_undo
      FROM ${RELEASES} r JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id
      WHERE r.workspace_id=$1 AND r.status=ANY($2::text[]) ORDER BY coalesce(r.released_at,r.created_at) DESC,r.id LIMIT 20`,[ctx.workspaceId,status]);
    const waiting=(await releases(['PROPOSED'])).rows,recent=(await releases(['RELEASED','UNDONE'])).rows;
    const growth=mode==='trained';
    for(const r of recent)r.can_teach=growth&&r.status==='RELEASED'&&r.authorization_kind==='INDIVIDUAL'&&!state.shadow&&!taught(sites.find(s=>s.id===r.location_id)?.enabled?sites.find(s=>s.id===r.location_id):null);
    return {mode,href,shadow:Boolean(state.shadow),blocked,sites,ready:readyRows,more:ready.length>100,held,waiting,recent,chosen,next,filter,
      maxBatch:MAX_BATCH,requestKey:newId('release')};
  },{isolation:'REPEATABLE READ',retrySafe:true});
}

// The agent review: ready orders in pick order, and where each stands.
async function review(db,ctx,{filter='',page:number=1}={}){
  await owner(db,ctx);
  if(!await installed(db))return {rows:[],more:false,summary:'Release ready orders is not available yet.'};
  const rows=await candidates(db,ctx.workspaceId,{filter,limit:101,offset:(Number(number)-1)*100});
  return {rows:rows.slice(0,100).map(o=>({Order:o.order_number,Customer:o.customer,Warehouse:o.location,'Pick order':why(o),link:'/orders/'+o.id})),
    more:rows.length>100,pickReleaseLink:true,
    summary:'Confirmed shipping orders, fully reserved at their chosen warehouse, in the order StockChief releases them: your saved priority (lower numbers first), the ship-by date, the warehouse’s carrier cut-off, then order age. Address, overdue-invoice and stock checks run before each release.'};
}

// Needs you: releases waiting for the owner.
async function inbox(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!included(state))return [];
  const rows=(await db.query(`SELECT r.id,r.reason,r.created_at,r.plan->>'summary' summary,l.name FROM ${RELEASES} r
    JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id
    WHERE r.workspace_id=$1 AND r.status='PROPOSED' ORDER BY r.created_at,r.id LIMIT 20`,[workspaceId])).rows;
  return rows.map(r=>({kind:'approval',importance:'Needs You',priority:85,title:'Release orders to '+r.name,
    happened:(r.summary||'Ready orders are waiting.')+' Nothing has been released yet.',why:r.reason||'Your plan asks you to approve each release.',
    recommendation:'Check the orders and their pick order, then approve or dismiss the release.',href:href+'#release-'+r.id,actionLabel:'Review release',
    sourceId:'pick-release:'+r.id,at:r.created_at,createdAt:r.created_at}));
}

// Job 64 sends orders its allocation completed through these same checks.
async function inspect(db,ctx,anchorId,options={}){
  if(!await installed(db))throw new ValidationError('Release ready orders needs the latest StockChief update. Release this order yourself.');
  const order=(await db.query('SELECT fulfillment_location_id FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,anchorId])).rows[0];
  if(!order?.fulfillment_location_id)throw new ValidationError('Choose a ready order with an active dispatch warehouse.');
  const ids=options.single?[anchorId]:null;
  const p=await preview(db,ctx,{locationId:order.fulfillment_location_id,orderIds:ids,count:options.single?1:Number(options.limit||MAX_BATCH),lock:options.lock===true});
  if(!p.orders.some(o=>o.id===anchorId)){
    const held=p.held.find(o=>o.id===anchorId);
    throw new ValidationError(held?held.reason:'That order is not ready to release. Review the ready-order list again.');
  }
  return {...p,orders:p.orders.map(o=>({...o,order_number:o.orderNumber}))};
}

// Ask: "release the next ready orders at this warehouse".
async function build(db,ctx,row,args){
  await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  if(!row.fulfillment_location_id)throw new ValidationError('Choose the shipping warehouse for this order first.');
  const rule=await read(db,ctx.workspaceId,row.fulfillment_location_id);
  const size=await sizing(db,ctx.workspaceId,row.fulfillment_location_id,rule?.enabled?rule:null);
  const count=args.quantity==null||args.quantity===''?Math.max(1,Math.min(size.count||UNSIZED_PROPOSAL,MAX_BATCH)):whole(args.quantity,'Orders to release',1,MAX_BATCH);
  const p=await preview(db,ctx,{locationId:row.fulfillment_location_id,count});
  if(!p.orders.some(o=>o.id===row.id)){
    const held=p.held.find(o=>o.id===row.id);
    throw new ValidationError(held?held.reason:'That order is not in the next release at its warehouse. Review the ready orders again.');
  }
  return {payload:{recordId:row.id,locationId:p.locationId,locationName:p.location.name,orderIds:p.orders.map(o=>o.id),orderNumbers:p.orders.map(o=>o.orderNumber),
      fingerprint:p.fingerprint,limit:count,orders:p.orders},
    summary:'Release '+p.orders.length+' ready order'+(p.orders.length===1?'':'s')+' to '+p.location.name+' in pick order: '+p.orders.map(o=>o.orderNumber).join(', ')+'. No stock moves and nothing ships; picking waves, scans, packing and handoff follow.'};
}
async function execute(db,ctx,p){
  const state=await policy.accountState(db,ctx.workspaceId);
  if(policy.usesAgentTerms(state)){
    const automatic=ctx.agentWarehouseReleaseScope==='automatic',rule=await read(db,ctx.workspaceId,p.locationId);
    policy.requireJob(state.plan,JOB,automatic?'automatic':'draft',{trained:taught(rule)});
    const stop=await policy.stopped(db,ctx.workspaceId,state,ACTION,automatic);if(stop)throw new ValidationError(stop);
    if(automatic){
      const size=await sizing(db,ctx.workspaceId,p.locationId,rule?.enabled?rule:null);
      if(size.capacity!=null&&p.orderIds.length>size.room)throw new ValidationError('This release is over the warehouse’s limit of orders waiting to be picked. Approve it individually.');
    }
  }
  const done=await apply(db,ctx,{locationId:p.locationId,orderIds:p.orderIds,fingerprint:p.fingerprint,kind:ctx.agentWarehouseReleaseScope==='automatic'?'AUTOMATIC':'INDIVIDUAL',
    requestKey:'ask:'+p.idempotencyKey,count:p.orderIds.length});
  return {releaseId:done.releaseId,status:'RELEASED',orderIds:done.orderIds};
}
async function verify(db,ctx,r,p){
  if(!r.releaseId)return false;
  const rows=(await db.query(`SELECT sales_order_id FROM ${MEMBERS} WHERE workspace_id=$1 AND release_id=$2 ORDER BY position`,[ctx.workspaceId,r.releaseId])).rows;
  return JSON.stringify(rows.map(x=>x.sales_order_id))===JSON.stringify(p.orderIds);
}
// The routine authority the assistant checks for a standing job rule.
async function requireRoutineAuthority(db,ctx){
  await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic',{trained:true});
  if(!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)throw new ValidationError('The owner must enable automatic work first.');
  return {kind:'standing_job_rule',job:JOB,ownerId:ctx.actorId};
}

module.exports={JOB,ACTION,href,MAX_BATCH,installed,read,candidates,preview,stockFacts,sizing,openWork,shippedPerDay,automaticStop,propose,apply,
  releaseNow,approve,discard,undo,configure,teach,trained,run,recheck,page,review,inbox,inspect,build,execute,verify,requireRoutineAuthority,
  parseCutoffs,cutoffs,startedBoxes,
  definition:{id:JOB,key:'pick-release',label:'Release ready orders to the warehouse',filterLabel:'Warehouse name or order number',readPage:review}};
