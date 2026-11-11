'use strict';

const {ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');
const money=require('../domain/currency');
const workflow=require('./agent-direct-shipments');
const mail=require('../connections/postgres-outbound-mail');

function compose(row){
  const products=row.facts.products.map(product=>product.quantity+' '+product.unit+' of '+product.name+' ('+product.code+')'+
    (product.secondaryQuantity===null?'':' / '+product.secondaryQuantity+' '+product.weightUnit)+
    '\nSupplier packs '+product.purchaseUnits+' '+product.purchaseUnit+' / '+product.unitsPerPurchaseUnit+' '+product.unit+' per pack'+
    '\nUnit cost '+money.format(product.unitCostMinor,row.currency)+' per '+(product.weightUnit||product.unit)+
    '\nGoods total '+money.format(product.totalMinor,row.currency));
  return {subject:row.po_number+' — deliver directly to customer',
    body:['Hello '+row.facts.supplier.name+',','','Please supply purchase order '+row.po_number+' for customer order '+row.order_number+'.',
      'Deliver directly to '+row.facts.customer.name+'.',row.facts.customer.address,
      row.facts.customer.phone?'Customer delivery phone '+row.facts.customer.phone:null,'',...products,'',
      'Please use the private order link below to confirm this purchase and report the goods actually dispatched, actual batches or serials, carrier and tracking number.',
      'Report partial shipments separately, using a unique dispatch reference for each one.','', 'Thank you.'].filter(value=>value!==null).join('\n')};
}

async function authority(db,workspaceId,grant,{lock=false}={}){
  if(grant.kind!=='supplier_direct_purchase'||!grant.actorId||typeof grant.automatic!=='boolean')
    throw new ValidationError('This supplier-direct email needs a valid current purchase approval.');
  const row=await workflow.deliveryFacts(db,{workspaceId,actorId:grant.actorId},grant.recordId,{lock,automatic:grant.automatic});
  if(row.source_hash!==grant.sourceHash||row.revision!==grant.revision)
    throw new ValidationError('This supplier-direct purchase changed after its email was prepared. Review the current purchase.');
  const connector=(await db.query(`SELECT id,provider_account_id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2
    AND provider_type IN ('gmail','microsoft365') AND status='connected' AND paused_at IS NULL
    AND setup_status IS DISTINCT FROM 'REAUTHORIZATION_REQUIRED'${lock?' FOR SHARE':''}`,[workspaceId,grant.connectorId])).rows[0];
  if(!connector||connector.provider_account_id!==grant.mailboxAccount)
    throw new ValidationError('The mailbox used to approve this supplier purchase changed or needs reconnection.');
  return row;
}

async function send(db,ctx,id,input,{automatic=false}={}){
  return db.transaction(async c=>{
    if(!automatic&&input.confirmed!=='yes')throw new ValidationError('Review this exact customer destination and supplier purchase email before sending.');
    const row=await workflow.deliveryFacts(c,ctx,id,{lock:true,automatic});
    if(Number(input.revision)!==row.revision||input.sourceHash!==row.source_hash)
      throw new ValidationError('This supplier purchase changed after review. Open its current details before sending.');
    const connector=(await c.query(`SELECT id,provider_account_id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2
      AND provider_type IN ('gmail','microsoft365') AND status='connected' AND paused_at IS NULL
      AND setup_status IS DISTINCT FROM 'REAUTHORIZATION_REQUIRED' FOR SHARE`,[ctx.workspaceId,input.connectorId])).rows[0];
    if(!connector)throw new ValidationError('Choose a connected sending mailbox for this purchase.');
    const grant={kind:'supplier_direct_purchase',recordId:id,actorId:ctx.actorId,sourceHash:row.source_hash,
      revision:row.revision,connectorId:connector.id,mailboxAccount:connector.provider_account_id,automatic};
    await authority(c,ctx.workspaceId,grant);
    const key='supplier-direct-purchase:'+id;
    const prior=(await c.query('SELECT id,status FROM supplier_communications WHERE workspace_id=$1 AND idempotency_key=$2',
      [ctx.workspaceId,key])).rows[0];
    if(prior){
      if(['FAILED','CANCELLED'].includes(prior.status))throw new ValidationError('Review the earlier purchase email’s delivery before sending another order to this supplier.');
      return {communicationId:prior.id,status:prior.status,replayed:true};
    }
    return mail.queueInTransaction(c,ctx,{recipientKind:'supplier',recipientId:row.facts.supplier.id,
      recipientEmail:row.facts.supplier.email,purchaseOrderId:row.purchase_order_id,connectorId:connector.id,
      ...compose(row),standingAuthority:grant},key,{agentRequested:true,agentJob:37});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function accepted(c,workspaceId,grant,messageId,at){
  const row=(await c.query(`SELECT d.id,d.purchase_order_id,p.status FROM stockchief_runtime.agent_direct_orders d
    JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
    JOIN supplier_communications m ON m.workspace_id=p.workspace_id AND m.purchase_order_id=p.id
    WHERE d.workspace_id=$1 AND d.id=$2 AND d.source_hash=$3 AND m.id=$4 AND m.status='SENT'
      AND m.external_message_id IS NOT NULL AND p.delivery_kind='CUSTOMER_DIRECT' FOR UPDATE OF d,p`,
    [workspaceId,grant.recordId,grant.sourceHash,messageId])).rows[0];
  if(!row)throw new ValidationError('The confirmed supplier email does not match this direct purchase.');
  if(row.status!=='APPROVED')return;
  await c.query("UPDATE purchase_orders SET status='ORDERED',ordered_at=coalesce(ordered_at,$3),updated_at=$3 WHERE workspace_id=$1 AND id=$2",
    [workspaceId,row.purchase_order_id,at]);
  await c.query('UPDATE stockchief_runtime.agent_direct_orders SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[workspaceId,row.id]);
  await c.query(`INSERT INTO purchase_order_events(id,workspace_id,purchase_order_id,event,detail,actor_user_id,created_at)
    VALUES($1,$2,$3,'ordered',$4,$5,$6)`,[newId('poevt'),workspaceId,row.purchase_order_id,
    JSON.stringify({supplierDirect:true,communicationId:messageId,mailboxAccepted:true}),grant.actorId,at]);
}

module.exports={compose,authority,send,accepted};
