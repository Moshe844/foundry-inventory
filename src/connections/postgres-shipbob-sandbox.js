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
    await vault.remove(c,ctx.workspaceId,con.id);
    await c.query("UPDATE workspace_connectors SET status='disconnected',setup_status='DISCONNECTED',credential_ref=NULL,paused_at=$3,updated_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,con.id,nowIso()]);
  });
}
async function draft(db,ctx,orderId){
  await access(db,ctx);
  const con=await connection(db,ctx);
  // The same plain order and ShipBob request the 3PL routes of job 186 send.
  const {plain}=await require('./agent-3pl-orders').plainOrder(db,ctx,orderId);
  const payload=require('./third-party-logistics').get('shipbob').payload(plain);
  return {payload,channelId:con.channelId,hash:fingerprint([con.id,con.channelId,payload])};
}
function snapshot(order){
  const shipments=(order.shipments||[]).map(s=>({id:api.positiveId(s.id,'shipment ID'),status:String(s.status||'Unknown'),carrier:s.tracking?.carrier||null,tracking:s.tracking?.tracking_number||s.tracking?.number||null}));
  return [api.positiveId(order.id,'order ID'),String(order.status||'Unknown'),JSON.stringify(shipments)];
}
async function save(db,ctx,orderId,hash,order){
  const [id,status,shipments]=snapshot(order);
  const saved=await db.query(`UPDATE stockchief_runtime.shipbob_sandbox_orders SET provider_order_id=$4,provider_status=$5,shipments=$6,observed_at=now()
    WHERE workspace_id=$1 AND sales_order_id=$2 AND request_hash=$3 AND (provider_order_id IS NULL OR provider_order_id=$4)`,[ctx.workspaceId,orderId,hash,id,status,shipments]);
  if(saved.rowCount!==1)throw new ValidationError('The saved ShipBob reference changed. Review the original order.');
}
async function send(db,ctx,orderId,expectedHash,transport){
  const {con,review,known}=await db.transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
    const review=await draft(c,ctx,orderId),con=await connection(c,ctx);
    if(review.hash!==expectedHash)throw new ValidationError('This order changed. Review its destination and lines again.');
    await c.query(`INSERT INTO stockchief_runtime.shipbob_sandbox_orders(workspace_id,sales_order_id,connector_id,channel_id,request_hash,prepared_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[ctx.workspaceId,orderId,con.id,con.channelId,review.hash,ctx.actorId]);
    const previous=(await c.query('SELECT * FROM stockchief_runtime.shipbob_sandbox_orders WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,orderId])).rows[0];
    if(previous.request_hash!==review.hash)throw new ValidationError('A different version was submitted. Reconcile the original ShipBob order first.');
    return {review,con,known:previous.provider_order_id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
  await access(db,ctx);
  const response=await (await remote(db,ctx,con,transport)).send(review.payload,
    ()=>require('../sales/agent-order-checks').assertCanRelease(db,ctx.workspaceId,orderId));
  await save(db,ctx,orderId,review.hash,response);
  // A person's own send is audited once too; the activity log shows only StockChief's.
  if(!known)await require('../operations/postgres-security-audit').record(db,ctx,{action:require('./agent-3pl-orders').SENT_ACTION,reference:orderId,
    after:{automatic:false,provider:'ShipBob sandbox',providerOrder:String(response.id),order:review.payload.order_number,lines:review.payload.products.length}});
}
async function refresh(db,ctx,orderId,transport){
  await access(db,ctx);
  const con=await connection(db,ctx);
  const row=(await db.query('SELECT * FROM stockchief_runtime.shipbob_sandbox_orders WHERE workspace_id=$1 AND sales_order_id=$2 AND connector_id=$3',[ctx.workspaceId,orderId,con.id])).rows[0];
  if(!row?.provider_order_id)throw new ValidationError('Submit or reconcile the sandbox order first.');
  const order=await (await remote(db,ctx,con,transport)).order(row.provider_order_id,orderId);
  await save(db,ctx,orderId,row.request_hash,order);
}
async function stock(db,ctx,input,transport,authorizeRefresh){
  await access(db,ctx);const con=await connection(db,ctx);
  const skus=(await db.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND lower(code)=lower($2) AND is_active=1',[ctx.workspaceId,String(input.sku||'').trim()])).rows;
  if(skus.length!==1)throw new ValidationError('Enter one exact active SKU.');
  if(authorizeRefresh)await authorizeRefresh(db);
  const requestedAt=new Date().toISOString(),value=await (await remote(db,ctx,con,transport)).stock(input.inventoryId,skus[0].code);
  await db.transaction(async c=>{
   await access(c,ctx);const current=await connection(c,ctx);
   if(current.id!==con.id||current.channelId!==con.channelId)throw new ValidationError('The stock connection changed while reading. Request a fresh reading.');
   if(authorizeRefresh)await authorizeRefresh(c);
   await c.query(`INSERT INTO stockchief_runtime.shipbob_sandbox_stock(workspace_id,sku_id,inventory_id,connector_id,on_hand,fulfillable,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,sku_id) DO UPDATE SET inventory_id=excluded.inventory_id,
    connector_id=excluded.connector_id,on_hand=excluded.on_hand,fulfillable=excluded.fulfillable,observed_at=excluded.observed_at
    WHERE shipbob_sandbox_stock.observed_at<=excluded.observed_at`,
   [ctx.workspaceId,skus[0].id,String(value.inventory_id),con.id,value.total_on_hand_quantity,value.total_fulfillable_quantity,requestedAt]);
   // Job 123: compare the reading with StockChief's records at the ShipBob partner location.
   await require('../autopilot/partner-stock').compareShipBob(c,ctx.workspaceId,skus[0].id,{quiet:true});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
// The warehouse rule is a job 186 route: orders confirmed for that warehouse go to ShipBob on their own.
async function configureRule(db,ctx,input){
  const routes=require('./agent-3pl-orders'),con=await connection(db,ctx);
  if(input.action==='disable'){
    const route=(await db.query("SELECT location_id,revision FROM stockchief_runtime.agent_3pl_routes WHERE workspace_id=$1 AND connector_id=$2 AND enabled",[ctx.workspaceId,con.id])).rows[0];
    if(!route)return;
    return routes.saveRoute(db,ctx,{locationId:route.location_id,revision:route.revision,stop:'yes'});
  }
  if(input.action!=='enable')throw new ValidationError('Choose a sandbox order rule.');
  const prior=(await db.query('SELECT revision FROM stockchief_runtime.agent_3pl_routes WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,String(input.locationId||'')])).rows[0];
  return routes.saveRoute(db,ctx,{locationId:input.locationId,connectorId:con.id,automatic:'yes',revision:prior?.revision});
}
// Older queued sandbox orders: the 3PL routes now send them.
async function runJob(){return {held:true,reason:'3PL routes now send these orders.'};}
async function dashboard(db,ctx){
  const state=await ownerState(db,ctx),enabled=plan.usesAgentTerms(state)&&plan.permits(state.plan,186,'draft');
  const linked=(await db.query("SELECT 1 FROM workspace_connectors WHERE workspace_id=$1 AND connector_key=$2 AND status='connected' AND paused_at IS NULL",[ctx.workspaceId,connectorKey])).rowCount===1;
  if(!enabled||!linked)return {enabled,linked,orders:[],stock:[]};
  const orders=(await db.query(`SELECT o.id,o.order_number,x.provider_order_id,x.provider_status,x.shipments,x.observed_at
    FROM sales_orders o LEFT JOIN stockchief_runtime.shipbob_sandbox_orders x ON x.workspace_id=o.workspace_id AND x.sales_order_id=o.id
    WHERE o.workspace_id=$1 AND ((o.status='CONFIRMED' AND o.delivery_method='SHIP') OR x.sales_order_id IS NOT NULL)
    ORDER BY coalesce(x.observed_at,o.created_at::timestamptz) DESC,o.id LIMIT 100`,[ctx.workspaceId])).rows;
  const stock=(await db.query('SELECT s.code,x.* FROM stockchief_runtime.shipbob_sandbox_stock x JOIN skus s ON s.id=x.sku_id WHERE x.workspace_id=$1 ORDER BY s.code',[ctx.workspaceId])).rows;
  const automatic=plan.permits(state.plan,186,'automatic');
  return {enabled,linked,orders,stock,automatic};
}
module.exports={connect,disconnect,draft,send,refresh,stock,dashboard,configureRule,runJob};
