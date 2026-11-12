'use strict';
// Money a customer paid on an order that the order can no longer use: the order
// was cancelled, or everything has shipped and what they paid is more than the
// invoices came to. It was never applied to an invoice, so it is still theirs
// until somebody hands it back.
//
// Driven from receipts that still hold unapplied money, so the cost follows the
// number of deposits, not the number of orders.
async function positions(db,workspaceId,{orderId=null}={}){
 // Refunds a person approved through job 107 and not yet paid are spoken for.
 const prepared=await require('../db/schema-installed').has(db,'stockchief_runtime.agent_customer_credit_refunds');
 const rows=(await db.query(`WITH held AS (
    SELECT p.sales_order_id AS order_id,SUM(p.amount_minor-COALESCE(applied.minor,0))::bigint AS minor
    FROM accounting_payments p
    CROSS JOIN LATERAL(SELECT SUM(a.amount_minor) AS minor FROM accounting_payment_allocations a
      WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id) applied
    WHERE p.workspace_id=$1 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED' AND p.sales_order_id IS NOT NULL
      AND ($2::text IS NULL OR p.sales_order_id=$2)
    GROUP BY p.sales_order_id HAVING SUM(p.amount_minor-COALESCE(applied.minor,0))>0)
  SELECT o.id,o.order_number,o.currency,o.customer_id,o.status,c.name AS customer_name,o.cancelled_at,o.updated_at,
    held.minor AS received_minor,returned.minor AS refunded_minor,open.minor AS open_minor,pending.minor AS pending_minor
  FROM held JOIN sales_orders o ON o.workspace_id=$1 AND o.id=held.order_id
  JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
  CROSS JOIN LATERAL(SELECT coalesce(sum(r.amount_minor),0)::bigint AS minor FROM accounting_deposit_refunds r
    WHERE r.workspace_id=o.workspace_id AND r.sales_order_id=o.id) returned
  CROSS JOIN LATERAL(SELECT coalesce(sum(i.balance_minor),0)::bigint AS minor FROM accounting_customer_invoices i
    WHERE i.workspace_id=o.workspace_id AND i.sales_order_id=o.id AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.voided_at IS NULL) open
  ${prepared?`CROSS JOIN LATERAL(SELECT coalesce(sum(r.amount_minor),0)::bigint AS minor FROM stockchief_runtime.agent_customer_credit_refunds r
    JOIN stockchief_runtime.agent_customer_credits c ON c.workspace_id=r.workspace_id AND c.id=r.credit_id
    WHERE c.workspace_id=o.workspace_id AND c.sales_order_id=o.id AND c.kind<>'price_adjustment' AND r.status IN ('TO_PAY','APPROVED','REVIEW')) pending`:'CROSS JOIN LATERAL(SELECT 0::bigint AS minor) pending'}
  WHERE o.status IN ('CANCELLED','FULFILLED')
  ORDER BY o.cancelled_at DESC NULLS LAST,o.id`,[workspaceId,orderId])).rows;
 return rows.map(row=>({orderId:row.id,orderNumber:row.order_number,customerId:row.customer_id,customerName:row.customer_name,currency:row.currency,cancelledAt:row.cancelled_at,
  cancelled:row.status==='CANCELLED',changedAt:row.cancelled_at||row.updated_at,refundedMinor:Number(row.refunded_minor),
  pendingMinor:Number(row.pending_minor),toRefundMinor:Math.max(0,Number(row.received_minor)-Number(row.refunded_minor)-Number(row.open_minor)-Number(row.pending_minor))}));
}
async function due(db,workspaceId){return (await positions(db,workspaceId)).filter(row=>row.toRefundMinor>0);}
async function forOrder(db,workspaceId,orderId){return (await positions(db,workspaceId,{orderId}))[0]||null;}

// What a customer can still pay towards one order: what is not yet invoiced
// (nothing once every line has shipped), plus open invoice balances, less money
// already held for it and not yet applied.
async function owed(db,workspaceId,order){
 const lines=(await db.query('SELECT quantity_ordered,quantity_fulfilled,unit_price_minor FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2',[workspaceId,order.id])).rows;
 const invoices=(await db.query(`SELECT coalesce(sum(total_minor),0)::bigint AS total_minor,
    coalesce(sum(balance_minor) FILTER (WHERE status IN ('OPEN','PARTIALLY_PAID')),0)::bigint AS open_minor
   FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2 AND status NOT IN ('DRAFT','VOID') AND voided_at IS NULL`,[workspaceId,order.id])).rows[0];
 const held=(await db.query(`SELECT coalesce(sum(p.amount_minor-coalesce((SELECT sum(a.amount_minor) FROM accounting_payment_allocations a
     WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id),0)),0)::bigint
     -(SELECT coalesce(sum(r.amount_minor),0) FROM accounting_deposit_refunds r WHERE r.workspace_id=$1 AND r.sales_order_id=$2)::bigint AS minor
   FROM accounting_payments p WHERE p.workspace_id=$1 AND p.sales_order_id=$2 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED'`,[workspaceId,order.id])).rows[0];
 const allShipped=lines.length>0&&lines.every(line=>Number(line.quantity_fulfilled)>=Number(line.quantity_ordered));
 const uninvoiced=allShipped?0:Math.max(0,require('./order-total').orderTotalMinor(order,lines)-Number(invoices.total_minor));
 return Math.max(0,uninvoiced+Number(invoices.open_minor)-Math.max(0,Number(held.minor)));
}
module.exports={positions,due,forOrder,owed};
