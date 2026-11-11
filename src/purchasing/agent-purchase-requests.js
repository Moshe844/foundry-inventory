'use strict';

const {ValidationError, AuthorizationError, NotFoundError} = require('../domain/errors');
const agent = require('../commercial/agent-plan');
const warehouse = require('../operations/postgres-warehouse-access');
const {newId} = require('../lib/util');
const stockQuantity = require('../domain/stock-quantity');
const {key:recordKey} = require('../assistant/postgres-record-aliases');

function requestInput(input){
  const original=String(input.requestText||'').normalize('NFKC').trim();
  if(original.length>240)throw new ValidationError('Use a request of up to 240 characters.');
  const sentence=/^(?:(?:we|i) need|(?:please )?(?:buy|reorder|order))\s+(.+?)[.!?]?$/i.exec(original);
  const wording=sentence?.[1]?.replace(/^more\s+/i,'')||original||String(input.sku||'').trim();
  const counted=sentence?/^(\d+(?:\.\d+)?)\s+(.+)$/.exec(wording):null;
  const reason=[original,String(input.reason||'').trim()].filter(Boolean).join(' ');
  const item=counted?.[2]||wording;
  if(!reason||reason.length>1000||!item||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestKey||''))
    throw new ValidationError('Enter the product or a short purchase request and explain why it is needed.');
  const explicit=String(input.quantity??'').trim();
  if(explicit&&counted&&Number(explicit)!==Number(counted[1]))throw new ValidationError('The request and quantity field give different amounts.');
  return {reason,item,exactSku:!original,quantity:explicit||counted?.[1]||null};
}

async function access(db, ctx) {
  const actor = (await db.query('SELECT id,role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if (!actor) throw new AuthorizationError();
  const state = await agent.requireWorkspaceJob(db,ctx.workspaceId,41,'draft');
  if (!agent.usesAgentTerms(state)) throw new (require('../commercial/entitlements').EntitlementError)('Review your current plan terms to use agent purchase requests.');
  return actor;
}

async function page(db,ctx) {
  const actor = await access(db,ctx);
  const locations = await warehouse.locations(db,ctx.workspaceId,await warehouse.scope(db,ctx));
  const rows = (await db.query(`SELECT r.id,r.status,r.quantity,r.reason,r.sku_id,s.code,i.name AS product,i.unit_label,i.secondary_unit_label,l.name AS destination,u.name AS requester,
    r.purchase_order_id,po.po_number FROM stockchief_runtime.purchase_requests r
    JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.requested_by
    LEFT JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id
    WHERE r.workspace_id=$1 AND ($2::boolean OR (r.requested_by=$3 AND r.location_id=ANY($4)))
    ORDER BY (r.status='PENDING') DESC,r.created_at DESC,r.id LIMIT 200`,[ctx.workspaceId,actor.role==='owner',ctx.actorId,locations.map(l=>l.id)])).rows;
  const pending=actor.role==='owner'?rows.filter(row=>row.status==='PENDING').map(row=>row.sku_id):[];
  const choices=pending.length?(await db.query(`SELECT si.sku_id,s.id,s.name FROM supplier_items si
    JOIN suppliers s ON s.workspace_id=si.workspace_id AND s.id=si.supplier_id
    WHERE si.workspace_id=$1 AND si.sku_id=ANY($2::text[]) AND si.is_active=1 AND s.status='active' AND si.last_unit_cost IS NOT NULL
    ORDER BY s.name,s.id`,[ctx.workspaceId,pending])).rows:[];
  const suppliers=new Map();
  for(const choice of choices){
    if(!suppliers.has(choice.sku_id))suppliers.set(choice.sku_id,[]);
    suppliers.get(choice.sku_id).push(choice);
  }
  return {requests:rows,locations,suppliers,canApprove:actor.role==='owner'};
}

async function submit(db,ctx,input) {
  return db.transaction(async c=>{
    await access(c,ctx);
    const request=requestInput(input);
    await warehouse.assertLocations(c,ctx,[input.locationId]);
    const loc=await c.query('SELECT id FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,input.locationId]);
    if(!loc.rowCount) throw new ValidationError('Choose an active destination in this inventory.');
    const items=(await c.query(`SELECT i.*,s.id AS sku_id,lower(s.code)=$2 AS exact_code FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND (lower(s.code)=$2 OR NOT $3::boolean AND (lower(i.name)=$2 OR EXISTS(
        SELECT 1 FROM workspace_record_aliases a WHERE a.workspace_id=s.workspace_id AND a.alias_key=$2
          AND (a.kind='sku' AND a.target_id=s.id OR a.kind='item' AND a.target_id=i.id))))
      ORDER BY exact_code DESC LIMIT 2`,[ctx.workspaceId,recordKey(request.item),request.exactSku])).rows;
    if(!items.length||items.length>1&&(!items[0].exact_code||items[1].exact_code))
      throw new ValidationError(items.length?'More than one active product matches this request. Enter the exact item code.':'No active product matches this request. Enter its saved name or item code.');
    const quantity=request.quantity===null&&!request.exactSku?null:stockQuantity.validate(items[0],request.quantity);
    await c.query(`INSERT INTO stockchief_runtime.purchase_requests(id,workspace_id,requested_by,request_key,sku_id,location_id,quantity,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,requested_by,request_key) DO NOTHING`,
    [newId('purchreq'),ctx.workspaceId,ctx.actorId,input.requestKey,items[0].sku_id,input.locationId,quantity,request.reason]);
    const saved=(await c.query('SELECT * FROM stockchief_runtime.purchase_requests WHERE workspace_id=$1 AND requested_by=$2 AND request_key=$3',[ctx.workspaceId,ctx.actorId,input.requestKey])).rows[0];
    if(saved.sku_id!==items[0].sku_id || saved.location_id!==input.locationId || (saved.quantity===null?null:Number(saved.quantity))!==quantity || saved.reason!==request.reason)
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
        WHERE s.workspace_id=$1 AND si.sku_id=$2 AND si.is_active=1 AND s.status='active'
        AND ($3::text IS NOT NULL AND s.id=$3 OR $3::text IS NULL AND lower(s.name)=lower($4))`,
      [ctx.workspaceId,row.sku_id,input.supplierId||null,String(input.supplier||'').trim()])).rows;
      if(suppliers.length!==1 || suppliers[0].last_unit_cost==null) throw new ValidationError('Choose a linked supplier with a saved price for this item.');
      const item=(await c.query(`SELECT i.* FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
        WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1`,[ctx.workspaceId,row.sku_id])).rows[0];
      if(!item)throw new ValidationError('This requested product is no longer active.');
      if(row.quantity===null&&!String(input.quantity??'').trim())throw new ValidationError('Enter the exact quantity to purchase before approving this request.');
      const quantity=stockQuantity.validate(item,row.quantity??input.quantity);
      const result=await require('../operations/postgres-business-workflows').createPurchaseOrderInTransaction(c,ctx,{
        supplierId:suppliers[0].id,destinationLocationId:row.location_id,currency:suppliers[0].currency,
        idempotencyKey:'staff-request:'+id,notes:row.reason,source:'manual',reference:id,
        lines:[{skuId:row.sku_id,quantityUnits:quantity,secondaryQuantity:input.secondaryQuantity||null,unitCost:Number(suppliers[0].last_unit_cost)}]});
      po=result.purchaseOrderId;
    }
    await c.query('UPDATE stockchief_runtime.purchase_requests SET status=$3,purchase_order_id=$4,decided_by=$5,decided_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,status,po,ctx.actorId]);
    return po;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={page,submit,decide};
