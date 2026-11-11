'use strict';

const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const budgets=require('./agent-budgets');
const allocation=require('./open-to-buy-allocation');
const exposure=require('./postgres-purchase-exposure');
const storage=require('../commercial/storage-capacity');
const time=require('../lib/business-time');
const {addDays}=require('../accounting/customer-money');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');

const path='/autopilot/open-to-buy',kind='planning.open-to-buy.v1',action='planning.open_to_buy';
const rules='stockchief_runtime.agent_open_to_buy_rules',plans='stockchief_runtime.agent_open_to_buy_plans',
  drafts='stockchief_runtime.agent_open_to_buy_drafts';
const transaction=(db,work)=>db.transaction(work,{isolation:'SERIALIZABLE',retrySafe:true});

async function owner(c,ctx,lock=false){
  const row=(await c.query(`SELECT w.owner_account_id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF w,u':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the current inventory owner can manage the monthly buying plan.');
  if(lock)await c.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[row.owner_account_id]);
  return row.owner_account_id;
}

async function authority(c,ctx,{automatic=false,lock=false,readOnly=false}={}){
  await owner(c,ctx,lock);
  const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,26,automatic?'automatic':'draft');
  await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'purchasing.core');
  if(readOnly)return account;
  if(lock)await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR NO KEY UPDATE',[ctx.workspaceId]);
  const stop=await policy.stopped(c,ctx.workspaceId,account,action,automatic);
  if(stop)throw new ValidationError(stop);
  if(automatic&&!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)
    throw new ValidationError('Enable routine work before scheduling monthly purchase plans.');
  return account;
}

async function configure(db,ctx,input){
  return transaction(db,async c=>{
    await exposure.lock(c,ctx.workspaceId,{budgetFence:true});
    await owner(c,ctx,true);
    const current=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if((current?.revision||'')!==(input.revision||''))throw new ValidationError('Open the current monthly planning setting before changing it.');
    if(input.stop==='yes'){
      if(current?.enabled)await c.query(`UPDATE ${rules} SET enabled=false,revision=$2 WHERE workspace_id=$1`,[ctx.workspaceId,newId('otb-rule')]);
      return {stopped:true};
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm routine planning for the exact months with saved budgets.');
    await authority(c,ctx,{automatic:true,lock:true});
    if(!current?.enabled)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    if(!current)await storage.reserve(c,ctx.workspaceId,'open-to-buy-rule',8192,{finished:true});
    await c.query(`INSERT INTO ${rules}(workspace_id,authorized_by,revision,enabled) VALUES($1,$2,$3,true)
      ON CONFLICT(workspace_id) DO UPDATE SET authorized_by=$2,revision=$3,enabled=true`,[ctx.workspaceId,ctx.actorId,newId('otb-rule')]);
    return {enabled:true};
  });
}

async function savePlan(c,ctx,snapshot,automatic){
  const fingerprint=hash(snapshot),monthStart=budgets.period(snapshot.month).start;
  const existing=(await c.query(`SELECT id FROM ${plans} WHERE workspace_id=$1 AND month_start=$2 AND evidence_hash=$3`,
    [ctx.workspaceId,monthStart,fingerprint])).rows[0];
  if(existing)return {id:existing.id,replayed:true};
  const id=newId('open-to-buy');
  await storage.reserve(c,ctx.workspaceId,'open-to-buy-plan:'+id,8192+Buffer.byteLength(JSON.stringify(snapshot)),{finished:true});
  await c.query(`INSERT INTO ${plans}(id,workspace_id,actor_id,month_start,evidence_hash,snapshot,automatic)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,ctx.workspaceId,ctx.actorId,monthStart,fingerprint,snapshot,automatic]);
  return {id,replayed:false};
}

async function prepare(db,ctx,input){
  return transaction(db,async c=>{
    await exposure.lock(c,ctx.workspaceId,{budgetFence:true});
    await authority(c,ctx,{lock:true});
    return savePlan(c,ctx,await allocation.plan(c,ctx,input),false);
  });
}

async function enqueue(db,workspaceId,cycleId){
  const setting=(await db.query(`SELECT authorized_by,revision FROM ${rules} WHERE workspace_id=$1 AND enabled`,[workspaceId])).rows[0];
  if(!setting?.authorized_by)return;
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,26,'automatic')||state.shadow||
    await policy.stopped(db,workspaceId,state,action,true)||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return;
  const month=(await time.today(db,workspaceId)).slice(0,7);
  const {rows}=await db.query(`SELECT DISTINCT to_char(month_start,'YYYY-MM') AS budget_month FROM stockchief_runtime.purchase_budgets
    WHERE workspace_id=$1 AND month_start>=$2::date ORDER BY budget_month`,[workspaceId,month+'-01']);
  for(const r of rows)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind,
    idempotencyKey:'open-to-buy:'+setting.revision+':'+r.budget_month+':'+cycleId,
    payload:{month:r.budget_month,actorId:setting.authorized_by,revision:setting.revision},priority:64,maxAttempts:3});
}

async function run(job,c){
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId};
  await exposure.lock(c,ctx.workspaceId,{budgetFence:true});
  try{
    await authority(c,ctx,{automatic:true,lock:true});
    const setting=await c.query(`SELECT 1 FROM ${rules} WHERE workspace_id=$1 AND authorized_by=$2 AND revision=$3 AND enabled FOR SHARE`,
      [ctx.workspaceId,ctx.actorId,job.payload.revision]);
    if(!setting.rowCount)return {held:'The owner’s recurring planning scope changed.'};
    return savePlan(c,ctx,await allocation.plan(c,ctx,{month:job.payload.month}),true);
  }catch(error){
    if(error instanceof ValidationError||error instanceof AuthorizationError||error.code==='entitlement_required')return {held:error.message};
    throw error;
  }
}

async function load(c,ctx,id,lock=false){
  const row=(await c.query(`SELECT id,month_start::text,actor_id,evidence_hash,snapshot,automatic,status,created_at,drafted_by,drafted_at
    FROM ${plans} WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('This monthly buying plan is unavailable in this inventory.');
  return row;
}

async function nativeLines(c,workspaceId,id){
  return (await c.query(`SELECT sku_id,supplier_item_id,supplier_sku,destination_location_id,purchase_unit,units_per_purchase_unit,
    quantity_purchase_units,quantity_units,secondary_quantity_ordered,unit_cost,line_total
    FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY line_number`,[workspaceId,id])).rows;
}
function nativeFingerprint(order,lines){
  return hash([order.supplier_id,order.currency,order.order_date,order.expected_date,order.destination_location_id,
    lines.map(l=>[l.sku_id,l.supplier_item_id,l.supplier_sku,l.destination_location_id,l.purchase_unit,
      exact.canonical(l.units_per_purchase_unit),exact.canonical(l.quantity_purchase_units),exact.canonical(l.quantity_units),
      l.secondary_quantity_ordered==null?null:exact.canonical(l.secondary_quantity_ordered),l.unit_cost==null?null:money.toMinor(String(l.unit_cost),order.currency),
      l.line_total==null?null:money.toMinor(String(l.line_total),order.currency)])]);
}

async function prepareDrafts(db,ctx,id,input){
  return transaction(db,async c=>{
    await exposure.lock(c,ctx.workspaceId,{budgetFence:true});
    await authority(c,ctx,{lock:true});
    const saved=await load(c,ctx,id,true);
    if(saved.evidence_hash!==input.evidence||input.confirmed!=='yes')throw new ValidationError('Confirm the exact monthly plan and its supplier terms first.');
    if(saved.status==='DRAFTED')return {replayed:true};
    const current=await allocation.plan(c,ctx,{month:saved.snapshot.month,...saved.snapshot.request});
    if(hash(current)!==saved.evidence_hash)throw new ValidationError('Budget, stock, incoming supply or supplier terms changed. Prepare a fresh monthly plan.');
    if(!current.groups.length)throw new ValidationError('This plan has no purchase groups that fit the recorded budgets and terms.');
    await storage.reserve(c,ctx.workspaceId,'open-to-buy-drafts:'+id,8192+Buffer.byteLength(JSON.stringify(current.groups))*3,{finished:true});
    const native=require('../operations/postgres-business-workflows');
    for(const [index,group] of current.groups.entries()){
      const locations=[...new Set(group.lines.map(l=>l.destinationLocationId))];
      const order=await native.createPurchaseOrderInTransaction(c,ctx,{...group,destinationLocationId:locations.length===1?locations[0]:null,
        source:'foundry_recommendation',sourceDetail:{kind:'monthly_open_to_buy',planId:id,month:current.month,goodsMinor:group.totalMinor},
        idempotencyKey:'open-to-buy:'+id+':'+index});
      const po=(await c.query('SELECT * FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,order.purchaseOrderId])).rows[0];
      const lines=await nativeLines(c,ctx.workspaceId,po.id);
      if(po.status!=='DRAFT'||lines.length!==group.lines.length||lines.some((line,i)=>line.supplier_item_id!==group.lines[i].offerId)||
        money.sum(lines.map(l=>money.toMinor(String(l.line_total),po.currency)))!==group.totalMinor)
        throw new ValidationError('The native purchase draft no longer matches the reviewed budget and supplier packs.');
      await c.query(`INSERT INTO ${drafts}(workspace_id,plan_id,purchase_order_id,month_start,group_number,order_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6)`,[ctx.workspaceId,id,po.id,saved.month_start,index,nativeFingerprint(po,lines)]);
    }
    await c.query(`UPDATE ${plans} SET status='DRAFTED',drafted_by=$3,drafted_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId]);
    return {replayed:false};
  });
}

async function assertApproval(c,ctx,order){
  if(order.status==='APPROVED')return;
  let detail;
  try{detail=typeof order.source_detail==='string'?JSON.parse(order.source_detail):order.source_detail;}catch{}
  if(detail?.kind!=='monthly_open_to_buy')return;
  const link=(await c.query(`SELECT plan_id,month_start::text,group_number,order_fingerprint FROM ${drafts}
    WHERE workspace_id=$1 AND purchase_order_id=$2`,[ctx.workspaceId,order.id])).rows[0];
  if(!link)throw new ValidationError('Open the verified monthly plan before approving this purchase.');
  const saved=await load(c,ctx,link.plan_id),group=saved.snapshot.groups[link.group_number],lines=await nativeLines(c,ctx.workspaceId,order.id);
  await authority(c,{...ctx,actorId:saved.drafted_by},{lock:true});
  if(group?.lines.some(line=>!line.knownTerms)&&ctx.actorId!==saved.drafted_by)
    throw new AuthorizationError('The inventory owner must approve new supplier or price terms.');
  if(!group||nativeFingerprint(order,lines)!==link.order_fingerprint)
    throw new ValidationError('The budgeted purchase draft changed. Cancel it and prepare a new monthly plan before approving.');
  const today=await time.today(c,ctx.workspaceId);
  if(today<group.orderDate)throw new ValidationError('This purchase is planned for '+group.orderDate+'. Review the delivery month before ordering early.');
  if(group.lines.some(line=>addDays(today,line.leadDays)>group.expectedDate))
    throw new ValidationError('The planned delivery date is stale. Refresh the monthly plan before approving this purchase.');
  const offerIds=group.lines.map(line=>line.offerId),{rows:offers}=await c.query(`SELECT si.*,v.currency,v.minimum_order_amount,v.payment_terms,
    v.freight_terms_currency,v.free_freight_threshold_minor,v.ordinary_freight_minor,v.default_lead_time_days,
    l.effective_lead,l.samples,lower(trim(coalesce(f.category,''))) category
    FROM supplier_items si JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id AND v.status='active'
    JOIN skus s ON s.workspace_id=si.workspace_id AND s.id=si.sku_id AND s.is_active=1
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    LEFT JOIN catalogue_item_facts f ON f.workspace_id=i.workspace_id AND f.item_id=i.id
    LEFT JOIN stockchief_runtime.supplier_planning_leads l ON l.workspace_id=si.workspace_id AND l.supplier_item_id=si.id
    WHERE si.workspace_id=$1 AND si.id=ANY($2::text[]) AND si.is_active=1 FOR SHARE OF si,v,s,i`,[ctx.workspaceId,offerIds]);
  const byOffer=new Map(offers.map(o=>[o.id,o])),needs=new Map();
  for(const line of group.lines){
    const offer=byOffer.get(line.offerId);
    if(!offer||line.offerHash!==hash(allocation.offerFacts(offer))||line.category!==offer.category)
      throw new ValidationError('The current supplier terms or budget category changed. Review a new monthly plan.');
    const key=allocation.key(line.category,group.currency);
    needs.set(key,money.sum([needs.get(key)||0,line.amountMinor]));
  }
  const capacity=new Map((await budgets.headroom(c,ctx.workspaceId,{month:saved.snapshot.month,today,excludeOrderId:order.id}))
    .map(row=>[allocation.key(row.category,row.currency),row.remaining]));
  for(const [key,amount] of needs)if(capacity.get(key)==null||capacity.get(key)<amount)
    throw new ValidationError('The current category budget cannot cover this purchase after other bills, commitments and reserved drafts.');
}

async function page(db,ctx,{month,id,after=0}={}){
  await authority(db,ctx,{readOnly:true});
  const selected=month||(await time.today(db,ctx.workspaceId)).slice(0,7);
  const {start}=budgets.period(selected);
  if(id){
    const saved=await load(db,ctx,id),cursor=Number(after);
    if(!Number.isSafeInteger(cursor)||cursor<0)throw new ValidationError('Choose a valid result page.');
    const orderRows=(await db.query(`SELECT p.id,p.po_number,p.status FROM ${drafts} d JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
      WHERE d.workspace_id=$1 AND d.plan_id=$2 ORDER BY d.group_number`,[ctx.workspaceId,id])).rows;
    const groups=saved.snapshot.groups,held=saved.snapshot.held;
    return {month:saved.snapshot.month,saved,groups:groups.slice(cursor,cursor+50),held:held.slice(cursor,cursor+50),orders:orderRows,
      next:Math.max(groups.length,held.length)>cursor+50?cursor+50:null};
  }
  const [latest,setting]=await Promise.all([
    db.query(`SELECT id,status,automatic,created_at FROM ${plans} WHERE workspace_id=$1 AND month_start=$2 ORDER BY created_at DESC,id LIMIT 100`,[ctx.workspaceId,start]),
    db.query(`SELECT revision,enabled FROM ${rules} WHERE workspace_id=$1`,[ctx.workspaceId]),
  ]);
  return {month:selected,saved:null,plans:latest.rows,rule:setting.rows[0]||null};
}

module.exports={path,kind,configure,prepare,enqueue,run,prepareDrafts,assertApproval,page};
