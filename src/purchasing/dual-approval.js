'use strict';
const {createHash}=require('node:crypto');
const {AuthorizationError,ValidationError,NotFoundError}=require('../domain/errors');
const money=require('../domain/currency');
const policy=require('../commercial/agent-plan');
const team=require('../operations/postgres-team-access');
const warehouse=require('../operations/postgres-warehouse-access');
const permissions=require('../actions/permissions');
const exposure=require('./postgres-purchase-exposure');

async function setting(db,workspaceId){
  const row=(await db.query('SELECT currency,amount_minor,revision,escalation_hours FROM stockchief_runtime.purchase_approval_thresholds WHERE workspace_id=$1',[workspaceId])).rows[0];
  return row||{currency:null,amount_minor:null,revision:0,escalation_hours:24};
}
async function configure(db,ctx,input){
  return db.transaction(async c=>{
    await exposure.lock(c,ctx.workspaceId);
    const actor=(await c.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    if(actor?.role!=='owner')throw new AuthorizationError('Only the inventory owner can set the purchase approval threshold.');
    await policy.requireWorkspaceJob(c,ctx.workspaceId,205,'automatic');
    const previous=await setting(c,ctx.workspaceId);
    if(input.revision==null||Number(input.revision)!==previous.revision)throw new ValidationError('The approval threshold changed. Reload before saving.');
    const currency=money.code(input.currency),amount=money.userToMinor(input.amount,currency,{label:'Purchase threshold',optional:true});
    const hours=Number(input.escalationHours??previous.escalation_hours);
    if(!Number.isInteger(hours)||hours<1||hours>720)throw new ValidationError('Choose between 1 and 720 hours before passing the request to the next person.');
    await c.query(`INSERT INTO stockchief_runtime.purchase_approval_thresholds(workspace_id,currency,amount_minor,revision,changed_by,escalation_hours)
      VALUES($1,$2,$3,1,$4,$5) ON CONFLICT(workspace_id) DO UPDATE SET currency=$2,amount_minor=$3,
      revision=purchase_approval_thresholds.revision+1,changed_by=$4,changed_at=now(),escalation_hours=$5`,[ctx.workspaceId,currency,amount,ctx.actorId,hours]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
const recordFields=`
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id)::text FROM purchase_order_lines l WHERE l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id) lines,
  (SELECT jsonb_agg(to_jsonb(ch) ORDER BY ch.id)::text FROM purchase_order_charges ch WHERE ch.workspace_id=p.workspace_id AND ch.purchase_order_id=p.id) charges,
  (to_jsonb(p)-ARRAY['status','approved_at','approved_by_user_id','updated_at','ordered_at'])::text header`;
function digestFor(rule,records){
  return createHash('sha256').update(JSON.stringify([rule.revision,rule.currency,rule.amount_minor,records.header,records.lines,records.charges])).digest('hex');
}
async function snapshot(c,order){
  const workspaceId=order.workspace_id,rule=await setting(c,workspaceId);
  if(rule.amount_minor==null)return null;
  const amount=await team.purchaseAmount(c,workspaceId,order);
  if(rule.currency===order.currency&&amount<=Number(rule.amount_minor))return null;
  const records=(await c.query('SELECT '+recordFields+' FROM purchase_orders p WHERE p.workspace_id=$1 AND p.id=$2',[workspaceId,order.id])).rows[0];
  return {digest:digestFor(rule,records),amount};
}
function eligible(u,currency,amount){
  return permissions.can(u,permissions.APPROVE_PO)&&(u.role==='owner'||(u.warehouse_location_ids===null&&
    (u.po_approval_limit_minor==null||u.po_approval_currency===currency&&amount<=Number(u.po_approval_limit_minor))));
}
async function signers(c,order,review){
  const rows=(await c.query(`SELECT s.account_id,u.id,u.name,u.role,u.permissions,u.po_approval_limit_minor,u.po_approval_currency,u.warehouse_location_ids
    FROM stockchief_runtime.purchase_approval_signatures s JOIN users u ON u.workspace_id=s.workspace_id AND u.id=s.actor_id AND u.account_id=s.account_id
    LEFT JOIN platform_account_access a ON a.account_id=u.account_id
    WHERE s.workspace_id=$1 AND s.purchase_order_id=$2 AND s.digest=$3 AND a.disabled_at IS NULL ORDER BY s.signed_at,s.actor_id`,
    [order.workspace_id,order.id,review.digest])).rows;
  return rows.filter(u=>eligible(u,order.currency,review.amount));
}
async function assertApproved(c,order){
  const review=await snapshot(c,order);
  if(!review)return;
  await policy.requireWorkspaceJob(c,order.workspace_id,205,'automatic');
  if((await signers(c,order,review)).length<2)throw new AuthorizationError('Two authorized people must review and sign this purchase order before it can be approved.');
}
async function view(db,ctx,id){
  const order=(await db.query("SELECT id,workspace_id,currency,status FROM purchase_orders WHERE workspace_id=$1 AND id=$2 AND status IN('DRAFT','AWAITING_APPROVAL','APPROVED')",[ctx.workspaceId,id])).rows[0];
  if(!order)return null;
  const review=await snapshot(db,order);if(!review)return null;
  const state=await policy.accountState(db,ctx.workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,205,'automatic'))return {locked:true};
  const people=await signers(db,order,review);
  if(order.status==='APPROVED'&&people.length>=2)return null;
  return {digest:review.digest,total:money.format(review.amount,order.currency),people:people.map(p=>p.name),signed:people.some(p=>p.id===ctx.actorId)};
}
async function sign(db,ctx,id,expectedDigest){
  return db.transaction(async c=>{
    await exposure.lock(c,ctx.workspaceId);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,205,'automatic');
    await warehouse.assertInventoryWide(c,ctx);
    const order=(await c.query('SELECT * FROM purchase_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
    if(!order)throw new NotFoundError();
    await team.assertPurchaseApproval(c,ctx,order);
    if(!['DRAFT','AWAITING_APPROVAL','APPROVED'].includes(order.status))throw new ValidationError('Only an open purchase approval can be signed.');
    if((await c.query('SELECT 1 FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2 AND unit_cost IS NULL LIMIT 1',[ctx.workspaceId,id])).rowCount)
      throw new ValidationError('Every line needs a price before you sign.');
    const review=await snapshot(c,order);
    if(!review||review.digest!==expectedDigest)throw new ValidationError('The order or its approval threshold changed. Review the current order before signing.');
    const member=(await c.query(`SELECT u.account_id FROM users u LEFT JOIN platform_account_access a ON a.account_id=u.account_id
      WHERE u.workspace_id=$1 AND u.id=$2 AND u.account_id IS NOT NULL AND a.disabled_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rows[0];
    if(!member)throw new AuthorizationError('An active individual account is required to sign.');
    if(order.status==='APPROVED'&&(await signers(c,order,review)).length>=2)return {status:'APPROVED'};
    await c.query(`INSERT INTO stockchief_runtime.purchase_approval_signatures(workspace_id,purchase_order_id,digest,account_id,actor_id,amount_minor)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[ctx.workspaceId,id,review.digest,member.account_id,ctx.actorId,review.amount]);
    if((await signers(c,order,review)).length<2)return {status:'WAITING_FOR_SECOND_SIGNER'};
    if(order.status==='APPROVED')return {status:'APPROVED'};
    const scoped={query:c.query.bind(c),transaction:work=>work(c)};
    return require('../operations/postgres-business-workflows').approvePurchaseOrder(scoped,ctx,id,{idempotencyKey:'two-signatures:'+id+':'+review.digest});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function guardOrderMessage(db,workspaceId,id){
  const order=(await db.query("SELECT * FROM purchase_orders WHERE workspace_id=$1 AND id=$2 AND status IN('DRAFT','AWAITING_APPROVAL','APPROVED')",[workspaceId,id])).rows[0];
  if(order)await assertApproved(db,order);
}
const definition={id:205,key:'purchase-approval-threshold',label:'Require two people to approve large purchases',
  read:async(db,ctx)=>{
    const rule=await setting(db,ctx.workspaceId);
    return {summary:'Two authorized people must sign a purchase order above your threshold. Orders in another currency always require two signatures when this rule is active.',
      rows:rule.amount_minor==null?[]:[{Currency:rule.currency,'Require two people above':money.format(rule.amount_minor,rule.currency)}]};
  }};
module.exports={configure,setting,view,sign,assertApproved,guardOrderMessage,definition,recordFields,digestFor,eligible};
