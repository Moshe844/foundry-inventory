'use strict';

// Job 121: picks the best warehouse to ship each order from.
//
// For each new or unassigned shipping order StockChief looks at the stock each
// shipping warehouse really has free (after other orders, transfers, returns,
// QC holds and protected stock), how far each warehouse is from the customer,
// and the owner's saved warehouse priority and cost. One warehouse that can
// ship the whole order wins. Otherwise the owner's rule decides: never split
// (the order waits at the warehouse that has the most of it) or split when
// that ships it sooner (up to the owner's number of warehouses).
//
// The choice goes through the order itself: the ship-from warehouse is saved
// on the order and its reserved stock moves there through the native
// set-aside service, so picking, waves and backorders follow. Growth prepares
// each choice for approval; Pro and Custom choose on their own inside the
// owner's rules. It never changes an order that has started picking or
// shipping, every choice is audited and can be undone until picking starts,
// and unclear addresses or stock facts stop and ask.
const {newId,nowIso}=require('../lib/util');
const {ValidationError,NotFoundError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const exact=require('../domain/exact-quantity');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const addresses=require('../shipping/address');
const distance=require('../shipping/distance');
const native=require('./postgres-order-allocations');
const {hash}=require('../pricing/postgres-promotions');
const {sublocationPredicate}=require('../commercial/location-capacity');

const JOB=121,ACTION='sales_order.route_warehouse',KIND='agent.warehouse-routing.v1',href='/autopilot/warehouse-routing';
const RULES='stockchief_runtime.agent_warehouse_routing_rules',SITES='stockchief_runtime.agent_warehouse_routing_sites',RUNS='stockchief_runtime.agent_warehouse_routings';
const CRITERIA={nearest:'Nearest to the customer',priority:'Your warehouse priority',cheapest:'Lowest cost to ship from'};
const DEFAULT_CRITERIA=['nearest','priority','cheapest'];
const OPEN=['CONFIRMED','BACKORDERED'];
const SWEEP_LIMIT=100,RECHECK_MINUTES=60,MAX_LINES=100;
// Undo is offered while the order is open and nobody has started picking or shipping it.
const UNDOABLE=`o.status IN ('DRAFT','CONFIRMED','BACKORDERED') AND NOT EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status<>'CANCELLED') AND NOT EXISTS(SELECT 1 FROM sales_order_lines q WHERE q.workspace_id=o.workspace_id AND q.sales_order_id=o.id AND q.quantity_fulfilled>0)`;
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>['validation_error','entitlement_required','forbidden','not_found'].includes(error?.code);
const num=value=>exact.safeNumber(value,{signed:true,precision:9});
const plus=(a,b)=>num(exact.add(a,b));
const minus=(a,b)=>num(exact.subtract(a,b));
const total=list=>list.reduce((sum,row)=>plus(sum,row.quantity),0);
const included=state=>policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'draft');

// Order confirmation asks for the rules on every order, including on databases
// still being upgraded to the migration that adds them.
let installed=false;
async function ready(c){
  if(!installed)installed=(await c.query(`SELECT to_regclass('${RUNS}') IS NOT NULL AS ready`)).rows[0].ready;
  return installed;
}
async function read(c,workspaceId,{lock=false}={}){
  if(!await ready(c))return null;
  return (await c.query(`SELECT * FROM ${RULES} WHERE workspace_id=$1${lock?' FOR UPDATE':''}`,[workspaceId])).rows[0]||null;
}

// Every warehouse or site the business owns, with the owner's saved settings.
// Before the owner saves rules, every site may ship; afterwards only the ones
// the owner chose, so a new store never starts shipping orders by surprise.
async function sites(c,workspaceId,rules){
  const rows=(await c.query(`SELECT l.id,l.name,l.address,l.pick_sequence,l.annual_count_freeze_id,s.ships,s.priority,s.cost_minor
    FROM locations l LEFT JOIN ${SITES} s ON s.workspace_id=l.workspace_id AND s.location_id=l.id
    WHERE l.workspace_id=$1 AND l.is_active=1 AND l.custody_agreement_id IS NULL AND NOT ${sublocationPredicate('l')}
    ORDER BY l.pick_sequence,lower(l.name),l.id LIMIT 100`,[workspaceId])).rows;
  return rows.map((r,index)=>{
    const place=addresses.parse(r.address||'');
    return {id:r.id,name:r.name,address:r.address||'',order:index,frozen:Boolean(r.annual_count_freeze_id),saved:r.ships!==null,
      ships:r.ships===null?!rules:Boolean(r.ships),priority:r.priority===null?index+1:Number(r.priority),
      costMinor:r.cost_minor===null||r.cost_minor===undefined?null:Number(r.cost_minor),place:place.state?place:null};
  });
}

async function facts(c,ctx,orderId,{lock=false}={}){
  const order=(await c.query(`SELECT o.*,c.name customer,c.record_state,c.shipping_address customer_shipping_address,
      c.shipping_address_fields customer_shipping_address_fields,
      EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status<>'CANCELLED') boxed,
      EXISTS(SELECT 1 FROM stockchief_runtime.shipbob_sandbox_orders d WHERE d.workspace_id=o.workspace_id AND d.sales_order_id=o.id) delegated
    FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE o.workspace_id=$1 AND o.id=$2${lock?' FOR UPDATE OF o':''}`,[ctx.workspaceId,String(orderId||'')])).rows[0];
  if(!order)throw new NotFoundError('Choose an order from this inventory.');
  const args=[ctx.workspaceId,order.id];
  const lines=(await c.query(`SELECT l.id,l.sku_id,s.code,i.name item,l.quantity_ordered::text ordered,l.quantity_fulfilled::text fulfilled,
      coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)::text direct,
      (i.tracking_mode='quantity' AND i.quantity_precision=0 AND i.secondary_unit_label IS NULL) whole,(s.is_active=1 AND i.is_active=1) active
    FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.created_at,l.id`,args)).rows;
  const parts=(await c.query(`SELECT k.sales_order_line_id,k.component_sku_id,k.quantity_per_kit::text per_kit FROM sales_order_kit_components k
    JOIN sales_order_lines l ON l.workspace_id=k.workspace_id AND l.id=k.sales_order_line_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY k.id`,args)).rows;
  const allocations=(await c.query(`SELECT a.sales_order_line_id line_id,a.location_id,a.quantity::text quantity,
      (to_jsonb(a)->>'rotation_selection') IS NOT NULL rotation
    FROM sales_order_allocations a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 AND a.quantity>0 ORDER BY a.sales_order_line_id,a.location_id`,args)).rows;
  const kitHeld=(await c.query(`SELECT 1 FROM sales_order_kit_components k JOIN sales_order_kit_allocations a ON a.workspace_id=k.workspace_id AND a.kit_component_id=k.id
    JOIN sales_order_lines l ON l.workspace_id=k.workspace_id AND l.id=k.sales_order_line_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2 LIMIT 1`,args)).rowCount>0;
  const kits=new Map();
  for(const p of parts){if(!kits.has(p.sales_order_line_id))kits.set(p.sales_order_line_id,[]);kits.get(p.sales_order_line_id).push({skuId:p.component_sku_id,perKit:p.per_kit});}
  return {order,kitHeld,
    lines:lines.map(l=>({id:l.id,skuId:l.sku_id,code:l.code,item:l.item,whole:Boolean(l.whole),active:Boolean(l.active),
      fulfilled:num(l.fulfilled),direct:num(l.direct),remaining:minus(minus(l.ordered,l.fulfilled),l.direct),parts:kits.get(l.id)||null})),
    allocations:allocations.map(a=>({lineId:a.line_id,locationId:a.location_id,quantity:num(a.quantity),rotation:Boolean(a.rotation)}))};
}

// Orders StockChief never touches: they already have a warehouse, or picking
// or shipping has started, or the warehouse is not StockChief's to choose.
function untouchable({order:o,lines}){
  if(!['DRAFT',...OPEN].includes(o.status))return 'Only open orders that have not started shipping get a warehouse.';
  if(o.delivery_method!=='SHIP')return 'The customer collects this order from the location they chose.';
  if(o.fulfillment_location_id)return 'This order already ships from a chosen warehouse.';
  if(o.boxed||lines.some(l=>l.fulfilled>0))return 'Picking or shipping has started for this order, so its warehouse stays as it is.';
  if(o.delegated)return 'ShipBob ships this order.';
  if(lines.some(l=>l.direct>0))return 'The supplier ships part of this order directly.';
  if(!lines.length)return 'This order has no products yet.';
  return null;
}

function destinationOf(o){
  const text=o.ship_to_address||'';
  const fields=text&&text===o.customer_shipping_address?o.customer_shipping_address_fields:null;
  return addresses.parse(text,fields);
}
function addressQuestion(parsed){
  if(!parsed.raw)return 'There is no delivery address on this order. Add it, then StockChief can choose the warehouse.';
  const m=parsed.missing,list=m.length===1?m[0]:m.slice(0,-1).join(', ')+' and '+m[m.length-1];
  return 'The delivery address is missing the '+list+'. Fix it, then StockChief can choose the warehouse.';
}

// What one warehouse can ship of the order from what it has.
function fill(lines,pool){
  const taken=new Map(),missingKits=[];let complete=true;
  const left=sku=>Math.max(0,pool.get(sku)||0);
  for(const l of lines){
    if(l.remaining<=0)continue;
    const take=Math.min(l.remaining,left(l.skuId));
    if(take>0){pool.set(l.skuId,minus(left(l.skuId),take));taken.set(l.id,take);}
    const missing=minus(l.remaining,take);
    if(missing>0){if(l.parts)missingKits.push({l,missing});else complete=false;}
  }
  // A kit the warehouse has not built can be made there from its parts.
  for(const {l,missing} of missingKits){
    const wanted=l.parts.map(p=>[p.skuId,num(exact.convert(missing,{numerator:p.perKit}))]);
    if(wanted.every(([sku,quantity])=>left(sku)>=quantity)){
      for(const [sku,quantity] of wanted)pool.set(sku,minus(left(sku),quantity));
      taken.set(l.id,plus(taken.get(l.id)||0,missing));
    }else complete=false;
  }
  const out=lines.filter(l=>taken.get(l.id)>0).map(l=>({lineId:l.id,skuId:l.skuId,code:l.code,quantity:taken.get(l.id)}));
  return {lines:out,units:total(out),complete};
}

function ranker(criteria){
  const key={nearest:s=>s.distance?.zone??99,priority:s=>s.priority,cheapest:s=>s.costMinor??Number.MAX_SAFE_INTEGER};
  return (a,b)=>{for(const c of criteria){const d=key[c](a)-key[c](b);if(d)return d;}return a.order-b.order;};
}

// Split: take the most from one warehouse at a time, best-ranked first on a tie.
function greedy(ranked,lines,max){
  const left=new Map(lines.map(l=>[l.id,l.remaining])),pools=new Map(ranked.map(s=>[s.id,new Map(s.pool)])),parts=[];
  while(parts.length<max&&[...left.values()].some(v=>v>0)){
    let best=null;
    for(const s of ranked){
      if(parts.some(p=>p.site.id===s.id))continue;
      const got=fill(lines.map(l=>({...l,remaining:left.get(l.id)})),new Map(pools.get(s.id)));
      if(got.units>0&&(!best||got.units>best.got.units))best={s,got};
    }
    if(!best)break;
    for(const x of best.got.lines)left.set(x.lineId,minus(left.get(x.lineId),x.quantity));
    parts.push({site:best.s,lines:best.got.lines,units:best.got.units});
  }
  return parts;
}

function summarize(kind,parts,units){
  const ready=parts.reduce((n,p)=>plus(n,p.units),0);
  if(kind==='none')return 'No shipping warehouse has any of it yet. It waits for stock.';
  if(kind==='whole')return 'Ship all '+units+' from '+parts[0].site.name+'.';
  if(kind==='wait')return 'Ship from '+parts[0].site.name+': '+ready+' of '+units+' now; the rest waits there.';
  return 'Split it: '+parts.map(p=>p.units+' from '+p.site.name).join(' and ')+'.'+(ready<units?' The rest waits.':'');
}

// Works out the warehouse choice for one order. It never writes.
async function decide(c,ctx,orderId,rules,{lock=false,force=null}={}){
  const f=await facts(c,ctx,orderId,{lock}),o=f.order,confirmed=o.status!=='DRAFT';
  const head={orderId:o.id,orderNumber:o.order_number,customer:o.customer,orderVersion:Number(o.version),orderStatus:o.status,confirmed,
    ruleRevision:rules?.revision||null};
  const never=untouchable(f);
  if(never)return {...head,untouchable:never};
  const ask=reason=>({...head,ask:reason,fingerprint:hash({order:o.id,version:head.orderVersion,ask:reason})});
  if(o.record_state!=='ACTIVE')return ask('This customer is archived. Check the order before choosing its warehouse.');
  if(Number(o.customer_decision_required)||Number(o.delivery_decision_required))return ask('Confirm the customer and delivery details first.');
  const destination=destinationOf(o);
  if(!destination.complete)return ask(addressQuestion(destination));
  if(f.lines.length>MAX_LINES)return ask('Orders with more than '+MAX_LINES+' lines need a person to choose their warehouse.');
  if(f.lines.some(l=>!l.active))return ask('A product on this order is archived. Check the order before choosing its warehouse.');
  if(confirmed&&(f.kitHeld||f.lines.some(l=>l.parts)))return ask('Kits need a person to choose where they ship from.');
  const criteria=rules?.criteria||DEFAULT_CRITERIA,splitRule=rules?.split_rule||'never',maxWarehouses=Number(rules?.max_warehouses||2);
  const all=await sites(c,ctx.workspaceId,rules);
  let candidates=all.filter(s=>s.ships&&!s.frozen);
  if(force){
    const site=all.find(s=>s.id===force);
    if(!site||site.frozen)throw new ValidationError('Choose an active warehouse you own that is not frozen for a stock count.');
    candidates=[site];
  }
  if(!candidates.length)return ask('No warehouse is set to ship orders. Choose your shipping warehouses on the warehouse routing page.');
  const lines=f.lines.filter(l=>l.remaining>0);
  const skuIds=[...new Set([...lines.map(l=>l.skuId),...lines.flatMap(l=>(l.parts||[]).map(p=>p.skuId))])];
  let free;
  try{
    // The customer's own protected stock (job 12) counts for an order that
    // confirmation will reserve; moving reserved stock uses the native rules.
    free=await require('../domain/postgres-stock-availability').readMany(c,ctx.workspaceId,
      candidates.flatMap(s=>skuIds.map(skuId=>({skuId,locationId:s.id}))),{sellableOnly:true,customerId:confirmed?null:o.customer_id});
  }catch(error){
    if(!(error instanceof ValidationError))throw error;
    return ask(error.message+' StockChief needs exact stock figures to choose a warehouse.');
  }
  const own=new Map();
  for(const a of f.allocations){
    const line=f.lines.find(l=>l.id===a.lineId),key=JSON.stringify([line.skuId,a.locationId]);
    own.set(key,plus(own.get(key)||0,a.quantity));
  }
  const options=candidates.map(s=>{
    const pool=new Map(skuIds.map(sku=>{const key=JSON.stringify([sku,s.id]);return [sku,plus(free.get(key)?.available||0,own.get(key)||0)];}));
    return {...s,pool,coverage:fill(lines,new Map(pool)),distance:distance.between(s.place,destination)};
  });
  const ranked=[...options].sort(ranker(criteria));
  const units=lines.reduce((n,l)=>plus(n,l.remaining),0);
  let kind='none',parts=[];
  const single=s=>[{site:s,lines:s.coverage.lines,units:s.coverage.units}];
  const most=()=>[...ranked].sort((a,b)=>b.coverage.units-a.coverage.units||ranked.indexOf(a)-ranked.indexOf(b))[0];
  if(force){parts=single(ranked[0]);kind=ranked[0].coverage.complete?'whole':'wait';}
  else{
    const complete=ranked.find(s=>s.coverage.complete);
    if(complete){kind='whole';parts=single(complete);}
    else{
      const splittable=splitRule==='faster'&&lines.every(l=>l.whole&&!l.parts);
      const split=splittable?greedy(ranked,lines,maxWarehouses):[];
      if(split.length>1){kind='split';parts=split;}
      else{const best=most();if(best&&best.coverage.units>0){kind='wait';parts=single(best);}}
    }
  }
  const to=['whole','wait'].includes(kind)?parts[0].site.id:null;
  // The order's stock moves to the chosen warehouses; nothing else changes.
  const target=new Map();
  for(const p of parts)for(const x of p.lines)target.set(x.lineId+'|'+p.site.id,{lineId:x.lineId,locationId:p.site.id,quantity:x.quantity});
  const current=new Map(f.allocations.map(a=>[a.lineId+'|'+a.locationId,a]));
  const takes=[],gives=[];
  if(confirmed&&kind!=='none'){
    for(const [key,a] of current){const d=minus(a.quantity,target.get(key)?.quantity||0);if(d>0)takes.push({lineId:a.lineId,locationId:a.locationId,quantity:d,rotation:a.rotation});}
    for(const [key,t] of target){const d=minus(t.quantity,current.get(key)?.quantity||0);if(d>0)gives.push({lineId:t.lineId,locationId:t.locationId,quantity:d});}
  }
  const held=total(f.allocations),keeps=confirmed?total([...target.values()]):0;
  const plan={...head,kind,locationId:to,units,ready:parts.reduce((n,p)=>plus(n,p.units),0),
    destination:{line:addresses.oneLine(destination),state:destination.state,postalCode:destination.postalCode},
    criteria,splitRule,maxWarehouses,forced:Boolean(force),
    warehouses:parts.map(p=>({locationId:p.site.id,name:p.site.name,units:p.units,lines:p.lines,distance:p.site.distance})),
    options:ranked.slice(0,20).map((s,i)=>({rank:i+1,locationId:s.id,name:s.name,units:s.coverage.units,complete:s.coverage.complete,
      distance:s.distance,priority:s.priority,costMinor:s.costMinor})),
    before:{fulfillmentLocationId:null,allocations:f.allocations.map(({rotation,...a})=>a)},
    after:{fulfillmentLocationId:to,allocations:confirmed?[...target.values()]:[]},
    takes:takes.map(({rotation,...t})=>t),gives,held,keeps,shrink:confirmed?Math.max(0,minus(held,keeps)):0,
    currency:rules?.currency||null,summary:summarize(kind,parts,units)};
  plan.waiting=minus(units,plan.ready);
  plan.changes=kind==='none'?false:confirmed?Boolean(takes.length||gives.length||to):kind!=='split';
  if(takes.some(t=>t.rotation))return ask('Some stock was picked for this order by batch date. Choose its warehouse yourself.');
  if([...takes,...gives].some(m=>!f.lines.find(l=>l.id===m.lineId).whole))
    return ask('Batch, serial and measured goods need a person to move their reserved stock.');
  plan.fingerprint=hash({order:o.id,version:head.orderVersion,kind,to,forced:plan.forced,
    parts:parts.map(p=>[p.site.id,p.lines.map(x=>[x.lineId,x.quantity])]),takes:plan.takes,gives});
  return plan;
}

async function lockOrder(c,ctx,orderId){
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['warehouse-routing:'+ctx.workspaceId+':'+orderId]);
}

async function insert(c,ctx,{status,kind=null,p,reason=null,requestKey,ruleRevision=null}){
  const id=newId('ship-from');
  await storage.reserve(c,ctx.workspaceId,'warehouse-routing:'+id,Buffer.byteLength(JSON.stringify(p))*2+4096,{finished:true});
  const applied=status==='APPLIED';
  return (await c.query(`INSERT INTO ${RUNS}(id,workspace_id,sales_order_id,status,authorization_kind,plan,fingerprint,rule_revision,request_key,reason,
      prepared_by,applied_by,applied_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,CASE WHEN $13 THEN now() END)
    ON CONFLICT(workspace_id,request_key) DO NOTHING RETURNING *`,
    [id,ctx.workspaceId,p.orderId,status,kind,JSON.stringify(p),p.fingerprint,ruleRevision,requestKey,reason,ctx.actorId,applied?ctx.actorId:null,applied])).rows[0]||null;
}

// One open question or draft per order. A changed situation replaces it.
async function openRun(c,ctx,p,status,reason,rules){
  const open=(await c.query(`SELECT * FROM ${RUNS} WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('DRAFT','ASK') FOR UPDATE`,
    [ctx.workspaceId,p.orderId])).rows[0];
  if(open&&open.status===status&&open.fingerprint===p.fingerprint){
    if(open.reason!==reason)await c.query(`UPDATE ${RUNS} SET reason=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,open.id,reason]);
    return {id:open.id,created:false};
  }
  if(open)await c.query(`UPDATE ${RUNS} SET status='STALE' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,open.id]);
  const row=await insert(c,ctx,{status,p,reason,requestKey:status.toLowerCase()+':'+newId('key'),ruleRevision:rules?.revision||null});
  return {id:row.id,created:true};
}
async function closeOpen(c,ctx,orderId,exceptId=null){
  await c.query(`UPDATE ${RUNS} SET status='STALE' WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('DRAFT','ASK') AND id IS DISTINCT FROM $3`,
    [ctx.workspaceId,orderId,exceptId]);
}
// Checked and nothing to change yet: look again after a while or when the order changes.
async function keep(c,ctx,p,rules){
  await closeOpen(c,ctx,p.orderId);
  await c.query(`INSERT INTO ${RUNS}(id,workspace_id,sales_order_id,status,plan,fingerprint,rule_revision,request_key,reason,prepared_by)
    VALUES($1,$2,$3,'KEPT',$4::jsonb,$5,$6,$7,$8,$9)
    ON CONFLICT(workspace_id,request_key) DO UPDATE SET plan=EXCLUDED.plan,fingerprint=EXCLUDED.fingerprint,rule_revision=EXCLUDED.rule_revision,
      reason=EXCLUDED.reason,created_at=now()`,
    [newId('ship-from'),ctx.workspaceId,p.orderId,JSON.stringify(p),p.fingerprint,rules?.revision||null,'kept:'+p.orderId,p.summary,ctx.actorId]);
}

// Moves the order's reserved stock and saves its ship-from warehouse.
async function apply(c,ctx,p,runId){
  let version=p.orderVersion;
  const detail={job:JOB,runId};
  if(p.takes.length)version=(await native.giveBack(c,ctx,p.orderId,{expectedVersion:version,idempotencyKey:'ship-from:'+runId+':take',
    lines:p.takes,detail})).version;
  if(p.gives.length)version=(await native.setAside(c,ctx,p.orderId,{expectedVersion:version,idempotencyKey:'ship-from:'+runId+':give',
    lines:p.gives,detail})).version;
  const at=nowIso();
  if(p.locationId){
    const row=(await c.query(`UPDATE sales_orders SET fulfillment_location_id=$3,updated_at=$4,version=version+1
      WHERE workspace_id=$1 AND id=$2 AND version=$5 AND fulfillment_location_id IS NULL RETURNING version`,[ctx.workspaceId,p.orderId,p.locationId,at,version])).rows[0];
    if(!row)throw new ValidationError(p.orderNumber+' changed. Review its warehouse again.');
  }
  await c.query(`INSERT INTO sales_order_events(id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
    VALUES($1,$2,$3,'ship_from_chosen',$4,$5,$6,$7) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
    [newId('soevt'),ctx.workspaceId,p.orderId,JSON.stringify({...detail,kind:p.kind,warehouses:p.warehouses.map(w=>({locationId:w.locationId,name:w.name,units:w.units}))}),
      ctx.actorId,'ship-from:'+runId+':event',at]);
}

async function automaticStop(c,ctx,state,rules,p){
  if(!policy.permits(state.plan,JOB,'automatic'))return 'Your plan prepares each warehouse choice for your approval.';
  if(!rules.automatic)return 'Turn on choosing warehouses on its own to let StockChief assign orders without asking.';
  if(rules.authorized_by!==ctx.actorId)return 'The current owner must confirm these routing rules.';
  const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,true);
  if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)return 'Automatic work is off for this inventory. Approve this choice yourself.';
  if(p.units>rules.max_units)return p.orderNumber+' has '+p.units+' units, more than your limit of '+rules.max_units+' for one order.';
  if(p.shrink>0)return 'This ships '+p.orderNumber+' from fewer warehouses, but '+p.shrink+' units it holds now would wait. Approve it if that is what you want.';
  return null;
}

// One order, inside its own transaction and order lock.
async function handle(c,ctx,orderId){
  const state=await policy.accountState(c,ctx.workspaceId),rules=await read(c,ctx.workspaceId);
  if(!included(state)||!rules?.enabled)return {};
  await lockOrder(c,ctx,orderId);
  const p=await decide(c,ctx,orderId,rules,{lock:true});
  if(p.untouchable){await closeOpen(c,ctx,p.orderId);return {};}
  if(p.ask)return {asked:(await openRun(c,ctx,p,'ASK',p.ask,rules)).created};
  if(!p.changes){await keep(c,ctx,p,rules);return {kept:true};}
  const why=await automaticStop(c,ctx,state,rules,p);
  if(why)return {drafted:(await openRun(c,ctx,p,'DRAFT',why,rules)).created};
  const row=await insert(c,ctx,{status:'APPLIED',kind:'AUTOMATIC',p,requestKey:'auto:'+p.orderId+':'+p.fingerprint,ruleRevision:rules.revision});
  if(!row)return {replayed:true};
  await closeOpen(c,ctx,p.orderId,row.id);
  await apply(c,ctx,p,row.id);
  await audit.record(c,ctx,{action:'StockChief chose the shipping warehouse',reference:p.orderNumber,
    after:{run:row.id,kind:p.kind,warehouses:p.warehouses.map(w=>[w.name,w.units]),limit:rules.max_units}});
  return {applied:true};
}

async function candidates(db,workspaceId,{orderIds=null,limit=SWEEP_LIMIT}={}){
  return (await db.query(`SELECT o.id FROM sales_orders o
    WHERE o.workspace_id=$1 AND o.fulfillment_location_id IS NULL AND o.status=ANY($2::text[]) AND o.delivery_method='SHIP' AND o.confirmed_at IS NOT NULL
      AND ($3::text[] IS NULL OR o.id=ANY($3::text[]))
      AND NOT EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status<>'CANCELLED')
      AND NOT EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND l.quantity_fulfilled>0)
      AND NOT EXISTS(SELECT 1 FROM ${RUNS} r WHERE r.workspace_id=o.workspace_id AND r.sales_order_id=o.id AND (r.status IN ('APPLIED','UNDONE')
        OR (r.status='DISCARDED' AND (r.plan->>'orderVersion')::bigint=o.version)
        OR (r.status='KEPT' AND (r.plan->>'orderVersion')::bigint=o.version AND r.created_at>now()-make_interval(mins=>$5))))
    ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT $4`,[workspaceId,OPEN,orderIds,limit,RECHECK_MINUTES])).rows.map(r=>r.id);
}

// The routine: every confirmed shipping order still without a warehouse.
async function run(db,workspaceId,{orderIds=null}={}){
  const result={applied:0,drafted:0,asked:0,kept:0,held:0,watching:false};
  const state=await policy.accountState(db,workspaceId);
  if(!included(state))return result;
  const rules=await read(db,workspaceId);
  if(!rules?.enabled)return result;
  const actorId=await require('./agent-backorders').currentOwner(db,workspaceId);
  if(!actorId)return result;
  // Shadow mode, Watch only and the job's own Watch setting only watch.
  if(await policy.stopped(db,workspaceId,state,ACTION,false)){result.watching=true;return result;}
  const ctx={workspaceId,actorId};
  for(const id of await candidates(db,workspaceId,{orderIds})){
    const outcome=await tx(db,async c=>{
      await c.query('SAVEPOINT warehouse_routing');
      try{const done=await handle(c,ctx,id);await c.query('RELEASE SAVEPOINT warehouse_routing');return done;}
      catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT warehouse_routing');await c.query('RELEASE SAVEPOINT warehouse_routing');
        return {held:true};
      }
    });
    for(const k of ['applied','drafted','asked','kept','held'])if(outcome[k])result[k]++;
  }
  return result;
}

async function onQueued(db,job){
  const ids=job.payload?.orderIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(id=>typeof id!=='string'))throw new ValidationError('A warehouse check needs its orders.');
  return run(db,job.workspaceId,{orderIds:ids});
}

// Called inside order confirmation, before stock is reserved. When the owner
// lets StockChief choose on its own and one warehouse is the answer, the
// order is reserved there from the start. Anything else waits for the check
// that runs after confirmation.
async function chooseAtConfirmation(db,ctx,order){
  if(order.status!=='DRAFT'||order.delivery_method!=='SHIP'||order.fulfillment_location_id)return;
  const rules=await read(db,ctx.workspaceId);
  if(!rules?.enabled||!rules.automatic)return;
  const state=await policy.accountState(db,ctx.workspaceId);
  if(!included(state)||!policy.permits(state.plan,JOB,'automatic'))return;
  const actorId=await require('./agent-backorders').currentOwner(db,ctx.workspaceId);
  if(!actorId||rules.authorized_by!==actorId)return;
  const agent={workspaceId:ctx.workspaceId,actorId};
  if(await policy.stopped(db,ctx.workspaceId,state,ACTION,true))return;
  if(!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)return;
  // An order that was already split (and has since been edited) keeps that choice until a person undoes it.
  if(await appliedFor(db,ctx.workspaceId,order.id))return;
  await db.query('SAVEPOINT warehouse_routing_choice');
  try{
    const p=await decide(db,agent,order.id,rules);
    if(p.untouchable||p.ask||!['whole','wait'].includes(p.kind)||p.units>rules.max_units||p.before.allocations.length){await db.query('RELEASE SAVEPOINT warehouse_routing_choice');return;}
    const row=await insert(db,agent,{status:'APPLIED',kind:'AUTOMATIC',p:{...p,phase:'confirmation'},requestKey:'confirm:'+p.orderId+':'+p.fingerprint,ruleRevision:rules.revision});
    if(row){
      await closeOpen(db,agent,p.orderId,row.id);
      await apply(db,agent,p,row.id);
      await audit.record(db,agent,{action:'StockChief chose the shipping warehouse',reference:p.orderNumber,
        after:{run:row.id,kind:p.kind,warehouses:p.warehouses.map(w=>[w.name,w.units]),limit:rules.max_units,atConfirmation:true}});
      order.fulfillment_location_id=p.locationId;
    }
    await db.query('RELEASE SAVEPOINT warehouse_routing_choice');
  }catch(error){
    if(!expected(error))throw error;
    await db.query('ROLLBACK TO SAVEPOINT warehouse_routing_choice');await db.query('RELEASE SAVEPOINT warehouse_routing_choice');
  }
}

// After confirmation, an order still without a warehouse is checked by the worker.
async function queueAfterConfirmation(c,ctx,order,key){
  if(order.delivery_method!=='SHIP'||order.fulfillment_location_id)return;
  const rules=await read(c,ctx.workspaceId);
  if(!rules?.enabled)return;
  if(!included(await policy.accountState(c,ctx.workspaceId)))return;
  await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind:KIND,priority:60,maxAttempts:5,
    idempotencyKey:'warehouse-routing:'+hash([order.id,String(key||'')]),payload:{orderIds:[order.id]}});
}

async function staff(c,ctx){
  const access=require('../actions/permissions');
  const user=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  access.assertCan(user,access.VIEW_SALES,'see customer orders');
  access.assertCan(user,access.OPERATE,'choose the shipping warehouse');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
}
async function manualAccess(c,ctx){
  await staff(c,ctx);
  const state=await policy.accountState(c,ctx.workspaceId);
  policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,JOB,'draft');
  return state;
}
async function owner(c,ctx){
  const row=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=w.owner_account_id AND x.disabled_at IS NOT NULL)
    FOR SHARE OF w,u`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the current inventory owner can set warehouse routing rules.');
}

async function locked(c,ctx,id){
  const row=(await c.query(`SELECT * FROM ${RUNS} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That warehouse choice is not in this inventory.');
  return row;
}

function refuse(p){
  if(p.untouchable)throw new ValidationError(p.untouchable);
  if(p.ask)throw new ValidationError(p.ask);
  if(p.kind==='none')throw new ValidationError('No shipping warehouse has any of this order yet.');
  if(!p.changes)throw new ValidationError(p.confirmed?'This order already ships from these warehouses.':'Confirm the order first. StockChief then reserves it from these warehouses.');
}

async function applyIndividually(c,ctx,p,{run=null,rules}){
  const prior=(await c.query(`SELECT id FROM ${RUNS} WHERE workspace_id=$1 AND sales_order_id=$2 AND status='APPLIED' FOR UPDATE`,[ctx.workspaceId,p.orderId])).rows[0];
  if(prior)throw new ValidationError('Undo the earlier warehouse choice for '+p.orderNumber+' before choosing again.');
  let row=run;
  if(row)await c.query(`UPDATE ${RUNS} SET status='APPLIED',authorization_kind='INDIVIDUAL',applied_by=$3,applied_at=now(),plan=$4::jsonb WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,row.id,ctx.actorId,JSON.stringify(p)]);
  else row=await insert(c,ctx,{status:'APPLIED',kind:'INDIVIDUAL',p,requestKey:'manual:'+newId('key'),ruleRevision:rules?.revision||null});
  await closeOpen(c,ctx,p.orderId,row.id);
  await apply(c,ctx,p,row.id);
  await audit.record(c,ctx,{action:'Shipping warehouse chosen',reference:p.orderNumber,after:{run:row.id,kind:p.kind,warehouses:p.warehouses.map(w=>[w.name,w.units])}});
  return row;
}

// A person chooses from the order's review: the suggestion or any warehouse.
async function choose(database,ctx,orderId,input={}){
  return tx(database,async c=>{
    const state=await manualAccess(c,ctx);
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    if(stop)throw new ValidationError(stop);
    const rules=await read(c,ctx.workspaceId);
    await lockOrder(c,ctx,orderId);
    const force=input.locationId?String(input.locationId):null;
    const p=await decide(c,ctx,orderId,rules,{lock:true,force});
    refuse(p);
    // The suggestion is approved exactly as shown; a warehouse the person picks
    // only needs the order to be unchanged.
    if(force?String(input.version??'')!==String(p.orderVersion):String(input.fingerprint||'')!==p.fingerprint)
      throw new ValidationError('The order or available stock changed. Review the shipping warehouse again.');
    const open=(await c.query(`SELECT * FROM ${RUNS} WHERE workspace_id=$1 AND sales_order_id=$2 AND status='DRAFT' AND fingerprint=$3 FOR UPDATE`,
      [ctx.workspaceId,p.orderId,p.fingerprint])).rows[0]||null;
    const row=await applyIndividually(c,ctx,p,{run:open,rules});
    return {id:row.id,applied:true,location:p.locationId};
  });
}

async function approve(database,ctx,id,input={}){
  return tx(database,async c=>{
    const state=await manualAccess(c,ctx);
    const r=await locked(c,ctx,id);
    if(r.status==='APPLIED')return {id:r.id,replayed:true};
    if(r.status!=='DRAFT')throw new ValidationError('This choice is no longer waiting for approval. Review the order again.');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    if(stop)throw new ValidationError(stop);
    if(input.confirmed!=='yes'||input.fingerprint!==r.fingerprint)throw new ValidationError('Review and approve this exact warehouse choice.');
    const rules=await read(c,ctx.workspaceId);
    await lockOrder(c,ctx,r.sales_order_id);
    const p=await decide(c,ctx,r.sales_order_id,rules,{lock:true});
    if(p.untouchable||p.ask||!p.changes||p.fingerprint!==r.fingerprint){
      await c.query(`UPDATE ${RUNS} SET status='STALE' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id]);
      const next=p.untouchable?null:p.ask?await openRun(c,ctx,p,'ASK',p.ask,rules):p.changes?await openRun(c,ctx,p,'DRAFT','The order or stock changed after the earlier choice.',rules):null;
      return {id:r.id,stale:true,next:next?.id||null,orderId:r.sales_order_id};
    }
    await applyIndividually(c,ctx,p,{run:r,rules});
    return {id:r.id,applied:true,orderId:r.sales_order_id};
  });
}

async function discard(database,ctx,id){
  return tx(database,async c=>{
    await staff(c,ctx);
    const r=await locked(c,ctx,id);
    if(r.status==='DISCARDED')return {id:r.id,replayed:true,orderId:r.sales_order_id};
    if(!['DRAFT','ASK'].includes(r.status))throw new ValidationError('Only a choice waiting for you can be dismissed.');
    await c.query(`UPDATE ${RUNS} SET status='DISCARDED' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id]);
    await audit.record(c,ctx,{action:'Dismissed a warehouse choice',reference:r.plan.orderNumber,after:{run:r.id}});
    return {id:r.id,orderId:r.sales_order_id};
  });
}

function sameAllocations(current,expectedRows){
  const key=a=>a.lineId+'|'+a.locationId+'|'+a.quantity;
  return JSON.stringify(current.map(key).sort())===JSON.stringify(expectedRows.map(key).sort());
}
// Undo puts the order back the way it was. Nobody may have started picking it.
async function undo(database,ctx,id,input={}){
  return tx(database,async c=>{
    await staff(c,ctx);
    const r=await locked(c,ctx,id);
    if(r.status==='UNDONE')return {id:r.id,replayed:true,orderId:r.sales_order_id};
    if(r.status!=='APPLIED')throw new ValidationError('Only an applied warehouse choice can be undone.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this warehouse choice should be undone.');
    await lockOrder(c,ctx,r.sales_order_id);
    const f=await facts(c,ctx,r.sales_order_id,{lock:true}),o=f.order,p=r.plan;
    if(o.boxed||f.lines.some(l=>l.fulfilled>0))throw new ValidationError('Picking has started for '+o.order_number+'. Undo is no longer possible.');
    if(!['DRAFT',...OPEN].includes(o.status))throw new ValidationError(o.order_number+' is no longer open, so its warehouse stays as it is.');
    if((o.fulfillment_location_id||null)!==(p.locationId||null))throw new ValidationError('The warehouse for '+o.order_number+' was changed since. Review it on the order.');
    let version=Number(o.version);
    if(p.confirmed){
      if(!sameAllocations(f.allocations,p.after.allocations))throw new ValidationError('The stock reserved for '+o.order_number+' changed since. Review it on the order.');
      if(p.gives.length)version=(await native.giveBack(c,ctx,o.id,{expectedVersion:version,idempotencyKey:'ship-from-undo:'+r.id+':give',lines:p.gives,detail:{job:JOB,runId:r.id,undo:true}})).version;
      if(p.takes.length){
        try{version=(await native.setAside(c,ctx,o.id,{expectedVersion:version,idempotencyKey:'ship-from-undo:'+r.id+':take',lines:p.takes,detail:{job:JOB,runId:r.id,undo:true}})).version;}
        catch(error){if(error instanceof ValidationError)throw new ValidationError('The stock '+o.order_number+' held before is now promised elsewhere, so this cannot be undone. Choose its warehouse on the order instead.');throw error;}
      }
    }
    const at=nowIso();
    await c.query('UPDATE sales_orders SET fulfillment_location_id=$3,updated_at=$4,version=$5+1 WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,o.id,p.before.fulfillmentLocationId||null,at,version]);
    await c.query(`INSERT INTO sales_order_events(id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
      VALUES($1,$2,$3,'ship_from_undone',$4,$5,$6,$7) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
      [newId('soevt'),ctx.workspaceId,o.id,JSON.stringify({job:JOB,runId:r.id}),ctx.actorId,'ship-from-undo:'+r.id+':event',at]);
    await c.query(`UPDATE ${RUNS} SET status='UNDONE',undone_by=$3,undone_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Undid a warehouse choice',reference:o.order_number,before:{run:r.id,warehouses:p.warehouses.map(w=>w.name)}});
    return {id:r.id,orderId:o.id};
  });
}

function criteriaFrom(input){
  const picked=[input.first,input.second,input.third].map(v=>String(v||'').trim()).filter(Boolean);
  if(!picked.length||picked.some(v=>!Object.hasOwn(CRITERIA,v))||new Set(picked).size!==picked.length)
    throw new ValidationError('Choose what matters most, using each one once.');
  return picked;
}
function whole(value,label,min,max){
  const n=Number(String(value??'').trim());
  if(String(value??'').trim()===''||!Number.isSafeInteger(n)||n<min||n>max)throw new ValidationError(label+' must be a whole number from '+min.toLocaleString('en-US')+' to '+max.toLocaleString('en-US')+'.');
  return n;
}

async function configure(database,ctx,input={}){
  return tx(database,async c=>{
    await owner(c,ctx);
    const prior=await read(c,ctx.workspaceId,{lock:true});
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the warehouse routing rules before changing them.');
    if(input.stop==='yes'||input.manual==='yes'){
      if(prior&&(prior.enabled||prior.automatic)){
        const off=input.stop==='yes';
        await c.query(`UPDATE ${RULES} SET enabled=CASE WHEN $2 THEN false ELSE enabled END,automatic=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1`,
          [ctx.workspaceId,off]);
        await audit.record(c,ctx,{action:off?'Turned off warehouse routing':'Stopped choosing warehouses on its own',before:{revision:prior.revision}});
      }
      return {stopped:true};
    }
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm these warehouse routing rules.');
    const criteria=criteriaFrom(input),split=String(input.split||'');
    if(!['never','faster'].includes(split))throw new ValidationError('Choose whether StockChief may split an order between warehouses.');
    const maxWarehouses=split==='faster'?whole(input.maxWarehouses,'Most warehouses for one order',2,5):Number(prior?.max_warehouses||2);
    const maxUnits=whole(input.maxUnits,'Most units in one order',1,1000000);
    const automatic=input.automatic==='yes'&&policy.permits(state.plan,JOB,'automatic');
    const books=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;
    const currency=books||prior?.currency||'USD',money=require('../domain/currency');
    const list=await sites(c,ctx.workspaceId,prior);
    const settings=list.map(s=>{
      const ships=input['ships_'+s.id]==='yes',raw=String(input['priority_'+s.id]??'').trim();
      const priority=raw===''?s.priority:whole(raw,'Priority for '+s.name,1,1000);
      const cost=money.userToMinor(input['cost_'+s.id],currency,{optional:true,label:'Cost to ship from '+s.name});
      return {id:s.id,name:s.name,ships,priority,cost};
    });
    if(!settings.some(s=>s.ships))throw new ValidationError('Choose at least one warehouse that ships orders.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await storage.reserve(c,ctx.workspaceId,'warehouse-routing-rule:'+((prior?.revision||0)+1),4096+settings.length*256,{finished:true});
    await c.query(`INSERT INTO ${RULES}(workspace_id,authorized_by,criteria,split_rule,max_warehouses,max_units,currency,automatic) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(workspace_id) DO UPDATE SET authorized_by=EXCLUDED.authorized_by,criteria=EXCLUDED.criteria,split_rule=EXCLUDED.split_rule,
        max_warehouses=EXCLUDED.max_warehouses,max_units=EXCLUDED.max_units,currency=EXCLUDED.currency,automatic=EXCLUDED.automatic,enabled=true,
        revision=agent_warehouse_routing_rules.revision+1,updated_at=now()`,[ctx.workspaceId,ctx.actorId,criteria,split,maxWarehouses,maxUnits,currency,automatic]);
    for(const s of settings)await c.query(`INSERT INTO ${SITES}(workspace_id,location_id,ships,priority,cost_minor,updated_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(workspace_id,location_id) DO UPDATE SET ships=EXCLUDED.ships,priority=EXCLUDED.priority,cost_minor=EXCLUDED.cost_minor,
        updated_by=EXCLUDED.updated_by,updated_at=now()`,[ctx.workspaceId,s.id,s.ships,s.priority,s.cost,ctx.actorId]);
    await audit.record(c,ctx,{action:'Saved warehouse routing rules',
      before:prior?{criteria:prior.criteria,split:prior.split_rule,maxWarehouses:prior.max_warehouses,maxUnits:prior.max_units,automatic:prior.automatic,enabled:prior.enabled}:{},
      after:{criteria,split,maxWarehouses,maxUnits,automatic,currency,warehouses:settings.map(s=>({name:s.name,ships:s.ships,priority:s.priority,costMinor:s.cost}))}});
    return {saved:true,automatic};
  });
}

async function blocks(db,ctx,state,rules){
  const blocked=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  let automatic=null;
  if(rules?.enabled&&rules.automatic){
    automatic=await policy.stopped(db,ctx.workspaceId,state,ACTION,true);
    if(!automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)
      automatic='Automatic work is off for this inventory, so each choice waits for your approval.';
  }
  return {blocked,automatic};
}

async function page(db,ctx){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const mode=included(state)?policy.allowance(state.plan,JOB):'excluded';
  const rules=await read(db,ctx.workspaceId),list=await sites(db,ctx.workspaceId,rules);
  const runs=status=>db.query(`SELECT r.*,o.order_number,(${UNDOABLE}) can_undo FROM ${RUNS} r JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
    WHERE r.workspace_id=$1 AND r.status=ANY($2::text[]) ORDER BY coalesce(r.applied_at,r.created_at) DESC,r.id LIMIT 30`,[ctx.workspaceId,status]);
  const waiting=(await runs(['DRAFT','ASK'])).rows,recent=(await runs(['APPLIED','UNDONE'])).rows;
  const unassigned=(await db.query(`SELECT o.id,o.order_number,c.name customer,o.status FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE o.workspace_id=$1 AND o.fulfillment_location_id IS NULL AND o.status=ANY($2::text[]) AND o.delivery_method='SHIP'
      AND NOT EXISTS(SELECT 1 FROM ${RUNS} r WHERE r.workspace_id=o.workspace_id AND r.sales_order_id=o.id AND r.status IN ('APPLIED','DRAFT','ASK'))
      AND NOT EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status<>'CANCELLED')
    ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT 11`,[ctx.workspaceId,OPEN])).rows;
  const {blocked,automatic}=mode==='excluded'?{}:await blocks(db,ctx,state,rules);
  const currency=rules?.currency||(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency||'USD';
  const money=require('../domain/currency');
  return {mode,shadow:Boolean(state.shadow),rules,labels:CRITERIA,defaults:DEFAULT_CRITERIA,waiting,recent,
    sites:list.map(s=>({...s,costText:s.costMinor===null?'':money.fromMinor(s.costMinor,currency)})),
    unassigned:unassigned.slice(0,10),moreUnassigned:unassigned.length>10,blocked,automatic,href,currency};
}

// The review on one order: what StockChief suggests and why, and any earlier choice.
async function preview(db,ctx,orderId){
  return db.transaction(async c=>{
    const state=await manualAccess(c,ctx);
    const rules=await read(c,ctx.workspaceId);
    const p=await decide(c,ctx,orderId,rules);
    const latest=(await c.query(`SELECT r.*,(${UNDOABLE}) can_undo FROM ${RUNS} r JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
      WHERE r.workspace_id=$1 AND r.sales_order_id=$2 AND r.status IN ('DRAFT','ASK','APPLIED','UNDONE')
      ORDER BY r.created_at DESC,r.id DESC LIMIT 5`,[ctx.workspaceId,p.orderId])).rows;
    const {blocked}=await blocks(c,ctx,state,rules);
    return {order:{id:p.orderId,order_number:p.orderNumber,customer:p.customer,status:p.orderStatus},plan:p,rules,
      open:latest.find(r=>['DRAFT','ASK'].includes(r.status))||null,applied:latest.find(r=>r.status==='APPLIED')||null,
      history:latest.filter(r=>['APPLIED','UNDONE'].includes(r.status)),block:blocked,labels:CRITERIA,currency:rules?.currency||'USD'};
  },{isolation:'REPEATABLE READ',retrySafe:true});
}

// Whether an order page offers the warehouse review.
function eligible(order){
  return ['DRAFT',...OPEN].includes(order.status)&&order.delivery_method==='SHIP'&&!order.fulfillment_location_id;
}
async function appliedFor(db,workspaceId,orderId){
  if(!await ready(db))return null;
  return (await db.query(`SELECT id FROM ${RUNS} WHERE workspace_id=$1 AND sales_order_id=$2 AND status='APPLIED' LIMIT 1`,[workspaceId,orderId])).rows[0]||null;
}

// The agent review: open shipping orders without a warehouse and where each stands.
async function review(db,ctx,{filter='',page=1}={}){
  const rows=(await db.query(`SELECT o.order_number "Order",c.name "Customer",
      CASE WHEN r.status='DRAFT' THEN 'Waiting for your approval: '||(r.plan->>'summary') WHEN r.status='ASK' THEN 'Needs you: '||r.reason
        WHEN r.status='KEPT' THEN r.plan->>'summary' ELSE 'Not checked yet' END "Warehouse",'/orders/'||o.id||'/ship-from' link
    FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    LEFT JOIN LATERAL(SELECT x.status,x.plan,x.reason FROM ${RUNS} x WHERE x.workspace_id=o.workspace_id AND x.sales_order_id=o.id AND x.status IN ('DRAFT','ASK','KEPT')
      ORDER BY CASE x.status WHEN 'DRAFT' THEN 0 WHEN 'ASK' THEN 1 ELSE 2 END,x.created_at DESC LIMIT 1) r ON true
    WHERE o.workspace_id=$1 AND o.fulfillment_location_id IS NULL AND o.status=ANY($2::text[]) AND o.delivery_method='SHIP'
      AND ($3='' OR o.order_number ILIKE $3||'%')
      AND NOT EXISTS(SELECT 1 FROM ${RUNS} a WHERE a.workspace_id=o.workspace_id AND a.sales_order_id=o.id AND a.status='APPLIED')
      AND NOT EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status<>'CANCELLED')
    ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT 101 OFFSET $4`,
    [ctx.workspaceId,['DRAFT',...OPEN],String(filter||'').trim(),(Number(page)-1)*100])).rows;
  return {rows:rows.slice(0,100),more:rows.length>100,
    summary:'Open shipping orders that have no warehouse yet. StockChief picks the best one by the stock each warehouse really has free, the distance to the customer and your warehouse priority and cost. Open an order to see why, or set your rules.'};
}

module.exports={JOB,ACTION,KIND,href,CRITERIA,read,sites,decide,run,handle,onQueued,chooseAtConfirmation,queueAfterConfirmation,
  choose,approve,discard,undo,configure,page,preview,eligible,appliedFor,review,
  definition:{id:JOB,key:'warehouse-routing',label:'Choose the shipping warehouse for each order',filterLabel:'Order number',readPage:review}};
