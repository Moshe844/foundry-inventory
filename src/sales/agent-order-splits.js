'use strict';

// Job 61: splits an order when part of it is out of stock and ships the rest.
// When a confirmed shipping order has some stock set aside and still waits for
// more, the owner's rules decide whether to split it: which customers or
// orders accept partial shipments, the least value or share of the order worth
// sending now, and how many separate shipments one order may take. A split
// opens the normal pick for what is set aside, whole kits only, with batches
// and serials confirmed at picking as usual. The rest stays on the same order
// as its backorder, which job 64 fills when stock arrives; once it is filled,
// the rest goes to picking the same way. Pro proposes each split until the
// owner approves one under the current rules and teaches it; Custom splits on
// its own. The customer can be told by email. Every split is logged and can be
// undone until its box is packed.
const {newId,nowIso}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const exact=require('../domain/exact-quantity');
const money=require('../domain/currency');
const {hash}=require('../pricing/postgres-promotions');
const JOB=61,ACTION='sales_order.split_partial',KIND='agent.order-splits.v1',NOTICE='order_split_notice',href='/autopilot/order-splits';
const rulesTable='stockchief_runtime.agent_split_rules',consents='stockchief_runtime.agent_split_consents',splits='stockchief_runtime.agent_order_splits';
const TEACH='Approve one split under these rules, then teach StockChief to split orders like that on its own.';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>['validation_error','entitlement_required','forbidden','not_found'].includes(error.code);
const backorders=()=>require('./agent-backorders');
const shipping=()=>require('../shipping/postgres-service');
const units=n=>Number.isInteger(n)?String(n):exact.canonical(n);

async function installed(db){return require('../db/schema-installed').has(db,rulesTable);}
async function read(c,workspaceId,{lock=false}={}){
  return (await c.query(`SELECT * FROM ${rulesTable} WHERE workspace_id=$1${lock?' FOR UPDATE':''}`,[workspaceId])).rows[0]||null;
}
function included(state){return policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'draft');}
async function lockFulfillment(c,ctx){
  // The same lock order as native picking: the workspace pick lock before the order.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
}

// Does this order's customer accept partial shipments? The order's own answer
// comes first, then the customer's, then the owner's default.
async function accepts(c,ctx,o,rules){
  const row=(await c.query(`SELECT (SELECT accepts FROM ${consents} WHERE workspace_id=$1 AND sales_order_id=$2) order_choice,
    (SELECT accepts FROM ${consents} WHERE workspace_id=$1 AND customer_id=$3) customer_choice`,[ctx.workspaceId,o.id,o.customer_id])).rows[0];
  if(row.order_choice!==null)return {yes:row.order_choice,why:row.order_choice?null:'This order is marked to ship complete.'};
  if(row.customer_choice!==null)return {yes:row.customer_choice,why:row.customer_choice?null:o.customer+' does not accept partial shipments.'};
  return rules.customers==='all'?{yes:true}:{yes:false,why:o.customer+' has not said it accepts partial shipments.'};
}

// Everything StockChief knows about splitting one order now. It never writes.
async function facts(c,ctx,orderId,rules){
  const o=(await c.query(`SELECT o.id,o.order_number,o.status,o.version,o.customer_id,o.currency,o.delivery_method,o.ship_to_address,o.contact_email,
      o.fulfillment_location_id,o.confirmed_at,o.pricing_total_minor,o.pricing_quote_id,coalesce(o.customer_decision_required,0)::int customer_decision,
      coalesce(o.delivery_decision_required,0)::int delivery_decision,c.name customer,c.email customer_email,c.record_state,
      loc.name location,(loc.is_active=1 AND loc.custody_agreement_id IS NULL) owned,loc.annual_count_freeze_id frozen,
      EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status IN ('PICKING','PACKED')) picking,
      (SELECT count(*) FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status<>'CANCELLED')::int shipments,
      EXISTS(SELECT 1 FROM stockchief_runtime.shipbob_sandbox_orders d WHERE d.workspace_id=o.workspace_id AND d.sales_order_id=o.id) delegated
    FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    LEFT JOIN locations loc ON loc.workspace_id=o.workspace_id AND loc.id=o.fulfillment_location_id
    WHERE o.workspace_id=$1 AND o.id=$2`,[ctx.workspaceId,String(orderId||'')])).rows[0];
  if(!o)throw new NotFoundError('That order is not in this inventory.');
  const rows=(await c.query(`SELECT l.id,l.sku_id,s.code,i.name item,i.unit_label unit,l.quantity_ordered::text ordered,l.quantity_fulfilled::text fulfilled,
      coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)::text direct,l.unit_price_minor::text price,
      EXISTS(SELECT 1 FROM sales_order_kit_components k WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id) kit,
      coalesce((SELECT json_agg(json_build_object('locationId',a.location_id,'quantity',a.quantity::text) ORDER BY a.location_id) FROM sales_order_allocations a
        WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id AND a.quantity>0),'[]') allocations
    FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY s.code,l.id LIMIT 101`,[ctx.workspaceId,o.id])).rows;
  const here=o.fulfillment_location_id,parts=rows.some(l=>l.kit)?await require('../operations/postgres-kit-order-view').load(c,ctx.workspaceId,o.id):new Map();
  const ship=[],lines=[];let elsewhere=false,partUnits=false,readyUnits=0,waitingUnits=0,valueMinor=0,openValueMinor=0;
  for(const l of rows){
    const open=exact.safeNumber(exact.subtract(exact.subtract(l.ordered,l.fulfilled),l.direct)),price=l.price==null?null:Number(l.price);
    let ready=0;
    for(const a of l.allocations){
      const quantity=exact.safeNumber(a.quantity);
      if(a.locationId!==here){elsewhere=true;continue;}
      if(!Number.isSafeInteger(quantity))partUnits=true;
      ship.push({lineId:l.id,locationId:a.locationId,quantity});ready=exact.safeNumber(exact.add(ready,quantity));
    }
    if(l.kit){
      // Kits leave only as whole kits built from parts set aside at this warehouse.
      const kit=parts.get(l.id)||[];
      const kits=kit.length?Math.max(0,Math.min(...kit.map(p=>Math.floor((p.allocations.filter(a=>a.location_id===here).reduce((n,a)=>n+a.quantity,0)+1e-9)/Number(p.quantity_per_kit))))):0;
      if(require('../operations/postgres-kit-order-view').ready(kit)>kits)elsewhere=true;
      const whole=Math.max(0,Math.min(kits,open-ready));
      if(whole>0){ship.push({lineId:l.id,locationId:here,quantity:whole,kit:true});ready+=whole;}
    }
    ready=Math.min(ready,open);
    const waiting=exact.safeNumber(exact.subtract(open,ready));
    readyUnits=exact.safeNumber(exact.add(readyUnits,ready));waitingUnits=exact.safeNumber(exact.add(waitingUnits,Math.max(0,waiting)));
    if(price!=null){valueMinor+=exact.costMinor(ready,price);openValueMinor+=exact.costMinor(open,price);}
    lines.push({lineId:l.id,skuId:l.sku_id,code:l.code,item:l.item,unit:l.unit,kit:Boolean(l.kit),open,ready,waiting:Math.max(0,waiting),priced:price!=null});
  }
  const recipient=o.customer_email||o.contact_email||null;
  const p={orderId:o.id,orderNumber:o.order_number,status:o.status,version:Number(o.version),customerId:o.customer_id,customer:o.customer,
    locationId:here,location:o.location,delivery:o.ship_to_address,recipient,currency:o.currency,ship,lines,readyUnits,waitingUnits,
    valueMinor,openValueMinor,percent:openValueMinor>0?Math.floor(valueMinor*100/openValueMinor):100,earlier:o.shipments,
    final:waitingUnits===0&&o.shipments>0,split:o.shipments+1,hold:null,wait:null,skip:null,ruleRevision:rules?.revision||null};
  p.hold=await hold(c,ctx,o,p,{elsewhere,partUnits,lines:rows.length});
  if(!p.hold&&readyUnits<=0)p.skip='Nothing is set aside for this order yet.';
  else if(!p.hold&&waitingUnits<=0&&!p.final)p.skip='Everything is set aside. It ships as one order.';
  if(!p.hold&&!p.skip&&!p.final&&rules){
    const consent=await accepts(c,ctx,o,rules);
    const fmt=v=>money.format(v,rules.currency);
    if(!consent.yes)p.wait=consent.why;
    else if(o.shipments>=rules.max_splits)p.wait='This order already went out in '+o.shipments+' part'+(o.shipments===1?'':'s')+', your most before the rest is complete.';
    else if(rules.min_value_minor>0&&(o.currency!==rules.currency||valueMinor<Number(rules.min_value_minor)))
      p.wait=o.currency!==rules.currency?'This order is in '+o.currency+'. Your minimum is in '+rules.currency+'.':'Only '+fmt(valueMinor)+' is ready, below your minimum of '+fmt(Number(rules.min_value_minor))+'.';
    else if(p.percent<rules.min_percent)p.wait='Only '+p.percent+'% of the order is ready, below your minimum of '+rules.min_percent+'%.';
  }
  p.fingerprint=hash({order:o.id,version:p.version,status:o.status,ship:p.ship,lines:lines.map(l=>[l.lineId,l.ready,l.waiting]),earlier:o.shipments,
    rules:p.ruleRevision,hold:p.hold,wait:p.wait,delivery:o.ship_to_address,recipient});
  return p;
}

// Facts a person must look at before any part of this order can leave.
async function hold(c,ctx,o,p,{elsewhere,partUnits,lines}){
  if(!['CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'].includes(o.status)||!o.confirmed_at)return 'This order is not open.';
  if(o.delivery_method!=='SHIP')return 'Pickup orders are collected in one go.';
  if(o.record_state!=='ACTIVE')return 'This customer is archived.';
  if(o.customer_decision||o.delivery_decision)return 'Confirm the customer and delivery details first.';
  if(!o.fulfillment_location_id||!o.owned)return 'Choose the warehouse that ships this order first.';
  if(o.frozen)return 'The warehouse is frozen for a stocktake.';
  if(o.picking)return 'A pick is already open for this order.';
  if(o.delegated)return 'ShipBob handles this order.';
  if(lines>100)return 'Orders with more than 100 lines need a person.';
  if(p.lines.some(l=>!l.priced))return 'A line has no price.';
  if(elsewhere)return 'Some of its stock is set aside at another warehouse.';
  if(partUnits)return 'Part units of measured goods need a person.';
  if(!require('../shipping/address').parse(o.ship_to_address).complete)return 'Check the delivery address first.';
  try{
    await require('./agent-order-checks').assertCanRelease(c,ctx.workspaceId,o.id);
    await require('./customer-commercial-terms').assertRelease(c,ctx.workspaceId,o);
  }catch(error){if(!(error instanceof ValidationError))throw error;return error.message;}
  const skus=[...new Set(p.ship.filter(s=>!s.kit).map(s=>p.lines.find(l=>l.lineId===s.lineId).skuId))];
  if(skus.length){
    const positions=await require('../domain/postgres-stock-availability').readMany(c,ctx.workspaceId,skus.map(skuId=>({skuId,locationId:o.fulfillment_location_id})));
    if(skus.some(id=>{const x=positions.get(JSON.stringify([id,o.fulfillment_location_id]));return !x||x.onHand<x.committed+x.reserved;}))
      return 'Recorded stock at the warehouse needs a check first.';
  }
  return null;
}

async function insert(c,ctx,{status,kind=null,p,reason=null,requestKey,ruleRevision}){
  const id=newId('order-split');
  await storage.reserve(c,ctx.workspaceId,'order-split:'+id,Buffer.byteLength(JSON.stringify(p))*2+4096,{finished:true});
  const applied=status==='APPLIED';
  return (await c.query(`INSERT INTO ${splits}(id,workspace_id,sales_order_id,location_id,status,authorization_kind,plan,fingerprint,rule_revision,request_key,reason,
      prepared_by,applied_by,applied_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,CASE WHEN $14 THEN now() END)
    ON CONFLICT(workspace_id,request_key) DO NOTHING RETURNING *`,
    [id,ctx.workspaceId,p.orderId,p.locationId,status,kind,JSON.stringify(p),p.fingerprint,ruleRevision,requestKey,reason,ctx.actorId,applied?ctx.actorId:null,applied])).rows[0]||null;
}
async function staleDrafts(c,ctx,orderId,keep=null){
  await c.query(`UPDATE ${splits} SET status='STALE' WHERE workspace_id=$1 AND sales_order_id=$2 AND status='DRAFT' AND id IS DISTINCT FROM $3`,[ctx.workspaceId,orderId,keep]);
}
// One open draft per order. A changed situation replaces it.
async function draft(c,ctx,p,reason,rules){
  const open=(await c.query(`SELECT * FROM ${splits} WHERE workspace_id=$1 AND sales_order_id=$2 AND status='DRAFT' FOR UPDATE`,[ctx.workspaceId,p.orderId])).rows[0];
  if(open&&open.fingerprint===p.fingerprint){
    if(open.reason!==reason&&reason!=='Prepared on request.')await c.query(`UPDATE ${splits} SET reason=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,open.id,reason]);
    return {id:open.id,created:false};
  }
  await staleDrafts(c,ctx,p.orderId);
  const row=await insert(c,ctx,{status:'DRAFT',p,reason,requestKey:'draft:'+newId('key'),ruleRevision:rules.revision});
  return {id:row.id,created:true};
}

async function taughtExample(c,ctx,rules){
  if(!rules.taught_split_id||rules.taught_revision!==rules.revision)return null;
  return (await c.query(`SELECT id FROM ${splits} WHERE workspace_id=$1 AND id=$2 AND status IN ('APPLIED','UNDONE') AND authorization_kind='INDIVIDUAL'
    AND applied_by=$3 AND rule_revision=$4`,[ctx.workspaceId,rules.taught_split_id,ctx.actorId,rules.revision])).rows[0]||null;
}
// A new customer or a new delivery address always needs a person first (PDF page 13).
async function knownDelivery(c,ctx,p){
  return (await c.query(`SELECT 1 FROM sales_orders prior WHERE prior.workspace_id=$1 AND prior.customer_id=$2 AND prior.id<>$3
    AND prior.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED') AND coalesce(prior.customer_decision_required,0)=0
    AND coalesce(prior.delivery_decision_required,0)=0 AND prior.delivery_method='SHIP' AND lower(trim(prior.ship_to_address))=lower(trim($4)) LIMIT 1`,
    [ctx.workspaceId,p.customerId,p.orderId,p.delivery||''])).rowCount>0;
}
async function automaticStop(c,ctx,state,rules,p){
  const trained=policy.allowance(state.plan,JOB)==='trained';
  if(!rules.automatic)return trained?TEACH:'Turn on splitting on its own to let StockChief split orders without asking.';
  if(rules.authorized_by!==ctx.actorId)return 'The current owner must confirm these split rules.';
  if(trained&&!await taughtExample(c,ctx,rules))return TEACH;
  if(!policy.permits(state.plan,JOB,'automatic',{trained:true}))return 'Your plan proposes each split for approval.';
  const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,true);
  if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)return 'Automatic work is off for this inventory. Approve this split yourself.';
  if(!p.final&&!await knownDelivery(c,ctx,p))return 'The first order for a new customer or delivery address needs your approval.';
  return null;
}

function compose(p,business){
  const ready=p.lines.filter(l=>l.ready>0).map(l=>units(l.ready)+' × '+l.item+' ('+l.code+')');
  const waiting=p.lines.filter(l=>l.waiting>0).map(l=>units(l.waiting)+' × '+l.item+' ('+l.code+')');
  return p.final?{subject:'The rest of order '+p.orderNumber+' is being packed',
    body:['Hello '+p.customer+',','','The rest of your order '+p.orderNumber+' is now being packed:',...ready,'','We will send tracking details when it leaves.','',business||'Thank you.'].join('\n')}
    :{subject:'Part of order '+p.orderNumber+' is being packed',
    body:['Hello '+p.customer+',','','Part of your order '+p.orderNumber+' is in stock, so we are sending it now:',...ready,'','The rest will follow as soon as it is in stock:',...waiting,
      '','We will send tracking details when each part leaves.','',business||'Thank you.'].join('\n')};
}
// Tell the customer through the connected mailbox, when the owner's rules say so.
async function notify(c,ctx,p,row,rules,{automatic}){
  if(rules.notify!=='send')return null;
  const problem=async message=>{await c.query(`UPDATE ${splits} SET notice_problem=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,message]);return null;};
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.recipient||''))return problem('The customer has no email address, so nobody was told.');
  const box=await require('../shipping/agent-shipping-notices').mailbox(c,ctx.workspaceId,rules.connector_id);
  if(!box||box.provider_account_id!==rules.mailbox_account)return problem('Reconnect the mailbox chosen in your split rules to tell customers.');
  const business=(await c.query('SELECT coalesce(signature,business_name) sign FROM customer_communication_policy WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.sign;
  const authority={kind:NOTICE,splitId:row.id,orderId:p.orderId,customerId:p.customerId,recipient:p.recipient,connector:box.id,mailboxAccount:box.provider_account_id,
    ruleRevision:rules.revision,actorId:ctx.actorId,automatic};
  const queued=await require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'customer',recipientId:p.customerId,
    recipientEmail:p.recipient,connectorId:box.id,...compose(p,business),standingAuthority:authority},'order-split:'+row.id,{agentRequested:true,agentJob:JOB});
  await c.query(`UPDATE ${splits} SET notice_id=$3,notice_problem=NULL WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,queued.communicationId]);
  return queued;
}
// Checked again by the mail worker just before the message leaves.
async function noticeAuthority(db,workspaceId,a){
  const state=await policy.requireWorkspaceJob(db,workspaceId,JOB,'draft');
  const row=(await db.query(`SELECT s.status,s.sales_order_id,c.email customer_email,o.contact_email,r.notify,r.connector_id,r.mailbox_account,r.revision,r.authorized_by
    FROM ${splits} s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    LEFT JOIN ${rulesTable} r ON r.workspace_id=s.workspace_id WHERE s.workspace_id=$1 AND s.id=$2`,[workspaceId,a.splitId])).rows[0];
  if(!row||row.status!=='APPLIED'||row.sales_order_id!==a.orderId)throw new ValidationError('This split was undone or changed, so the customer was not told.');
  if(row.notify!=='send'||row.connector_id!==a.connector||row.mailbox_account!==a.mailboxAccount||row.revision!==a.ruleRevision)
    throw new ValidationError('The customer email setting in your split rules changed. Nothing was sent.');
  if(String(row.customer_email||row.contact_email||'').toLowerCase()!==String(a.recipient).toLowerCase())throw new ValidationError('The customer email changed. Nothing was sent.');
  if(a.automatic){
    if(row.authorized_by!==a.actorId)throw new ValidationError('The current owner must confirm these split rules before customers are told.');
    const stop=await policy.stopped(db,workspaceId,state,ACTION,true);
    if(stop)throw new ValidationError(stop);
    if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)throw new ValidationError('Automatic work is paused. Nothing was sent.');
  }
  const box=await require('../shipping/agent-shipping-notices').mailbox(db,workspaceId,a.connector);
  if(!box||box.provider_account_id!==a.mailboxAccount)throw new ValidationError('Reconnect the chosen mailbox before telling customers.');
}

// Open the normal pick for the ready part. The rest stays waiting on the order.
async function apply(c,ctx,p,row,rules,{automatic}){
  const box=await shipping().prepare(scoped(c),ctx,p.orderId,{idempotencyKey:'order-split:'+row.id,shipFromLocationId:p.locationId,
    shipToAddress:p.delivery,startPicking:true,lines:p.ship});
  await c.query(`UPDATE ${splits} SET shipment_id=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,box.shipmentId]);
  await c.query(`INSERT INTO sales_order_events(id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
    VALUES($1,$2,$3,'order_split',$4,$5,$6,$7) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
    [newId('soevt'),ctx.workspaceId,p.orderId,JSON.stringify({job:JOB,splitId:row.id,shipmentId:box.shipmentId,shipment:box.shipmentNumber,ready:p.readyUnits,
      waiting:p.waitingUnits,final:p.final,automatic}),ctx.actorId,'order-split:'+row.id+':event',nowIso()]);
  const told=await notify(c,ctx,p,row,rules,{automatic});
  await audit.record(c,ctx,{action:automatic?'StockChief split an order and sent the ready part to picking':'Approved splitting an order',reference:row.id,
    after:{order:p.orderNumber,shipment:box.shipmentNumber,ready:p.readyUnits,waiting:p.waitingUnits,final:p.final,rules:rules.revision,customerTold:Boolean(told)}});
  return box;
}

async function handle(c,ctx,state,orderId){
  await lockFulfillment(c,ctx);
  const rules=await read(c,ctx.workspaceId);
  if(!rules?.enabled)return {};
  await c.query('SELECT id FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,orderId]);
  const p=await facts(c,ctx,orderId,rules);
  if(p.skip||p.hold||p.wait){await staleDrafts(c,ctx,orderId);return p.hold?{held:true}:p.wait?{waiting:true}:{};}
  const why=await automaticStop(c,ctx,state,rules,p);
  if(why)return {drafted:(await draft(c,ctx,p,why,rules)).created};
  const row=await insert(c,ctx,{status:'APPLIED',kind:'AUTOMATIC',p,requestKey:'auto:'+p.orderId+':'+p.fingerprint,ruleRevision:rules.revision});
  if(!row)return {replayed:true};
  await staleDrafts(c,ctx,orderId);
  await apply(c,ctx,p,row,rules,{automatic:true});
  return {split:true};
}

// Shipping orders with stock set aside that may be ready to split, best first.
async function candidates(db,workspaceId,{orderIds=null,limit=50}={}){
  return (await db.query(`SELECT o.id FROM sales_orders o WHERE o.workspace_id=$1 AND o.status IN ('BACKORDERED','PARTIALLY_FULFILLED')
    AND o.confirmed_at IS NOT NULL AND o.delivery_method='SHIP' AND o.fulfillment_location_id IS NOT NULL AND ($2::text[] IS NULL OR o.id=ANY($2::text[]))
    AND NOT EXISTS(SELECT 1 FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status IN ('PICKING','PACKED'))
    AND (EXISTS(SELECT 1 FROM sales_order_lines l JOIN sales_order_allocations a ON a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id
        WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND a.quantity>0)
      OR EXISTS(SELECT 1 FROM sales_order_lines l JOIN sales_order_kit_components k ON k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id
        JOIN sales_order_kit_allocations a ON a.workspace_id=k.workspace_id AND a.kit_component_id=k.id
        WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND a.quantity>0))
    ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT $3`,[workspaceId,orderIds,limit])).rows;
}

async function run(db,workspaceId,{orderIds=null}={}){
  const result={split:0,drafted:0,held:0,waiting:0,watching:false};
  if(!await installed(db))return result;
  const state=await policy.accountState(db,workspaceId);
  if(!included(state))return result;
  const rules=await read(db,workspaceId);
  if(!rules?.enabled)return result;
  const actorId=await backorders().currentOwner(db,workspaceId);
  if(!actorId)return result;
  // Shadow mode, watch-only mode and this job's own Watch setting only watch.
  if(await policy.stopped(db,workspaceId,state,ACTION,false)){result.watching=true;return result;}
  const ctx={workspaceId,actorId};
  for(const {id} of await candidates(db,workspaceId,{orderIds})){
    const outcome=await tx(db,async c=>{
      await c.query('SAVEPOINT order_split');
      try{const done=await handle(c,ctx,state,id);await c.query('RELEASE SAVEPOINT order_split');return done;}
      catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT order_split');await c.query('RELEASE SAVEPOINT order_split');
        return {held:true};
      }
    });
    if(outcome.split)result.split++;
    if(outcome.drafted)result.drafted++;
    if(outcome.held)result.held++;
    if(outcome.waiting)result.waiting++;
  }
  return result;
}

// Called inside the transaction that sets stock aside for a waiting order.
async function queue(c,ctx,orderIds,cause){
  const ids=[...new Set((orderIds||[]).filter(Boolean))].sort();
  if(!ids.length||!await installed(c))return;
  if(!included(await policy.accountState(c,ctx.workspaceId)))return;
  if(!(await read(c,ctx.workspaceId))?.enabled)return;
  await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind:KIND,priority:65,maxAttempts:5,
    idempotencyKey:'order-splits:'+hash([ids,String(cause||'')]),payload:{orderIds:ids}});
}
async function onQueued(db,job){
  const ids=job.payload?.orderIds;
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'))throw new ValidationError('A split check needs its orders.');
  return run(db,job.workspaceId,{orderIds:ids});
}

async function locked(c,ctx,id){
  const row=(await c.query(`SELECT * FROM ${splits} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That split is not in this inventory.');
  return row;
}

async function prepare(database,ctx,input){
  return tx(database,async c=>{
    await backorders().owner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    if(stop)throw new ValidationError(stop);
    const rules=await read(c,ctx.workspaceId);
    if(!rules?.enabled)throw new ValidationError('Save your split rules first.');
    await lockFulfillment(c,ctx);
    const p=await facts(c,ctx,input.orderId,rules);
    if(p.hold||p.wait||p.skip)throw new ValidationError(p.hold||p.wait||p.skip);
    return draft(c,ctx,p,'Prepared on request.',rules);
  });
}

async function approve(database,ctx,id,input){
  return tx(database,async c=>{
    await backorders().owner(c,ctx);
    const r=await locked(c,ctx,id);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    if(stop)throw new ValidationError(stop);
    if(r.status==='APPLIED')return {id:r.id,replayed:true};
    if(r.status!=='DRAFT')throw new ValidationError('This split is no longer waiting for approval. Review the order again.');
    if(input.confirmed!=='yes'||input.fingerprint!==r.fingerprint)throw new ValidationError('Review and approve this exact split.');
    const rules=await read(c,ctx.workspaceId);
    if(!rules?.enabled)throw new ValidationError('Your split rules are off. Turn them on before splitting orders.');
    await lockFulfillment(c,ctx);
    await c.query('SELECT id FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,r.sales_order_id]);
    const p=await facts(c,ctx,r.sales_order_id,rules);
    if(p.fingerprint!==r.fingerprint){
      await c.query(`UPDATE ${splits} SET status='STALE' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id]);
      const next=!p.hold&&!p.wait&&!p.skip?await draft(c,ctx,p,'The order, its stock or your rules changed after the earlier split.',rules):null;
      return {id:r.id,stale:true,next:next?.id||null};
    }
    await c.query(`UPDATE ${splits} SET status='APPLIED',authorization_kind='INDIVIDUAL',applied_by=$3,applied_at=now(),rule_revision=$4 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,r.id,ctx.actorId,rules.revision]);
    const box=await apply(c,ctx,p,r,rules,{automatic:false});
    return {id:r.id,applied:true,shipmentId:box.shipmentId};
  });
}

async function discard(database,ctx,id){
  return tx(database,async c=>{
    await backorders().owner(c,ctx);
    const r=await locked(c,ctx,id);
    if(r.status==='DISCARDED')return {id:r.id,replayed:true};
    if(r.status!=='DRAFT')throw new ValidationError('Only a split waiting for approval can be dismissed.');
    await c.query(`UPDATE ${splits} SET status='DISCARDED' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id]);
    await audit.record(c,ctx,{action:'Dismissed an order split',reference:r.id});
    return {id:r.id};
  });
}

// Undo cancels the pick while its box is not packed. Stock stays set aside for the order.
async function undo(database,ctx,id,input){
  return tx(database,async c=>{
    await backorders().owner(c,ctx);
    const r=await locked(c,ctx,id);
    if(r.status==='UNDONE')return {id:r.id,replayed:true};
    if(r.status!=='APPLIED')throw new ValidationError('Only a split that was made can be undone.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this split should be undone.');
    await lockFulfillment(c,ctx);
    const box=r.shipment_id?(await c.query('SELECT status,shipment_number FROM sales_shipments WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.shipment_id])).rows[0]:null;
    if(box&&box.status!=='CANCELLED'){
      if(box.status!=='PICKING')throw new ValidationError('The box for '+r.plan.orderNumber+' is already packed or has left. Undo is no longer possible.');
      await shipping().cancel(scoped(c),ctx,r.shipment_id,{reason:'StockChief order split undone'});
    }
    await c.query(`UPDATE ${splits} SET status='UNDONE',undone_by=$3,undone_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id,ctx.actorId]);
    await c.query(`INSERT INTO sales_order_events(id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
      VALUES($1,$2,$3,'order_split_undone',$4,$5,$6,$7) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
      [newId('soevt'),ctx.workspaceId,r.sales_order_id,JSON.stringify({job:JOB,splitId:r.id}),ctx.actorId,'order-split:'+r.id+':undo',nowIso()]);
    await audit.record(c,ctx,{action:'Undid an order split',reference:r.id,after:{order:r.plan.orderNumber,shipment:box?.shipment_number||null}});
    return {id:r.id};
  });
}

async function configure(database,ctx,input){
  return tx(database,async c=>{
    await backorders().owner(c,ctx);
    const prior=await read(c,ctx.workspaceId,{lock:true});
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the split rules before changing them.');
    if(input.stop==='yes'||input.manual==='yes'){
      if(prior&&(prior.enabled||prior.automatic)){
        const off=input.stop==='yes';
        await c.query(`UPDATE ${rulesTable} SET enabled=CASE WHEN $2 THEN false ELSE enabled END,automatic=false,taught_split_id=NULL,taught_revision=NULL,
          revision=revision+1,updated_at=now() WHERE workspace_id=$1`,[ctx.workspaceId,off]);
        await audit.record(c,ctx,{action:off?'Turned off order split rules':'Stopped splitting orders on its own',before:{revision:prior.revision}});
      }
      return {stopped:true};
    }
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm these split rules.');
    const customers=String(input.customers||'');
    if(!['accepting','all'].includes(customers))throw new ValidationError('Choose which customers get partial shipments.');
    const percent=Number(String(input.minPercent??'').trim()||0);
    if(!Number.isSafeInteger(percent)||percent<0||percent>99)throw new ValidationError('Choose a whole percentage from 0 to 99.');
    const splitsAllowed=Number(input.maxSplits);
    if(!Number.isSafeInteger(splitsAllowed)||splitsAllowed<1||splitsAllowed>10)throw new ValidationError('Choose from 1 to 10 parts before the rest is complete.');
    const currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency;
    if(!currency)throw new ValidationError('Set up the inventory currency first.');
    const minValue=String(input.minValue??'').trim()?money.userToMinor(input.minValue,currency,{label:'Least value to send'}):0;
    if(minValue<0)throw new ValidationError('Choose a value of zero or more.');
    const notify=input.notify==='send'?'send':'off';
    let box=null;
    if(notify==='send'){
      box=await require('../shipping/agent-shipping-notices').mailbox(c,ctx.workspaceId,String(input.connectorId||''));
      if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 mailbox that can send email.');
    }
    const trained=policy.allowance(state.plan,JOB)==='trained',automatic=!trained&&input.automatic==='yes';
    const same=prior?.enabled&&prior.customers===customers&&prior.min_percent===percent&&Number(prior.min_value_minor)===minValue&&prior.max_splits===splitsAllowed
      &&prior.notify===notify&&(prior.connector_id||null)===(box?.id||null)&&(trained||prior.automatic===automatic)&&prior.authorized_by===ctx.actorId;
    if(same)return {unchanged:true};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await storage.reserve(c,ctx.workspaceId,'order-split-rule:'+((prior?.revision||0)+1),2048,{finished:true});
    await c.query(`INSERT INTO ${rulesTable}(workspace_id,authorized_by,customers,min_percent,min_value_minor,currency,max_splits,notify,connector_id,mailbox_account,automatic)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(workspace_id) DO UPDATE SET authorized_by=EXCLUDED.authorized_by,customers=EXCLUDED.customers,min_percent=EXCLUDED.min_percent,
      min_value_minor=EXCLUDED.min_value_minor,currency=EXCLUDED.currency,max_splits=EXCLUDED.max_splits,notify=EXCLUDED.notify,connector_id=EXCLUDED.connector_id,
      mailbox_account=EXCLUDED.mailbox_account,automatic=EXCLUDED.automatic,enabled=true,taught_split_id=NULL,taught_revision=NULL,
      revision=agent_split_rules.revision+1,updated_at=now()`,
      [ctx.workspaceId,ctx.actorId,customers,percent,minValue,currency,splitsAllowed,notify,box?.id||null,box?.provider_account_id||null,automatic]);
    const after={customers,minPercent:percent,minValueMinor:minValue,maxSplits:splitsAllowed,notify,automatic};
    await audit.record(c,ctx,{action:'Saved order split rules',before:prior?{customers:prior.customers,minPercent:prior.min_percent,minValueMinor:Number(prior.min_value_minor),
      maxSplits:prior.max_splits,notify:prior.notify,automatic:prior.automatic,enabled:prior.enabled}:{},after});
    return {saved:true};
  });
}

// Pro: an approved split under the current rules teaches them.
async function teach(database,ctx,input){
  return tx(database,async c=>{
    await backorders().owner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    if(policy.allowance(state.plan,JOB)!=='trained')throw new ValidationError('Your plan splits orders on its own without teaching. Turn it on with your rules.');
    const rules=await read(c,ctx.workspaceId,{lock:true});
    if(!rules?.enabled||Number(input.revision)!==rules.revision)throw new ValidationError('Reload the split rules before teaching them.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that StockChief may split orders like this on its own.');
    const example=(await c.query(`SELECT id FROM ${splits} WHERE workspace_id=$1 AND id=$2 AND status='APPLIED' AND authorization_kind='INDIVIDUAL'
      AND applied_by=$3 AND rule_revision=$4`,[ctx.workspaceId,String(input.splitId||''),ctx.actorId,rules.revision])).rows[0];
    if(!example)throw new ValidationError('Approve one split under these exact rules before teaching them.');
    await c.query(`UPDATE ${rulesTable} SET automatic=true,taught_split_id=$2,taught_revision=revision,authorized_by=$3,updated_at=now() WHERE workspace_id=$1`,
      [ctx.workspaceId,example.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Taught StockChief to split orders on its own',reference:example.id,after:{revision:rules.revision}});
    return {taught:true};
  });
}

// Whether a customer, or one order, accepts partial shipments.
async function setConsent(database,ctx,input){
  return tx(database,async c=>{
    await backorders().owner(c,ctx);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const number=String(input.orderNumber||'').trim();
    let subject;
    if(number){
      subject=(await c.query(`SELECT o.id,o.order_number name FROM sales_orders o WHERE o.workspace_id=$1 AND lower(o.order_number)=lower($2)
        AND o.status IN ('DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')`,[ctx.workspaceId,number])).rows[0];
      if(!subject)throw new NotFoundError('Choose an open order by its number.');
    }else{
      subject=(await c.query(`SELECT id,name FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'`,[ctx.workspaceId,String(input.customerId||'')])).rows[0];
      if(!subject)throw new NotFoundError('Choose an active customer.');
    }
    const column=number?'sales_order_id':'customer_id',choice=String(input.accepts??'');
    if(!['yes','no',''].includes(choice))throw new ValidationError('Choose whether partial shipments are accepted.');
    const before=(await c.query(`SELECT accepts FROM ${consents} WHERE workspace_id=$1 AND ${column}=$2 FOR UPDATE`,[ctx.workspaceId,subject.id])).rows[0]?.accepts??null;
    if(choice==='')await c.query(`DELETE FROM ${consents} WHERE workspace_id=$1 AND ${column}=$2`,[ctx.workspaceId,subject.id]);
    else{
      await storage.reserve(c,ctx.workspaceId,'split-consent:'+subject.id,1024,{finished:true});
      const changed=await c.query(`UPDATE ${consents} SET accepts=$3,updated_by=$4,updated_at=now() WHERE workspace_id=$1 AND ${column}=$2`,[ctx.workspaceId,subject.id,choice==='yes',ctx.actorId]);
      if(!changed.rowCount)await c.query(`INSERT INTO ${consents}(id,workspace_id,${column},accepts,updated_by) VALUES($1,$2,$3,$4,$5)`,[newId('split-consent'),ctx.workspaceId,subject.id,choice==='yes',ctx.actorId]);
    }
    await audit.record(c,ctx,{action:'Changed whether partial shipments are accepted',reference:subject.id,before:{accepts:before},after:{accepts:choice===''?null:choice==='yes',order:Boolean(number)}});
    if(number)await queue(c,ctx,[subject.id],'consent:'+newId('key'));
    return {name:subject.name,accepts:choice===''?null:choice==='yes',order:Boolean(number)};
  });
}

async function inbox(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!included(state))return [];
  const rows=(await db.query(`SELECT s.id,s.reason,s.created_at,o.order_number,(s.plan->>'readyUnits') ready,(s.plan->>'waitingUnits') waiting,(s.plan->>'final')::boolean final
    FROM ${splits} s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    WHERE s.workspace_id=$1 AND s.status='DRAFT' ORDER BY s.created_at,s.id LIMIT 50`,[workspaceId])).rows;
  return rows.map(row=>({kind:'approval',importance:'Needs You',priority:84,
    title:(row.final?'Send the rest of ':'Split ')+row.order_number,
    happened:row.final?'The rest of this order is now set aside. Nothing has been sent to picking.':row.ready+' units are in stock and '+row.waiting+' still wait. Nothing has been sent to picking.',
    why:row.reason||'Your plan proposes each split for approval.',recommendation:'Check what ships now and what waits, then approve or dismiss the split.',
    href:href+'#split-'+row.id,actionLabel:'Review split',sourceId:'order-split:'+row.id,createdAt:row.created_at,at:row.created_at}));
}

async function page(db,ctx){
  const state=await policy.accountState(db,ctx.workspaceId);
  const mode=included(state)?policy.allowance(state.plan,JOB):'excluded';
  const rules=await read(db,ctx.workspaceId);
  const listed=status=>db.query(`SELECT s.*,o.order_number,h.shipment_number,h.status shipment_status,m.status notice_status
    FROM ${splits} s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    LEFT JOIN sales_shipments h ON h.workspace_id=s.workspace_id AND h.id=s.shipment_id
    LEFT JOIN customer_communications m ON m.workspace_id=s.workspace_id AND m.id=s.notice_id
    WHERE s.workspace_id=$1 AND s.status=ANY($2::text[]) ORDER BY coalesce(s.applied_at,s.created_at) DESC,s.id LIMIT 20`,[ctx.workspaceId,status]);
  const drafts=(await listed(['DRAFT'])).rows,recent=(await listed(['APPLIED','UNDONE'])).rows;
  const orders=[];
  if(rules?.enabled)for(const {id} of await candidates(db,ctx.workspaceId,{limit:30})){
    const p=await facts(db,ctx,id,rules);
    if(!p.skip)orders.push(p);
  }
  const choices=(await db.query(`SELECT x.accepts,x.customer_id,x.sales_order_id,coalesce(c.name,o.order_number) name
    FROM ${consents} x LEFT JOIN customers c ON c.workspace_id=x.workspace_id AND c.id=x.customer_id LEFT JOIN sales_orders o ON o.workspace_id=x.workspace_id AND o.id=x.sales_order_id
    WHERE x.workspace_id=$1 ORDER BY x.sales_order_id IS NOT NULL,name LIMIT 200`,[ctx.workspaceId])).rows;
  const customers=(await db.query(`SELECT c.id,c.name FROM customers c WHERE c.workspace_id=$1 AND c.record_state='ACTIVE'
    AND EXISTS(SELECT 1 FROM sales_orders o WHERE o.workspace_id=c.workspace_id AND o.customer_id=c.id AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'))
    ORDER BY c.name,c.id LIMIT 200`,[ctx.workspaceId])).rows;
  const mailboxes=(await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId)).slice(0,20);
  const currency=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency||'USD';
  const example=mode==='trained'&&rules?.enabled&&!rules.automatic?recent.find(r=>r.status==='APPLIED'&&r.authorization_kind==='INDIVIDUAL'&&r.applied_by===ctx.actorId&&r.rule_revision===rules.revision)||null:null;
  const blocked=mode==='excluded'?null:await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  let automatic=null;
  if(rules?.enabled&&rules.automatic){
    automatic=await policy.stopped(db,ctx.workspaceId,state,ACTION,true);
    if(!automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)automatic='Automatic work is off for this inventory, so each split waits for your approval.';
  }
  const minValue=rules&&Number(rules.min_value_minor)>0?money.fromMinor(rules.min_value_minor,rules.currency):'';
  return {mode,shadow:Boolean(state.shadow),rules,drafts,recent,orders,choices,customers,mailboxes,currency,minValue,example,blocked,automatic,href};
}

module.exports={JOB,ACTION,KIND,NOTICE,href,read,facts,run,handle,queue,onQueued,prepare,approve,discard,undo,configure,teach,setConsent,inbox,page,
  noticeAuthority,compose,installed};
