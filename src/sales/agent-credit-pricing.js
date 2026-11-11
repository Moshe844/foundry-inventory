'use strict';
const {review:credit}=require('./order-credit-exposure');

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
