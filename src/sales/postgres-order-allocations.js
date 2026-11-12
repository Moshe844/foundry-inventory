'use strict';

// Native, idempotent changes to the stock set aside for one confirmed customer
// order. Callers decide which order gets stock; this module keeps the
// reservation ledger, the order's status and version, and its event history
// exact. Stock is only taken back from an order nobody has started to pick.
const {newId,nowIso}=require('../lib/util');
const {ValidationError,InvariantError}=require('../domain/errors');
const access=require('../actions/permissions');
const OPEN=['CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'];

async function begin(c,ctx,kind,key){
  const idempotencyKey=String(key||'').trim();
  if(!idempotencyKey||idempotencyKey.length>240)throw new ValidationError('A durable idempotency key is required.');
  const id=newId('pgop');
  const inserted=await c.query(`INSERT INTO stockchief_runtime.business_operations(id,workspace_id,kind,idempotency_key)
    VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING RETURNING id`,[id,ctx.workspaceId,kind,idempotencyKey]);
  if(inserted.rows.length)return {id,replayed:false};
  const prior=(await c.query(`SELECT id,status,result FROM stockchief_runtime.business_operations
    WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3 FOR UPDATE`,[ctx.workspaceId,kind,idempotencyKey])).rows[0];
  if(prior?.status==='COMPLETED')return {id:prior.id,replayed:true,result:prior.result};
  throw new InvariantError('That stock change is already running.','operation_in_progress');
}

async function actor(c,ctx){
  await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
  const row=(await c.query('SELECT id,role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new ValidationError('The acting user does not belong to this inventory.');
  access.assertCan(row,access.OPERATE,'set stock aside for customer orders');
}

function whole(value,label){
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<=0)throw new ValidationError(label+' must be a whole number above zero.');
  return n;
}

async function status(c,ctx,orderId){
  const row=(await c.query(`SELECT bool_or(l.quantity_fulfilled>0) shipped,
    bool_or(NOT EXISTS(SELECT 1 FROM sales_order_kit_components k WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id)
      AND l.quantity_ordered-l.quantity_fulfilled-coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)>
      coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0)) short
    FROM sales_order_lines l WHERE l.workspace_id=$1 AND l.sales_order_id=$2`,[ctx.workspaceId,orderId])).rows[0];
  return row.shipped?'PARTIALLY_FULFILLED':row.short?'BACKORDERED':'CONFIRMED';
}

// lines: [{lineId,locationId,quantity}]. direction is 'add' or 'remove'.
async function change(c,ctx,orderId,{lines,idempotencyKey,direction,expectedVersion,detail={}}){
  if(!ctx?.workspaceId||!ctx?.actorId)throw new ValidationError('A workspace and acting user are required.');
  if(!['add','remove'].includes(direction))throw new TypeError('Unknown stock change.');
  if(!Array.isArray(lines)||!lines.length||lines.length>200)throw new ValidationError('Choose one to 200 order lines.');
  await actor(c,ctx);
  await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'sales_orders.core');
  const kind=direction==='add'?'sales_order.set_aside':'sales_order.give_back';
  const operation=await begin(c,ctx,kind,idempotencyKey);
  if(operation.replayed)return {...operation.result,replayed:true};
  const order=(await c.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,orderId])).rows[0];
  if(!order||!OPEN.includes(order.status)||!order.confirmed_at)throw new ValidationError('Choose a confirmed open customer order.');
  if(expectedVersion!=null&&Number(expectedVersion)!==Number(order.version))throw new ValidationError(order.order_number+' changed. Review it again.');
  const current=new Map((await c.query(`SELECT l.id,l.sku_id,l.quantity_ordered::text ordered,l.quantity_fulfilled::text fulfilled,
    coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)::text direct,
    coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0)::text allocated
    FROM sales_order_lines l WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.id FOR UPDATE OF l`,[ctx.workspaceId,orderId])).rows.map(l=>[l.id,l]));
  const wanted=lines.map(l=>({lineId:String(l.lineId),locationId:String(l.locationId),quantity:whole(l.quantity,'The quantity')}));
  if(new Set(wanted.map(l=>l.lineId+'|'+l.locationId)).size!==wanted.length)throw new ValidationError('Combine each order line and location into one change.');
  for(const l of wanted)if(!current.has(l.lineId))throw new ValidationError('A line no longer belongs to '+order.order_number+'.');
  const at=nowIso();
  if(direction==='add'){
    const positions=[...new Map(wanted.map(l=>[current.get(l.lineId).sku_id+'|'+l.locationId,{skuId:current.get(l.lineId).sku_id,locationId:l.locationId}])).values()]
      .sort((a,b)=>(a.skuId+a.locationId).localeCompare(b.skuId+b.locationId));
    for(const p of positions)await c.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',[ctx.workspaceId,p.skuId,p.locationId]);
    const free=await require('../domain/postgres-stock-availability').readMany(c,ctx.workspaceId,positions);
    const asked=new Map();
    for(const l of wanted){
      const line=current.get(l.lineId),waiting=Number(line.ordered)-Number(line.fulfilled)-Number(line.direct)-Number(line.allocated);
      if(l.quantity>waiting)throw new ValidationError(order.order_number+' no longer waits for that many units.');
      const key=JSON.stringify([line.sku_id,l.locationId]);asked.set(key,(asked.get(key)||0)+l.quantity);
    }
    for(const [key,quantity] of asked)if(quantity>(free.get(key)?.available||0))throw new ValidationError('That stock is no longer free. Review the waiting orders again.');
    // A receipt-routed reservation keeps its exact arrivals; extra plain units
    // are appended the same way native order confirmation appends them.
    for(const l of wanted)await c.query(`INSERT INTO sales_order_allocations(id,workspace_id,sales_order_line_id,location_id,quantity,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(sales_order_line_id,location_id) DO UPDATE
      SET quantity=sales_order_allocations.quantity+EXCLUDED.quantity,
       rotation_selection=CASE WHEN sales_order_allocations.rotation_selection IS NOT NULL
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(sales_order_allocations.rotation_selection) selection WHERE selection ? 'arrivals')
        AND EXISTS(SELECT 1 FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
          WHERE s.workspace_id=$2 AND s.id=$7 AND i.tracking_mode='quantity' AND i.secondary_unit_label IS NULL)
        THEN sales_order_allocations.rotation_selection||jsonb_build_array(jsonb_build_object('quantity',EXCLUDED.quantity,'arrivals','[]'::jsonb))
        ELSE sales_order_allocations.rotation_selection END,
       updated_at=EXCLUDED.updated_at`,
      [newId('soa'),ctx.workspaceId,l.lineId,l.locationId,l.quantity,at,current.get(l.lineId).sku_id]);
  }else{
    // Stock in an open pick or on a packed box is never taken back.
    if((await c.query(`SELECT 1 FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('PICKING','PACKED') LIMIT 1`,[ctx.workspaceId,orderId])).rowCount)
      throw new ValidationError('Picking has started for '+order.order_number+'. Its stock stays with it.');
    for(const l of wanted){
      const row=(await c.query(`SELECT id,quantity FROM sales_order_allocations WHERE workspace_id=$1 AND sales_order_line_id=$2 AND location_id=$3
        AND to_jsonb(sales_order_allocations)->>'rotation_selection' IS NULL FOR UPDATE`,[ctx.workspaceId,l.lineId,l.locationId])).rows[0];
      if(!row||Number(row.quantity)<l.quantity)throw new ValidationError(order.order_number+' no longer has that stock set aside.');
      if(Number(row.quantity)===l.quantity)await c.query('DELETE FROM sales_order_allocations WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,row.id]);
      else await c.query('UPDATE sales_order_allocations SET quantity=quantity-$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,row.id,l.quantity,at]);
    }
  }
  const next=await status(c,ctx,orderId);
  const version=Number((await c.query('UPDATE sales_orders SET status=$3,updated_at=$4,version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING version',
    [ctx.workspaceId,orderId,next,at])).rows[0].version);
  await c.query(`INSERT INTO sales_order_events(id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
    [newId('soevt'),ctx.workspaceId,orderId,direction==='add'?'stock_set_aside':'stock_given_back',
      JSON.stringify({...detail,lines:wanted,status:next}),ctx.actorId,idempotencyKey+':event',at]);
  const result={salesOrderId:orderId,orderNumber:order.order_number,status:next,before:order.status,version,lines:wanted};
  // Stock newly set aside may let the owner's rules split the order or send its rest (job 61).
  if(direction==='add')await require('./agent-order-splits').queue(c,ctx,[orderId],idempotencyKey);
  await c.query(`UPDATE stockchief_runtime.business_operations SET status='COMPLETED',result=$2::jsonb,completed_at=now() WHERE id=$1`,
    [operation.id,JSON.stringify(result)]);
  return {...result,replayed:false};
}

const setAside=(c,ctx,orderId,input)=>change(c,ctx,orderId,{...input,direction:'add'});
const giveBack=(c,ctx,orderId,input)=>change(c,ctx,orderId,{...input,direction:'remove'});
module.exports={setAside,giveBack,status,OPEN};
