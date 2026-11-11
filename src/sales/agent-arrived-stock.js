'use strict';

const { ValidationError, AuthorizationError } = require('../domain/errors');
const policy = require('../commercial/agent-plan');
const { hash } = require('../pricing/postgres-promotions');
const { plan } = require('./arrived-stock-plan');
const native = require('./postgres-arrived-stock-reservations');
const action = 'sales_order.reserve_arrived';
const job = 48;
const arrivalKind = 'sales_order.route-receipt.v1';

async function owner(db, ctx, lock = false) {
  const grant = (await db.query(`SELECT w.owner_account_id FROM workspaces w
    JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id AND u.role='owner'
    WHERE w.id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL AND NOT EXISTS(
      SELECT 1 FROM platform_account_access x WHERE x.account_id=w.owner_account_id AND x.disabled_at IS NOT NULL)
    ${lock ? 'FOR SHARE OF w,u' : ''}`, [ctx.workspaceId, ctx.actorId])).rows[0];
  if (!grant) throw new AuthorizationError('Only the current inventory owner can route stock receipts to backorders.');
  if (lock) {
    await db.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE', [grant.owner_account_id]);
    await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE', [ctx.workspaceId]);
  }
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db, ctx);
}

async function inspect(db, ctx, id, { lock = false } = {}) {
  const current = await plan(db, ctx, id, { lock });
  const { order, lines, components, quantities, pools, amountMinor } = current;
  const scopeLocations = [...new Set(quantities.map(q => q.locationId))].sort();
  const goods = [...lines, ...components].map(l => [l.sku_id, l.tracking_mode, l.unit_label, l.quantity_increment, l.secondary_unit_label,
    l.unit_price_minor ?? null, l.quantity_per_kit ?? null]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const simple = order.fulfillment_location_id && !components.length && lines.every(l =>
    l.tracking_mode === 'quantity' && Number(l.quantity_precision) === 0 && !l.secondary_unit_label);
  const qualification = simple ? ['arrived-stock', order.fulfillment_location_id, order.delivery_method, order.ship_to_address,
    ...lines.map(l => l.sku_id).sort()] : ['arrived-stock', order.fulfillment_location_id, scopeLocations, order.delivery_method, order.ship_to_address, goods];
  const training = require('../autopilot/draft-authority').scope(order.customer_id, order.currency, amountMinor, qualification,
    order.customer_name + ' · reserve arrived stock at ' + [...new Set(quantities.map(q => q.location))].join(', '));
  const fingerprint = hash({ version: Number(order.version), status: order.status, customer: order.customer_id, currency: order.currency,
    dispatch: order.fulfillment_location_id, delivery: order.delivery_method, address: order.ship_to_address, priority: order.allocation_priority,
    neededBy: order.needed_by, lines, quantities, pools, shortage: current.shortage, training });
  return { ...current, fingerprint, training };
}

function describe(choice) {
  const identities = choice.selection.filter(s => s.arrivals?.length).map(s => s.serial ? 'Serial ' + s.serial : s.lotCode ? 'Batch ' + s.lotCode : null).filter(Boolean);
  const receipts = [...new Set(choice.arrivals.map(a => a.reference || a.movementId))];
  return choice.quantity + ' ' + choice.unit + ' of ' + choice.code + ' at ' + choice.location
    + (choice.secondaryQuantity ? ' · ' + choice.secondaryQuantity + ' ' + choice.secondaryUnit : '')
    + (identities.length ? ' · ' + identities.join(', ') : '') + ' · Receipt ' + receipts.join(', ');
}

async function build(db, ctx, row) {
  await policy.requireWorkspaceJob(db, ctx.workspaceId, job, 'draft');
  await owner(db, ctx);
  const p = await inspect(db, ctx, row.id);
  const quantities = p.quantities.map(({ selection, previousId, previousQuantity, componentRequirements, ...q }) =>
    ({ ...q, detail: describe({ ...q, selection }) }));
  return { payload: { recordId: row.id, orderNumber: p.order.order_number, customerName: p.order.customer_name,
    locationName: [...new Set(quantities.map(q => q.location))].join(', '), fingerprint: p.fingerprint, quantities, training: p.training },
    summary: 'Set aside posted receipts for ' + p.order.order_number + '.\n' + quantities.map(q => q.detail).join('\n') +
      '\nPhysical picking and handoff require separate confirmation.' };
}

async function execute(db, ctx, p) {
  await owner(db, ctx, true);
  const account = await policy.requireWorkspaceJob(db, ctx.workspaceId, job, 'draft');
  const automatic = ctx.agentArrivedStockScope === 'automatic';
  const stop = await policy.stopped(db, ctx.workspaceId, account, action, automatic);
  if (stop) throw new ValidationError(stop);
  if (automatic) await requireRoutineAuthority(db, ctx);
  const current = await inspect(db, ctx, p.recordId, { lock: true });
  if (current.fingerprint !== p.fingerprint) throw new ValidationError('This backorder, receipt evidence, availability or priority changed. Review a fresh reservation.');
  if (automatic) {
    const rule = (await db.query(`SELECT maximum_minor,authorized_by FROM stockchief_runtime.agent_draft_rules
      WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND currency=$4 FOR SHARE`,
      [ctx.workspaceId, action, current.training.key, current.training.currency])).rows[0];
    if (account.plan === 'growth' && (!rule || rule.authorized_by !== ctx.actorId))
      throw new ValidationError('Teach an individually completed reservation for this customer, warehouse and product scope.');
    if (rule && Number(rule.maximum_minor) < current.training.amountMinor)
      throw new ValidationError('This reservation exceeds the saved owner limit. Review it individually.');
    if (rule && rule.authorized_by !== ctx.actorId)
      throw new ValidationError('The current owner must confirm this receipt reservation limit.');
  }
  const result = await require('../operations/postgres-business-workflows').confirmSalesOrderInTransaction(db, ctx, p.recordId,
    native.confirmationInput(p.idempotencyKey, current));
  if (!result.receiptReservations?.length || result.receiptReservations.length !== current.quantities.length) {
    throw new ValidationError('The recorded reservation differs from the reviewed arrived stock.');
  }
  return { ...result, automatic };
}
async function requireRoutineAuthority(db,ctx){
 await owner(db,ctx,true);
 await policy.requireWorkspaceJob(db,ctx.workspaceId,job,'automatic',{trained:true});
 const grant=(await db.query(`SELECT m.revision FROM stockchief_runtime.agent_job_modes m JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
  JOIN accounts a ON a.id=u.account_id JOIN workspace_autopilot w ON w.workspace_id=m.workspace_id WHERE m.workspace_id=$1 AND m.job_id=48 AND m.mode='routine' AND u.id=$2
  AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL) FOR SHARE OF m,u,w`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!grant||!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)throw new ValidationError('The owner must enable arrived-stock reservations and automatic work first.');
 return {kind:'standing_job_rule',job,ownerId:ctx.actorId,modeRevision:Number(grant.revision)};
}
async function routineGrant(db,workspaceId){
 return (await db.query(`SELECT m.updated_by FROM stockchief_runtime.agent_job_modes m JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
  JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE m.workspace_id=$1 AND m.job_id=48 AND m.mode='routine'
  AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=w.owner_account_id AND x.disabled_at IS NOT NULL)`,[workspaceId])).rows[0];
}
async function queueArrivals(c,ctx,movements){
 const arrivals=movements.filter(m=>m.operation==='receive'||m.operation==='transfer'&&m.leg==='in');
 if(!arrivals.length||!await routineGrant(c,ctx.workspaceId))return;
 const state=await policy.accountState(c,ctx.workspaceId);
 if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,job,'automatic',{trained:true})||
    !(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)return;
 const positions=[...new Map(arrivals.map(m=>[JSON.stringify([m.sku_id,m.location_id]),{sku_id:m.sku_id,location_id:m.location_id}])).values()];
 const eligible=(await c.query(`WITH requested AS (SELECT * FROM jsonb_to_recordset($2::jsonb) x(sku_id text,location_id text))
   SELECT DISTINCT r.sku_id,r.location_id FROM requested r JOIN sales_order_lines l ON l.workspace_id=$1
    AND (l.sku_id=r.sku_id OR EXISTS(SELECT 1 FROM sales_order_kit_components k
      WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id AND k.component_sku_id=r.sku_id))
   JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
   WHERE o.status IN('BACKORDERED','PARTIALLY_FULFILLED') AND o.confirmed_at IS NOT NULL
    AND (o.fulfillment_location_id IS NULL OR o.fulfillment_location_id=r.location_id)
    AND l.quantity_ordered>l.quantity_fulfilled`,[ctx.workspaceId,JSON.stringify(positions)])).rows;
 if(!eligible.length)return;
 const receiptKey=hash(arrivals.map(m=>m.id).sort());
 await enqueueArrival({query:(...args)=>c.query(...args),transaction:fn=>fn(c)},ctx.workspaceId,{receiptKey,positions:eligible,batch:0});
}
async function enqueueArrival(db,workspaceId,payload){
 return require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:arrivalKind,
   idempotencyKey:payload.receiptKey+':'+payload.batch,payload,priority:70});
}
async function onArrival(db,jobRow){
 const { positions, batch }=jobRow.payload;
 if(!Array.isArray(positions)||!positions.length||!Number.isSafeInteger(batch)||batch<0)throw new ValidationError('A receipt routing job needs posted stock positions.');
 const result=await run(db,jobRow.workspaceId,{positions});
 if(result.reserved+result.held===20)await enqueueArrival(db,jobRow.workspaceId,{...jobRow.payload,batch:batch+1});
 return result;
}
async function run(db,workspaceId,{positions=null}={}){
 const result={reserved:0,held:0},grant=await routineGrant(db,workspaceId);
 const state=await policy.accountState(db,workspaceId);
 if(!grant||!policy.usesAgentTerms(state)||!policy.permits(state.plan,job,'automatic',{trained:true})||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return result;
 const ctx={workspaceId,actorId:grant.updated_by},candidates=(await db.query(`SELECT o.id FROM sales_orders o LEFT JOIN stockchief_runtime.agent_arrived_stock_checks checked ON checked.workspace_id=o.workspace_id AND checked.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.status IN('BACKORDERED','PARTIALLY_FULFILLED') AND o.confirmed_at IS NOT NULL
  AND EXISTS(SELECT 1 FROM (
   SELECT l.sku_id FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
    AND l.quantity_ordered-l.quantity_fulfilled-coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)>coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0)
   UNION ALL SELECT k.component_sku_id FROM sales_order_kit_components k JOIN sales_order_lines l ON l.workspace_id=k.workspace_id AND l.id=k.sales_order_line_id
    WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND k.quantity_required-k.quantity_fulfilled>
      coalesce((SELECT sum(a.quantity) FROM sales_order_kit_allocations a WHERE a.workspace_id=k.workspace_id AND a.kit_component_id=k.id),0)
  ) demand JOIN balances b ON b.workspace_id=o.workspace_id AND b.sku_id=demand.sku_id
  JOIN locations location ON location.workspace_id=b.workspace_id AND location.id=b.location_id
   WHERE b.on_hand>0 AND (o.fulfillment_location_id IS NULL OR b.location_id=o.fulfillment_location_id)
    AND location.is_active=1 AND location.custody_agreement_id IS NULL
    AND ($2::jsonb IS NULL OR EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) x(sku_id text,location_id text)
      WHERE x.sku_id=b.sku_id AND x.location_id=b.location_id))
   AND (checked.retry_after IS NULL OR checked.retry_after<=now() OR b.updated_at::timestamptz>checked.checked_at OR o.updated_at::timestamptz>checked.checked_at))
  ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT 20`,[workspaceId,positions&&JSON.stringify(positions)])).rows;
 for(const candidate of candidates){
  const reserved=await db.transaction(async c=>{
   const scoped={query:(...args)=>c.query(...args),transaction:fn=>fn(c)};
   await c.query('SAVEPOINT arrived_stock');
   try{
    const prepared=await build(c,ctx,candidate);
    const assistant=require('../assistant/postgres-service'),proposal=await assistant.createProposal(scoped,{...ctx,planStepKey:'arrived-stock:'+candidate.id+':'+prepared.payload.fingerprint},'Reserve arrived stock for this confirmed backorder',action,prepared.payload,prepared.summary);
    const done=await assistant.executeArrivedStockRoutine(scoped,ctx,proposal.proposal.id);await c.query('RELEASE SAVEPOINT arrived_stock');await checked(c,candidate.id,null);return !done.replayed;
   }catch(error){if(!['validation_error','entitlement_required','forbidden'].includes(error.code))throw error;await c.query('ROLLBACK TO SAVEPOINT arrived_stock');await c.query('RELEASE SAVEPOINT arrived_stock');await checked(c,candidate.id,error.message);return false;}
   async function checked(c,id,problem){await c.query(`INSERT INTO stockchief_runtime.agent_arrived_stock_checks(workspace_id,sales_order_id,checked_at,retry_after,problem) VALUES($1,$2,clock_timestamp(),clock_timestamp()+interval '15 minutes',$3)
    ON CONFLICT(workspace_id,sales_order_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,retry_after=EXCLUDED.retry_after,problem=EXCLUDED.problem`,[workspaceId,id,problem]);}
  },{isolation:'SERIALIZABLE',retrySafe:true});result[reserved?'reserved':'held']++;
 }
 return result;
}
async function review(db,ctx,{page=1,filter=''}){
 const rows=(await db.query(`SELECT o.order_number "Order",c.name "Customer",l.name "Dispatch from",coalesce(checked.problem,'Waiting for available stock') "Last check",'/sales/orders/'||o.id link
  FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id LEFT JOIN locations l ON l.workspace_id=o.workspace_id AND l.id=o.fulfillment_location_id
  LEFT JOIN stockchief_runtime.agent_arrived_stock_checks checked ON checked.workspace_id=o.workspace_id AND checked.sales_order_id=o.id
  WHERE o.workspace_id=$1 AND o.status IN('BACKORDERED','PARTIALLY_FULFILLED') AND ($2='' OR lower(o.order_number)=lower($2) OR lower(c.name)=lower($2))
  ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const state=await policy.accountState(db,ctx.workspaceId),blocked=await policy.stopped(db,ctx.workspaceId,state,action,false);
 return {summary:'Sets aside posted receipts for already confirmed backorders in priority order, at the confirmed warehouse or across eligible warehouses when the order permits it. Review exact batches, serials, and actual weights. Growth needs an individually completed example for the customer, products, warehouses and value. Pro and Custom follow current owner authority and saved limits. Warehouse staff confirm physical picking and dispatch separately.',rows:rows.slice(0,100),more:rows.length>100,arrivedStockForm:{blocked}};
}
const spec={name:action,description:'Reserve posted, costed receipts for an already confirmed waiting order, respecting priority and eligible dispatch warehouses. Keep recorded prices and delivery details. Staff separately receive, pick and dispatch physical goods.',
 record:'sales_order',fields:['recordReference'],permission:require('../actions/permissions').MANAGE_SALES,capability:'sales_orders.core',ownerOnly:true,build,execute,resultingRecords:['sales_order_allocations','sales_order_kit_allocations','sales_order_events'],
 verify:async(db,ctx,r,p)=>Boolean(r.salesOrderId===p.recordId&&r.receiptReservations?.length&&(await db.query(`SELECT 1 FROM stockchief_runtime.business_operations op
  JOIN sales_order_events e ON e.workspace_id=op.workspace_id AND e.idempotency_key=op.idempotency_key||':event' AND e.event_type='confirmed'
  JOIN sales_orders o ON o.workspace_id=e.workspace_id AND o.id=e.sales_order_id AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
  WHERE op.workspace_id=$1 AND op.idempotency_key=$2 AND op.kind='sales_order.confirm' AND op.status='COMPLETED'
   AND o.id=$3 AND op.result->>'salesOrderId'=o.id AND op.result->'receiptReservations'=$4::jsonb AND e.detail::jsonb->'receiptReservations'=$4::jsonb
   AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) x("allocationId" text,kind text,selection jsonb)
     WHERE CASE x.kind WHEN 'kit' THEN NOT EXISTS(SELECT 1 FROM sales_order_kit_allocations a WHERE a.workspace_id=op.workspace_id AND a.id=x."allocationId" AND a.rotation_selection=x.selection)
       ELSE NOT EXISTS(SELECT 1 FROM sales_order_allocations a WHERE a.workspace_id=op.workspace_id AND a.id=x."allocationId" AND a.rotation_selection=x.selection) END)`,
   [ctx.workspaceId,p.idempotencyKey,p.recordId,JSON.stringify(r.receiptReservations)])).rows.length)};
module.exports={spec,inspect,build,execute,run,queueArrivals,onArrival,requireRoutineAuthority,definition:{id:48,key:'arrived-stock',label:'Reserve arrived stock for waiting orders',filterLabel:'Order number or customer',readPage:review}};
