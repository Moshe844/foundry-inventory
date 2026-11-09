'use strict';

const plans=require('../commercial/agent-plan');
const modes=require('../autopilot/job-modes');
const exact=require('../domain/exact-quantity');
const {ValidationError,NotFoundError}=require('../domain/errors');

function eligible(order){
  return order.status==='DRAFT'&&order.delivery_method==='SHIP'&&!order.fulfillment_location_id;
}

async function openOrder(db,ctx,id){
  const {rows:[order]}=await db.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id]);
  if(!order)throw new NotFoundError('Choose an order from this inventory.');
  if(!eligible(order))throw new ValidationError('Choose an unconfirmed shipping order without a ship-from location.');
  return order;
}

// Reserve physical lines first, just as order confirmation does. Any unbuilt kits
// then compete for the same remaining components as other kits in the order.
function covers(lines,parts,available,locationId){
  const free=new Map(),missingKits=[];
  function take(sku,quantity){
    const balance=free.get(sku)??available.get(JSON.stringify([sku,locationId]))??0;
    const taken=Math.min(balance,quantity);
    free.set(sku,exact.safeNumber(exact.subtract(balance,taken)));
    return exact.safeNumber(exact.subtract(quantity,taken));
  }
  for(const line of lines){
    const missing=take(line.sku_id,exact.safeNumber(line.quantity_ordered));
    if(!missing)continue;
    if(!parts.has(line.id))return false;
    missingKits.push({missing,parts:parts.get(line.id)});
  }
  for(const kit of missingKits)for(const part of kit.parts){
    const quantity=exact.safeNumber(exact.convert(kit.missing,{numerator:part.quantity_per_kit}));
    if(take(part.component_sku_id,quantity)>0)return false;
  }
  return true;
}

async function selection(db,workspaceId,order){
  const args=[workspaceId,order.id];
  const prior=await db.query(`SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=$1 AND l.sales_order_id=$2
    AND (l.quantity_fulfilled>0 OR EXISTS(SELECT 1 FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id)
      OR EXISTS(SELECT 1 FROM sales_order_kit_components k JOIN sales_order_kit_allocations a ON a.workspace_id=k.workspace_id AND a.kit_component_id=k.id
        WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id)) LIMIT 1`,args);
  if(prior.rowCount)return null;
  const {rows:lines}=await db.query('SELECT id,sku_id,quantity_ordered FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY created_at,id',args);
  if(!lines.length)return null;
  const {rows:components}=await db.query(`SELECT k.sales_order_line_id,k.component_sku_id,k.quantity_per_kit FROM sales_order_kit_components k
    JOIN sales_order_lines l ON l.id=k.sales_order_line_id AND l.workspace_id=k.workspace_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY k.id`,args);
  const parts=new Map();
  for(const part of components){
    if(!parts.has(part.sales_order_line_id))parts.set(part.sales_order_line_id,[]);
    parts.get(part.sales_order_line_id).push(part);
  }
  const skuIds=[...new Set([...lines.map(l=>l.sku_id),...components.map(p=>p.component_sku_id)])];
  const available=await require('../domain/postgres-kit-availability').stock(db,workspaceId,skuIds);
  const ids=[...new Set([...available.keys()].map(key=>JSON.parse(key)[1]))];
  if(!ids.length)return null;
  const {rows:locations}=await db.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[])
    AND is_active=1 AND custody_agreement_id IS NULL ORDER BY pick_sequence,lower(name),id`,[workspaceId,ids]);
  return locations.find(loc=>covers(lines,parts,available,loc.id))||null;
}

async function manualAccess(db,ctx){
  const access=require('../actions/permissions');
  const {rows:[user]}=await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId]);
  access.assertCan(user,access.VIEW_SALES,'see customer orders');
  access.assertCan(user,access.OPERATE,'choose the shipping warehouse');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
  const state=await plans.accountState(db,ctx.workspaceId);
  plans.requireJob(plans.usesAgentTerms(state)?state.plan:null,121,'draft');
  return state;
}

async function preview(db,ctx,id){
  return db.transaction(async c=>{
    await manualAccess(c,ctx);
    const order=await openOrder(c,ctx,id);
    return {order,location:await selection(c,ctx.workspaceId,order),block:await manualBlock(c,ctx.workspaceId)};
  },{isolation:'REPEATABLE READ',retrySafe:true});
}

async function manualBlock(db,workspaceId){
  const state=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(!state.canAct)return 'StockChief is watching or paused. Review its authority before using the suggested warehouse.';
  return modes.restriction(db,workspaceId,121,false);
}

async function assign(db,ctx,order,location,automatic){
  await db.query('UPDATE sales_orders SET fulfillment_location_id=$3,updated_at=$4,version=version+1 WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,order.id,location.id,new Date().toISOString()]);
  await require('../operations/postgres-security-audit').record(db,ctx,{action:'Shipping warehouse selected',reference:order.order_number,
    after:{warehouse:location.name,locationId:location.id,automatic}});
  order.fulfillment_location_id=location.id;
}

async function approve(db,ctx,id,input){
  return db.transaction(async c=>{
    await manualAccess(c,ctx);
    const order=await openOrder(c,ctx,id);
    const stop=await manualBlock(c,ctx.workspaceId);
    if(stop)throw new ValidationError(stop);
    const location=await selection(c,ctx.workspaceId,order);
    if(!location||location.id!==input.locationId||String(order.version)!==String(input.version))
      throw new ValidationError('The order or available warehouse changed. Review the shipping warehouse again.');
    await assign(c,ctx,order,location,false);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function chooseAtConfirmation(db,ctx,order){
  if(!eligible(order))return;
  const {rows:[choice]}=await db.query(`SELECT 1 FROM stockchief_runtime.agent_job_modes m JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
    WHERE m.workspace_id=$1 AND m.job_id=121 AND m.mode='routine'`,[ctx.workspaceId]);
  if(!choice)return;
  const state=await require('../autopilot/postgres-service').getState(db,ctx.workspaceId);
  if(!state.agentTerms||!state.canAutomate||!plans.permits(state.plan,121,'automatic'))return;
  if(await require('../operations/postgres-warehouse-access').scope(db,ctx)!==null)return;
  const location=await selection(db,ctx.workspaceId,order);
  if(location)await assign(db,ctx,order,location,true);
}

module.exports={eligible,preview,approve,chooseAtConfirmation};
