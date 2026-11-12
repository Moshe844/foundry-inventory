'use strict';

// Job 57: builds pick lists and pick waves by zone.
//
// Orders released to a warehouse (job 56) are grouped into waves. Each wave
// starts with the first released order still waiting and takes in the orders
// that add the fewest new zones, then share the most zones with it, so a wave
// walks as few areas as it can. Every zone gets its own pick list, in pick
// path order: the owner's pick sequence, then the farthest bin first so the
// picker ends near packing (job 122's walking distances). Lot, serial and
// weighed goods carry their exact reserved batch, serial number or weight,
// or tell the picker to scan one, earliest expiry (FEFO) or oldest (FIFO)
// first. Physical scans, packing and handoff stay with staff.
//
// Each warehouse has the owner's wave rule: the most orders in one wave and
// the latest time of day StockChief starts a wave on its own. Growth prepares
// each wave for a person to start until taught (a saved rule that starts on
// its own, or "start like this" after a person starts one). Pro and Custom
// build and start waves on their own within the rule. Pause, Watch only, Ask
// me first and the first 14 days prepare or only watch. Every wave is audited
// and can be undone until picking starts.
const {newId}=require('../lib/util');
const {ValidationError,NotFoundError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const time=require('../lib/business-time');
const access=require('../actions/permissions');
const {has}=require('../db/schema-installed');
const {hash}=require('../pricing/postgres-promotions');
const {sublocationPredicate}=require('../commercial/location-capacity');

const JOB=57,ACTION='warehouse.wave.create',href='/autopilot/pick-waves';
const RULES='stockchief_runtime.agent_pick_wave_rules',WAVES='stockchief_runtime.agent_pick_waves';
const RELEASES='stockchief_runtime.agent_pick_releases',MEMBERS='stockchief_runtime.agent_pick_release_orders';
// Without the owner's wave size StockChief only prepares waves of this size
// for a person to start; it never starts one on its own.
const UNSIZED_WAVE=25,MAX_WAVE=200,MAX_WAITING=500,MAX_WAVES_PER_RUN=20;
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>['validation_error','entitlement_required','forbidden','not_found'].includes(error?.code);
const included=state=>policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'draft');
const releases=()=>require('./agent-pick-release');

async function installed(db){return has(db,WAVES);}
async function read(c,workspaceId,locationId,{lock=false}={}){
  return (await c.query(`SELECT * FROM ${RULES} WHERE workspace_id=$1 AND location_id=$2${lock?' FOR UPDATE':''}`,[workspaceId,locationId])).rows[0]||null;
}
function taught(rule){return Boolean(rule?.enabled&&rule.automatic);}
async function trained(db,workspaceId,payload){
  if(!await installed(db))return false;
  let locationId=payload?.locationId;
  if(!locationId&&payload?.orderIds?.[0])locationId=(await db.query('SELECT fulfillment_location_id FROM sales_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,payload.orderIds[0]])).rows[0]?.fulfillment_location_id;
  return locationId?taught(await read(db,workspaceId,locationId)):false;
}

// Where each pick location sits: its zone (or the area under the warehouse),
// its place in the owner's pick sequence and its walking distance to packing.
async function places(c,workspaceId,locationIds){
  const ids=[...new Set(locationIds)];
  if(!ids.length)return new Map();
  const chains=(await c.query(`WITH RECURSIVE up(start,id,parent,kind,name,seq,depth,path) AS (
    SELECT l.id,l.id,l.parent_location_id,l.kind,l.name,l.pick_sequence,0,ARRAY[l.id] FROM locations l WHERE l.workspace_id=$1 AND l.id=ANY($2::text[])
    UNION ALL
    SELECT u.start,p.id,p.parent_location_id,p.kind,p.name,p.pick_sequence,u.depth+1,u.path||p.id FROM up u JOIN locations p ON p.workspace_id=$1 AND p.id=u.parent AND NOT p.id=ANY(u.path))
    SELECT start,id,kind,name,seq,depth FROM up ORDER BY start,depth`,[workspaceId,ids])).rows;
  const distances=await has(c,'stockchief_runtime.bin_packing_distances')?new Map((await c.query(`SELECT location_id,metres::float8 metres FROM stockchief_runtime.bin_packing_distances
    WHERE workspace_id=$1 AND location_id=ANY($2::text[])`,[workspaceId,ids])).rows.map(r=>[r.location_id,Number(r.metres)])):new Map();
  const result=new Map();
  for(const id of ids){
    const chain=chains.filter(r=>r.start===id);
    if(!chain.length)continue;
    const self=chain[0],root=chain.at(-1);
    const zone=chain.find(r=>r.kind==='zone')||(chain.length>1?chain.at(-2):null);
    result.set(id,{id,name:self.name,sequence:Number(self.seq)||0,metres:distances.has(id)?distances.get(id):null,
      zoneId:zone?zone.id:root.id,zone:zone?zone.name:'Main area',zoneSequence:zone?Number(zone.seq)||0:-1});
  }
  return result;
}

// What the picker takes from one line: the exact batch, serial or weight
// reserved for the order, or which ones to scan first.
async function identities(c,workspaceId,lines,today){
  const unbound=lines.filter(l=>['lot','serial'].includes(l.tracking_mode)&&!Array.isArray(l.rotation_selection));
  const keys=[...new Set(unbound.map(l=>l.sku_id+'|'+l.location_id))];
  const suggestions=new Map(),rotation=await has(c,'stockchief_runtime.sales_rotation_entries');
  for(const key of keys){
    const [skuId,locationId]=key.split('|'),mode=unbound.find(l=>l.sku_id===skuId).tracking_mode;
    if(mode==='lot'){
      // Batches promised to other orders by FIFO/FEFO are not offered.
      const held=rotation?await require('../operations/postgres-stock-rotation').heldLots(c,workspaceId,skuId,locationId):new Map();
      const lots=(await c.query(`SELECT l.id,l.code,l.expires_at,l.received_at,b.quantity::text quantity FROM lots l JOIN lot_balances b ON b.workspace_id=l.workspace_id AND b.lot_id=l.id
        WHERE l.workspace_id=$1 AND l.sku_id=$2 AND b.location_id=$3 AND b.quantity>0 AND l.recalled_at IS NULL AND (l.expires_at IS NULL OR l.expires_at::date>=$4::date)
        ORDER BY l.expires_at NULLS LAST,l.received_at NULLS LAST,l.code LIMIT 20`,[workspaceId,skuId,locationId,today])).rows
        .map(l=>({...l,free:Number(l.quantity)-Number(held.get(l.id)||0)})).filter(l=>l.free>0);
      const fefo=lots.some(l=>l.expires_at);
      suggestions.set(key,{rule:fefo?'FEFO':'FIFO',text:'Scan a batch, '+(fefo?'earliest expiry first':'oldest first')+': '+(lots.slice(0,3).map(l=>l.code+(l.expires_at?' (expires '+String(l.expires_at).slice(0,10)+')':'')+' · '+l.free+' here').join(', ')||'none here')});
    }else{
      const units=(await c.query(`SELECT u.serial FROM serial_units u LEFT JOIN lots l ON l.workspace_id=u.workspace_id AND l.id=u.lot_id
        WHERE u.workspace_id=$1 AND u.sku_id=$2 AND u.location_id=$3 AND u.status='in_stock' AND u.condition='good' AND l.recalled_at IS NULL
         ${rotation?'AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.sales_rotation_entries r WHERE r.workspace_id=u.workspace_id AND r.serial_unit_id=u.id)':''}
        ORDER BY l.expires_at NULLS LAST,u.received_at NULLS LAST,u.serial LIMIT 3`,[workspaceId,skuId,locationId])).rows;
      suggestions.set(key,{rule:'FIFO',text:'Scan a serial number, oldest first: '+(units.map(u=>u.serial).join(', ')||'none here')});
    }
  }
  return lines.map(l=>{
    const chosen=Array.isArray(l.rotation_selection)?l.rotation_selection:null,parts=[];
    if(chosen&&l.tracking_mode!=='quantity')parts.push('Take exactly: '+chosen.map(s=>s.serial?'serial '+s.serial:'batch '+(s.lotCode||'')+(s.expiresOn?' (expires '+s.expiresOn+')':'')+' × '+s.quantity).join(', '));
    else if(l.tracking_mode!=='quantity')parts.push(suggestions.get(l.sku_id+'|'+l.location_id)?.text||'Scan a batch or serial number.');
    if(l.secondary_unit_label){
      const weight=chosen?.every(s=>s.secondaryQuantity!=null)?chosen.reduce((n,s)=>n+Number(s.secondaryQuantity),0):null;
      parts.push(weight!=null?'Reserved weight '+weight+' '+l.secondary_unit_label+'. Weigh it at packing.':'Weigh it and record the actual '+l.secondary_unit_label+' at packing.');
    }
    return {...l,instruction:parts.join(' ')};
  });
}

// One pick list per zone, each in pick path order.
function lists(lines,where){
  const zones=new Map();
  for(const l of lines){
    const p=where.get(l.location_id)||{zoneId:l.location_id,zone:'Main area',zoneSequence:-1,sequence:0,metres:null,name:l.location_name};
    if(!zones.has(p.zoneId))zones.set(p.zoneId,{id:p.zoneId,name:p.zone,sequence:p.zoneSequence,lines:[]});
    zones.get(p.zoneId).lines.push({...l,bin:p.name,binSequence:p.sequence,metres:p.metres});
  }
  return [...zones.values()].sort((a,b)=>a.sequence-b.sequence||a.name.localeCompare(b.name)).map(z=>{
    z.lines.sort((a,b)=>a.binSequence-b.binSequence||(b.metres??-1)-(a.metres??-1)||String(a.bin).localeCompare(String(b.bin))||String(a.code).localeCompare(String(b.code))||String(a.order_number).localeCompare(String(b.order_number)));
    const known=z.lines.every(l=>l.metres!=null);
    return {...z,walkMetres:known?Math.round(2*Math.max(...z.lines.map(l=>l.metres))*10)/10:null,units:z.lines.reduce((n,l)=>n+Number(l.quantity),0)};
  });
}

// The lines of a native wave, with everything a picker needs, by zone.
async function pickLists(db,workspaceId,waveId){
  const lines=(await db.query(`SELECT w.id,w.sku_id,w.location_id,w.planned_quantity::int quantity,w.picked_quantity::int picked,w.status,s.code,s.barcode sku_barcode,s.variant_label,
     i.name item,i.tracking_mode,i.secondary_unit_label,loc.name location_name,loc.barcode location_barcode,h.shipment_number,o.order_number,
     ${await has(db,'sales_order_allocations','rotation_selection')?'a.rotation_selection':'NULL::jsonb rotation_selection'}
    FROM fulfillment_wave_lines w JOIN skus s ON s.workspace_id=w.workspace_id AND s.id=w.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations loc ON loc.workspace_id=w.workspace_id AND loc.id=w.location_id
    JOIN sales_shipments h ON h.workspace_id=w.workspace_id AND h.id=w.shipment_id AND h.status<>'CANCELLED'
    JOIN sales_orders o ON o.workspace_id=h.workspace_id AND o.id=h.sales_order_id
    JOIN sales_shipment_lines sl ON sl.workspace_id=w.workspace_id AND sl.id=w.shipment_line_id
    LEFT JOIN sales_order_allocations a ON a.workspace_id=sl.workspace_id AND a.sales_order_line_id=sl.sales_order_line_id AND a.location_id=w.location_id
    WHERE w.workspace_id=$1 AND w.wave_id=$2 ORDER BY w.id LIMIT 2000`,[workspaceId,waveId])).rows;
  if(!lines.length)return [];
  const today=await time.today(db,workspaceId);
  return lists(await identities(db,workspaceId,lines,today),await places(db,workspaceId,lines.map(l=>l.location_id)));
}

// Released orders at one warehouse still waiting for a wave, in release order.
async function waiting(c,ctx,locationId,{skipUndone=false,orderIds=null}={}){
  const rows=(await c.query(`SELECT m.sales_order_id id,o.version FROM ${MEMBERS} m JOIN ${RELEASES} r ON r.workspace_id=m.workspace_id AND r.id=m.release_id AND r.status='RELEASED'
    JOIN sales_orders o ON o.workspace_id=m.workspace_id AND o.id=m.sales_order_id
    WHERE m.workspace_id=$1 AND r.location_id=$2 AND m.state='RELEASED' AND o.status='CONFIRMED' AND ($4::text[] IS NULL OR o.id=ANY($4::text[]))
     AND NOT EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status<>'CANCELLED')
     AND (NOT $3 OR NOT EXISTS(SELECT 1 FROM ${WAVES} w WHERE w.workspace_id=o.workspace_id AND w.status='UNDONE'
       AND w.plan->'undone' @> jsonb_build_array(jsonb_build_object('id',o.id,'version',o.version))))
    ORDER BY r.released_at,r.id,m.position LIMIT ${MAX_WAITING}`,[ctx.workspaceId,locationId,skipUndone,orderIds])).rows;
  if(!rows.length)return {orders:[],held:[],lines:[]};
  // The same checks as release: address, credit hold, stock and batches.
  const check=await releases().preview(c,ctx,{locationId,orderIds:rows.map(r=>r.id),count:rows.length,released:true});
  const ok=new Map(check.orders.map(o=>[o.id,o])),order=rows.map(r=>r.id).filter(id=>ok.has(id)).map(id=>ok.get(id));
  return {orders:order,held:check.held,lines:check.lines};
}

// Waves for one warehouse: orders that add the fewest new zones go together.
function group(orders,size){
  const left=[...orders],waves=[];
  while(left.length){
    const seed=left.shift(),wave=[seed],zones=new Set(seed.zones);
    const window=left.slice(0,size*3);
    while(wave.length<size&&window.length){
      window.sort((a,b)=>{
        const ea=a.zones.filter(z=>!zones.has(z)).length,eb=b.zones.filter(z=>!zones.has(z)).length;
        const sa=a.zones.length-ea,sb=b.zones.length-eb;
        return ea-eb||sb-sa||(a.walk??Infinity)-(b.walk??Infinity)||a.rank-b.rank;
      });
      const next=window.shift();wave.push(next);next.zones.forEach(z=>zones.add(z));left.splice(left.indexOf(next),1);
    }
    waves.push(wave);
  }
  return waves;
}

// Why a wave cannot start on its own now, or null.
async function startStop(c,ctx,state,rule,now=new Date()){
  if(!policy.permits(state.plan,JOB,'automatic',{trained:taught(rule)}))
    return 'Growth prepares each wave for a person to start until you teach it: save this warehouse’s wave rule to start waves on its own, or start one and teach it.';
  if(!rule?.enabled)return 'Save the wave size for this warehouse so StockChief can start waves on its own.';
  if(rule.start_cutoff){
    const {timeZone}=await time.forWorkspace(c,ctx.workspaceId),p=time.parts(now,timeZone),at=String(p.hour).padStart(2,'0')+':'+String(p.minute).padStart(2,'0');
    if(at>=rule.start_cutoff)return 'It is past '+rule.start_cutoff+', the last time StockChief starts a wave on its own today. A person can start it, or it starts tomorrow.';
  }
  const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,true);
  if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)
    return 'Automatic work is off for this inventory, so each wave waits for a person to start it.';
  return null;
}

// Builds every wave the released orders at one warehouse need. Each is a
// native picking wave: prepared waits for a person, started is open for scans.
async function build(c,ctx,state,locationId,{now=new Date(),manual=false}={}){
  const site=(await c.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,locationId])).rows[0];
  if(!site)return {built:0,started:0};
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
  const rule=await read(c,ctx.workspaceId,locationId),active=rule?.enabled?rule:null;
  const ready=await waiting(c,ctx,locationId,{skipUndone:!manual});
  if(!ready.orders.length)return {built:0,started:0,held:ready.held};
  const where=await places(c,ctx.workspaceId,ready.lines.map(l=>l.location_id));
  const orders=ready.orders.map((o,rank)=>{
    const lines=ready.lines.filter(l=>l.sales_order_id===o.id),zones=[...new Set(lines.map(l=>where.get(l.location_id)?.zoneId||l.location_id))];
    const metres=lines.map(l=>where.get(l.location_id)?.metres);
    return {...o,rank,zones,walk:metres.every(m=>m!=null)?Math.max(...metres):null};
  });
  const size=Math.min(active?Number(active.wave_orders):UNSIZED_WAVE,MAX_WAVE);
  const stop=await startStop(c,ctx,state,active,now);
  const result={built:0,started:0,waves:[]};
  for(const members of group(orders,size).slice(0,MAX_WAVES_PER_RUN)){
    const ids=members.map(o=>o.id),key='pick-wave:'+hash([locationId,members.map(o=>[o.id,o.version])]);
    const zoneNames=[...new Set(members.flatMap(o=>o.zones))].map(z=>[...where.values()].find(p=>p.zoneId===z)?.zone||'Main area');
    const created=await require('../operations/postgres-fulfillment-waves').create(scoped(c),ctx,{orderIds:ids,strategy:'WAVE',
      title:site.name+' · '+zoneNames.slice(0,4).join(', ')+(zoneNames.length>4?' and '+(zoneNames.length-4)+' more':''),idempotencyKey:key},{prepared:Boolean(stop)});
    if(created.replayed)continue;
    const zones=await pickLists(c,ctx.workspaceId,created.waveId);
    const plan={location:site.name,orders:members.map(o=>({id:o.id,orderNumber:o.orderNumber,version:o.version})),
      zones:zones.map(z=>({name:z.name,lines:z.lines.length,units:z.units,walkMetres:z.walkMetres})),size};
    const id=newId('pick-wave');
    await storage.reserve(c,ctx.workspaceId,'pick-wave:'+id,Buffer.byteLength(JSON.stringify(plan))*2+2048,{finished:true});
    await c.query(`INSERT INTO ${WAVES}(id,workspace_id,location_id,wave_id,status,started_kind,plan,rule_revision,reason,prepared_by,started_by,started_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,CASE WHEN $12 THEN now() END)`,
      [id,ctx.workspaceId,locationId,created.waveId,stop?'PREPARED':'STARTED',stop?null:'AUTOMATIC',JSON.stringify(plan),active?.revision||null,stop,ctx.actorId,stop?null:ctx.actorId,!stop]);
    await audit.record(c,ctx,{action:stop?'StockChief prepared a pick wave':'StockChief started a pick wave',reference:site.name,
      after:{wave:created.waveNumber,orders:plan.orders.map(o=>o.orderNumber),zones:plan.zones,reason:stop}});
    result.built++;if(!stop)result.started++;result.waves.push({id,waveId:created.waveId,waveNumber:created.waveNumber,started:!stop});
  }
  return result;
}

// Prepared waves StockChief may now start on its own (taught, before the cut-off).
async function startPrepared(c,ctx,state,locationId,now){
  const rule=await read(c,ctx.workspaceId,locationId),stop=await startStop(c,ctx,state,rule?.enabled?rule:null,now);
  if(stop)return 0;
  let started=0;
  for(const w of (await c.query(`SELECT a.* FROM ${WAVES} a JOIN fulfillment_waves f ON f.workspace_id=a.workspace_id AND f.id=a.wave_id AND f.status='RELEASED'
    WHERE a.workspace_id=$1 AND a.location_id=$2 AND a.status='PREPARED' ORDER BY a.created_at,a.id FOR UPDATE OF a`,[ctx.workspaceId,locationId])).rows){
    await c.query('SAVEPOINT start_wave');
    try{await begin(c,ctx,w,'AUTOMATIC');await c.query('RELEASE SAVEPOINT start_wave');started++;}
    catch(error){if(!expected(error))throw error;await c.query('ROLLBACK TO SAVEPOINT start_wave');await c.query('RELEASE SAVEPOINT start_wave');
      await c.query(`UPDATE ${WAVES} SET reason=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,w.id,error.message]);}
  }
  return started;
}

// The orders in a wave must still be fit to pick before anyone starts it.
async function recheck(c,ctx,w){
  const orders=(await c.query(`SELECT DISTINCT x.sales_order_id id FROM fulfillment_wave_shipments x JOIN sales_shipments h ON h.workspace_id=x.workspace_id AND h.id=x.shipment_id AND h.status='PICKING'
    WHERE x.workspace_id=$1 AND x.wave_id=$2`,[ctx.workspaceId,w.wave_id])).rows.map(r=>r.id);
  if(!orders.length)throw new ValidationError('This wave has no boxes left to pick.');
  const creditRule=await require('../sales/agent-order-checks').rule(c,ctx.workspaceId);
  const rows=(await c.query('SELECT id,order_number,ship_to_address,status FROM sales_orders WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE',[ctx.workspaceId,orders])).rows;
  for(const o of rows){
    if(!['CONFIRMED','PARTIALLY_FULFILLED'].includes(o.status))throw new ValidationError(o.order_number+' is no longer open. Undo this wave.');
    if(!require('../shipping/address').parse(o.ship_to_address||'').complete)throw new ValidationError(o.order_number+' has an incomplete delivery address. Fix it or undo this wave.');
    if(creditRule){try{await require('../sales/agent-order-checks').assertCanRelease(c,ctx.workspaceId,o.id);}
      catch(error){if(error instanceof ValidationError)throw new ValidationError(o.order_number+' is on hold for an overdue invoice. Undo this wave or settle the invoice.');throw error;}}
  }
  const facts=await releases().stockFacts(c,ctx.workspaceId,orders,{lock:true});
  for(const o of rows)if(facts.problems.has(o.id))throw new ValidationError(o.order_number+': '+facts.problems.get(o.id));
}
async function begin(c,ctx,w,kind){
  await recheck(c,ctx,w);
  const started=await require('../operations/postgres-fulfillment-waves').start(scoped(c),ctx,w.wave_id);
  await c.query(`UPDATE ${WAVES} SET status='STARTED',started_kind=$3,started_by=$4,started_at=now(),reason=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,w.id,kind,ctx.actorId]);
  await audit.record(c,ctx,{action:kind==='AUTOMATIC'?'StockChief started a pick wave':'Started a pick wave',reference:w.plan.location,after:{wave:started.waveNumber,orders:w.plan.orders.map(o=>o.orderNumber)}});
  return started;
}

async function owner(c,ctx){
  const row=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=w.owner_account_id AND x.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the current inventory owner can change pick wave rules or undo waves.');
}
async function picker(c,ctx){
  const user=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!user)throw new AuthorizationError('Sign in to this inventory first.');
  access.assertCan(user,access.MANAGE_FULFILLMENT_WAVES,'start pick waves');
}
async function lockedRow(c,ctx,{id=null,waveId=null}){
  const row=(await c.query(`SELECT * FROM ${WAVES} WHERE workspace_id=$1 AND (id=$2 OR wave_id=$3) FOR UPDATE`,[ctx.workspaceId,id,waveId])).rows[0];
  if(!row)throw new NotFoundError('That pick wave is not in this inventory.');
  return row;
}

// A person starts a prepared wave, from the wave itself or the waves page.
async function start(db,ctx,{id=null,waveId=null}){
  return tx(db,async c=>{
    await picker(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    if(stop)throw new ValidationError(stop);
    const w=await lockedRow(c,ctx,{id,waveId});
    if(w.status==='STARTED')return {id:w.id,waveId:w.wave_id,replayed:true};
    if(w.status!=='PREPARED')throw new ValidationError('This wave was undone. Build a fresh wave.');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
    await begin(c,ctx,w,'INDIVIDUAL');
    return {id:w.id,waveId:w.wave_id,replayed:false};
  });
}

// Undo until picking starts: the boxes are cancelled and the orders wait,
// still released, for a person to build their wave again.
async function undo(db,ctx,id){
  return tx(db,async c=>{
    await owner(c,ctx);
    const w=await lockedRow(c,ctx,{id});
    if(w.status==='UNDONE')return {id:w.id,replayed:true};
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
    const boxes=(await c.query(`SELECT h.id,h.sales_order_id,o.order_number,(h.status='PACKED' OR EXISTS(SELECT 1 FROM fulfillment_wave_lines l WHERE l.workspace_id=h.workspace_id AND l.shipment_id=h.id AND l.picked_quantity>0)
        OR EXISTS(SELECT 1 FROM fulfillment_wave_scans s JOIN fulfillment_wave_lines l ON l.workspace_id=s.workspace_id AND l.id=s.line_id WHERE s.workspace_id=h.workspace_id AND l.shipment_id=h.id AND s.status='ACCEPTED')) started
      FROM fulfillment_wave_shipments x JOIN sales_shipments h ON h.workspace_id=x.workspace_id AND h.id=x.shipment_id AND h.status IN ('PICKING','PACKED')
      JOIN sales_orders o ON o.workspace_id=h.workspace_id AND o.id=h.sales_order_id
      WHERE x.workspace_id=$1 AND x.wave_id=$2 ORDER BY h.id FOR UPDATE OF h`,[ctx.workspaceId,w.wave_id])).rows;
    const started=boxes.find(b=>b.started);
    if(started)throw new ValidationError('Picking has started for '+started.order_number+'. This wave can no longer be undone.');
    for(const b of boxes)await require('../shipping/postgres-service').cancel(scoped(c),ctx,b.id,{reason:'Pick wave undone before picking started'});
    const versions=boxes.length?(await c.query('SELECT id,version FROM sales_orders WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id',[ctx.workspaceId,boxes.map(b=>b.sales_order_id)])).rows:[];
    await c.query(`UPDATE ${WAVES} SET status='UNDONE',undone_by=$3,undone_at=now(),plan=plan||jsonb_build_object('undone',$4::jsonb) WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,w.id,ctx.actorId,JSON.stringify(versions.map(v=>({id:v.id,version:Number(v.version)})))]);
    await audit.record(c,ctx,{action:'Undid a pick wave',reference:w.plan.location,before:{wave:w.wave_id,orders:w.plan.orders.map(o=>o.orderNumber)},after:{cancelledBoxes:boxes.length}});
    return {id:w.id,cancelledBoxes:boxes.length};
  });
}
// Job 56 undid a release: its waves end with it.
async function releaseUndone(c,ctx,orderIds){
  if(!orderIds.length||!await installed(c))return;
  await c.query(`UPDATE ${WAVES} a SET status='UNDONE',undone_by=$3,undone_at=now(),plan=a.plan||jsonb_build_object('undone','[]'::jsonb)
    FROM fulfillment_waves f WHERE a.workspace_id=$1 AND f.workspace_id=a.workspace_id AND f.id=a.wave_id AND f.status='CANCELLED' AND a.status IN ('PREPARED','STARTED')
     AND EXISTS(SELECT 1 FROM fulfillment_wave_shipments x WHERE x.workspace_id=f.workspace_id AND x.wave_id=f.id AND x.sales_order_id=ANY($2::text[]))`,
  [ctx.workspaceId,orderIds,ctx.actorId]);
}

function whole(value,label,min,max){
  const n=Number(String(value??'').trim());
  if(String(value??'').trim()===''||!Number.isSafeInteger(n)||n<min||n>max)throw new ValidationError(label+' must be a whole number from '+min+' to '+max+'.');
  return n;
}
function clock(value){
  const text=String(value??'').trim();
  if(!text)return null;
  const m=/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(text);
  if(!m)throw new ValidationError('Write the last start time like 15:00.');
  let hour=Number(m[1]);const minute=Number(m[2]),half=(m[3]||'').toLowerCase();
  if(half==='pm'&&hour<12)hour+=12;if(half==='am'&&hour===12)hour=0;
  if(hour>23||minute>59||(half&&Number(m[1])>12))throw new ValidationError('Choose a real time of day for the last start time.');
  return String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0');
}
async function site(c,workspaceId,id){
  const row=(await c.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL
    AND NOT ${sublocationPredicate('locations')}`,[workspaceId,String(id||'')])).rows[0];
  if(!row)throw new ValidationError('Choose an active warehouse that ships orders.');
  return row;
}

// The owner's wave rule for one warehouse. On Growth, starting waves on its
// own is what teaches StockChief.
async function configure(db,ctx,input={}){
  return tx(db,async c=>{
    await owner(c,ctx);
    const place=await site(c,ctx.workspaceId,input.locationId);
    const prior=await read(c,ctx.workspaceId,place.id,{lock:true});
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the wave rule before changing it.');
    if(input.stop==='yes'){
      if(prior?.enabled){
        await c.query(`UPDATE ${RULES} SET enabled=false,automatic=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND location_id=$2`,[ctx.workspaceId,place.id]);
        await audit.record(c,ctx,{action:'Turned off a pick wave rule',reference:place.name,before:{revision:prior.revision}});
      }
      return {stopped:true};
    }
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const size=whole(input.waveOrders,'Most orders in one wave',1,MAX_WAVE),cutoff=clock(input.startCutoff);
    const growth=policy.allowance(state.plan,JOB)==='trained';
    const automatic=growth?input.automatic==='yes':Boolean(prior?.automatic);
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await storage.reserve(c,ctx.workspaceId,'pick-wave-rule:'+place.id+':'+((prior?.revision||0)+1),1024,{finished:true});
    await c.query(`INSERT INTO ${RULES}(workspace_id,location_id,wave_orders,start_cutoff,automatic,authorized_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(workspace_id,location_id) DO UPDATE SET wave_orders=EXCLUDED.wave_orders,start_cutoff=EXCLUDED.start_cutoff,automatic=EXCLUDED.automatic,
       authorized_by=EXCLUDED.authorized_by,enabled=true,revision=agent_pick_wave_rules.revision+1,updated_at=now()`,[ctx.workspaceId,place.id,size,cutoff,automatic,ctx.actorId]);
    await audit.record(c,ctx,{action:'Saved a pick wave rule',reference:place.name,
      before:prior?{size:prior.wave_orders,cutoff:prior.start_cutoff,automatic:prior.automatic,enabled:prior.enabled}:{},after:{size,cutoff,automatic}});
    return {saved:true,automatic,growth};
  });
}

// Growth: "start waves like this on its own" after a person started one here.
async function teach(db,ctx,id){
  return tx(db,async c=>{
    await owner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    if(!policy.permits(state.plan,JOB,'automatic',{trained:true}))throw new ValidationError('Your plan prepares each wave for a person to start.');
    if(state.shadow)throw new ValidationError('StockChief is watching during the first 14 days. Teach it after shadow mode ends.');
    const w=await lockedRow(c,ctx,{id});
    if(w.status!=='STARTED'||w.started_kind!=='INDIVIDUAL')throw new ValidationError('Teach StockChief from a wave a person started.');
    const prior=await read(c,ctx.workspaceId,w.location_id,{lock:true});
    if(taught(prior))return {taught:true,replayed:true};
    const size=prior?.enabled?Number(prior.wave_orders):Math.min(Math.max(w.plan.orders.length,1),MAX_WAVE);
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await c.query(`INSERT INTO ${RULES}(workspace_id,location_id,wave_orders,automatic,authorized_by) VALUES($1,$2,$3,true,$4)
      ON CONFLICT(workspace_id,location_id) DO UPDATE SET automatic=true,enabled=true,wave_orders=CASE WHEN agent_pick_wave_rules.enabled THEN agent_pick_wave_rules.wave_orders ELSE EXCLUDED.wave_orders END,
       authorized_by=EXCLUDED.authorized_by,revision=agent_pick_wave_rules.revision+1,updated_at=now()`,[ctx.workspaceId,w.location_id,size,ctx.actorId]);
    await audit.record(c,ctx,{action:'Taught StockChief to start pick waves on its own',reference:w.plan.location,after:{example:w.id,size}});
    return {taught:true};
  });
}

// After a release (job 56), in the same transaction: build its waves now.
async function afterRelease(c,ctx,locationId){
  if(!await installed(c))return null;
  const state=await policy.accountState(c,ctx.workspaceId);
  if(!included(state)||await policy.stopped(c,ctx.workspaceId,state,ACTION,false))return null;
  await c.query('SAVEPOINT pick_waves');
  try{const done=await build(c,ctx,state,locationId);await c.query('RELEASE SAVEPOINT pick_waves');return done;}
  catch(error){if(!expected(error))throw error;await c.query('ROLLBACK TO SAVEPOINT pick_waves');await c.query('RELEASE SAVEPOINT pick_waves');return {built:0,started:0,problem:error.message};}
}

// The routine, every 15 minutes, after releases: each warehouse in turn.
async function run(db,workspaceId,{now=new Date(),locationId=null,manualActor=null}={}){
  const result={built:0,started:0,watching:false};
  if(!await installed(db)||!await has(db,RELEASES))return result;
  const state=await policy.accountState(db,workspaceId);
  if(!included(state))return result;
  const actorId=manualActor||await require('../sales/agent-backorders').currentOwner(db,workspaceId);
  if(!actorId)return result;
  if(await policy.stopped(db,workspaceId,state,ACTION,false)){result.watching=true;return result;}
  const ctx={workspaceId,actorId};
  const sites=(await db.query(`SELECT DISTINCT r.location_id FROM ${MEMBERS} m JOIN ${RELEASES} r ON r.workspace_id=m.workspace_id AND r.id=m.release_id AND r.status='RELEASED'
      WHERE m.workspace_id=$1 AND m.state='RELEASED' AND ($2::text IS NULL OR r.location_id=$2)
    UNION SELECT a.location_id FROM ${WAVES} a WHERE a.workspace_id=$1 AND a.status='PREPARED' AND ($2::text IS NULL OR a.location_id=$2) ORDER BY 1 LIMIT 20`,[workspaceId,locationId])).rows;
  for(const s of sites){
    const done=await tx(db,async c=>{
      if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',['agent-pick-waves:'+workspaceId+':'+s.location_id])).rows[0].locked)return {built:0,started:0};
      await c.query('SAVEPOINT pick_waves_site');
      try{
        const started=await startPrepared(c,ctx,state,s.location_id,now);
        const made=await build(c,ctx,state,s.location_id,{now,manual:Boolean(manualActor)});
        await c.query('RELEASE SAVEPOINT pick_waves_site');
        return {built:made.built,started:made.started+started};
      }catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT pick_waves_site');await c.query('RELEASE SAVEPOINT pick_waves_site');
        return {built:0,started:0};
      }
    });
    result.built+=done.built;result.started+=done.started;
  }
  return result;
}

// A person asks StockChief to build waves now, including orders whose wave was undone.
async function buildNow(db,ctx,locationId){
  await db.transaction(async c=>{await owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');await site(c,ctx.workspaceId,locationId);},{isolation:'REPEATABLE READ',retrySafe:true});
  return run(db,ctx.workspaceId,{locationId,manualActor:ctx.actorId});
}

async function page(db,ctx){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const mode=included(state)?policy.allowance(state.plan,JOB):'excluded';
  if(mode==='excluded')return {mode,href};
  return db.transaction(async c=>{
    const blocked=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    const sites=(await c.query(`SELECT l.id,l.name,r.wave_orders,r.start_cutoff,r.automatic,r.enabled,r.revision,
        (SELECT count(*) FROM ${MEMBERS} m JOIN ${RELEASES} x ON x.workspace_id=m.workspace_id AND x.id=m.release_id AND x.status='RELEASED' AND x.location_id=l.id
          JOIN sales_orders o ON o.workspace_id=m.workspace_id AND o.id=m.sales_order_id AND o.status='CONFIRMED'
          WHERE m.workspace_id=l.workspace_id AND m.state='RELEASED' AND NOT EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status<>'CANCELLED'))::int waiting
      FROM locations l LEFT JOIN ${RULES} r ON r.workspace_id=l.workspace_id AND r.location_id=l.id
      WHERE l.workspace_id=$1 AND l.is_active=1 AND l.custody_agreement_id IS NULL AND NOT ${sublocationPredicate('l')}
      ORDER BY l.pick_sequence,lower(l.name),l.id LIMIT 50`,[ctx.workspaceId])).rows;
    for(const s of sites)s.startStop=await startStop(c,ctx,state,s.enabled?s:null);
    const rows=status=>c.query(`SELECT a.*,f.wave_number,f.status native_status,f.title,
        NOT EXISTS(SELECT 1 FROM fulfillment_wave_shipments x JOIN sales_shipments h ON h.workspace_id=x.workspace_id AND h.id=x.shipment_id
          WHERE x.workspace_id=a.workspace_id AND x.wave_id=a.wave_id AND (h.status IN ('PACKED','SHIPPED','DELIVERED')
           OR EXISTS(SELECT 1 FROM fulfillment_wave_lines w WHERE w.workspace_id=h.workspace_id AND w.shipment_id=h.id AND w.picked_quantity>0))) can_undo
      FROM ${WAVES} a JOIN fulfillment_waves f ON f.workspace_id=a.workspace_id AND f.id=a.wave_id
      WHERE a.workspace_id=$1 AND a.status=ANY($2::text[]) ORDER BY coalesce(a.started_at,a.created_at) DESC,a.id LIMIT 20`,[ctx.workspaceId,status]);
    const prepared=(await rows(['PREPARED'])).rows,recent=(await rows(['STARTED','UNDONE'])).rows;
    for(const w of prepared)w.zones=await pickLists(c,ctx.workspaceId,w.wave_id);
    const growth=mode==='trained';
    for(const w of recent)w.can_teach=growth&&w.status==='STARTED'&&w.started_kind==='INDIVIDUAL'&&!state.shadow&&!taught(sites.find(s=>s.id===w.location_id)?.enabled?sites.find(s=>s.id===w.location_id):null);
    return {mode,href,shadow:Boolean(state.shadow),blocked,sites,prepared,recent,maxWave:MAX_WAVE};
  },{isolation:'REPEATABLE READ',retrySafe:true});
}

async function review(db,ctx,{page:number=1}={}){
  await owner(db,ctx);
  if(!await installed(db))return {rows:[],more:false,summary:'Pick waves are not available yet.'};
  const rows=(await db.query(`SELECT a.id,a.status,a.reason,a.plan,f.wave_number,f.id wave_id FROM ${WAVES} a JOIN fulfillment_waves f ON f.workspace_id=a.workspace_id AND f.id=a.wave_id
    WHERE a.workspace_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(Number(number)-1)*100])).rows;
  return {rows:rows.slice(0,100).map(r=>({Wave:'#'+r.wave_number,Warehouse:r.plan.location,Orders:r.plan.orders.length,
      Zones:r.plan.zones.map(z=>z.name+' ('+z.lines+' lines'+(z.walkMetres!=null?', about '+z.walkMetres+' m':'')+')').join(', '),
      Status:r.status==='PREPARED'?'Waiting for a person to start'+(r.reason?': '+r.reason:''):r.status==='STARTED'?'Started':'Undone',link:'/warehouse/waves/'+r.wave_id})),
    more:rows.length>100,pickWavesLink:true,
    summary:'Released orders grouped into pick waves by zone, with one pick list per zone in walking order. Lots, serials and weighed goods name the exact batch, serial or weight, or which to scan first.'};
}

// Needs you: waves waiting for a person to start.
async function inbox(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!included(state))return [];
  const rows=(await db.query(`SELECT a.id,a.reason,a.created_at,a.plan,f.wave_number,f.id wave_id FROM ${WAVES} a JOIN fulfillment_waves f ON f.workspace_id=a.workspace_id AND f.id=a.wave_id AND f.status='RELEASED'
    WHERE a.workspace_id=$1 AND a.status='PREPARED' ORDER BY a.created_at,a.id LIMIT 20`,[workspaceId])).rows;
  return rows.map(r=>({kind:'approval',importance:'Needs You',priority:84,title:'Start pick wave #'+r.wave_number+' at '+r.plan.location,
    happened:r.plan.orders.length+' orders are grouped by zone: '+r.plan.zones.map(z=>z.name).join(', ')+'. Nobody can pick them until the wave starts.',
    why:r.reason||'Your plan asks a person to start each wave.',recommendation:'Check the zone pick lists, then start the wave or undo it.',
    href:'/warehouse/waves/'+r.wave_id,actionLabel:'Review wave',sourceId:'pick-wave:'+r.id,at:r.created_at,createdAt:r.created_at}));
}

// Ask: one exact order as its own picking wave, approved by a person.
async function single(db,ctx,id){
  if(!(await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount)return {needsWaveConfirmation:true};
  if(!await installed(db))return {needsWaveConfirmation:true};
  try{
    const p=await releases().inspect(db,ctx,id,{single:true});
    return {locationId:p.locationId,releaseFingerprint:p.fingerprint,needsWaveConfirmation:false};
  }catch(error){if(error instanceof ValidationError)return {needsWaveConfirmation:true};throw error;}
}
async function executeSingle(db,ctx,p){
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
  if(p.releaseFingerprint){const now=await releases().inspect(db,ctx,p.orderIds[0],{single:true,lock:true});if(now.fingerprint!==p.releaseFingerprint)throw new ValidationError('The ready order or its reservations changed. Review a fresh pick wave.');}
  const state=await policy.accountState(db,ctx.workspaceId);
  if(policy.usesAgentTerms(state)){
    const automatic=ctx.agentWarehouseReleaseScope==='automatic';
    policy.requireJob(state.plan,JOB,automatic?'automatic':'draft',{trained:automatic&&await trained(db,ctx.workspaceId,p)});
    const stop=await policy.stopped(db,ctx.workspaceId,state,ACTION,automatic,p);if(stop)throw new ValidationError(stop);
  }
  return require('../operations/postgres-fulfillment-waves').create({query:db.query.bind(db),transaction:fn=>fn(db)},ctx,p);
}

module.exports={JOB,ACTION,href,installed,read,trained,places,pickLists,lists,group,waiting,build,startStop,start,undo,releaseUndone,configure,teach,
  afterRelease,run,buildNow,page,review,inbox,single,executeSingle,clock,
  definition:{id:JOB,key:'pick-waves',label:'Build pick lists and pick waves by zone',filterLabel:'Wave number',readPage:review}};
