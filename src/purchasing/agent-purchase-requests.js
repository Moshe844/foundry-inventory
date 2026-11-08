'use strict';

const {ValidationError, AuthorizationError, NotFoundError} = require('../domain/errors');
const agent = require('../commercial/agent-plan');
const warehouse = require('../operations/postgres-warehouse-access');
const {newId} = require('../lib/util');

async function access(db, ctx) {
  const actor = (await db.query('SELECT id,role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if (!actor) throw new AuthorizationError();
  const state = await agent.requireWorkspaceJob(db,ctx.workspaceId,41,'draft');
  if (!agent.usesAgentTerms(state)) throw new ValidationError('Review your current plan terms to use agent purchase requests.');
  return actor;
}

async function page(db,ctx) {
  const actor = await access(db,ctx);
  const locations = await warehouse.locations(db,ctx.workspaceId,await warehouse.scope(db,ctx));
  const rows = (await db.query(`SELECT r.id,r.status,r.quantity,r.reason,s.code,i.name AS product,l.name AS destination,u.name AS requester,
    r.purchase_order_id,po.po_number FROM stockchief_runtime.purchase_requests r
    JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.requested_by
    LEFT JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id
    WHERE r.workspace_id=$1 AND ($2::boolean OR (r.requested_by=$3 AND r.location_id=ANY($4)))
    ORDER BY (r.status='PENDING') DESC,r.created_at DESC,r.id LIMIT 200`,[ctx.workspaceId,actor.role==='owner',ctx.actorId,locations.map(l=>l.id)])).rows;
  return {requests:rows,locations,canApprove:actor.role==='owner'};
}

async function submit(db,ctx,input) {
  const reason=String(input.reason||'').trim(), code=String(input.sku||'').trim();
  if(!reason || reason.length>1000 || !code || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestKey||'')) throw new ValidationError('Choose an item and explain why you need it.');
  return db.transaction(async c=>{
    await access(c,ctx);
    await warehouse.assertLocations(c,ctx,[input.locationId]);
    const loc=await c.query('SELECT id FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,input.locationId]);
    if(!loc.rowCount) throw new ValidationError('Choose an active destination in this inventory.');
    const items=(await c.query(`SELECT i.*,s.id AS sku_id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE s.workspace_id=$1 AND lower(s.code)=lower($2) AND s.is_active=1 AND i.is_active=1`,[ctx.workspaceId,code])).rows;
    if(items.length!==1) throw new ValidationError('Enter one exact active item code.');
    const quantity=require('../domain/stock-quantity').validate(items[0],input.quantity);
    await c.query(`INSERT INTO stockchief_runtime.purchase_requests(id,workspace_id,requested_by,request_key,sku_id,location_id,quantity,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,requested_by,request_key) DO NOTHING`,
    [newId('purchreq'),ctx.workspaceId,ctx.actorId,input.requestKey,items[0].sku_id,input.locationId,quantity,reason]);
    const saved=(await c.query('SELECT * FROM stockchief_runtime.purchase_requests WHERE workspace_id=$1 AND requested_by=$2 AND request_key=$3',[ctx.workspaceId,ctx.actorId,input.requestKey])).rows[0];
    if(saved.sku_id!==items[0].sku_id || saved.location_id!==input.locationId || Number(saved.quantity)!==quantity || saved.reason!==reason)
      throw new ValidationError('This request reference is already in use. Open a new form.');
    return saved.id;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function decide(db,ctx,id,input){
  return db.transaction(async c=>{
    const actor=await access(c,ctx);
    if(actor.role!=='owner') throw new AuthorizationError('Only the owner can approve or decline a purchase request.');
    const row=(await c.query('SELECT * FROM stockchief_runtime.purchase_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
    if(!row) throw new NotFoundError();
    const decision=input.decision;
    if(!['approve','decline'].includes(decision)) throw new ValidationError('Choose approve or decline.');
    const status=decision==='approve'?'APPROVED':'DECLINED';
    if(row.status!== 'PENDING'){
      if(row.status!==status) throw new ValidationError('This request already has a decision.');
      return row.purchase_order_id;
    }
    let po=null;
    if(decision==='approve'){
      const suppliers=(await c.query(`SELECT s.id,s.currency,si.last_unit_cost FROM suppliers s JOIN supplier_items si ON si.supplier_id=s.id AND si.workspace_id=s.workspace_id
        WHERE s.workspace_id=$1 AND si.sku_id=$2 AND si.is_active=1 AND s.status='active' AND lower(s.name)=lower($3)`,
      [ctx.workspaceId,row.sku_id,String(input.supplier||'').trim()])).rows;
      if(suppliers.length!==1 || suppliers[0].last_unit_cost==null) throw new ValidationError('Choose a linked supplier with a saved price for this item.');
      const result=await require('../operations/postgres-business-workflows').createPurchaseOrderInTransaction(c,ctx,{
        supplierId:suppliers[0].id,destinationLocationId:row.location_id,currency:suppliers[0].currency,
        idempotencyKey:'staff-request:'+id,notes:row.reason,source:'manual',reference:id,
        lines:[{skuId:row.sku_id,quantityUnits:row.quantity,unitCost:Number(suppliers[0].last_unit_cost)}]});
      po=result.purchaseOrderId;
    }
    await c.query('UPDATE stockchief_runtime.purchase_requests SET status=$3,purchase_order_id=$4,decided_by=$5,decided_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,status,po,ctx.actorId]);
    return po;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={page,submit,decide};
