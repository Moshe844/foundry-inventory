'use strict';

const {ValidationError}=require('../domain/errors');
const permissions=new WeakMap();

function context(ctx,purchaseOrderId,action,dispatchId=null){
  const authorized={...ctx};
  permissions.set(authorized,{purchaseOrderId,action,dispatchId});
  return authorized;
}

function requireAction(ctx,order,action){
  if(order.delivery_kind!=='CUSTOMER_DIRECT')return;
  const grant=permissions.get(ctx);
  if(grant?.purchaseOrderId===order.id&&grant.action===action)return;
  throw new ValidationError('Open this order’s supplier-direct delivery to '+action+' it using its confirmed customer destination and current plan.');
}

function fulfillment(ctx){
  const grant=permissions.get(ctx);
  return grant?.action==='fulfill'&&grant.dispatchId?grant:null;
}

async function assertCustomerEditable(db,ctx,salesOrderId){
  const promised=await db.query(`SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=$1 AND l.sales_order_id=$2
    AND coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)>0 LIMIT 1`,[ctx.workspaceId,salesOrderId]);
  if(promised.rowCount)throw new ValidationError('This customer order has goods promised by a supplier. Confirm stopping those direct deliveries before changing or cancelling the customer order.');
}

module.exports={context,requireAction,fulfillment,assertCustomerEditable};
