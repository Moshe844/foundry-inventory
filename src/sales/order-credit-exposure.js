'use strict';

const money=require('../domain/currency');

function exposure(selection){
  return `WITH selected AS MATERIALIZED (
    SELECT o.id,o.order_number,o.status,o.customer_id,o.currency,o.pricing_total_minor,c.name,
      t.credit_limit_minor,b.base_currency
    FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    JOIN accounting_settings b ON b.workspace_id=o.workspace_id AND b.enabled=1
    JOIN LATERAL (SELECT credit_limit_minor FROM customer_payment_terms
      WHERE workspace_id=o.workspace_id AND (customer_id=o.customer_id OR customer_id IS NULL)
      ORDER BY (customer_id IS NOT NULL) DESC LIMIT 1)t ON t.credit_limit_minor IS NOT NULL
    WHERE o.workspace_id=$1 AND ${selection}
  ), customers AS (SELECT DISTINCT customer_id,base_currency FROM selected),
  invoices AS MATERIALIZED (
    SELECT i.customer_id,i.sales_order_id,i.currency,i.total_minor,i.balance_minor,i.status
    FROM accounting_customer_invoices i JOIN customers c ON c.customer_id=i.customer_id
    WHERE i.workspace_id=$1 AND i.status IN ('OPEN','PARTIALLY_PAID','PAID')
  ), debts AS (
    SELECT c.customer_id,coalesce(sum(i.balance_minor) FILTER(WHERE i.currency=c.base_currency),0) AS debt,
      bool_or(i.currency<>c.base_currency) AS foreign_debt
    FROM customers c LEFT JOIN invoices i ON i.customer_id=c.customer_id AND i.balance_minor>0
      AND i.status IN ('OPEN','PARTIALLY_PAID')
    GROUP BY c.customer_id
  ), billed AS (
    SELECT i.sales_order_id,i.customer_id,coalesce(sum(i.total_minor),0) AS total,
      bool_or(i.currency<>c.base_currency) AS foreign_invoice
    FROM invoices i JOIN customers c ON c.customer_id=i.customer_id
    WHERE i.sales_order_id IS NOT NULL GROUP BY i.sales_order_id,i.customer_id
  ), commitments AS (
    SELECT o.customer_id,sum(greatest(o.pricing_total_minor-coalesce(b.total,0),0)) AS total,
      bool_or(o.pricing_total_minor IS NULL OR o.currency<>c.base_currency OR b.foreign_invoice) AS unknown
    FROM sales_orders o JOIN customers c ON c.customer_id=o.customer_id
    LEFT JOIN billed b ON b.sales_order_id=o.id AND b.customer_id=o.customer_id
    WHERE o.workspace_id=$1 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
    GROUP BY o.customer_id
  )
  SELECT s.*,d.debt,d.foreign_debt,coalesce(k.total,0)+CASE WHEN s.status='DRAFT'
      THEN greatest(s.pricing_total_minor-coalesce(b.total,0),0) ELSE 0 END AS unbilled,
    (coalesce(k.unknown,false) OR s.pricing_total_minor IS NULL OR s.currency<>s.base_currency
      OR coalesce(b.foreign_invoice,false)) AS unknown
  FROM selected s JOIN debts d ON d.customer_id=s.customer_id
  LEFT JOIN commitments k ON k.customer_id=s.customer_id
  LEFT JOIN billed b ON b.sales_order_id=s.id AND b.customer_id=s.customer_id`;
}

function present(row){
  const limit=money.integer(row.credit_limit_minor);
  const known=!(row.unknown||row.foreign_debt);
  const total=known?money.sum([money.integer(row.debt),money.integer(row.unbilled)]):null;
  const fmt=n=>money.format(n,row.base_currency);
  return {Order:row.order_number,Customer:row.name,'Credit limit':fmt(limit),
    'Open invoices':row.foreign_debt?null:fmt(row.debt),
    'Unbilled orders':row.unknown?null:fmt(row.unbilled),'Exposure with this order':total==null?null:fmt(total),
    Result:total==null?'Review currencies or missing prices':total>limit?'Over limit':'Within limit',link:'/orders/'+row.id};
}

async function review(db,ctx,{filter,page}){
  const query=exposure(`o.status IN ('DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
    AND ($2='' OR lower(o.order_number)=lower($2) OR lower(c.name)=lower($2)) ORDER BY o.order_date DESC,o.id LIMIT 51 OFFSET $3`);
  const {rows}=await db.query(query+' ORDER BY s.order_number,s.id',[ctx.workspaceId,filter,(page-1)*50]);
  return {rows:rows.slice(0,50).map(present),more:rows.length>50,
    summary:'Compares proposed orders and confirmed commitments with saved credit limits. Open invoices and unbilled portions are each counted once. Currency differences or missing prices need review.'};
}

async function forOrder(db,ctx,id){
  const {rows:[row]}=await db.query(exposure("o.status='DRAFT' AND o.id=$2"),[ctx.workspaceId,id]);
  return row?present(row):null;
}

const notices=`SELECT 80,'Order credit',order_number,'/orders/'||id,$3::date
  FROM (${exposure("o.status='DRAFT'")}) checks
  WHERE unknown OR foreign_debt OR debt+unbilled>credit_limit_minor`;

module.exports={review,forOrder,notices};
