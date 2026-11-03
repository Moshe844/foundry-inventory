'use strict';
// Money a customer paid on an order that was then cancelled. It was never
// applied to an invoice, so it is still theirs until somebody hands it back.
async function positions(db,workspaceId,{orderId=null}={}){
 const rows=(await db.query(`SELECT o.id,o.order_number,o.currency,o.customer_id,c.name AS customer_name,o.cancelled_at,
    received.minor AS received_minor,returned.minor AS refunded_minor
  FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
  CROSS JOIN LATERAL(SELECT coalesce(sum(p.amount_minor-coalesce((SELECT sum(a.amount_minor) FROM accounting_payment_allocations a
      WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id),0)),0)::bigint AS minor
    FROM accounting_payments p WHERE p.workspace_id=o.workspace_id AND p.sales_order_id=o.id
      AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED') received
  CROSS JOIN LATERAL(SELECT coalesce(sum(r.amount_minor),0)::bigint AS minor FROM accounting_deposit_refunds r
    WHERE r.workspace_id=o.workspace_id AND r.sales_order_id=o.id) returned
  WHERE o.workspace_id=$1 AND o.status='CANCELLED' AND ($2::text IS NULL OR o.id=$2)
  ORDER BY o.cancelled_at DESC NULLS LAST,o.id`,[workspaceId,orderId])).rows;
 return rows.map(row=>({orderId:row.id,orderNumber:row.order_number,customerId:row.customer_id,customerName:row.customer_name,currency:row.currency,cancelledAt:row.cancelled_at,
  refundedMinor:Number(row.refunded_minor),toRefundMinor:Math.max(0,Number(row.received_minor)-Number(row.refunded_minor))}));
}
async function due(db,workspaceId){return (await positions(db,workspaceId)).filter(row=>row.toRefundMinor>0);}
async function forOrder(db,workspaceId,orderId){return (await positions(db,workspaceId,{orderId}))[0]||null;}
module.exports={positions,due,forOrder};
