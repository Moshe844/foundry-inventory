'use strict';

const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const exact=require('../domain/exact-quantity');
const money=require('../domain/currency');
const table='stockchief_runtime.agent_direct_rules';
const scoped=c=>({query:(...args)=>c.query(...args),transaction:work=>work(c)});
const kind='agent.supplier_direct.orders.v1';

async function owner(c,ctx){
  const actor=await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)
    FOR SHARE OF u,w`,[ctx.workspaceId,ctx.actorId]);
  if(!actor.rowCount)throw new AuthorizationError('Only the current inventory owner can authorize routine supplier-direct purchases.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
}

function terms(facts){
  return {supplier:facts.supplier,products:facts.products.map(product=>({skuId:product.skuId,supplierItemId:product.supplierItemId,
    supplierSku:product.supplierSku,purchaseUnit:product.purchaseUnit,unitsPerPurchaseUnit:product.unitsPerPurchaseUnit,
    unitCost:product.unitCost,trackingMode:product.trackingMode,stockProfile:product.stockProfile,unit:product.unit,weightUnit:product.weightUnit}))};
}

async function rule(c,ctx,id,{lock=false}={}){
  const row=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That supplier-direct purchasing rule was not found.');
  return row;
}

async function active(c,ctx,row,state){
  await owner(c,ctx);
  state=state||await policy.requireWorkspaceJob(c,ctx.workspaceId,37,'automatic');
  const reason=await policy.stopped(c,ctx.workspaceId,state,'purchasing.supplier_direct',true);
  if(reason)throw new ValidationError(reason);
  if(!row.enabled||row.authorized_by!==ctx.actorId)throw new ValidationError('Routine supplier-direct purchasing is stopped or its approving owner changed.');
  const connector=(await c.query(`SELECT id,provider_account_id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2
    AND provider_type IN ('gmail','microsoft365') AND status='connected' AND paused_at IS NULL
    AND setup_status IS DISTINCT FROM 'REAUTHORIZATION_REQUIRED' FOR SHARE`,[ctx.workspaceId,row.connector_id])).rows[0];
  if(!connector||connector.provider_account_id!==row.mailbox_account)
    throw new ValidationError('Reconnect the originally authorized purchasing mailbox before automatic direct ordering.');
  const supplier=(await c.query("SELECT id,name,email,currency FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active' FOR SHARE",
    [ctx.workspaceId,row.supplier_id])).rows[0];
  if(!supplier||supplier.email!==row.source_terms.supplier.email||supplier.currency!==row.currency)
    throw new ValidationError('The supplier contact or purchase currency changed. Review the direct-purchasing rule.');
  return state;
}

async function configure(db,ctx,directId,input){
  return db.transaction(async c=>{
    await owner(c,ctx);
    const prior=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND reference_order_id=$2 FOR UPDATE`,
      [ctx.workspaceId,directId])).rows[0];
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('The direct-purchasing rule changed. Review its current settings.');
    if(input.stop==='yes'){
      if(prior)await c.query(`UPDATE ${table} SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,prior.id]);
      return {stopped:true};
    }
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,37,'automatic');
    const reason=await policy.stopped(c,ctx.workspaceId,state,'purchasing.supplier_direct',true);
    if(reason)throw new ValidationError(reason);
    const source=(await c.query(`SELECT * FROM stockchief_runtime.agent_direct_orders WHERE workspace_id=$1 AND id=$2 FOR SHARE`,
      [ctx.workspaceId,directId])).rows[0];
    if(!source||input.confirmed!=='yes'||input.sourceHash!==source.source_hash)
      throw new ValidationError('Review the exact supplier, products, current purchase terms and customer scope before enabling routine direct orders.');
    const maximum=money.userToMinor(input.maximum,source.facts.supplier.currency,{label:'Maximum supplier-direct order'});
    const cap=policy.purchaseLimits(state);
    if(!cap||cap.currency!==source.facts.supplier.currency||maximum<=0||maximum>money.toMinor(String(cap.perOrder),cap.currency))
      throw new ValidationError('Choose a positive purchase ceiling within your current plan’s agreed per-order currency and spending limit.');
    const connector=(await c.query(`SELECT id,provider_account_id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2
      AND provider_type IN ('gmail','microsoft365') AND status='connected' AND paused_at IS NULL
      AND setup_status IS DISTINCT FROM 'REAUTHORIZATION_REQUIRED' FOR SHARE`,[ctx.workspaceId,input.connectorId])).rows[0];
    if(!connector?.provider_account_id)throw new ValidationError('Choose a connected purchasing mailbox with a verified sending account.');
    const sourceTerms=terms(source.facts),skuIds=sourceTerms.products.map(product=>product.skuId);
    const customerId=input.allCustomers==='yes'?null:source.facts.customer.id;
    const conflict=await c.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND enabled AND sku_ids&&$2::text[]
      AND ($3::text IS NULL OR customer_id IS NULL OR customer_id=$3) AND id IS DISTINCT FROM $4 LIMIT 1`,
      [ctx.workspaceId,skuIds,customerId,prior?.id||null]);
    if(conflict.rowCount)throw new ValidationError('These products and customers already have an enabled direct-purchasing rule. Stop that rule before choosing another supplier.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    const id=prior?.id||newId('directrule');
    await require('../commercial/storage-capacity').reserve(scoped(c),ctx.workspaceId,'supplier-direct-rule:'+id,
      Buffer.byteLength(JSON.stringify(sourceTerms))+4096,{finished:true});
    await c.query(`INSERT INTO ${table}(workspace_id,id,reference_order_id,supplier_id,customer_id,sku_ids,source_terms,currency,
      maximum_minor,connector_id,mailbox_account,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(workspace_id,reference_order_id) DO UPDATE SET customer_id=$5,sku_ids=$6,source_terms=$7,currency=$8,
      maximum_minor=$9,connector_id=$10,mailbox_account=$11,authorized_by=$12,enabled=true,revision=agent_direct_rules.revision+1,
      next_check_at=NULL,last_issue=NULL`,[ctx.workspaceId,id,directId,source.facts.supplier.id,customerId,skuIds,JSON.stringify(sourceTerms),
      source.facts.supplier.currency,maximum,connector.id,connector.provider_account_id,ctx.actorId]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Routine supplier-direct purchases authorized',reference:id,
      after:{supplierId:source.facts.supplier.id,customerId,skuIds,maximumMinor:maximum,currency:source.facts.supplier.currency}});
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function assertPurchase(c,ctx,purchase,ruleId,state){
  const saved=await rule(c,ctx,ruleId,{lock:true});
  await active(c,ctx,saved,state);
  if(saved.customer_id&&saved.customer_id!==purchase.facts.customer.id||
    purchase.facts.products.some(product=>!saved.sku_ids.includes(product.skuId)))
    throw new ValidationError('This customer order is outside the authorized direct-purchasing scope.');
  const expected=saved.source_terms;
  const current=terms(purchase.facts);
  if(current.supplier.id!==expected.supplier.id||current.supplier.email!==expected.supplier.email||
    current.products.some(product=>hash(product)!==hash(expected.products.find(original=>original.skuId===product.skuId))))
    throw new ValidationError('The supplier product, price, unit or pack changed after this direct-purchasing rule was approved.');
  const total=await require('../operations/postgres-team-access').purchaseAmount(c,ctx.workspaceId,
    {id:purchase.purchase_order_id,currency:saved.currency});
  if(total>Number(saved.maximum_minor))throw new ValidationError('This customer purchase exceeds the supplier-direct rule’s purchase-value ceiling.');
  for(const product of purchase.facts.products){
    const reason=await policy.purchaseReview(c,ctx.workspaceId,{supplierId:saved.supplier_id,skuId:product.skuId,
      currency:saved.currency,value:Number(money.fromMinor(total,saved.currency)),unitCost:product.unitCost,
      unitsPerPurchaseUnit:product.unitsPerPurchaseUnit},{itemScope:saved.sku_ids},state,purchase.purchase_order_id);
    if(reason)throw new ValidationError(reason);
  }
  return saved;
}

async function recordPurchase(c,ctx,purchase,ruleId){
  const at=new Date().toISOString(),id=newId('work');
  await c.query(`INSERT INTO work_items(id,workspace_id,category,source,source_evidence,affected_entities,recommended_action,
    priority,confidence,approval_requirement,execution_status,verification_status,idempotency_key,purchase_order_id,outcome,created_at,completed_at)
    VALUES($1,$2,'supplier_direct','postgres_autopilot',$3,$4,$5,30,'high','NONE','COMPLETED','VERIFIED',$6,$7,$8,$9,$9)`,
    [id,ctx.workspaceId,JSON.stringify([{directOrderId:purchase.id,ruleId}]),JSON.stringify({salesOrderId:purchase.sales_order_id}),
      JSON.stringify({kind:'supplier_direct',supplierId:purchase.facts.supplier.id}),
      'supplier-direct-purchase:'+purchase.id,purchase.purchase_order_id,
      JSON.stringify({directOrderId:purchase.id,purchaseOrderId:purchase.purchase_order_id,approvedAutomatically:true}),at]);
}

async function executeOrder(db,workspaceId,ruleId,orderId){
  return db.transaction(async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('account-purchase:'||owner_account_id,0)) FROM workspaces WHERE id=$1",[workspaceId]);
    await require('./postgres-purchase-exposure').lock(c,workspaceId);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['supplier-direct:'+workspaceId]);
    const saved=await rule(c,{workspaceId},ruleId,{lock:true});
    const ctx={workspaceId,actorId:saved.authorized_by};
    await active(c,ctx,saved);
    const order=(await c.query(`SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2
      AND status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED') FOR UPDATE`,[workspaceId,orderId])).rows[0];
    if(!order||saved.customer_id&&saved.customer_id!==order.customer_id)return {skipped:true};
    const open=(await c.query(`SELECT l.* FROM sales_order_lines l WHERE l.workspace_id=$1 AND l.sales_order_id=$2
      AND l.sku_id=ANY($3::text[]) AND l.quantity_ordered>l.quantity_fulfilled+l.direct_committed_quantity
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_direct_order_lines x
        JOIN stockchief_runtime.agent_direct_orders d ON d.workspace_id=x.workspace_id AND d.id=x.direct_order_id
        JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
        WHERE x.workspace_id=l.workspace_id AND x.sales_order_line_id=l.id AND
          (p.status IN ('DRAFT','AWAITING_APPROVAL') OR d.stopped_at IS NOT NULL))
      ORDER BY l.created_at,l.id LIMIT 101 FOR UPDATE OF l`,[workspaceId,orderId,saved.sku_ids])).rows;
    if(!open.length)return {skipped:true};
    if(open.length>100)throw new ValidationError('This customer order needs individual review of its more than 100 direct supplier lines.');
    const workflow=require('./agent-direct-shipments');
    const selection=open.map(line=>({lineId:line.id,quantity:exact.subtract(exact.subtract(line.quantity_ordered,line.quantity_fulfilled),line.direct_committed_quantity),
      secondaryQuantity:line.secondary_quantity_ordered==null?null:exact.subtract(
        exact.subtract(line.secondary_quantity_ordered,line.secondary_quantity_fulfilled),line.direct_committed_secondary_quantity)}));
    const requestKey='routine:'+saved.id+':'+hash([orderId,selection]);
    const prepared=await workflow.prepare(scoped(c),ctx,{salesOrderId:orderId,supplierId:saved.supplier_id,requestKey,confirmed:'yes',lines:selection});
    const approved=await workflow.approve(scoped(c),ctx,prepared.id,{confirmed:'yes',revision:prepared.revision,sourceHash:prepared.source_hash,
      routine:'yes',releaseReserved:'yes'},{automatic:true,ruleId});
    const sent=await require('./direct-shipment-mail').send(scoped(c),ctx,prepared.id,{revision:approved.revision,
      sourceHash:approved.source_hash,connectorId:saved.connector_id},{automatic:true});
    return {directOrderId:prepared.id,purchaseOrderId:prepared.purchase_order_id,effectId:sent.effectId};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function process(job,db){
  const saved=await rule(db,{workspaceId:job.workspaceId},job.payload.ruleId);
  const orders=(await db.query(`SELECT o.id,o.created_at FROM sales_orders o WHERE o.workspace_id=$1
    AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED') AND o.delivery_method='SHIP'
    AND ($2::text IS NULL OR o.customer_id=$2) AND EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id
      AND l.sales_order_id=o.id AND l.sku_id=ANY($3::text[]) AND l.quantity_ordered>l.quantity_fulfilled+l.direct_committed_quantity
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_direct_order_lines x
        JOIN stockchief_runtime.agent_direct_orders d ON d.workspace_id=x.workspace_id AND d.id=x.direct_order_id
        JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
        WHERE x.workspace_id=l.workspace_id AND x.sales_order_line_id=l.id AND
          (p.status IN ('DRAFT','AWAITING_APPROVAL') OR d.stopped_at IS NOT NULL)))
    AND ($4::text IS NULL OR o.id=$4) AND ($4::text IS NOT NULL OR $5::text IS NULL OR (o.created_at,o.id)>($5,$6))
    ORDER BY o.created_at,o.id LIMIT 20`,[job.workspaceId,saved.customer_id,saved.sku_ids,job.payload.orderId||null,
      saved.last_order_at,saved.last_order_id])).rows;
  const results=[],held=[];
  for(const order of orders){
    try{results.push(await executeOrder(db,job.workspaceId,saved.id,order.id));}
    catch(error){if(![400,402,403,404,422].includes(error.status))throw error;held.push(error.message);}
  }
  await db.query(`UPDATE ${table} SET next_check_at=clock_timestamp()+interval '15 minutes',last_issue=$3
    WHERE workspace_id=$1 AND id=$2`,[job.workspaceId,saved.id,held.length?[...new Set(held)].join(' ').slice(0,2000):null]);
  if(!job.payload.orderId){
    const last=orders.at(-1);
    await db.query(`UPDATE ${table} SET last_order_at=$3,last_order_id=$4 WHERE workspace_id=$1 AND id=$2`,
      [job.workspaceId,saved.id,last?.created_at||null,last?.id||null]);
  }
  return {orders:results.filter(result=>!result.skipped),held:held.length};
}

async function queueForOrder(c,workspaceId,orderId){
  const matches=(await c.query(`SELECT DISTINCT r.id,r.revision,o.version FROM ${table} r
    JOIN sales_orders o ON o.workspace_id=r.workspace_id AND (r.customer_id IS NULL OR r.customer_id=o.customer_id)
    JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND l.sku_id=ANY(r.sku_ids)
    WHERE r.workspace_id=$1 AND r.enabled AND o.id=$2 AND o.delivery_method='SHIP'
      AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
    AND l.quantity_ordered>l.quantity_fulfilled+l.direct_committed_quantity
    AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_direct_order_lines x
      JOIN stockchief_runtime.agent_direct_orders d ON d.workspace_id=x.workspace_id AND d.id=x.direct_order_id
      WHERE x.workspace_id=l.workspace_id AND x.sales_order_line_id=l.id AND d.stopped_at IS NOT NULL)
    ORDER BY r.id LIMIT 100`,[workspaceId,orderId])).rows;
  for(const saved of matches)await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId,kind,
    idempotencyKey:'supplier-direct-source:'+orderId+':'+saved.version+':'+saved.id+':'+saved.revision,
    payload:{ruleId:saved.id,orderId},priority:30,maxAttempts:3});
  return {queued:matches.length};
}

async function schedule(db,workspaceId){
  const installed=(await db.query("SELECT to_regclass('stockchief_runtime.agent_direct_rules') IS NOT NULL AS installed")).rows[0];
  if(!installed?.installed)return {queued:0};
  const rows=(await db.query(`SELECT id,revision FROM ${table} WHERE workspace_id=$1 AND enabled
    AND (next_check_at IS NULL OR next_check_at<=now()) ORDER BY next_check_at NULLS FIRST,id LIMIT 5`,[workspaceId])).rows;
  for(const row of rows)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind,
    idempotencyKey:'supplier-direct-rule:'+row.id+':'+row.revision+':'+Math.floor(Date.now()/900000),payload:{ruleId:row.id},priority:30,maxAttempts:3});
  return {queued:rows.length};
}

module.exports={configure,rule,active,assertPurchase,recordPurchase,executeOrder,process,schedule,queueForOrder,kind};
