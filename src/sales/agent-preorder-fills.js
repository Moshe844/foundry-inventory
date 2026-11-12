'use strict';

// Job 68: fills accepted preorders as soon as their incoming stock arrives.
// A preorder holds a claim on the units of an exact placed purchase line
// (preorder-supply.js). When a person posts the receipt, the arrived units are
// set aside on the preorder's draft order in claim order, so no other order
// can take them. Once all of a preorder's units are here, it is filled: the
// order is confirmed on the stock already set aside and a shipping order goes
// to picking. Growth prepares each fill for approval; Pro and Custom fill on
// their own from pages the owner authorized for routine preorders. When less
// stock will now arrive than the preorders were promised (a cancelled or
// closed purchase line, a supplier's unavailability notice, or a receipt that
// fell short), the preorders affected are flagged in claim order and the owner
// can tell the customer by email. Every fill is logged; its pick can be taken
// back until the box is packed.
const {newId,nowIso}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const exact=require('../domain/exact-quantity');
const JOB=68,ACTION='customer_order.fill_preorder',CHECK='customer.preorder-check.v1',href='/autopilot/preorders';
const claims='stockchief_runtime.agent_preorder_claims',requests='stockchief_runtime.agent_customer_page_requests',pages='stockchief_runtime.agent_customer_order_pages';
const fills='stockchief_runtime.agent_preorder_fills',shortfalls='stockchief_runtime.agent_preorder_shortfalls';
const FLAG='Less stock is coming than this preorder needs.';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>['validation_error','entitlement_required','forbidden','not_found'].includes(error.code);
const pagesService=()=>require('./agent-customer-order-pages');
const n=v=>exact.safeNumber(v);
const units=v=>exact.canonical(v);

async function installed(db){return require('../db/schema-installed').has(db,claims);}
async function filling(db){return require('../db/schema-installed').has(db,fills);}
function included(state){return policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'draft');}

// How much of each claim on these purchase lines has arrived, in claim order.
// A receipt counts toward the claims made before it, at the claim's warehouse.
async function coverage(c,workspaceId,lineIds){
  if(!lineIds.length)return [];
  const rows=(await c.query(`SELECT pledge.request_id,pledge.sku_id,pledge.purchase_order_line_id,pledge.location_id,pledge.quantity::text quantity,pledge.created_at,
      r.status request_status,r.sales_order_id,r.reference,r.customer_id,o.status order_status
    FROM ${claims} pledge JOIN ${requests} r ON r.workspace_id=pledge.workspace_id AND r.id=pledge.request_id
    LEFT JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
    WHERE pledge.workspace_id=$1 AND pledge.purchase_order_line_id=ANY($2::text[])
      AND (r.status='RECEIVED' OR (r.status='DRAFTED' AND o.status<>'CANCELLED'))`,[workspaceId,lineIds])).rows;
  const arrivals=(await c.query(`SELECT l.id,l.purchase_order_line_id,l.location_id,l.quantity_units::text quantity,receipt.created_at::timestamptz happened
    FROM purchase_order_receipt_lines l JOIN purchase_order_receipts receipt ON receipt.workspace_id=l.workspace_id AND receipt.id=l.receipt_id
    WHERE l.workspace_id=$1 AND l.purchase_order_line_id=ANY($2::text[])`,[workspaceId,lineIds])).rows;
  const events=[...rows.map(r=>({kind:'claim',key:r.purchase_order_line_id+'|'+r.location_id,at:new Date(r.created_at).getTime(),id:r.request_id,row:r})),
    ...arrivals.map(a=>({kind:'receipt',key:a.purchase_order_line_id+'|'+a.location_id,at:new Date(a.happened).getTime(),id:a.id,quantity:a.quantity}))]
    .sort((a,b)=>a.key.localeCompare(b.key)||a.at-b.at||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
  const queues=new Map(),out=[];
  for(const e of events){
    if(!queues.has(e.key))queues.set(e.key,{list:[],next:0});
    const q=queues.get(e.key);
    if(e.kind==='claim'){const x={...e.row,quantity:n(e.row.quantity),covered:0};q.list.push(x);out.push(x);continue;}
    let left=n(e.quantity);
    while(left>0&&q.next<q.list.length){
      const x=q.list[q.next],take=Math.min(left,n(exact.subtract(x.quantity,x.covered)));
      x.covered=n(exact.add(x.covered,take));left=n(exact.subtract(left,take));
      if(x.covered>=x.quantity)q.next++;
    }
  }
  return out;
}

// Set arrived units aside on accepted preorders in claim order. Runs in the
// transaction that posts the receipt or accepts the preorder, so no other
// order can take units a customer was promised.
async function hold(c,ctx,{lineIds=null,requestId=null}={}){
  if(!await installed(c))return 0;
  const state=await policy.accountState(c,ctx.workspaceId);
  if(!included(state))return 0;
  if(requestId)lineIds=(await c.query(`SELECT purchase_order_line_id FROM ${claims} WHERE workspace_id=$1 AND request_id=$2`,[ctx.workspaceId,requestId])).rows.map(r=>r.purchase_order_line_id);
  const covered=(await coverage(c,ctx.workspaceId,[...new Set(lineIds||[])].sort()))
    .filter(x=>x.request_status==='DRAFTED'&&x.order_status==='DRAFT'&&x.covered>0&&(!requestId||x.request_id===requestId))
    .sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)||a.request_id.localeCompare(b.request_id));
  let held=0;
  for(const x of covered){
    const line=(await c.query(`SELECT l.id,coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id AND a.location_id=$4),0)::text held
      FROM sales_order_lines l WHERE l.workspace_id=$1 AND l.sales_order_id=$2 AND l.sku_id=$3 ORDER BY l.id LIMIT 1 FOR UPDATE`,[ctx.workspaceId,x.sales_order_id,x.sku_id,x.location_id])).rows[0];
    if(!line)continue;
    const want=n(exact.subtract(Math.min(x.covered,x.quantity),line.held));
    if(want<=0)continue;
    await c.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',[ctx.workspaceId,x.sku_id,x.location_id]);
    const free=(await require('../domain/postgres-stock-availability').read(c,ctx.workspaceId,x.sku_id,x.location_id)).available;
    const quantity=Math.min(want,Math.max(0,n(free)));
    if(quantity<=0)continue;
    const at=nowIso();
    await c.query(`INSERT INTO sales_order_allocations(id,workspace_id,sales_order_line_id,location_id,quantity,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)
      ON CONFLICT(sales_order_line_id,location_id) DO UPDATE SET quantity=sales_order_allocations.quantity+EXCLUDED.quantity,updated_at=EXCLUDED.updated_at`,
      [newId('soa'),ctx.workspaceId,line.id,x.location_id,quantity,at]);
    await c.query('UPDATE sales_orders SET version=version+1,updated_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,x.sales_order_id,at]);
    const key='preorder-hold:'+newId('key');
    await c.query(`INSERT INTO sales_order_events(id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
      VALUES($1,$2,$3,'preorder_stock_held',$4,$5,$6,$7)`,[newId('soevt'),ctx.workspaceId,x.sales_order_id,
      JSON.stringify({job:JOB,requestId:x.request_id,skuId:x.sku_id,locationId:x.location_id,quantity}),ctx.actorId,key,at]);
    held++;
  }
  return held;
}

async function currentOwner(c,workspaceId){return require('./agent-backorders').currentOwner(c,workspaceId);}

// Every fact the fill depends on, checked again just before it happens.
async function facts(c,ctx,requestId,{lock=false}={}){
  const r=(await c.query(`SELECT * FROM ${requests} WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.workspaceId,requestId])).rows[0];
  if(!r)throw new NotFoundError('That preorder is not in this inventory.');
  const p=(await c.query(`SELECT * FROM ${pages} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.page_id])).rows[0];
  if(r.status!=='DRAFTED'||!r.snapshot?.preorder||!p?.preorder_enabled)throw new ValidationError('This preorder has not been accepted yet.');
  const order=(await c.query(`SELECT o.*,snap.quote FROM sales_orders o
    JOIN stockchief_runtime.pricing_order_snapshots snap ON snap.workspace_id=o.workspace_id AND snap.id=o.pricing_quote_id
    WHERE o.workspace_id=$1 AND o.id=$2${lock?' FOR UPDATE OF o':''}`,[ctx.workspaceId,r.sales_order_id])).rows[0];
  if(!order)throw new ValidationError('The preorder’s order is missing. Review it before filling.');
  return {r,p,order};
}
function checkOrder({r,p,order},lines){
  if(order.customer_id!==p.customer_id||order.fulfillment_location_id!==p.location_id||order.delivery_method!==p.delivery_method||order.currency!==p.currency
    ||order.reference!==r.reference||(p.delivery_method==='SHIP'&&order.ship_to_address!==r.snapshot.input.shipToAddress)
    ||pagesService().termsHash(order.quote)!==r.snapshot.quoteHash)
    throw new ValidationError('The preorder’s order changed. Review it before setting stock aside.');
  const accepted=new Map(r.snapshot.input.lines.map(row=>[row.skuId,exact.canonical(row.quantity)]));
  if(lines.length!==accepted.size||new Set(lines.map(row=>row.sku_id)).size!==accepted.size||lines.some(row=>exact.canonical(row.quantity_ordered)!==accepted.get(row.sku_id)))
    throw new ValidationError('The preorder’s quantities changed. Review it before setting stock aside.');
}

async function automaticStop(c,ctx,state,f,owner){
  if(!policy.permits(state.plan,JOB,'automatic'))return 'Your plan prepares each preorder fill for your approval.';
  if(!f.p.enabled||!f.p.routine_enabled||f.p.authorized_by!==owner||f.p.source_hash!==f.r.source_hash)
    return 'This preorder page is not set to handle preorders on its own. Approve this fill yourself.';
  const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,true);
  if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)return 'Automatic work is off for this inventory. Approve this fill yourself.';
  return null;
}

// Confirm the order on the stock set aside, then send a shipping order to picking.
async function fill(c,ctx,f,{automatic,row}){
  const {r,p,order}=f;
  if(order.status!=='DRAFT')throw new ValidationError('This preorder was already filled or changed.');
  const lines=(await c.query('SELECT id,sku_id,quantity_ordered::text FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY id FOR SHARE',[ctx.workspaceId,order.id])).rows;
  checkOrder(f,lines);
  await hold(c,ctx,{requestId:r.id});
  if(!await require('./preorder-supply').hasArrived(c,ctx,r.id))throw new ValidationError('Not all of this preorder’s stock has arrived yet.');
  const confirmed=await require('../operations/postgres-business-workflows').confirmSalesOrderInTransaction(c,ctx,order.id,
    {idempotencyKey:'preorder-arrived:'+r.id,requireFullAllocation:true});
  const placed=(await c.query(`SELECT l.id,l.quantity_ordered::text ordered,coalesce(sum(a.quantity) FILTER(WHERE a.location_id=$3),0)::text here,coalesce(sum(a.quantity),0)::text total
    FROM sales_order_lines l LEFT JOIN sales_order_allocations a ON a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 GROUP BY l.id,l.quantity_ordered ORDER BY l.id`,[ctx.workspaceId,order.id,p.location_id])).rows;
  if(confirmed.status!=='CONFIRMED'||placed.some(l=>exact.canonical(l.here)!==exact.canonical(l.ordered)||exact.canonical(l.total)!==exact.canonical(l.ordered)))
    throw new ValidationError('The exact preorder cannot be reserved at the promised warehouse.');
  let shipment=null,note=null;
  if(order.delivery_method==='SHIP'){
    await c.query('SAVEPOINT preorder_release');
    try{
      shipment=await require('../shipping/postgres-service').prepare(scoped(c),ctx,order.id,{idempotencyKey:'preorder-pick:'+r.id,shipFromLocationId:p.location_id,
        shipToAddress:order.ship_to_address,startPicking:true,lines:placed.map(l=>({lineId:l.id,locationId:p.location_id,quantity:n(l.here)}))});
      await c.query('RELEASE SAVEPOINT preorder_release');
    }catch(error){
      if(!expected(error))throw error;
      await c.query('ROLLBACK TO SAVEPOINT preorder_release');await c.query('RELEASE SAVEPOINT preorder_release');
      note='The stock is set aside. Start picking yourself: '+error.message;
    }
  }else note='The stock is set aside for the customer to collect.';
  await c.query(`UPDATE ${fills} SET status='FILLED',authorization_kind=$3,approved_by=$4,filled_at=now(),shipment_id=$5,release_note=$6 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,row.id,automatic?'AUTOMATIC':'INDIVIDUAL',ctx.actorId,shipment?.shipmentId||null,note]);
  await c.query(`UPDATE ${requests} SET problem=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id]);
  await audit.record(c,ctx,{action:automatic?'Reserved arrived stock for accepted preorder':'Approved filling a preorder from arrived stock',reference:r.reference,
    after:{orderId:order.id,units:r.snapshot.input.lines.map(l=>({sku:l.skuId,quantity:l.quantity})),shipment:shipment?.shipmentNumber||null}});
  return {filled:true,shipmentId:shipment?.shipmentId||null};
}

async function insertFill(c,ctx,f,{status,reason=null,key}){
  const id=newId('preorder-fill');
  await storage.reserve(c,ctx.workspaceId,'preorder-fill:'+id,4096,{finished:true});
  return (await c.query(`INSERT INTO ${fills}(id,workspace_id,request_id,sales_order_id,status,reason,request_key,prepared_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT DO NOTHING RETURNING *`,[id,ctx.workspaceId,f.r.id,f.order.id,status,reason,key,ctx.actorId])).rows[0]||null;
}

// One accepted preorder whose stock may have arrived.
async function handle(c,ctx,state,requestId,owner){
  const f=await facts(c,ctx,requestId,{lock:true});
  if(f.order.status!=='DRAFT')return {};
  await hold(c,ctx,{requestId});
  if(!await require('./preorder-supply').hasArrived(c,ctx,requestId))return {};
  const open=(await c.query(`SELECT * FROM ${fills} WHERE workspace_id=$1 AND request_id=$2 AND status IN ('DRAFT','FILLED') FOR UPDATE`,[ctx.workspaceId,requestId])).rows[0];
  if(open?.status==='FILLED')return {};
  // A fill the owner dismissed is left to them; it is not prepared again.
  if(!open&&(await c.query(`SELECT 1 FROM ${fills} WHERE workspace_id=$1 AND request_id=$2 AND status='DISCARDED' LIMIT 1`,[ctx.workspaceId,requestId])).rowCount)return {};
  const why=await automaticStop(c,ctx,state,f,owner);
  if(why){
    if(open){if(open.reason!==why)await c.query(`UPDATE ${fills} SET reason=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,open.id,why]);return {};}
    await insertFill(c,ctx,f,{status:'DRAFT',reason:why,key:'draft:'+requestId+':'+newId('key')});
    return {drafted:true};
  }
  const actor={workspaceId:ctx.workspaceId,actorId:f.p.authorized_by};
  const row=open||await insertFill(c,actor,f,{status:'DRAFT',key:'auto:'+requestId});
  if(!row)return {replayed:true};
  const done=await fill(c,actor,f,{automatic:true,row});
  return {reserved:true,released:Boolean(done.shipmentId)};
}

// Which accepted preorders are flagged because less stock will now arrive.
async function checkShortfalls(c,workspaceId,actorId){
  const lineIds=(await c.query(`SELECT DISTINCT pledge.purchase_order_line_id FROM ${claims} pledge JOIN ${requests} r ON r.workspace_id=pledge.workspace_id AND r.id=pledge.request_id
    LEFT JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
    WHERE pledge.workspace_id=$1 AND (r.status='RECEIVED' OR (r.status='DRAFTED' AND o.status='DRAFT')) ORDER BY 1 LIMIT 500`,[workspaceId])).rows.map(r=>r.purchase_order_line_id);
  const supply=new Map((lineIds.length?(await c.query(`SELECT l.id,p.status,p.po_number,(l.quantity_units-l.quantity_received_units)::text remaining,
      l.supplier_amendment_closed_at IS NOT NULL OR to_jsonb(l)->>'incoming_close_id' IS NOT NULL closed,to_jsonb(l)->>'supplier_supply_hold_id' IS NOT NULL supplier_hold
    FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    WHERE l.workspace_id=$1 AND l.id=ANY($2::text[])`,[workspaceId,lineIds])).rows:[]).map(r=>[r.id,r]));
  const cover=await coverage(c,workspaceId,lineIds),short=new Map();
  const byLine=new Map();
  for(const x of cover){if(!byLine.has(x.purchase_order_line_id))byLine.set(x.purchase_order_line_id,[]);byLine.get(x.purchase_order_line_id).push(x);}
  for(const [lineId,list] of byLine){
    const s=supply.get(lineId);
    const open=s&&['ORDERED','PARTIALLY_RECEIVED'].includes(s.status)&&!s.closed&&!s.supplier_hold;
    let coming=open?Math.max(0,n(s.remaining)):0;
    const cause=!s?'The purchase order is gone.':s.status==='CANCELLED'?'Purchase order '+s.po_number+' was cancelled.':s.supplier_hold?'The supplier reported these goods unavailable on '+s.po_number+'.'
      :s.closed?'Goods on '+s.po_number+' were closed as not arriving.':'Less arrived on '+s.po_number+' than was ordered.';
    for(const x of list.sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)||a.request_id.localeCompare(b.request_id))){
      const need=n(exact.subtract(x.quantity,x.covered)),give=Math.min(need,coming);coming=n(exact.subtract(coming,give));
      const missing=n(exact.subtract(need,give));
      const counts=x.request_status==='RECEIVED'||(x.request_status==='DRAFTED'&&x.order_status==='DRAFT');
      if(missing>0&&counts){
        if(!short.has(x.request_id))short.set(x.request_id,{lines:[],total:0,causes:new Set()});
        const e=short.get(x.request_id);e.lines.push({skuId:x.sku_id,claimed:units(x.quantity),arrived:units(x.covered),short:units(missing)});
        e.total=n(exact.add(e.total,missing));e.causes.add(cause);
      }
    }
  }
  const existing=new Map((await c.query(`SELECT * FROM ${shortfalls} WHERE workspace_id=$1 AND resolved_at IS NULL`,[workspaceId])).rows.map(r=>[r.request_id,r]));
  const ctx={workspaceId,actorId};let flagged=0;
  for(const [requestId,e] of short){
    const lines=e.lines.sort((a,b)=>a.skuId.localeCompare(b.skuId)),cause=[...e.causes].sort().join(' '),prior=existing.get(requestId);
    existing.delete(requestId);
    const same=list=>JSON.stringify(list.map(l=>[l.skuId,exact.canonical(l.claimed),exact.canonical(l.arrived),exact.canonical(l.short)]));
    if(prior&&same(prior.lines)===same(lines))continue;
    await storage.reserve(c,workspaceId,'preorder-shortfall:'+requestId,2048,{finished:true});
    await c.query(`INSERT INTO ${shortfalls}(workspace_id,request_id,lines,short_quantity,cause) VALUES($1,$2,$3::jsonb,$4,$5)
      ON CONFLICT(workspace_id,request_id) DO UPDATE SET lines=EXCLUDED.lines,short_quantity=EXCLUDED.short_quantity,cause=EXCLUDED.cause,flagged_at=now(),resolved_at=NULL,
        notice_id=CASE WHEN agent_preorder_shortfalls.resolved_at IS NULL THEN agent_preorder_shortfalls.notice_id END,
        notified_by=CASE WHEN agent_preorder_shortfalls.resolved_at IS NULL THEN agent_preorder_shortfalls.notified_by END,
        notified_at=CASE WHEN agent_preorder_shortfalls.resolved_at IS NULL THEN agent_preorder_shortfalls.notified_at END`,
      [workspaceId,requestId,JSON.stringify(lines),e.total,cause]);
    await c.query(`UPDATE ${requests} SET problem=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,requestId,(FLAG+' '+cause).slice(0,500)]);
    await audit.record(c,ctx,{action:'Flagged a preorder because less stock is coming',reference:requestId,after:{lines,cause}});
    flagged++;
  }
  for(const prior of existing.values()){
    await c.query(`UPDATE ${shortfalls} SET resolved_at=now() WHERE workspace_id=$1 AND request_id=$2`,[workspaceId,prior.request_id]);
    await c.query(`UPDATE ${requests} SET problem=NULL WHERE workspace_id=$1 AND id=$2 AND problem LIKE $3`,[workspaceId,prior.request_id,FLAG+'%']);
  }
  return flagged;
}

async function settle(db,workspaceId,{requestId=null,receiptId=null}={}){
  const result={reserved:0,held:0,drafted:0,released:0,flagged:0};
  if(!await installed(db)||!await filling(db))return result;
  const state=await policy.accountState(db,workspaceId);
  if(!included(state))return result;
  const owner=await currentOwner(db,workspaceId);
  if(!owner)return result;
  // Shadow mode, watch-only mode and this job's Watch setting only watch.
  if(await policy.stopped(db,workspaceId,state,ACTION,false))return result;
  result.flagged=await tx(db,c=>checkShortfalls(c,workspaceId,owner));
  const due=(await db.query(`SELECT r.id FROM ${requests} r JOIN ${pages} p ON p.workspace_id=r.workspace_id AND p.id=r.page_id
    JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
    WHERE r.workspace_id=$1 AND r.status='DRAFTED' AND p.preorder_enabled AND o.status='DRAFT' AND ($2::text IS NULL OR r.id=$2)
      AND NOT EXISTS(SELECT 1 FROM ${fills} x WHERE x.workspace_id=r.workspace_id AND x.request_id=r.id AND x.status='FILLED')
      AND EXISTS(SELECT 1 FROM ${claims} pledge JOIN purchase_order_receipt_lines l ON l.workspace_id=pledge.workspace_id AND l.purchase_order_line_id=pledge.purchase_order_line_id
        AND l.location_id=pledge.location_id WHERE pledge.workspace_id=r.workspace_id AND pledge.request_id=r.id AND ($3::text IS NULL OR l.receipt_id=$3))
    ORDER BY (SELECT min(created_at) FROM ${claims} pledge WHERE pledge.workspace_id=r.workspace_id AND pledge.request_id=r.id),r.id LIMIT 25`,[workspaceId,requestId,receiptId])).rows;
  for(const {id} of due){
    try{
      const done=await tx(db,c=>handle(c,{workspaceId,actorId:owner},state,id,owner));
      if(done.reserved)result.reserved++;
      if(done.released)result.released++;
      if(done.drafted)result.drafted++;
    }catch(error){
      if(!expected(error))throw error;
      result.held++;
      await db.query(`UPDATE ${requests} SET problem=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,String(error.message).slice(0,500)]);
    }
  }
  return result;
}

// Inside the transaction that posts a receipt: hold arrived units, then queue the fill.
async function onReceipt(c,ctx,receiptId,lineIds){
  if(!await installed(c))return;
  if(!(await c.query(`SELECT 1 FROM ${claims} WHERE workspace_id=$1 AND purchase_order_line_id=ANY($2::text[]) LIMIT 1`,[ctx.workspaceId,lineIds])).rowCount)return;
  await hold(c,ctx,{lineIds});
  await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind:pagesService().arrivalKind,idempotencyKey:receiptId,payload:{receiptId},priority:70});
}
// Inside the transaction that cancels a purchase order with preorders on it.
async function onSupplyChange(c,ctx,purchaseOrderId,cause){
  if(!await installed(c))return;
  if(!(await c.query(`SELECT 1 FROM ${claims} pledge JOIN purchase_order_lines l ON l.workspace_id=pledge.workspace_id AND l.id=pledge.purchase_order_line_id
    WHERE pledge.workspace_id=$1 AND l.purchase_order_id=$2 LIMIT 1`,[ctx.workspaceId,purchaseOrderId])).rowCount)return;
  await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind:CHECK,idempotencyKey:'preorder-check:'+purchaseOrderId+':'+cause,
    payload:{purchaseOrderId},priority:70});
}

async function owned(c,ctx){return require('./agent-backorders').owner(c,ctx);}
async function lockedFill(c,ctx,id){
  const row=(await c.query(`SELECT * FROM ${fills} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That preorder fill is not in this inventory.');
  return row;
}

async function approve(database,ctx,id,input){
  return tx(database,async c=>{
    await owned(c,ctx);
    const row=await lockedFill(c,ctx,id);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    if(stop)throw new ValidationError(stop);
    if(row.status==='FILLED')return {id:row.id,replayed:true};
    if(row.status!=='DRAFT')throw new ValidationError('This fill is no longer waiting for approval.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm filling this preorder.');
    const f=await facts(c,ctx,row.request_id,{lock:true});
    const done=await fill(c,ctx,f,{automatic:false,row});
    return {id:row.id,...done};
  });
}
async function discard(database,ctx,id){
  return tx(database,async c=>{
    await owned(c,ctx);
    const row=await lockedFill(c,ctx,id);
    if(row.status==='DISCARDED')return {id:row.id,replayed:true};
    if(row.status!=='DRAFT')throw new ValidationError('Only a fill waiting for approval can be dismissed.');
    await c.query(`UPDATE ${fills} SET status='DISCARDED' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id]);
    await audit.record(c,ctx,{action:'Dismissed a preorder fill',reference:row.id});
    return {id:row.id};
  });
}
// Undo takes the order back from picking while its box is not packed. The stock stays with the customer.
async function undo(database,ctx,id,input){
  return tx(database,async c=>{
    await owned(c,ctx);
    const row=await lockedFill(c,ctx,id);
    if(row.status==='UNDONE')return {id:row.id,replayed:true};
    if(row.status!=='FILLED')throw new ValidationError('Only a filled preorder can be taken back from picking.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm taking this order back from picking.');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
    const box=row.shipment_id?(await c.query('SELECT status FROM sales_shipments WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,row.shipment_id])).rows[0]:null;
    if(!box)throw new ValidationError('This preorder was not sent to picking, so there is nothing to take back.');
    if(box.status!=='CANCELLED'){
      if(box.status!=='PICKING')throw new ValidationError('The box is already packed or has left. Undo is no longer possible.');
      await require('../shipping/postgres-service').cancel(scoped(c),ctx,row.shipment_id,{reason:'StockChief preorder fill taken back from picking'});
    }
    await c.query(`UPDATE ${fills} SET status='UNDONE',undone_by=$3,undone_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Took a filled preorder back from picking',reference:row.id});
    return {id:row.id};
  });
}

function shortfallMessage(s,business){
  return {subject:'About your preorder '+s.reference,
    body:['Hello '+s.customer+',','','About your preorder '+s.reference+': our supplier will send less than we expected, so we cannot fill all of it from this delivery.',
      ...s.lines.map(l=>l.short+' × '+l.name+' ('+l.code+') may not arrive.'),'','We will contact you about the rest.','',business||'Thank you.'].join('\n')};
}
async function shortfall(c,ctx,requestId){
  const s=(await c.query(`SELECT x.*,r.reference,r.customer_id,c.name customer,c.email FROM ${shortfalls} x JOIN ${requests} r ON r.workspace_id=x.workspace_id AND r.id=x.request_id
    JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id WHERE x.workspace_id=$1 AND x.request_id=$2 AND x.resolved_at IS NULL`,[ctx.workspaceId,requestId])).rows[0];
  if(!s)return null;
  const names=new Map((await c.query('SELECT s.id,s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])',
    [ctx.workspaceId,s.lines.map(l=>l.skuId)])).rows.map(r=>[r.id,r]));
  s.lines=s.lines.map(l=>({...l,code:names.get(l.skuId)?.code||'',name:names.get(l.skuId)?.name||''}));
  return s;
}
// A person sends the customer the drafted note through the connected mailbox.
async function tell(database,ctx,requestId,input){
  return tx(database,async c=>{
    await owned(c,ctx);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const s=await shortfall(c,ctx,String(requestId||''));
    if(!s)throw new NotFoundError('This preorder is no longer short of stock.');
    if(s.notice_id)return {replayed:true,communicationId:s.notice_id};
    if(input.confirmed!=='yes')throw new ValidationError('Confirm sending this note to the customer.');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email||''))throw new ValidationError('Add the customer’s email address first.');
    const box=await require('../shipping/agent-shipping-notices').mailbox(c,ctx.workspaceId,String(input.connectorId||''));
    if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 mailbox that can send email.');
    const business=(await c.query('SELECT coalesce(signature,business_name) sign FROM customer_communication_policy WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.sign;
    const queued=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'customer',recipientId:s.customer_id,recipientEmail:s.email,
      connectorId:box.id,...shortfallMessage(s,business)},'preorder-shortfall:'+s.request_id+':'+new Date(s.flagged_at).getTime());
    await c.query(`UPDATE ${shortfalls} SET notice_id=$3,notified_by=$4,notified_at=now() WHERE workspace_id=$1 AND request_id=$2`,[ctx.workspaceId,s.request_id,queued.communicationId,ctx.actorId]);
    await audit.record(c,ctx,{action:'Told a customer their preorder is short of stock',reference:s.request_id,after:{communicationId:queued.communicationId}});
    return queued;
  });
}

async function inbox(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!included(state))return [];
  const drafts=(await db.query(`SELECT x.id,x.reason,x.created_at,r.reference,c.name customer FROM ${fills} x JOIN ${requests} r ON r.workspace_id=x.workspace_id AND r.id=x.request_id
    JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id WHERE x.workspace_id=$1 AND x.status='DRAFT' ORDER BY x.created_at,x.id LIMIT 50`,[workspaceId])).rows;
  const short=(await db.query(`SELECT x.request_id,x.cause,x.flagged_at,r.reference,c.name customer FROM ${shortfalls} x JOIN ${requests} r ON r.workspace_id=x.workspace_id AND r.id=x.request_id
    JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id WHERE x.workspace_id=$1 AND x.resolved_at IS NULL AND x.notified_at IS NULL ORDER BY x.flagged_at LIMIT 50`,[workspaceId])).rows;
  return [...drafts.map(row=>({kind:'approval',importance:'Needs You',priority:83,title:'Fill preorder '+row.reference+' for '+row.customer,
    happened:'All of this preorder’s stock has arrived and is set aside. The order is not confirmed or picked yet.',why:row.reason||'Your plan asks you to approve each fill.',
    recommendation:'Check the order, then approve the fill or dismiss it.',href:href+'#fill-'+row.id,actionLabel:'Review fill',sourceId:'preorder-fill:'+row.id,createdAt:row.created_at,at:row.created_at})),
  ...short.map(row=>({kind:'order',importance:'Important',priority:82,title:'Preorder '+row.reference+' for '+row.customer+' is short of stock',
    happened:row.cause,why:'Less stock is coming than this preorder was promised.',recommendation:'Tell the customer, or find the stock elsewhere.',
    href:href+'#short-'+row.request_id,actionLabel:'Review preorder',sourceId:'preorder-short:'+row.request_id,createdAt:row.flagged_at,at:row.flagged_at}))];
}

async function page(db,ctx){
  const state=await policy.accountState(db,ctx.workspaceId);
  const mode=included(state)?policy.allowance(state.plan,JOB):'excluded';
  const accepted=(await db.query(`SELECT r.id,r.reference,r.problem,r.created_at,c.name customer,o.id order_id,o.order_number,o.status order_status,p.routine_enabled,
      x.id fill_id,x.status fill_status,x.shipment_id,h.shipment_number,h.status shipment_status
    FROM ${requests} r JOIN ${pages} p ON p.workspace_id=r.workspace_id AND p.id=r.page_id JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id
    JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
    LEFT JOIN LATERAL(SELECT * FROM ${fills} f WHERE f.workspace_id=r.workspace_id AND f.request_id=r.id AND f.status IN ('DRAFT','FILLED','UNDONE','DISCARDED')
      ORDER BY f.created_at DESC,f.id DESC LIMIT 1) x ON true
    LEFT JOIN sales_shipments h ON h.workspace_id=x.workspace_id AND h.id=x.shipment_id
    WHERE r.workspace_id=$1 AND r.status='DRAFTED' AND r.snapshot->>'preorder'='true' AND o.status<>'CANCELLED'
    ORDER BY (o.status='DRAFT') DESC,r.created_at DESC,r.id LIMIT 101`,[ctx.workspaceId])).rows;
  const lineIds=accepted.length?(await db.query(`SELECT DISTINCT purchase_order_line_id FROM ${claims} WHERE workspace_id=$1 AND request_id=ANY($2::text[])`,
    [ctx.workspaceId,accepted.map(r=>r.id)])).rows.map(r=>r.purchase_order_line_id):[];
  const cover=await coverage(db,ctx.workspaceId,lineIds),codes=new Map((await db.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[])',
    [ctx.workspaceId,[...new Set(cover.map(x=>x.sku_id))]])).rows.map(r=>[r.id,r.code]));
  for(const a of accepted)a.lines=cover.filter(x=>x.request_id===a.id).map(x=>({code:codes.get(x.sku_id),claimed:units(x.quantity),arrived:units(x.covered)}));
  const drafts=(await db.query(`SELECT x.*,r.reference,c.name customer,o.order_number FROM ${fills} x JOIN ${requests} r ON r.workspace_id=x.workspace_id AND r.id=x.request_id
    JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id JOIN sales_orders o ON o.workspace_id=x.workspace_id AND o.id=x.sales_order_id
    WHERE x.workspace_id=$1 AND x.status='DRAFT' ORDER BY x.created_at,x.id LIMIT 50`,[ctx.workspaceId])).rows;
  for(const d of drafts)d.lines=accepted.find(a=>a.id===d.request_id)?.lines||[];
  const shortRows=(await db.query(`SELECT request_id FROM ${shortfalls} WHERE workspace_id=$1 AND resolved_at IS NULL ORDER BY flagged_at LIMIT 50`,[ctx.workspaceId])).rows;
  const short=[];
  for(const row of shortRows){const s=await shortfall(db,ctx,row.request_id);if(s){s.message=shortfallMessage(s,null);s.message.lines=s.message.body.split(/\r?\n/).filter(Boolean);short.push(s);}}
  const recent=(await db.query(`SELECT x.*,r.reference,o.order_number,h.shipment_number,h.status shipment_status FROM ${fills} x
    JOIN ${requests} r ON r.workspace_id=x.workspace_id AND r.id=x.request_id JOIN sales_orders o ON o.workspace_id=x.workspace_id AND o.id=x.sales_order_id
    LEFT JOIN sales_shipments h ON h.workspace_id=x.workspace_id AND h.id=x.shipment_id
    WHERE x.workspace_id=$1 AND x.status IN ('FILLED','UNDONE') ORDER BY x.filled_at DESC,x.id LIMIT 20`,[ctx.workspaceId])).rows;
  const mailboxes=(await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId)).slice(0,20);
  const blocked=mode==='excluded'?null:await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  let automatic=null;
  if(mode==='alone'){
    automatic=await policy.stopped(db,ctx.workspaceId,state,ACTION,true);
    if(!automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)automatic='Automatic work is off for this inventory, so each fill waits for your approval.';
  }
  return {mode,shadow:Boolean(state.shadow),accepted:accepted.slice(0,100),more:accepted.length>100,drafts,short,recent,mailboxes,blocked,automatic,href};
}

module.exports={JOB,ACTION,CHECK,href,coverage,hold,settle,checkShortfalls,onReceipt,onSupplyChange,approve,discard,undo,tell,inbox,page,installed};
