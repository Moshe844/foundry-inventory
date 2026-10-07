'use strict';

const inventory=require('../domain/postgres-inventory-engine');
const transfers=require('../transfers/postgres-transfer-service');
const catalog=require('../domain/postgres-catalog-service');
const locations=require('../domain/postgres-location-service');
const pricing=require('../pricing/postgres-service');
const mail=require('../connections/postgres-outbound-mail');
const workflows=require('../operations/postgres-business-workflows');

async function exists(client,table,workspaceId,id){
  if(!id)return false;
  // Only static table names from this module are ever interpolated.
  return Boolean((await client.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
    [workspaceId,id])).rows.length);
}

async function verifiedMovement(client,ctx,result,payload,operation,sign){
  if(!result?.movementId||!payload?.skuId||!payload?.locationId||!Number.isSafeInteger(payload.quantity))return false;
  const row=(await client.query(`SELECT sku_id,location_id,operation,quantity_delta,balance_after
    FROM movements WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,result.movementId])).rows[0];
  return Boolean(row&&row.sku_id===payload.skuId&&row.location_id===payload.locationId
    &&row.operation===operation&&Number(row.quantity_delta)===sign*payload.quantity
    &&Number(row.balance_after)===Number(result.balanceAfter));
}

const EXECUTORS=Object.freeze({
  'inventory.receive':{execute:(client,ctx,payload)=>inventory.receiveInTransaction(client,ctx,payload),
    verify:(client,ctx,result,payload)=>verifiedMovement(client,ctx,result,payload,'receive',1)},
  'inventory.issue':{execute:(client,ctx,payload)=>inventory.issueInTransaction(client,ctx,payload),
    verify:(client,ctx,result,payload)=>verifiedMovement(client,ctx,result,payload,'issue',-1)},
  'inventory.transfer':{execute:async(client,ctx,payload)=>{
    const requested=await transfers.requestInTransaction(client,ctx,{fromLocationId:payload.sourceLocationId,
      toLocationId:payload.destinationLocationId,reference:payload.reference,idempotencyKey:payload.idempotencyKey,
      lines:[{skuId:payload.skuId,quantity:payload.quantity}]});
    const approved=await transfers.approveInTransaction(client,ctx,requested.id,
      {idempotencyKey:`${payload.idempotencyKey}:approve`});
    return {transferId:approved.id,transferNumber:approved.transfer_number,status:approved.status,
      quantity:approved.totals.approved,physicalState:'Stock is reserved at the source; nothing has left yet.'};},
    verify:(client,ctx,result)=>exists(client,'inventory_transfers',ctx.workspaceId,result.transferId)},
  'inventory.adjust':{execute:(client,ctx,payload)=>inventory.adjustInTransaction(client,ctx,payload),
    verify:(client,ctx,result)=>exists(client,'adjustments',ctx.workspaceId,result.adjustmentId)},
  'catalog.create_item':{execute:(client,ctx,payload)=>catalog.createItemInTransaction(client,ctx,payload),
    verify:(client,ctx,result)=>exists(client,'items',ctx.workspaceId,result.itemId)},
  'location.create':{execute:(client,ctx,payload)=>locations.createLocationInTransaction(client,ctx,payload),
    verify:(client,ctx,result)=>exists(client,'locations',ctx.workspaceId,result.id)},
  'catalog.set_price':{execute:(client,ctx,payload)=>pricing.setPriceInTransaction(client,ctx,payload),
    verify:(client,ctx,result)=>exists(client,'sku_prices',ctx.workspaceId,result.id)},
  'catalog.set_purchase_cost':{execute:(client,ctx,payload)=>pricing.setPurchaseCostInTransaction(client,ctx,payload),
    verify:(client,ctx,result)=>exists(client,'sku_purchase_costs',ctx.workspaceId,result.id)},
  'communication.send_email':{execute:(client,ctx,payload)=>mail.queueInTransaction(client,ctx,payload,payload.idempotencyKey),
    verify:async(client,ctx,result,payload)=>{
      if(!result?.communicationId||!result?.effectId||!['supplier','customer'].includes(result.communicationKind))return false;
      const table=result.communicationKind==='supplier'?'supplier_communications':'customer_communications';
      const message=(await client.query(`SELECT recipient,subject,body,connector_id,status
        FROM ${table} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,result.communicationId])).rows[0];
      const effect=(await client.query(`SELECT kind,aggregate_id FROM stockchief_runtime.provider_effects
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,result.effectId])).rows[0];
      return Boolean(message&&effect&&String(message.recipient).toLowerCase()===String(payload.recipientEmail).toLowerCase()
        &&message.subject===payload.subject&&message.body===payload.body
        &&message.connector_id===payload.connectorId&&message.status==='QUEUED'
        &&effect.kind==='mail.outbound.send'&&effect.aggregate_id===result.communicationId);
    }},
  'sales_order.create':{execute:(client,ctx,payload)=>workflows.createSalesOrderInTransaction(client,ctx,payload),
    verify:(client,ctx,result)=>exists(client,'sales_orders',ctx.workspaceId,result.salesOrderId)},
  'purchase_order.create':{execute:(client,ctx,payload)=>workflows.createPurchaseOrderInTransaction(client,ctx,payload),
    verify:(client,ctx,result)=>exists(client,'purchase_orders',ctx.workspaceId,result.purchaseOrderId)},
  'purchase_order.receive':{execute:(client,ctx,payload)=>workflows.receivePurchaseOrderInTransaction(client,ctx,payload.purchaseOrderId,payload),
    verify:(client,ctx,result)=>exists(client,'purchase_order_receipts',ctx.workspaceId,result.receiptId)},
  'supplier_payment.record':{execute:(client,ctx,payload)=>workflows.recordSupplierPaymentInTransaction(client,ctx,payload),
    verify:(client,ctx,result)=>exists(client,'accounting_payments',ctx.workspaceId,result.paymentId)},
});

module.exports={EXECUTORS};
