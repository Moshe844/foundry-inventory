'use strict';

const money=require('../domain/currency');
const summary='Compares exact supplier originals by product, quoted quantity, receiving site and currency. Each rank uses quoted goods value. A delivered cost is shown only when the original states the delivery charge. StockChief keeps supplier quotes available for review without accepting or ordering from them.';

// Job 93 adds replies to RFQs: they are quotations held against the RFQ, not
// a purchase order, and are delivered to the location the RFQ named.
async function review(db,ctx,{filter='',page=1,today,rfqId=null}){
  const {rows}=await db.query(`WITH originals AS (
    SELECT d.id,d.supplier_id,d.message_id,d.document_reference,d.status,d.processed_at,d.facts::jsonb facts,
      s.name AS supplier,coalesce(p.destination_location_id,r.snapshot->>'locationId') AS destination_location_id,p.id AS order_id,r.id AS rfq_id
    FROM supplier_documents d JOIN suppliers s ON s.workspace_id=d.workspace_id AND s.id=d.supplier_id AND s.status='active'
    LEFT JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id AND p.supplier_id=d.supplier_id
    LEFT JOIN stockchief_runtime.agent_rfq_requests r ON d.purchase_order_id IS NULL AND r.workspace_id=d.workspace_id AND r.id=d.facts::jsonb->>'rfqRequestId'
      AND EXISTS(SELECT 1 FROM stockchief_runtime.agent_rfq_deliveries x WHERE x.workspace_id=r.workspace_id AND x.request_id=r.id AND x.supplier_id=d.supplier_id)
    JOIN connection_email_messages m ON m.workspace_id=d.workspace_id AND m.id=d.message_id
      AND m.supplier_id=d.supplier_id AND m.trust_status='TRUSTED' AND m.classification='supplier'
    WHERE d.workspace_id=$1 AND d.document_type='quotation' AND d.status IN ('MATCHED','RECORDED','NEEDS_REVIEW')
      AND (p.id IS NOT NULL OR r.id IS NOT NULL) AND ($6::text IS NULL OR r.id=$6)
  ), lines AS (
    SELECT o.*,k.code,coalesce(line->>'receivingSiteId',l.destination_location_id,o.destination_location_id) AS site_id,
      o.facts->>'currency' AS currency,o.facts->>'expectedArrivalDate' AS arrives,
      o.facts#>>'{quotationTerms,validThrough}' AS valid_through,
      CASE WHEN o.facts#>>'{quotationTerms,deliveryMinor}' ~ '^\\d{1,16}$'
        THEN (o.facts#>>'{quotationTerms,deliveryMinor}')::numeric END AS delivery_minor,
      line->>'skuId' AS sku_id,(line->>'quantity')::numeric AS quantity,(line->>'unitCostMinor')::numeric AS unit_minor
    FROM originals o CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(o.facts->'lines')='array' THEN o.facts->'lines' ELSE '[]'::jsonb END) line
    LEFT JOIN purchase_order_lines l ON o.order_id IS NOT NULL AND l.workspace_id=$1 AND l.id=line->>'lineId' AND l.purchase_order_id=o.order_id AND l.sku_id=line->>'skuId'
    JOIN skus k ON k.workspace_id=$1 AND k.id=CASE WHEN o.order_id IS NOT NULL THEN l.sku_id ELSE line->>'skuId' END
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
  SELECT id,supplier,supplier_id,sku_id,rfq_id,message_id,document_reference,code,currency,site,quantity,unit_minor,goods_minor,arrives,valid_through,
    delivery_minor,expired,suppliers,CASE WHEN NOT expired AND suppliers>1 THEN rank END AS rank
  FROM ranked ORDER BY code,currency,site,quantity,expired,goods_minor,supplier,id LIMIT 101 OFFSET $4`,
  [ctx.workspaceId,filter,today,(page-1)*100,[...Intl.supportedValuesOf('currency'),'CLF','UYW'],rfqId]);
  return {rows:rows.slice(0,100).map(row=>{
    const fmt=value=>value==null?null:money.format(value,row.currency);
    const delivered=row.delivery_minor===null?null:Number(row.goods_minor)+Number(row.delivery_minor);
    const evidence=row.expired?'Expired':row.rank?'Comparable goods quote':'Needs another current quote for this quantity, site and currency';
    return {SKU:row.code,Supplier:row.supplier,Warehouse:row.site,Currency:row.currency,'Quoted stock units':row.quantity,
      'Supplier unit price':fmt(row.unit_minor),'Quoted goods':fmt(row.goods_minor),'Quoted delivery charge':fmt(row.delivery_minor),
      'Goods plus delivery':Number.isSafeInteger(delivered)?fmt(delivered):null,'Goods price rank':row.rank,
      'Promised arrival':row.arrives,'Valid through':row.valid_through,'Quote reference':row.document_reference,
      Status:evidence,link:'/mail/'+row.message_id,...(row.rfq_id?{RFQ:row.document_reference}:{}),
      ...(rfqId?{supplierId:row.supplier_id,skuId:row.sku_id,documentId:row.id,goodsMinor:Number(row.goods_minor),unitMinor:Number(row.unit_minor),deliveryMinor:row.delivery_minor===null?null:Number(row.delivery_minor)}:{})};
  }),more:rows.length>100,summary};
}

module.exports={review};
