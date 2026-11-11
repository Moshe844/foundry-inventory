'use strict';

const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId,requireText}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const {compare,hasShortage}=require('./delivery-comparison');
const path='/autopilot/delivery-checks';
const table='stockchief_runtime.agent_delivery_comparisons';

async function access(db,ctx,{record=false,lock=false}={}){
  const member=await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId]);
  if(!member.rowCount)throw new AuthorizationError('Only the current inventory owner can review these supplier deliveries.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
  if(lock)await db.query(`SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id
    WHERE w.id=$1 FOR SHARE OF s`,[ctx.workspaceId]);
  return record?policy.requireWorkspaceJob(db,ctx.workspaceId,44,'draft'):policy.accountState(db,ctx.workspaceId);
}

async function source(db,ctx,orderId){
  const order=(await db.query(`SELECT p.*,s.name AS supplier_name FROM purchase_orders p JOIN suppliers s
    ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id WHERE p.workspace_id=$1 AND p.id=$2 FOR SHARE OF p`,
    [ctx.workspaceId,orderId])).rows[0];
  if(!order||!['ORDERED','PARTIALLY_RECEIVED','RECEIVED'].includes(order.status)||order.delivery_kind==='CUSTOMER_DIRECT')
    throw new ValidationError('Choose a placed purchase order for goods arriving at your business.');
  const lines=(await db.query(`SELECT l.*,s.code,s.variant_label,
    i.name||CASE WHEN coalesce(s.variant_label,'')='' THEN '' ELSE ' / '||s.variant_label END AS name,
    i.tracking_mode,i.unit_label,i.quantity_precision,i.quantity_increment,
    i.secondary_unit_label,i.secondary_precision,i.secondary_increment
    FROM purchase_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 ORDER BY l.line_number,l.id LIMIT 251`,[ctx.workspaceId,orderId])).rows;
  if(!lines.length||lines.length>250)throw new ValidationError('Compare a delivery for one to 250 purchase-order lines at a time.');
  return {order,lines};
}

async function save(db,ctx,input){
  return db.transaction(async c=>{
    await access(c,ctx,{record:true,lock:true});
    if(input.physicallyChecked!=='yes')throw new ValidationError('Confirm that these are the actual goods or original delivery-note rows you checked.');
    const reference=requireText(input.sourceReference,'Original delivery reference',{max:240});
    const requestKey=requireText(input.requestKey,'Delivery check request',{max:140});
    const requestHash=hash({orderId:input.orderId,observations:input.observations,reference});
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['delivery-check:'+ctx.workspaceId+':'+requestKey]);
    const prior=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND request_key=$2`,[ctx.workspaceId,requestKey])).rows[0];
    if(prior){
      if(prior.request_hash!==requestHash)throw new ValidationError('That delivery check was saved with different actual goods. Open its original record.');
      return {...prior,replayed:true};
    }
    const snapshot=await source(c,ctx,input.orderId);
    if(input.sourceHash!==hash(snapshot))throw new ValidationError('The purchase order or received quantities changed. Review the current delivery comparison.');
    const result=compare(snapshot.lines,input.observations);
    const id=newId('deliverycheck');
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'delivery-check:'+id,
      Buffer.byteLength(JSON.stringify({snapshot,result}))+4096,{finished:true});
    const saved=(await c.query(`INSERT INTO ${table}(workspace_id,id,purchase_order_id,request_key,request_hash,recorded_by,
      source_reference,source_hash,source_snapshot,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [ctx.workspaceId,id,input.orderId,requestKey,requestHash,ctx.actorId,reference,input.sourceHash,JSON.stringify(snapshot),JSON.stringify(result)])).rows[0];
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Actual supplier delivery compared',reference:id,
      after:{purchaseOrderId:input.orderId,sourceReference:reference,agrees:result.agrees,unexpectedRows:result.unexpected.length}});
    return {...saved,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function page(db,ctx,{orderId=null,id=null,page=1}={}){
  const state=await access(db,ctx);
  const canSuggest=policy.usesAgentTerms(state)&&policy.permits(state.plan,44,'suggest');
  const allowed=canSuggest&&policy.permits(state.plan,44,'draft');
  page=Number(page);
  if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid delivery-check page.');
  let record=null,snapshot=null;
  if(id){
    record=(await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id])).rows[0];
    if(!record)throw new NotFoundError('That delivery comparison was not found in this inventory.');
  }
  if(allowed&&orderId)snapshot=await source(db,ctx,orderId);
  const orders=allowed?(await db.query(`SELECT p.id,p.po_number,s.name AS supplier_name FROM purchase_orders p JOIN suppliers s
    ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED')
    AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE' ORDER BY p.order_date DESC,p.id DESC LIMIT 101 OFFSET $2`,
    [ctx.workspaceId,(page-1)*100])).rows:[];
  const history=allowed?(await db.query(`SELECT c.id,c.source_reference,c.recorded_at,p.po_number,c.result->>'agrees' AS agrees
    FROM ${table} c JOIN purchase_orders p ON p.workspace_id=c.workspace_id AND p.id=c.purchase_order_id
    WHERE c.workspace_id=$1 ORDER BY c.recorded_at DESC,c.id DESC LIMIT 101 OFFSET $2`,[ctx.workspaceId,(page-1)*100])).rows:[];
  const suggestion=canSuggest&&!allowed?(await require('../autopilot/job-reviews').run(db,ctx,'delivery-check')).rows[0]?.Suggestion:null;
  const canClaimShortages=allowed&&policy.permits(state.plan,45,'draft');
  const shortageLines=record?record.result.rows.filter(hasShortage)
    .filter(row=>record.result.original.some(original=>original.lineId===row.lineId)).map(row=>row.lineId):[];
  const claimMailboxes=canClaimShortages&&shortageLines.length
    ?await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId):[];
  return {allowed,record,snapshot,suggestion,sourceHash:snapshot?hash(snapshot):null,orders:orders.slice(0,100),history:history.slice(0,100),
    more:orders.length>100||history.length>100,pageNumber:page,requestKey:newId('delivery-check'),canClaimShortages,claimMailboxes,shortageLines};
}

function fromForm(body){
  const rows=Array.isArray(body.observations)?body.observations:Object.values(body.observations||{});
  return {...body,observations:rows.filter(row=>String(row.code||'').trim()&&String(row.quantity??'').trim()!=='')};
}

module.exports={path,save,page,source,fromForm};
