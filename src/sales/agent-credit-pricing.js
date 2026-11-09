'use strict';
const money=require('../domain/currency');

async function credit(db,ctx,{filter,page}){
  const {rows}=await db.query(`WITH selected AS (
    SELECT o.id,o.order_number,o.customer_id,o.currency,c.name,t.credit_limit_minor,b.base_currency FROM sales_orders o JOIN customers c
      ON c.workspace_id=o.workspace_id AND c.id=o.customer_id JOIN accounting_settings b ON b.workspace_id=o.workspace_id AND b.enabled=1
      JOIN LATERAL (SELECT credit_limit_minor FROM customer_payment_terms WHERE workspace_id=o.workspace_id AND (customer_id=o.customer_id OR customer_id IS NULL)
        ORDER BY (customer_id IS NOT NULL) DESC LIMIT 1)t ON t.credit_limit_minor IS NOT NULL
      WHERE o.workspace_id=$1 AND o.status IN ('DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED') AND ($2='' OR lower(o.order_number)=lower($2) OR lower(c.name)=lower($2))
      ORDER BY o.order_date DESC,o.id LIMIT 51 OFFSET $3)
    SELECT s.*,d.debt,k.unbilled,d.foreign_debt,k.unknown FROM selected s CROSS JOIN LATERAL (
      SELECT coalesce(sum(balance_minor) FILTER(WHERE currency=s.base_currency),0) debt,bool_or(currency<>s.base_currency) foreign_debt
      FROM accounting_customer_invoices i WHERE i.workspace_id=$1 AND i.customer_id=s.customer_id AND i.balance_minor>0 AND i.status IN ('OPEN','PARTIALLY_PAID'))d
    CROSS JOIN LATERAL (SELECT coalesce(sum(greatest(o.pricing_total_minor-coalesce(billed.total,0),0)),0) unbilled,
      bool_or(o.pricing_total_minor IS NULL OR o.currency<>s.base_currency OR billed.foreign_invoice) unknown FROM sales_orders o
      LEFT JOIN LATERAL (SELECT sum(i.total_minor) total,bool_or(i.currency<>o.currency) foreign_invoice FROM accounting_customer_invoices i WHERE i.workspace_id=o.workspace_id
        AND i.sales_order_id=o.id AND i.status IN ('OPEN','PARTIALLY_PAID','PAID'))billed ON true
      WHERE o.workspace_id=$1 AND o.customer_id=s.customer_id AND (o.id=s.id OR o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'))) k
    ORDER BY s.order_number,s.id`,[ctx.workspaceId,filter,(page-1)*50]);
  return {rows:rows.slice(0,50).map(r=>{
    const limit=money.integer(r.credit_limit_minor),known=!(r.unknown||r.foreign_debt||r.currency!==r.base_currency);
    const total=known?money.sum([money.integer(r.debt),money.integer(r.unbilled)]):null;
    const fmt=n=>money.format(n,r.base_currency);
    return {Order:r.order_number,Customer:r.name,'Credit limit':fmt(limit),'Open invoices':r.foreign_debt?null:fmt(r.debt),
      'Unbilled orders':r.unknown?null:fmt(r.unbilled),'Exposure with this order':total==null?null:fmt(total),
      Result:total==null?'Review currencies or missing prices':total>limit?'Over limit':'Within limit',link:'/orders/'+r.id};
  }),more:rows.length>50,summary:'Compares each proposed order and existing confirmed commitments with the saved customer credit limit. Amounts already billed are counted once. Unapplied deposits are excluded. Mixed currencies need review.'};
}

async function priceProblems(db,ctx,{filter,page}){
  const {rows}=await db.query(`WITH lines AS (SELECT o.id,o.order_number,o.currency,s.code,l.id AS line_id,
    CASE WHEN l.pricing_snapshot IS NULL THEN 'No reviewed line price'
      WHEN l.unit_price_minor IS DISTINCT FROM (l.pricing_snapshot->>'unitPriceMinor')::bigint THEN 'Price differs from the reviewed line'
      WHEN (l.pricing_snapshot->>'discountMinor')::bigint IS DISTINCT FROM
        ((l.pricing_snapshot->>'grossMinor')::bigint-(l.pricing_snapshot->>'netMinor')::bigint) THEN 'Line discount differs from reviewed amounts'
      WHEN (l.pricing_snapshot->>'netMinor')::numeric < (l.pricing_snapshot->>'costUnitMinor')::numeric *
        coalesce((l.pricing_snapshot->>'pricingQuantity')::numeric,(l.pricing_snapshot->>'quantity')::numeric) THEN 'Selling below recorded cost'
      WHEN l.pricing_snapshot->>'costUnitMinor' IS NULL THEN 'Cost evidence unavailable' END problem
    FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id WHERE o.workspace_id=$1 AND o.status<>'CANCELLED'
      AND ($2='' OR lower(o.order_number)=lower($2) OR lower(s.code)=lower($2))),
    problems AS (SELECT id,order_number,code,problem,line_id FROM lines WHERE problem IS NOT NULL
      UNION ALL SELECT o.id,o.order_number,NULL,'Order discount differs from approved quote',o.id FROM sales_orders o
      JOIN stockchief_runtime.pricing_order_snapshots snap ON snap.workspace_id=o.workspace_id AND snap.id=o.pricing_quote_id
      WHERE o.workspace_id=$1 AND o.status<>'CANCELLED' AND o.discount_minor IS DISTINCT FROM (snap.quote->>'discountMinor')::bigint
        AND ($2='' OR lower(o.order_number)=lower($2) OR EXISTS(SELECT 1 FROM lines WHERE lines.id=o.id)))
    SELECT order_number AS "Order",code AS "SKU",problem AS "Problem",'/orders/'||id AS link FROM problems
    ORDER BY (problem='Cost evidence unavailable'),order_number,code NULLS FIRST,line_id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100]);
  return {rows:rows.slice(0,100),more:rows.length>100,summary:'Uses the price, line discounts and unit costs recorded when the order was priced. Missing cost evidence is shown separately. An order-level discount is compared with its saved quote.'};
}
module.exports=[
  {id:80,key:'order-credit-limits',label:'Check order exposure against customer credit limits',readPage:credit},
  {id:82,key:'order-price-exceptions',label:'Find below-cost orders and discount differences',readPage:priceProblems}
];
