'use strict';
const {createHash}=require('node:crypto');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const plan=require('../commercial/agent-plan');
const {ownerState}=require('../autopilot/job-reviews');
const vault=require('./postgres-credential-store');
const api=require('./shipbob-sandbox-api');
const connectorKey='agent-shipbob-sandbox';
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function access(db,ctx,operation='draft'){
  const state=await ownerState(db,ctx);
  plan.requireJob(plan.usesAgentTerms(state)?state.plan:null,186,operation);
  if(operation==='automatic' && state.shadow)throw new ValidationError('The account is still in its 14-day review period.');
  return state;
}
async function connection(db,ctx){
  const row=(await db.query('SELECT id,status,paused_at,config FROM workspace_connectors WHERE workspace_id=$1 AND connector_key=$2',[ctx.workspaceId,connectorKey])).rows[0];
  if(!row||row.status!=='connected'||row.paused_at)throw new ValidationError('Connect the ShipBob sandbox first.');
  return {id:row.id,channelId:JSON.parse(row.config).channelId};
}
async function remote(db,ctx,con,transport){
  const secret=await vault.get(db,ctx.workspaceId,con.id,'provider');
  if(!secret?.apiKey)throw new ValidationError('Reconnect the ShipBob sandbox token.');
  return api.client({apiKey:secret.apiKey,channelId:con.channelId},transport);
}
async function connect(db,ctx,input,transport){
  await access(db,ctx);
  const apiKey=String(input.apiKey||'').trim(),channelId=api.positiveId(input.channelId,'ShipBob channel ID');
  if(!apiKey||apiKey.length>4096||/\s/.test(apiKey))throw new ValidationError('Enter a ShipBob sandbox token.');
  await api.client({apiKey,channelId},transport).verify();
  await db.transaction(async c=>{
    const state=await access(c,ctx);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[ctx.workspaceId+connectorKey]);
    const row=(await c.query('SELECT id,config FROM workspace_connectors WHERE workspace_id=$1 AND connector_key=$2 FOR UPDATE',[ctx.workspaceId,connectorKey])).rows[0];
    if(row && JSON.parse(row.config).channelId!==channelId)throw new ValidationError('Reconnect the original channel to preserve its order references.');
    const id=row?.id||newId('con'),capacity=require('../commercial/connection-capacity');
    await capacity.assertActivation(c,{accountId:state.accountId,workspaceId:ctx.workspaceId},'shipbob',row?await capacity.activationDelta(c,ctx.workspaceId,id):1);
    const at=nowIso();
    if(row)await c.query("UPDATE workspace_connectors SET status='connected',setup_status='CONNECTED',paused_at=NULL,credential_ref=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,'connection_credentials:'+id,at]);
    else await c.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,
      credential_ref,setup_status,authorized_by_user_id,created_at,updated_at,expected_interval_minutes) VALUES($1,$2,$3,'ShipBob sandbox','shipbob','["fulfillment"]',$4,'connected','["test_orders","inventory","tracking"]',$5,'CONNECTED',$6,$7,$7,0)`,
    [id,ctx.workspaceId,connectorKey,JSON.stringify({channelId,environment:'sandbox'}),'connection_credentials:'+id,ctx.actorId,at]);
    await vault.put(c,ctx.workspaceId,id,'provider',{apiKey});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function disconnect(db,ctx){
  await db.transaction(async c=>{
    await ownerState(c,ctx);
    const con=await connection(c,ctx);
    await c.query('DELETE FROM stockchief_runtime.shipbob_sandbox_rules WHERE workspace_id=$1',[ctx.workspaceId]);
    await vault.remove(c,ctx.workspaceId,con.id);
    await c.query("UPDATE workspace_connectors SET status='disconnected',setup_status='DISCONNECTED',credential_ref=NULL,paused_at=$3,updated_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,con.id,nowIso()]);
  });
}
async function draft(db,ctx,orderId){
  await access(db,ctx);
  const con=await connection(db,ctx);
  const order=(await db.query(`SELECT o.*,c.name FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE o.workspace_id=$1 AND o.id=$2`,[ctx.workspaceId,orderId])).rows[0];
  if(!order)throw new NotFoundError('The sales order was not found in this inventory.');
  if(order.status!=='CONFIRMED'||order.delivery_method!=='SHIP'||Number(order.customer_decision_required)!==0||Number(order.delivery_decision_required)!==0)
    throw new ValidationError('Choose a confirmed, unfulfilled delivery order with a verified customer and destination.');
  const address=require('../shipping/address').parse(order.ship_to_address);
  if(!address.complete)throw new ValidationError('Complete the order’s delivery address before sending.');
  const lines=(await db.query(`SELECT s.code,i.name,l.quantity_ordered,l.quantity_fulfilled FROM sales_order_lines l JOIN skus s ON s.id=l.sku_id
    JOIN items i ON i.id=s.item_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.id`,[ctx.workspaceId,orderId])).rows;
  if(!lines.length || lines.some(l=>Number(l.quantity_fulfilled)!==0||!Number.isSafeInteger(Number(l.quantity_ordered))||Number(l.quantity_ordered)<1))
    throw new ValidationError('ShipBob needs whole-unit lines with no prior fulfillment.');
  const payload={reference_id:orderId,order_number:order.order_number,type:'DTC',shipping_method:'Standard',
    recipient:{name:address.name||order.name,address:{address1:address.line1,address2:address.line2,city:address.city,state:address.state,country:address.country,zip_code:address.postalCode}},
    products:lines.map(l=>({reference_id:l.code,name:l.name,quantity:Number(l.quantity_ordered)}))};
  return {payload,channelId:con.channelId,hash:fingerprint([con.id,con.channelId,payload])};
}
function snapshot(order){
  const shipments=(order.shipments||[]).map(s=>({id:api.positiveId(s.id,'shipment ID'),status:String(s.status||'Unknown'),carrier:s.tracking?.carrier||null,tracking:s.tracking?.number||null}));
  return [api.positiveId(order.id,'order ID'),String(order.status||'Unknown'),JSON.stringify(shipments)];
}
async function save(db,ctx,orderId,hash,order){
  const [id,status,shipments]=snapshot(order);
  const saved=await db.query(`UPDATE stockchief_runtime.shipbob_sandbox_orders SET provider_order_id=$4,provider_status=$5,shipments=$6,observed_at=now()
    WHERE workspace_id=$1 AND sales_order_id=$2 AND request_hash=$3 AND (provider_order_id IS NULL OR provider_order_id=$4)`,[ctx.workspaceId,orderId,hash,id,status,shipments]);
  if(saved.rowCount!==1)throw new ValidationError('The saved ShipBob reference changed. Review the original order.');
}
async function send(db,ctx,orderId,expectedHash,transport,generation=null){
  const {con,review}=await db.transaction(async c=>{
    if(generation)await validateRule(c,ctx,orderId,generation);
    const review=await draft(c,ctx,orderId),con=await connection(c,ctx);
    if(review.hash!==expectedHash)throw new ValidationError('This order changed. Review its destination and lines again.');
    await c.query(`INSERT INTO stockchief_runtime.shipbob_sandbox_orders(workspace_id,sales_order_id,connector_id,channel_id,request_hash,prepared_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[ctx.workspaceId,orderId,con.id,con.channelId,review.hash,ctx.actorId]);
    const previous=(await c.query('SELECT * FROM stockchief_runtime.shipbob_sandbox_orders WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,orderId])).rows[0];
    if(previous.request_hash!==review.hash)throw new ValidationError('A different version was submitted. Reconcile the original ShipBob order first.');
    return {review,con};
  },{isolation:'SERIALIZABLE',retrySafe:true});
  if(generation)await validateRule(db,ctx,orderId,generation);
  else await access(db,ctx);
  const response=await (await remote(db,ctx,con,transport)).send(review.payload,
    ()=>require('../sales/agent-order-checks').assertCanRelease(db,ctx.workspaceId,orderId));
  await save(db,ctx,orderId,review.hash,response);
}
async function refresh(db,ctx,orderId,transport){
  await access(db,ctx);
  const con=await connection(db,ctx);
  const row=(await db.query('SELECT * FROM stockchief_runtime.shipbob_sandbox_orders WHERE workspace_id=$1 AND sales_order_id=$2 AND connector_id=$3',[ctx.workspaceId,orderId,con.id])).rows[0];
  if(!row?.provider_order_id)throw new ValidationError('Submit or reconcile the sandbox order first.');
  const order=await (await remote(db,ctx,con,transport)).order(row.provider_order_id,orderId);
  await save(db,ctx,orderId,row.request_hash,order);
}
async function stock(db,ctx,input,transport){
  await access(db,ctx);const con=await connection(db,ctx);
  const skus=(await db.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND lower(code)=lower($2) AND is_active=1',[ctx.workspaceId,String(input.sku||'').trim()])).rows;
  if(skus.length!==1)throw new ValidationError('Enter one exact active SKU.');
  const value=await (await remote(db,ctx,con,transport)).stock(input.inventoryId,skus[0].code);
  await db.query(`INSERT INTO stockchief_runtime.shipbob_sandbox_stock(workspace_id,sku_id,inventory_id,connector_id,on_hand,fulfillable)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,sku_id) DO UPDATE SET inventory_id=excluded.inventory_id,
    connector_id=excluded.connector_id,on_hand=excluded.on_hand,fulfillable=excluded.fulfillable,observed_at=now()`,
  [ctx.workspaceId,skus[0].id,String(value.inventory_id),con.id,value.total_on_hand_quantity,value.total_fulfillable_quantity]);
}
async function configureRule(db,ctx,input){
  return db.transaction(async c=>{
    await ownerState(c,ctx);
    if(input.action==='disable'){
      await c.query('DELETE FROM stockchief_runtime.shipbob_sandbox_rules WHERE workspace_id=$1',[ctx.workspaceId]);return;
    }
    if(input.action!=='enable')throw new ValidationError('Choose a sandbox order rule.');
    await access(c,ctx,'automatic');await connection(c,ctx);
    const warehouse=await c.query("SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND kind='warehouse' AND is_active=1 AND custody_agreement_id IS NULL",[ctx.workspaceId,input.locationId]);
    if(!warehouse.rowCount)throw new ValidationError('Choose an active warehouse in this inventory.');
    await c.query(`INSERT INTO stockchief_runtime.shipbob_sandbox_rules(workspace_id,location_id,actor_id,generation) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id) DO UPDATE SET location_id=excluded.location_id,actor_id=excluded.actor_id,generation=excluded.generation,enabled_at=now()`,
    [ctx.workspaceId,input.locationId,ctx.actorId,newId('rule')]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function validateRule(db,ctx,orderId,generation){
  await access(db,ctx,'automatic');
  const state=await require('../autopilot/postgres-service').getState(db,ctx.workspaceId);
  if(state.paused||state.suspended||state.mode!=='POLICY_AUTOMATED')throw new ValidationError('Automatic work must be enabled to send sandbox orders.');
  const valid=await db.query(`SELECT 1 FROM stockchief_runtime.shipbob_sandbox_rules r JOIN sales_orders o ON o.workspace_id=r.workspace_id
    AND o.fulfillment_location_id=r.location_id AND o.confirmed_at::timestamptz>=r.enabled_at JOIN locations l ON l.id=r.location_id AND l.is_active=1
    WHERE r.workspace_id=$1 AND r.actor_id=$2 AND r.generation=$3 AND o.id=$4 AND o.status='CONFIRMED' AND o.delivery_method='SHIP'`,[ctx.workspaceId,ctx.actorId,generation,orderId]);
  if(!valid.rowCount)throw new ValidationError('The warehouse rule or this order changed.');
}
async function schedule(client){
  const rows=(await client.query(`SELECT r.*,o.id AS order_id,o.version FROM stockchief_runtime.shipbob_sandbox_rules r JOIN sales_orders o
    ON o.workspace_id=r.workspace_id AND o.fulfillment_location_id=r.location_id AND o.confirmed_at::timestamptz>=r.enabled_at
    JOIN workspace_autopilot a ON a.workspace_id=r.workspace_id AND a.mode='POLICY_AUTOMATED' AND a.paused=0 AND a.suspended=0
    WHERE o.status='CONFIRMED' AND o.delivery_method='SHIP' AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.shipbob_sandbox_orders x
      WHERE x.workspace_id=o.workspace_id AND x.sales_order_id=o.id AND x.provider_order_id IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs j WHERE j.workspace_id=o.workspace_id AND j.kind='shipbob.sandbox-order'
      AND j.idempotency_key=r.generation||'/'||o.id||'/'||o.version::text)
    ORDER BY o.confirmed_at,o.id LIMIT 50`)).rows;
  const jobs=require('../operations/postgres-job-queue');
  for(const row of rows){
    const version=row.version;
    await jobs.enqueue({query:client.query.bind(client),transaction:fn=>fn(client)},{kind:'shipbob.sandbox-order',workspaceId:row.workspace_id,
      idempotencyKey:[row.generation,row.order_id,version].join('/'),payload:{generation:row.generation,actorId:row.actor_id,orderId:row.order_id,version}});
  }
}
async function runJob(db,job,transport){
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId},orderId=job.payload.orderId;
  await validateRule(db,ctx,orderId,job.payload.generation);
  const version=(await db.query('SELECT version FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,orderId])).rows[0]?.version;
  if(String(version)!==String(job.payload.version))throw new ValidationError('The queued order version has changed.');
  const review=await draft(db,ctx,orderId);
  await send(db,ctx,orderId,review.hash,transport,job.payload.generation);
  return {submitted:true};
}
async function dashboard(db,ctx){
  const state=await ownerState(db,ctx),enabled=plan.usesAgentTerms(state)&&plan.permits(state.plan,186,'draft');
  const linked=(await db.query("SELECT 1 FROM workspace_connectors WHERE workspace_id=$1 AND connector_key=$2 AND status='connected' AND paused_at IS NULL",[ctx.workspaceId,connectorKey])).rowCount===1;
  if(!enabled||!linked)return {enabled,linked,orders:[],stock:[]};
  const orders=(await db.query(`SELECT o.id,o.order_number,x.provider_order_id,x.provider_status,x.shipments,x.observed_at
    FROM sales_orders o LEFT JOIN stockchief_runtime.shipbob_sandbox_orders x ON x.workspace_id=o.workspace_id AND x.sales_order_id=o.id
    WHERE o.workspace_id=$1 AND ((o.status='CONFIRMED' AND o.delivery_method='SHIP') OR x.sales_order_id IS NOT NULL)
    ORDER BY coalesce(x.observed_at,o.created_at::timestamptz) DESC,o.id LIMIT 100`,[ctx.workspaceId])).rows;
  const stock=(await db.query('SELECT s.code,x.* FROM stockchief_runtime.shipbob_sandbox_stock x JOIN skus s ON s.id=x.sku_id WHERE x.workspace_id=$1 ORDER BY s.code',[ctx.workspaceId])).rows;
  const automatic=plan.permits(state.plan,186,'automatic'),rule=(await db.query('SELECT l.name FROM stockchief_runtime.shipbob_sandbox_rules r JOIN locations l ON l.id=r.location_id WHERE r.workspace_id=$1',[ctx.workspaceId])).rows[0];
  const warehouses=automatic?(await db.query("SELECT id,name FROM locations WHERE workspace_id=$1 AND kind='warehouse' AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id",[ctx.workspaceId])).rows:[];
  return {enabled,linked,orders,stock,automatic,rule,warehouses};
}
module.exports={connect,disconnect,draft,send,refresh,stock,dashboard,configureRule,runJob,schedule};
