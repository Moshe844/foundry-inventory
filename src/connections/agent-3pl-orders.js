'use strict';

// Job 186: sends orders to your 3PL and reads their stock and shipping back.
// Starter is excluded; Growth drafts each order for a person; Pro and Custom
// do it on their own within the owner's routes.
//
// The owner says which warehouse a connected 3PL runs (a route; each enabled
// route is one saved rule). Every five minutes, for each route:
//  - each order confirmed to ship from that warehouse after the route was
//    saved is checked: confirmed, a complete address, whole units, nothing
//    shipped yet and no local box. A missing or unmatched fact holds it and
//    asks in Needs you. Otherwise Pro and Custom hand it to the 3PL; Growth,
//    and any order while StockChief may not act on its own (pause, watch mode,
//    the first 14 days, Watch only, Ask me first, routine work off, a route
//    the owner approves by hand), drafts it for one-tap approval;
//  - handing over writes the shared delegation record first, so local picking
//    never touches the order, and the 3PL adapter finds an order already
//    placed under the same reference instead of placing it twice;
//  - the 3PL's order is read back. Each shipment it marks shipped becomes a
//    StockChief shipment from that warehouse through the normal handoff:
//    stock leaves, the invoice follows and the carrier and tracking number
//    are on the shipment. A shipment that does not match what the order has
//    reserved there, has no tracking, or needs lots, serials or weights
//    stops and asks. Growth records each one with a tap;
//  - saved 3PL stock readings are read again hourly; they show with the
//    partner stock of job 123.
// Every order handed over and every shipment recorded is audited. A sent
// order and goods that left cannot be undone here; the correction path is
// the 3PL and the order itself.
//
// 3PLs are reached only through third-party-logistics.js (ShipBob's sandbox is
// built in; another 3PL is another adapter of the same shape).

const {createHash}=require('node:crypto');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const installed=require('../db/schema-installed');
const vault=require('./postgres-credential-store');
const adapters=require('./third-party-logistics');
const {ValidationError,NotFoundError,DomainError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');

const JOB=186,SEND='fulfillment.send_to_3pl',RECORD='fulfillment.record_3pl_shipment',KIND='fulfillment.3pl-orders.v1';
const SENT_ACTION='Order sent to the 3PL',RECORDED_ACTION='3PL shipment recorded';
const ROUTES='stockchief_runtime.agent_3pl_routes',ORDERS='stockchief_runtime.agent_3pl_orders',PARCELS='stockchief_runtime.agent_3pl_parcels',STOCK='stockchief_runtime.agent_3pl_stock';
// The delegation record every local picking path already checks, for every 3PL.
const DELEGATED='stockchief_runtime.shipbob_sandbox_orders';
const href='/autopilot/3pl-orders';
const tx=(db,fn)=>typeof db.transaction==='function'?db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true}):fn(db);
const scoped=c=>({query:(s,v)=>c.query(s,v),transaction:fn=>fn(c)});
const expected=e=>e instanceof DomainError||[400,402,403,404,409,422].includes(Number(e?.status));
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function ready(db){for(const t of [ROUTES,ORDERS,PARCELS,STOCK])if(!await installed.has(db,t))return false;return true;}
const owner=(db,ctx)=>require('../autopilot/job-reviews').ownerState(db,ctx);

// Why StockChief may not hand orders over or record shipments on its own right now, or null.
async function automaticStop(db,workspaceId,state){
  state=state||await policy.accountState(db,workspaceId);
  const stop=await policy.stopped(db,workspaceId,state,SEND,true);if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return 'Routine work is off for this inventory, so 3PL orders wait for your approval.';
  return null;
}

// The connected 3PLs, each with its adapter.
function shaped(row){
  const adapter=adapters.byConnector(row.connector_key);if(!adapter)return null;
  const config=JSON.parse(row.config||'{}');
  return {id:row.id,connectorKey:row.connector_key,label:row.display_name||adapter.label,adapter,config,account:adapter.account(config),updatedAt:row.updated_at};
}
async function connections(db,workspaceId){
  const rows=(await db.query(`SELECT id,connector_key,display_name,config,updated_at FROM workspace_connectors WHERE workspace_id=$1 AND status='connected' AND paused_at IS NULL
    AND connector_key=ANY($2::text[]) ORDER BY display_name,id`,[workspaceId,adapters.list().map(a=>a.connectorKey)])).rows;
  return rows.map(shaped).filter(Boolean);
}
async function connector(db,ctx,id){
  const found=(await connections(db,ctx.workspaceId)).find(c=>c.id===String(id||''));
  if(!found)throw new ValidationError('Connect the 3PL first.');
  return found;
}
async function remote(db,ctx,con,transport){
  const secret=await vault.get(db,ctx.workspaceId,con.id,'provider');
  if(!secret?.apiKey)throw new ValidationError('Reconnect '+con.label+'.');
  return adapters.client(con.adapter,secret,con.config,transport);
}

// Connect a 3PL other than ShipBob, whose sandbox page keeps its own connection form.
async function connect(db,ctx,input,transport){
  await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  const adapter=adapters.get(input.provider);
  if(adapter.key==='shipbob')return require('./postgres-shipbob-sandbox').connect(db,ctx,input,transport);
  const apiKey=String(input.apiKey||'').trim(),account=String(input.account||'').trim();
  if(!apiKey||apiKey.length>4096||/\s/.test(apiKey))throw new ValidationError('Enter the 3PL’s API key.');
  if(!/^[A-Za-z0-9._:\-]{1,80}$/.test(account))throw new ValidationError('Enter the 3PL account or channel ID.');
  const config={account};
  await adapters.client(adapter,{apiKey},config,transport).verify();
  return tx(db,async c=>{
    const state=await owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[ctx.workspaceId+adapter.connectorKey]);
    const row=(await c.query('SELECT id,config FROM workspace_connectors WHERE workspace_id=$1 AND connector_key=$2 FOR UPDATE',[ctx.workspaceId,adapter.connectorKey])).rows[0];
    if(row&&JSON.parse(row.config).account!==account)throw new ValidationError('Reconnect the original account to keep its order references.');
    const id=row?.id||newId('con'),capacity=require('../commercial/connection-capacity'),at=nowIso();
    await capacity.assertActivation(c,{accountId:state.accountId,workspaceId:ctx.workspaceId},adapter.key,row?await capacity.activationDelta(c,ctx.workspaceId,id):1);
    if(row)await c.query("UPDATE workspace_connectors SET status='connected',setup_status='CONNECTED',paused_at=NULL,credential_ref=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,'connection_credentials:'+id,at]);
    else await c.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,
      credential_ref,setup_status,authorized_by_user_id,created_at,updated_at,expected_interval_minutes) VALUES($1,$2,$3,$4,$5,'["fulfillment"]',$6,'connected','["orders","inventory","tracking"]',$7,'CONNECTED',$8,$9,$9,0)`,
    [id,ctx.workspaceId,adapter.connectorKey,adapter.label,adapter.key,JSON.stringify(config),'connection_credentials:'+id,ctx.actorId,at]);
    await vault.put(c,ctx.workspaceId,id,'provider',{apiKey});
    return {connectorId:id};
  });
}

// The plain order a 3PL is asked to ship. Every fact must be present; nothing is guessed.
async function plainOrder(db,ctx,orderId){
  const order=(await db.query(`SELECT o.*,c.name FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE o.workspace_id=$1 AND o.id=$2`,[ctx.workspaceId,orderId])).rows[0];
  if(!order)throw new NotFoundError('The sales order was not found in this inventory.');
  if((await db.query("SELECT 1 FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('PICKING','PACKED') LIMIT 1",[ctx.workspaceId,orderId])).rowCount)throw new ValidationError('This order already has an unshipped StockChief box. Resolve it before sending the order to the 3PL.');
  if(order.status!=='CONFIRMED'||order.delivery_method!=='SHIP'||Number(order.customer_decision_required)!==0||Number(order.delivery_decision_required)!==0)
    throw new ValidationError('Choose a confirmed, unfulfilled delivery order with a verified customer and destination.');
  const address=require('../shipping/address').parse(order.ship_to_address);
  if(!address.complete)throw new ValidationError('Complete the order’s delivery address before sending.');
  const lines=(await db.query(`SELECT s.code,i.name,l.quantity_ordered,l.quantity_fulfilled FROM sales_order_lines l JOIN skus s ON s.id=l.sku_id
    JOIN items i ON i.id=s.item_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.id`,[ctx.workspaceId,orderId])).rows;
  if(!lines.length || lines.some(l=>Number(l.quantity_fulfilled)!==0||!Number.isSafeInteger(Number(l.quantity_ordered))||Number(l.quantity_ordered)<1))
    throw new ValidationError('The 3PL needs whole-unit lines with no prior fulfillment.');
  return {order,plain:{reference:orderId,number:order.order_number,
    recipient:{name:address.name||order.name,line1:address.line1,line2:address.line2,city:address.city,state:address.state,country:address.country,postalCode:address.postalCode},
    lines:lines.map(l=>({sku:l.code,name:l.name,quantity:Number(l.quantity_ordered)}))}};
}
// The exact request for one 3PL, and its fingerprint.
async function review(db,ctx,orderId,con){
  const {order,plain}=await plainOrder(db,ctx,orderId),payload=con.adapter.payload(plain);
  return {order,plain,payload,account:con.account,hash:fingerprint([con.id,con.account,payload])};
}
const snapshot=placed=>placed.shipments.map(s=>({id:s.id,status:s.status,carrier:s.carrier,tracking:s.tracking}));

// The owner's route: which warehouse a connected 3PL runs, and whether StockChief sends on its own.
async function saveRoute(db,ctx,input={}){
  return tx(db,async c=>{
    await owner(c,ctx);
    if(!await ready(c))throw new ValidationError('3PL routes are being upgraded. Try again shortly.');
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const location=(await c.query("SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND kind='warehouse' AND is_active=1 AND custody_agreement_id IS NULL",[ctx.workspaceId,String(input.locationId||'')])).rows[0];
    if(!location)throw new ValidationError('Choose an active warehouse in this inventory.');
    const prior=(await c.query(`SELECT * FROM ${ROUTES} WHERE workspace_id=$1 AND location_id=$2 FOR UPDATE`,[ctx.workspaceId,location.id])).rows[0];
    if(prior&&String(input.revision??'')!==String(prior.revision))throw new ValidationError('This route changed. Reload the page before saving it.');
    if(input.stop==='yes'){
      if(!prior?.enabled)throw new ValidationError('No 3PL runs this warehouse.');
      await c.query(`UPDATE ${ROUTES} SET enabled=false,automatic=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND location_id=$2`,[ctx.workspaceId,location.id]);
      await c.query(`UPDATE ${ORDERS} SET status='DISMISSED',reason='The 3PL route was stopped.',updated_at=clock_timestamp() WHERE workspace_id=$1 AND location_id=$2 AND status IN ('DRAFT','HELD')`,[ctx.workspaceId,location.id]);
      await audit.record(c,ctx,{action:'3PL route saved',reference:location.id,before:{connector:prior.connector_id,automatic:prior.automatic},after:{enabled:false}});
      return {stopped:true};
    }
    const con=await connector(c,ctx,input.connectorId);
    const automatic=input.automatic==='yes';
    if(automatic)await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    if(!prior?.enabled)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    // Only orders confirmed after a route starts (or moves to another 3PL) go to it.
    await c.query(`INSERT INTO ${ROUTES} AS r(workspace_id,location_id,connector_id,automatic,authorized_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(workspace_id,location_id) DO UPDATE SET connector_id=excluded.connector_id,automatic=excluded.automatic,authorized_by=excluded.authorized_by,
        enabled_at=CASE WHEN r.enabled AND r.connector_id=excluded.connector_id THEN r.enabled_at ELSE clock_timestamp() END,
        enabled=true,revision=r.revision+1,updated_at=clock_timestamp()`,[ctx.workspaceId,location.id,con.id,automatic,ctx.actorId]);
    await audit.record(c,ctx,{action:'3PL route saved',reference:location.id,before:prior?{connector:prior.connector_id,automatic:prior.automatic,enabled:prior.enabled}:{},
      after:{connector:con.id,provider:con.label,warehouse:location.name,automatic}});
    await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind:KIND,idempotencyKey:'3pl-orders:route:'+newId('route'),payload:{},priority:55,maxAttempts:3});
    return {saved:true};
  });
}

// Keep what StockChief decided about one order. A sent or sending order is never overwritten.
async function keep(db,ctx,orderId,route,version,{status,reason=null,hash=null}){
  await db.query(`INSERT INTO ${ORDERS} AS x(workspace_id,sales_order_id,connector_id,location_id,order_version,request_hash,status,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,sales_order_id) DO UPDATE SET connector_id=excluded.connector_id,location_id=excluded.location_id,
      order_version=excluded.order_version,request_hash=excluded.request_hash,status=excluded.status,reason=excluded.reason,decided_by=NULL,decided_at=NULL,updated_at=clock_timestamp()
    WHERE x.status IN ('DRAFT','HELD','DISMISSED')`,[ctx.workspaceId,orderId,route.connector_id,route.location_id,version,hash,status,reason]);
}

// Hand one order to its 3PL. The delegation record and the request are saved
// before the 3PL is called; a lost answer is checked again under the same
// reference, so the order is never placed twice.
async function handOver(db,ctx,orderId,expectedHash,{automatic,decidedBy=null,transport}={}){
  const prep=await tx(db,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,automatic?'automatic':'draft');
    const o=(await c.query('SELECT id,version,fulfillment_location_id FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,orderId])).rows[0];
    if(!o)throw new NotFoundError('The sales order was not found in this inventory.');
    const route=(await c.query(`SELECT * FROM ${ROUTES} WHERE workspace_id=$1 AND location_id=$2 AND enabled`,[ctx.workspaceId,o.fulfillment_location_id])).rows[0];
    if(!route)throw new ValidationError('No 3PL runs this order’s warehouse.');
    if(automatic){
      if(!route.automatic)throw new ValidationError('You approve each order for this warehouse.');
      const stop=await automaticStop(c,ctx.workspaceId,state);if(stop)throw new ValidationError(stop);
    }else{const stop=await policy.stopped(c,ctx.workspaceId,state,SEND,false);if(stop)throw new ValidationError(stop);}
    const con=await connector(c,ctx,route.connector_id),rv=await review(c,ctx,orderId,con);
    if(rv.hash!==expectedHash)throw new ValidationError('This order changed. Review its destination and lines again.');
    await c.query(`INSERT INTO ${DELEGATED}(workspace_id,sales_order_id,connector_id,channel_id,request_hash,prepared_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [ctx.workspaceId,orderId,con.id,con.account,rv.hash,ctx.actorId]);
    const delegated=(await c.query(`SELECT * FROM ${DELEGATED} WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,orderId])).rows[0];
    if(delegated.request_hash!==rv.hash||delegated.connector_id!==con.id)throw new ValidationError('A different version of this order went to a 3PL. Check the 3PL’s order first.');
    await c.query(`INSERT INTO ${ORDERS} AS x(workspace_id,sales_order_id,connector_id,location_id,order_version,request_hash,status,automatic,attempts,decided_by,decided_at)
      VALUES($1,$2,$3,$4,$5,$6,'SENDING',$7,1,$8,CASE WHEN $8::text IS NULL THEN NULL ELSE clock_timestamp() END)
      ON CONFLICT(workspace_id,sales_order_id) DO UPDATE SET connector_id=excluded.connector_id,location_id=excluded.location_id,order_version=excluded.order_version,
        request_hash=excluded.request_hash,status='SENDING',automatic=excluded.automatic,attempts=x.attempts+1,reason=NULL,
        decided_by=coalesce(excluded.decided_by,x.decided_by),decided_at=coalesce(excluded.decided_at,x.decided_at),updated_at=clock_timestamp() WHERE x.status<>'SENT'`,
      [ctx.workspaceId,orderId,con.id,route.location_id,o.version,rv.hash,automatic,decidedBy]);
    return {con,rv,route};
  });
  let placed;
  try{
    const client=await remote(db,ctx,prep.con,transport);
    placed=await client.submit(prep.rv.payload,()=>require('../sales/agent-order-checks').assertCanRelease(db,ctx.workspaceId,orderId));
  }catch(error){
    await db.query(`UPDATE ${ORDERS} SET reason=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND sales_order_id=$2 AND status='SENDING'`,
      [ctx.workspaceId,orderId,error.retryable||!expected(error)?'The 3PL did not confirm the order. StockChief checks again under the same reference, so it is never placed twice.':error.message]);
    throw error;
  }
  return tx(db,async c=>{
    const saved=await c.query(`UPDATE ${DELEGATED} SET provider_order_id=$4,provider_status=$5,shipments=$6,observed_at=now()
      WHERE workspace_id=$1 AND sales_order_id=$2 AND request_hash=$3 AND (provider_order_id IS NULL OR provider_order_id=$4)`,
      [ctx.workspaceId,orderId,prep.rv.hash,placed.id,placed.status,JSON.stringify(snapshot(placed))]);
    if(saved.rowCount!==1)throw new ValidationError('The saved 3PL reference changed. Check the 3PL’s order.');
    const marked=await c.query(`UPDATE ${ORDERS} SET status='SENT',sent_at=coalesce(sent_at,clock_timestamp()),reason=NULL,checked_at=NULL,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND sales_order_id=$2 AND status='SENDING' RETURNING sales_order_id`,[ctx.workspaceId,orderId]);
    if(marked.rowCount)await audit.record(c,ctx,{action:SENT_ACTION,reference:orderId,after:{automatic:Boolean(automatic),provider:prep.con.label,providerOrder:placed.id,
      order:prep.rv.plain.number,warehouse:prep.route.location_id,lines:prep.rv.plain.lines.length}});
    return {sent:true,replayed:!marked.rowCount,providerOrderId:placed.id};
  });
}

// One order routed to a 3PL: hold it, draft it, or hand it over.
async function decide(db,ctx,route,o,{automatic,stop,transport}){
  const con=await connector(db,ctx,route.connector_id);
  let rv;
  try{rv=await review(db,ctx,o.id,con);}catch(error){if(!expected(error))throw error;await keep(db,ctx,o.id,route,o.version,{status:'HELD',reason:error.message});return 'held';}
  if(!automatic||!route.automatic||stop){
    await keep(db,ctx,o.id,route,o.version,{status:'DRAFT',hash:rv.hash,reason:stop||(automatic?'You approve each order for this warehouse.':null)});return 'drafted';
  }
  try{await handOver(db,ctx,o.id,rv.hash,{automatic:true,transport});return 'sent';}
  catch(error){if(!expected(error))throw error;await keep(db,ctx,o.id,route,o.version,{status:'HELD',reason:error.message,hash:rv.hash});return 'held';}
}

// Read the 3PL's order back, keep its status and note each shipment it marks shipped.
async function refresh(db,ctx,row,transport){
  const con=await connector(db,ctx,row.connector_id);
  const delegated=(await db.query(`SELECT * FROM ${DELEGATED} WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,row.sales_order_id])).rows[0];
  if(!delegated?.provider_order_id)throw new ValidationError('Send or reconcile the 3PL order first.');
  const placed=await (await remote(db,ctx,con,transport)).order(delegated.provider_order_id,row.sales_order_id);
  const when=v=>{const t=Date.parse(v||'');return Number.isFinite(t)?new Date(t).toISOString():null;};
  await tx(db,async c=>{
    await c.query(`UPDATE ${DELEGATED} SET provider_status=$3,shipments=$4,observed_at=now() WHERE workspace_id=$1 AND sales_order_id=$2 AND provider_order_id=$5`,
      [ctx.workspaceId,row.sales_order_id,placed.status,JSON.stringify(snapshot(placed)),delegated.provider_order_id]);
    for(const s of placed.shipments.filter(s=>s.shipped))
      await c.query(`INSERT INTO ${PARCELS}(workspace_id,connector_id,provider_shipment_id,sales_order_id,status,carrier,tracking_number,shipped_at,lines)
        VALUES($1,$2,$3,$4,'WAITING',$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[ctx.workspaceId,con.id,String(s.id).slice(0,120),row.sales_order_id,s.carrier,s.tracking,when(s.shippedAt),JSON.stringify(s.lines||[])]);
    await c.query(`UPDATE ${ORDERS} SET checked_at=clock_timestamp() WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,row.sales_order_id]);
  });
  return placed;
}

// What the 3PL shipped, matched to the order's lines reserved at that warehouse.
async function parcelLines(c,ctx,parcel,locationId){
  const lines=(await c.query(`SELECT l.id,l.sku_id,l.quantity_ordered,l.quantity_fulfilled,s.code,i.tracking_mode,i.quantity_precision,i.secondary_unit_label,
      coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id AND a.location_id=$3),0) AS reserved
    FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.created_at,l.id`,[ctx.workspaceId,parcel.sales_order_id,locationId])).rows;
  const reported=Array.isArray(parcel.lines)?parcel.lines:[];
  if(!reported.length)throw new ValidationError('The 3PL did not say what it shipped. Check the shipment with the 3PL.');
  const take=new Map();
  for(const r of reported){
    const quantity=Number(r.quantity),sku=String(r.sku||'');
    if(!Number.isSafeInteger(quantity)||quantity<=0)throw new ValidationError('The 3PL reported an unclear quantity for '+(sku||'a product')+'.');
    const matching=lines.filter(l=>l.code.toLowerCase()===sku.toLowerCase());
    if(!matching.length)throw new ValidationError('The 3PL shipped '+(sku||'a product')+', which is not on this order.');
    let left=quantity;
    for(const l of matching){
      const open=Math.min(Number(l.quantity_ordered)-Number(l.quantity_fulfilled),Number(l.reserved))-(take.get(l.id)||0);
      const n=Math.min(left,Math.max(0,open));if(n>0){take.set(l.id,(take.get(l.id)||0)+n);left-=n;}
    }
    if(left>0)throw new ValidationError('The 3PL shipped '+quantity+' of '+sku+', more than this order has reserved to ship from that warehouse.');
  }
  const out=lines.filter(l=>take.has(l.id));
  const tracked=out.find(l=>l.tracking_mode!=='quantity'||Number(l.quantity_precision)!==0||l.secondary_unit_label);
  if(tracked)throw new ValidationError(tracked.code+' needs its lots, serials or weight recorded. Record this 3PL shipment by hand.');
  return out.map(l=>({lineId:l.id,skuId:l.sku_id,quantity:take.get(l.id)}));
}
// Record one 3PL shipment as a StockChief shipment, through the normal handoff.
async function recordParcel(db,ctx,connectorId,providerShipmentId,{automatic,decidedBy=null}={}){
  return tx(db,async c=>{
    const parcel=(await c.query(`SELECT p.*,x.location_id FROM ${PARCELS} p JOIN ${ORDERS} x ON x.workspace_id=p.workspace_id AND x.sales_order_id=p.sales_order_id
      WHERE p.workspace_id=$1 AND p.connector_id=$2 AND p.provider_shipment_id=$3 FOR UPDATE OF p`,[ctx.workspaceId,String(connectorId||''),String(providerShipmentId||'')])).rows[0];
    if(!parcel)throw new NotFoundError('That 3PL shipment was not found.');
    if(parcel.status==='RECORDED')return {replayed:true,shipmentId:parcel.shipment_id};
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,automatic?'automatic':'draft');
    if(automatic){
      const route=(await c.query(`SELECT automatic FROM ${ROUTES} WHERE workspace_id=$1 AND location_id=$2 AND enabled AND connector_id=$3`,[ctx.workspaceId,parcel.location_id,parcel.connector_id])).rows[0];
      if(!route?.automatic)throw new ValidationError('You record each 3PL shipment for this warehouse.');
      const stop=await automaticStop(c,ctx.workspaceId,state);if(stop)throw new ValidationError(stop);
    }else{const stop=await policy.stopped(c,ctx.workspaceId,state,RECORD,false);if(stop)throw new ValidationError(stop);}
    const con=await connector(c,ctx,parcel.connector_id);
    await c.query('SAVEPOINT third_party_parcel');
    try{
      const order=(await c.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,parcel.sales_order_id])).rows[0];
      if(!order||!['CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'].includes(order.status))throw new ValidationError('The order is no longer open to ship. Check what the 3PL shipped against the order.');
      const lines=await parcelLines(c,ctx,parcel,parcel.location_id);
      const id=newId('shp'),number=await require('../operations/postgres-business-numbers').next(c,ctx.workspaceId,'sales_shipments','SHP'),at=nowIso();
      await c.query(`INSERT INTO sales_shipments(id,workspace_id,sales_order_id,shipment_number,status,ship_from_location_id,ship_to_address,handover,package_count,currency,notes,
        packed_at,created_by_user_id,created_at,updated_at,provider,provider_shipment_id) VALUES($1,$2,$3,$4,'PACKED',$5,$6,'CARRIER',1,$7,$8,$9,$10,$9,$9,$11,$12)`,
        [id,ctx.workspaceId,order.id,number,parcel.location_id,order.ship_to_address,order.currency,'Shipped by '+con.label+'.',at,ctx.actorId,con.adapter.key,parcel.provider_shipment_id]);
      for(const line of lines)await c.query(`INSERT INTO sales_shipment_lines(id,workspace_id,shipment_id,sales_order_line_id,sku_id,location_id,quantity,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`,[newId('shpl'),ctx.workspaceId,id,line.lineId,line.skuId,parcel.location_id,line.quantity,at]);
      await require('../shipping/postgres-service').handoff(scoped(c),ctx,id,{handover:'CARRIER',carrier:parcel.carrier,trackingNumber:parcel.tracking_number});
      if(parcel.shipped_at)await c.query('UPDATE sales_shipments SET shipped_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,new Date(parcel.shipped_at).toISOString()]);
      await c.query('RELEASE SAVEPOINT third_party_parcel');
      await c.query(`UPDATE ${PARCELS} SET status='RECORDED',shipment_id=$4,reason=NULL,automatic=$5,decided_by=$6,recorded_at=clock_timestamp()
        WHERE workspace_id=$1 AND connector_id=$2 AND provider_shipment_id=$3`,[ctx.workspaceId,parcel.connector_id,parcel.provider_shipment_id,id,Boolean(automatic),decidedBy]);
      await audit.record(c,ctx,{action:RECORDED_ACTION,reference:id,after:{automatic:Boolean(automatic),order:order.order_number,provider:con.label,
        providerShipment:parcel.provider_shipment_id,carrier:parcel.carrier,tracking:parcel.tracking_number,units:lines.reduce((n,l)=>n+l.quantity,0)}});
      return {recorded:true,shipmentId:id};
    }catch(error){
      if(!expected(error))throw error;
      await c.query('ROLLBACK TO SAVEPOINT third_party_parcel');await c.query('RELEASE SAVEPOINT third_party_parcel');
      await c.query(`UPDATE ${PARCELS} SET status='HELD',reason=$4 WHERE workspace_id=$1 AND connector_id=$2 AND provider_shipment_id=$3`,
        [ctx.workspaceId,parcel.connector_id,parcel.provider_shipment_id,error.message]);
      return {held:error.message};
    }
  });
}

// Read one product's stock at a 3PL. ShipBob's sandbox keeps its own readings.
async function readStock(db,ctx,input={},transport){
  await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  const con=await connector(db,ctx,input.connectorId);
  if(con.adapter.key==='shipbob')return require('./postgres-shipbob-sandbox').stock(db,ctx,{sku:input.sku,inventoryId:input.inventoryRef},transport);
  const ref=String(input.inventoryRef||'').trim();
  if(!/^[A-Za-z0-9._:\-]{1,120}$/.test(ref))throw new ValidationError('Enter the 3PL’s inventory ID for this product.');
  const skus=(await db.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND lower(code)=lower($2) AND is_active=1',[ctx.workspaceId,String(input.sku||'').trim()])).rows;
  if(skus.length!==1)throw new ValidationError('Enter one exact active SKU.');
  const requestedAt=new Date().toISOString(),value=await (await remote(db,ctx,con,transport)).stock(ref,skus[0].code);
  const onHand=adapters.whole(value.onHand,'stock'),available=adapters.whole(value.available,'stock');
  if(String(value.inventoryRef)!==ref||available>onHand)throw new ValidationError('The 3PL’s stock does not match this product or has unconfirmed quantities.');
  await db.query(`INSERT INTO ${STOCK}(workspace_id,connector_id,sku_id,inventory_ref,on_hand,available,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(workspace_id,connector_id,sku_id) DO UPDATE SET inventory_ref=excluded.inventory_ref,on_hand=excluded.on_hand,available=excluded.available,observed_at=excluded.observed_at
    WHERE ${STOCK}.observed_at<=excluded.observed_at`,[ctx.workspaceId,con.id,skus[0].id,ref,onHand,available,requestedAt]);
  return {onHand,available};
}

// Worker: every route of one inventory.
async function run(db,workspaceId,{transport,fresh=false}={}){
  if(!await ready(db))return {skipped:'not_installed'};
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return {skipped:'plan'};
  const automatic=policy.permits(state.plan,JOB,'automatic'),stop=automatic?await automaticStop(db,workspaceId,state):null;
  const out={sent:0,drafted:0,held:0,adopted:0,refreshed:0,recorded:0,waiting:0,stock:0,skipped:0};
  const routes=(await db.query(`SELECT * FROM ${ROUTES} WHERE workspace_id=$1 AND enabled ORDER BY location_id`,[workspaceId])).rows;
  for(const route of routes){
    const ctx={workspaceId,actorId:route.authorized_by},alone=automatic&&route.automatic&&!stop;
    try{await owner(db,ctx);await connector(db,ctx,route.connector_id);}catch(error){if(!expected(error))throw error;out.skipped++;continue;}
    // Orders handed over by hand from the sandbox page are followed the same way.
    for(const d of (await db.query(`SELECT d.sales_order_id,d.request_hash,o.version FROM ${DELEGATED} d JOIN sales_orders o ON o.workspace_id=d.workspace_id AND o.id=d.sales_order_id
      WHERE d.workspace_id=$1 AND d.connector_id=$2 AND o.fulfillment_location_id=$3 AND d.provider_order_id IS NOT NULL AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
        AND NOT EXISTS(SELECT 1 FROM ${ORDERS} x WHERE x.workspace_id=d.workspace_id AND x.sales_order_id=d.sales_order_id AND x.status IN ('SENT','SENDING')) LIMIT 25`,
      [workspaceId,route.connector_id,route.location_id])).rows){
      await db.query(`INSERT INTO ${ORDERS} AS x(workspace_id,sales_order_id,connector_id,location_id,order_version,request_hash,status,sent_at) VALUES($1,$2,$3,$4,$5,$6,'SENT',clock_timestamp())
        ON CONFLICT(workspace_id,sales_order_id) DO UPDATE SET status='SENT',request_hash=excluded.request_hash,reason=NULL,sent_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE x.status IN ('DRAFT','HELD','DISMISSED')`,[workspaceId,d.sales_order_id,route.connector_id,route.location_id,d.version,d.request_hash]);
      out.adopted++;
    }
    // New and changed orders for this warehouse; drafts that waited only for authority go once StockChief may act.
    const candidates=(await db.query(`SELECT o.id,o.version FROM sales_orders o LEFT JOIN ${ORDERS} x ON x.workspace_id=o.workspace_id AND x.sales_order_id=o.id
      WHERE o.workspace_id=$1 AND o.fulfillment_location_id=$2 AND o.status='CONFIRMED' AND o.delivery_method='SHIP' AND o.confirmed_at::timestamptz>=$3
        AND NOT EXISTS(SELECT 1 FROM ${DELEGATED} d WHERE d.workspace_id=o.workspace_id AND d.sales_order_id=o.id)
        AND (x.sales_order_id IS NULL OR x.status IN ('DRAFT','HELD','DISMISSED') AND x.order_version<>o.version OR x.status='DRAFT' AND $4::boolean
          OR x.status='HELD' AND x.updated_at<now()-interval '1 hour')
      ORDER BY o.confirmed_at,o.id LIMIT 25`,[workspaceId,route.location_id,route.enabled_at,alone])).rows;
    for(const o of candidates){const r=await decide(db,ctx,route,o,{automatic,stop,transport});out[r==='sent'?'sent':r==='drafted'?'drafted':'held']++;}
    // An order whose answer was lost is checked again under the same reference.
    if(alone)for(const x of (await db.query(`SELECT * FROM ${ORDERS} WHERE workspace_id=$1 AND location_id=$2 AND status='SENDING' AND updated_at<now()-interval '2 minutes' LIMIT 10`,[workspaceId,route.location_id])).rows){
      try{await handOver(db,ctx,x.sales_order_id,x.request_hash,{automatic:true,transport});out.sent++;}catch(error){if(!expected(error))throw error;}
    }
    // Shipping and tracking come back.
    for(const x of (await db.query(`SELECT x.* FROM ${ORDERS} x JOIN sales_orders o ON o.workspace_id=x.workspace_id AND o.id=x.sales_order_id
      WHERE x.workspace_id=$1 AND x.location_id=$2 AND x.status='SENT' AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
        AND (x.checked_at IS NULL OR x.checked_at<now()-interval '15 minutes' OR $3) ORDER BY x.checked_at NULLS FIRST,x.sales_order_id LIMIT 25`,[workspaceId,route.location_id,fresh])).rows){
      try{await refresh(db,ctx,x,transport);out.refreshed++;}catch(error){if(!expected(error))throw error;}
    }
    for(const p of (await db.query(`SELECT p.connector_id,p.provider_shipment_id FROM ${PARCELS} p JOIN ${ORDERS} x ON x.workspace_id=p.workspace_id AND x.sales_order_id=p.sales_order_id
      WHERE p.workspace_id=$1 AND x.location_id=$2 AND p.status='WAITING' ORDER BY p.created_at LIMIT 25`,[workspaceId,route.location_id])).rows){
      if(!alone){
        await db.query(`UPDATE ${PARCELS} SET reason=$4 WHERE workspace_id=$1 AND connector_id=$2 AND provider_shipment_id=$3`,
          [workspaceId,p.connector_id,p.provider_shipment_id,stop||'You record each 3PL shipment for this warehouse.']);out.waiting++;continue;
      }
      const r=await recordParcel(db,ctx,p.connector_id,p.provider_shipment_id,{automatic:true});
      if(r.recorded)out.recorded++;else out.held++;
    }
    // Saved stock readings are read again hourly. ShipBob sandbox readings follow job 123's own setting.
    for(const s of (await db.query(`SELECT s.connector_id,s.inventory_ref,k.code FROM ${STOCK} s JOIN skus k ON k.workspace_id=s.workspace_id AND k.id=s.sku_id AND k.is_active=1
      WHERE s.workspace_id=$1 AND s.connector_id=$2 AND s.observed_at<now()-interval '1 hour' ORDER BY s.observed_at LIMIT 20`,[workspaceId,route.connector_id])).rows){
      try{await readStock(db,ctx,{connectorId:s.connector_id,sku:s.code,inventoryRef:s.inventory_ref},transport);out.stock++;}catch(error){if(!expected(error)&&!error.retryable)throw error;}
    }
  }
  return out;
}
// Every five minutes for each inventory with a route.
async function schedule(client){
  if(!await ready(client))return {queued:0};
  const bucket=Math.floor(Date.now()/(5*60_000));let queued=0;
  for(const r of (await client.query(`SELECT DISTINCT r.workspace_id FROM ${ROUTES} r JOIN workspaces w ON w.id=r.workspace_id AND w.deletion_requested_at IS NULL
    WHERE r.enabled ORDER BY r.workspace_id LIMIT 500`)).rows){
    const made=await jobs.enqueue(scoped(client),{workspaceId:r.workspace_id,kind:KIND,idempotencyKey:'3pl-orders:'+bucket,payload:{},priority:60,maxAttempts:3});
    if(made.created)queued++;
  }
  return {queued};
}

// A person approves, dismisses or records.
async function approve(db,ctx,orderId,{transport}={}){
  await owner(db,ctx);
  const row=(await db.query(`SELECT * FROM ${ORDERS} WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('DRAFT','HELD','SENDING')`,[ctx.workspaceId,String(orderId||'')])).rows[0];
  if(!row)throw new NotFoundError('That order is no longer waiting.');
  const route=(await db.query(`SELECT * FROM ${ROUTES} WHERE workspace_id=$1 AND location_id=$2 AND enabled`,[ctx.workspaceId,row.location_id])).rows[0];
  if(!route)throw new ValidationError('No 3PL runs this order’s warehouse.');
  const hash=row.status==='SENDING'?row.request_hash:(await review(db,ctx,orderId,await connector(db,ctx,route.connector_id))).hash;
  return handOver(db,ctx,orderId,hash,{automatic:false,decidedBy:ctx.actorId,transport});
}
async function dismiss(db,ctx,orderId){
  return tx(db,async c=>{
    await owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const done=await c.query(`UPDATE ${ORDERS} SET status='DISMISSED',decided_by=$3,decided_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('DRAFT','HELD') RETURNING sales_order_id`,[ctx.workspaceId,String(orderId||''),ctx.actorId]);
    if(!done.rowCount)throw new NotFoundError('That order is no longer waiting.');
    await audit.record(c,ctx,{action:'3PL order draft dismissed',reference:orderId});
    return {dismissed:true};
  });
}
async function record(db,ctx,connectorId,providerShipmentId){
  await owner(db,ctx);
  const result=await recordParcel(db,ctx,connectorId,providerShipmentId,{automatic:false,decidedBy:ctx.actorId});
  if(result.held)throw new ValidationError(result.held);
  return result;
}
async function refreshNow(db,ctx,orderId,transport){
  await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  const row=(await db.query(`SELECT * FROM ${ORDERS} WHERE workspace_id=$1 AND sales_order_id=$2 AND status='SENT'`,[ctx.workspaceId,String(orderId||'')])).rows[0];
  if(!row)throw new NotFoundError('That order has not gone to a 3PL.');
  return refresh(db,ctx,row,transport);
}

// The 3PL orders page.
async function panel(db,ctx){
  const state=await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  if(!await ready(db))return {upgrading:true,connections:[],routes:[],orders:[],parcels:[],stock:[],warehouses:[],available:[]};
  const linked=await connections(db,ctx.workspaceId),label=new Map(linked.map(c=>[c.id,c.label]));
  const warehouses=(await db.query("SELECT id,name FROM locations WHERE workspace_id=$1 AND kind='warehouse' AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id",[ctx.workspaceId])).rows;
  const routes=(await db.query(`SELECT r.*,l.name AS location FROM ${ROUTES} r JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id WHERE r.workspace_id=$1 ORDER BY r.enabled DESC,l.name`,[ctx.workspaceId])).rows
    .map(r=>({...r,provider:label.get(r.connector_id)||'Disconnected 3PL'}));
  const orders=(await db.query(`SELECT x.*,o.order_number,o.status AS order_status,d.provider_order_id,d.provider_status,d.shipments,l.name AS location FROM ${ORDERS} x
    JOIN sales_orders o ON o.workspace_id=x.workspace_id AND o.id=x.sales_order_id JOIN locations l ON l.workspace_id=x.workspace_id AND l.id=x.location_id
    LEFT JOIN ${DELEGATED} d ON d.workspace_id=x.workspace_id AND d.sales_order_id=x.sales_order_id
    WHERE x.workspace_id=$1 AND (x.status IN ('DRAFT','HELD','SENDING') OR x.updated_at>now()-interval '30 days')
    ORDER BY (x.status IN ('DRAFT','HELD','SENDING')) DESC,x.updated_at DESC,x.sales_order_id LIMIT 100`,[ctx.workspaceId])).rows
    .map(r=>({...r,provider:label.get(r.connector_id)||'3PL'}));
  const parcels=(await db.query(`SELECT p.*,o.order_number,s.shipment_number FROM ${PARCELS} p JOIN sales_orders o ON o.workspace_id=p.workspace_id AND o.id=p.sales_order_id
    LEFT JOIN sales_shipments s ON s.workspace_id=p.workspace_id AND s.id=p.shipment_id
    WHERE p.workspace_id=$1 AND (p.status<>'RECORDED' OR p.recorded_at>now()-interval '30 days') ORDER BY (p.status<>'RECORDED') DESC,p.created_at DESC LIMIT 100`,[ctx.workspaceId])).rows
    .map(r=>({...r,provider:label.get(r.connector_id)||'3PL'}));
  const stock=(await db.query(`SELECT s.*,k.code FROM ${STOCK} s JOIN skus k ON k.workspace_id=s.workspace_id AND k.id=s.sku_id WHERE s.workspace_id=$1 ORDER BY k.code LIMIT 200`,[ctx.workspaceId])).rows
    .map(r=>({...r,provider:label.get(r.connector_id)||'3PL'}));
  const automatic=policy.permits(state.plan,JOB,'automatic');
  return {connections:linked.map(c=>({id:c.id,label:c.label,key:c.adapter.key,account:c.account})),
    available:adapters.list().filter(a=>a.key!=='shipbob'&&!linked.some(c=>c.adapter.key===a.key)).map(a=>({key:a.key,label:a.label})),
    warehouses,routes,orders,parcels,stock,automatic,stop:automatic?await automaticStop(db,ctx.workspaceId,state):null};
}

// Needs you: orders and shipments that wait for a person, and what stopped.
async function inbox(db,workspaceId){
  if(!await ready(db))return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return [];
  const r=(await db.query(`SELECT
    count(*) FILTER (WHERE status='DRAFT')::int AS drafts,
    count(*) FILTER (WHERE status='HELD' OR status='SENDING' AND updated_at<now()-interval '10 minutes')::int AS held,
    min(reason) FILTER (WHERE status='HELD' OR status='SENDING' AND updated_at<now()-interval '10 minutes') AS held_reason,
    min(reason) FILTER (WHERE status='DRAFT') AS draft_reason,
    (SELECT count(*) FROM ${PARCELS} p WHERE p.workspace_id=$1 AND p.status='WAITING')::int AS waiting,
    (SELECT count(*) FROM ${PARCELS} p WHERE p.workspace_id=$1 AND p.status='HELD')::int AS parcels_held,
    (SELECT min(reason) FROM ${PARCELS} p WHERE p.workspace_id=$1 AND p.status='HELD') AS parcel_reason
    FROM ${ORDERS} WHERE workspace_id=$1`,[workspaceId])).rows[0];
  const items=[],at=new Date().toISOString(),base={kind:'sales',grouped:true,importance:'Needs You',href,sourceId:'3pl-orders',createdAt:at,at};
  const problems=r.held+r.parcels_held;
  if(problems)items.push({...base,priority:77,title:problems+' 3PL '+(problems===1?'order needs':'orders need')+' you',happened:r.held_reason||r.parcel_reason,
    why:'When facts are missing or do not match, StockChief stops and asks. It never guesses.',recommendation:'Fix the order, or check it with the 3PL.',actionLabel:'Review 3PL orders'});
  if(r.drafts)items.push({...base,priority:74,title:r.drafts+' '+(r.drafts===1?'order waits':'orders wait')+' to go to your 3PL',happened:r.draft_reason||'Orders confirmed for a warehouse your 3PL runs are ready to send.',
    why:'The 3PL ships them once it has them.',recommendation:'Approve each order, or dismiss it.',actionLabel:'Review 3PL orders'});
  if(r.waiting)items.push({...base,priority:73,title:r.waiting+' 3PL '+(r.waiting===1?'shipment waits':'shipments wait')+' to be recorded',
    happened:'Your 3PL shipped them. Recording takes the stock out and puts the tracking on the order.',why:'Stock and invoices follow what actually shipped.',
    recommendation:'Record each shipment.',actionLabel:'Record shipments'});
  return items;
}

// Stock readings for job 123's partner stock view: SQL rows in that view's shape.
const partnerStockSql=`SELECT '3pl:'||c.id||':'||k.id,c.display_name||' saved read',c.display_name,'Saved partner stock',k.code,'Not established by the snapshot',
   b.on_hand::text,NULL::text,b.available::text,
   CASE WHEN c.status='connected' AND c.paused_at IS NULL THEN 'Connected; saved provider reading' ELSE 'Connection paused or disconnected; saved reading' END,
   b.observed_at,'${href}'
  FROM ${STOCK} b JOIN skus k ON k.workspace_id=b.workspace_id AND k.id=b.sku_id
   JOIN workspace_connectors c ON c.workspace_id=b.workspace_id AND c.id=b.connector_id WHERE b.workspace_id=$1`;

module.exports={JOB,KIND,SENT_ACTION,RECORDED_ACTION,href,ready,automaticStop,connections,connect,plainOrder,review,fingerprint,saveRoute,handOver,decide,refresh,
  recordParcel,readStock,run,schedule,approve,dismiss,record,refreshNow,panel,inbox,partnerStockSql,STOCK};
