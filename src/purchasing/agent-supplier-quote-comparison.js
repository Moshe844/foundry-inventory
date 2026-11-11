'use strict';

const money=require('../domain/currency');
const summary='Compares exact supplier originals by product, quoted quantity, receiving site and currency. Each rank uses quoted goods value. A delivered cost is shown only when the original states the delivery charge. StockChief keeps supplier quotes available for review without accepting or ordering from them.';

async function review(db,ctx,{filter='',page=1,today}){
  const {rows}=await db.query(`WITH originals AS (
    SELECT d.id,d.supplier_id,d.message_id,d.document_reference,d.status,d.processed_at,d.facts::jsonb facts,
      s.name AS supplier,p.destination_location_id,p.id AS order_id
    FROM supplier_documents d JOIN suppliers s ON s.workspace_id=d.workspace_id AND s.id=d.supplier_id AND s.status='active'
    JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id AND p.supplier_id=d.supplier_id
    JOIN connection_email_messages m ON m.workspace_id=d.workspace_id AND m.id=d.message_id
      AND m.supplier_id=d.supplier_id AND m.trust_status='TRUSTED' AND m.classification='supplier'
    WHERE d.workspace_id=$1 AND d.document_type='quotation' AND d.status IN ('MATCHED','RECORDED','NEEDS_REVIEW')
  ), lines AS (
    SELECT o.*,k.code,coalesce(line->>'receivingSiteId',l.destination_location_id,o.destination_location_id) AS site_id,
      o.facts->>'currency' AS currency,o.facts->>'expectedArrivalDate' AS arrives,
      o.facts#>>'{quotationTerms,validThrough}' AS valid_through,
      CASE WHEN o.facts#>>'{quotationTerms,deliveryMinor}' ~ '^\\d{1,16}$'
        THEN (o.facts#>>'{quotationTerms,deliveryMinor}')::numeric END AS delivery_minor,
      line->>'skuId' AS sku_id,(line->>'quantity')::numeric AS quantity,(line->>'unitCostMinor')::numeric AS unit_minor
    FROM originals o CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(o.facts->'lines')='array' THEN o.facts->'lines' ELSE '[]'::jsonb END) line
    JOIN purchase_order_lines l ON l.workspace_id=$1 AND l.id=line->>'lineId' AND l.purchase_order_id=o.order_id AND l.sku_id=line->>'skuId'
    JOIN skus k ON k.workspace_id=l.workspace_id AND k.id=l.sku_id
    WHERE line->>'quantity' ~ '^\\d{1,16}$' AND line->>'unitCostMinor' ~ '^\\d{1,16}$'
      AND o.facts->>'currency'=ANY($5::text[]) AND ($2='' OR lower(k.code)=lower($2))
  ), latest AS (
    SELECT DISTINCT ON (supplier_id,sku_id,currency,site_id,quantity) *
    FROM lines WHERE quantity>0
    ORDER BY supplier_id,sku_id,currency,site_id,quantity,processed_at::timestamptz DESC,id DESC
  ), comparable AS (
    SELECT q.*,l.name site,unit_minor*quantity AS goods_minor,
      valid_through IS NOT NULL AND valid_through<$3 AS expired
    FROM latest q LEFT JOIN locations l ON l.workspace_id=$1 AND l.id=q.site_id
    WHERE unit_minor<=9007199254740991 AND unit_minor*quantity<=9007199254740991
  ), ranked AS (
    SELECT *,
      count(*) FILTER(WHERE NOT expired AND site_id IS NOT NULL) OVER (PARTITION BY sku_id,currency,site_id,quantity) AS suppliers,
      dense_rank() OVER (PARTITION BY sku_id,currency,site_id,quantity ORDER BY expired,goods_minor) AS rank
    FROM comparable
  )
  SELECT id,supplier,message_id,document_reference,code,currency,site,quantity,unit_minor,goods_minor,arrives,valid_through,
    delivery_minor,expired,suppliers,CASE WHEN NOT expired AND suppliers>1 THEN rank END AS rank
  FROM ranked ORDER BY code,currency,site,quantity,expired,goods_minor,supplier,id LIMIT 101 OFFSET $4`,
  [ctx.workspaceId,filter,today,(page-1)*100,[...Intl.supportedValuesOf('currency'),'CLF','UYW']]);
  return {rows:rows.slice(0,100).map(row=>{
    const fmt=value=>value==null?null:money.format(value,row.currency);
    const delivered=row.delivery_minor===null?null:Number(row.goods_minor)+Number(row.delivery_minor);
    const evidence=row.expired?'Expired':row.rank?'Comparable goods quote':'Needs another current quote for this quantity, site and currency';
    return {SKU:row.code,Supplier:row.supplier,Warehouse:row.site,Currency:row.currency,'Quoted stock units':row.quantity,
      'Supplier unit price':fmt(row.unit_minor),'Quoted goods':fmt(row.goods_minor),'Quoted delivery charge':fmt(row.delivery_minor),
      'Goods plus delivery':Number.isSafeInteger(delivered)?fmt(delivered):null,'Goods price rank':row.rank,
      'Promised arrival':row.arrives,'Valid through':row.valid_through,'Quote reference':row.document_reference,
      Status:evidence,link:'/mail/'+row.message_id};
  }),more:rows.length>100,summary};
}

module.exports={review};
