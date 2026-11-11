'use strict';

const money=require('../domain/currency');

const summary='Supplier prices are compared with the approved order or the latest earlier trusted supplier price for the exact product, currency and pricing unit.';
const factors=[...Intl.supportedValuesOf('currency'),'CLF','UYW'].map(code=>"('"+code+"',"+10**money.exponent(code)+')').join(',');

const invoices=`WITH evidence AS (
  SELECT b.workspace_id,b.purchase_order_id,b.supplier_id,l.purchase_order_line_id,l.sku_id,b.currency,
    coalesce(l.source_unit_cost_minor,l.unit_cost_minor)::numeric AS amount,
    coalesce(l.source_price_quantity,l.price_quantity)::numeric AS priced,
    l.secondary_quantity IS NOT NULL AS measured,recorded.amount AS checked_minor,false AS verify_live,'Invoice' AS kind,b.id AS source_id,
    coalesce(nullif(b.supplier_invoice_number,''),b.bill_number) AS document,'/money/bills/'||b.id AS href,b.status='DISPUTED' AS actionable
  FROM accounting_supplier_bills b JOIN accounting_supplier_bill_lines l ON l.workspace_id=b.workspace_id AND l.bill_id=b.id
  LEFT JOIN LATERAL (
    SELECT (d->>'approvedUnitCostMinor')::numeric AS amount
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.exception_detail::jsonb->'differences')='array'
      THEN b.exception_detail::jsonb->'differences' ELSE '[]'::jsonb END) d
    WHERE d->>'kind'='price_outside_approved_cost' AND d->>'line'=l.line_number::text LIMIT 1
  ) recorded ON true
  WHERE b.workspace_id=$1 AND b.status IN('DISPUTED','OPEN','PARTIALLY_PAID','PAID')
  UNION ALL
  SELECT q.workspace_id,q.purchase_order_id,q.supplier_id,l->>'purchaseOrderLineId',l->>'skuId',
    q.prepared_input->>'currency',(l->>'unitCostMinor')::numeric,(l->>'priceQuantity')::numeric,
    l->>'secondaryQuantity' IS NOT NULL,(difference.value->>'approvedUnitCostMinor')::numeric,true,
    'Invoice',q.id,q.invoice_number,'/autopilot/supplier-invoices/'||q.id,true
  FROM stockchief_runtime.agent_supplier_invoice_intakes q
  LEFT JOIN stockchief_runtime.agent_supplier_invoice_uploads u ON u.workspace_id=q.workspace_id AND u.id=q.source_upload_id AND u.content_hash=q.source_hash AND u.status='READABLE'
  LEFT JOIN connection_email_attachments a ON a.workspace_id=q.workspace_id AND a.id=q.attachment_id AND a.content_hash=q.source_hash AND a.extraction_status='READABLE'
  CROSS JOIN LATERAL jsonb_array_elements(q.prepared_input->'lines') WITH ORDINALITY AS lines(l,ordinal)
  CROSS JOIN LATERAL jsonb_array_elements(q.comparison->'differences') AS difference(value)
  WHERE q.workspace_id=$1 AND q.status IN('EXCEPTION','READY') AND q.bill_id IS NULL AND q.duplicate_bill_id IS NULL
    AND q.document->>'documentType'='invoice' AND (u.id IS NOT NULL OR a.id IS NOT NULL)
    AND q.source_text_hash=encode(sha256(convert_to(coalesce(u.extracted_text,a.extracted_text),'UTF8')),'hex')
    AND difference.value->>'kind'='price_outside_approved_cost' AND (difference.value->>'line')::bigint=lines.ordinal
    AND difference.value->>'approvedUnitCostMinor' IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.comparison->'differences') d
      WHERE d->>'kind'='document_total_differs' OR d->>'kind'='line_total_differs' AND (d->>'line')::bigint=lines.ordinal)
    AND NOT EXISTS(SELECT 1 FROM accounting_supplier_bills b WHERE b.workspace_id=q.workspace_id AND b.supplier_id=q.supplier_id
      AND lower(b.supplier_invoice_number)=lower(q.invoice_number) AND b.status<>'VOID')
  UNION ALL
  SELECT d.workspace_id,d.purchase_order_id,p.supplier_id,l.id,l.sku_id,d.facts::jsonb->>'currency',
    (f->>'unitCostMinor')::numeric,1,false,NULL,false,replace(initcap(d.document_type),'_',' '),d.id,coalesce(d.document_reference,d.id),
    '/purchasing/orders/'||p.id,d.status='NEEDS_REVIEW'
  FROM supplier_documents d CROSS JOIN LATERAL jsonb_array_elements(d.facts::jsonb->'lines') f
  JOIN purchase_orders p ON p.workspace_id=d.workspace_id AND p.id=d.purchase_order_id
  JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id AND l.id=f->>'lineId'
  WHERE d.workspace_id=$1 AND d.supplier_id=p.supplier_id AND d.status<>'IGNORED'
    AND d.document_type IN('quotation','price_update') AND f->>'unitCostMinor' IS NOT NULL
)
SELECT s.code AS sku,v.name AS supplier,p.po_number AS po,e.kind,e.source_id,e.document,p.currency,e.amount,e.priced,
  trunc(prior.amount)::text AS prior_amount,'1'::text AS prior_priced,
  'Approved purchase order '||p.po_number AS basis,e.href,e.actionable,
  coalesce(i.secondary_unit_label,i.unit_label) AS unit
FROM evidence e JOIN purchase_orders p ON p.workspace_id=e.workspace_id AND p.id=e.purchase_order_id AND p.supplier_id=e.supplier_id AND p.currency=e.currency
JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id AND l.id=e.purchase_order_line_id AND l.sku_id=e.sku_id
JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id
JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
JOIN (VALUES ${factors}) scale(currency,factor) ON scale.currency=p.currency
CROSS JOIN LATERAL (SELECT coalesce(e.checked_minor,l.unit_cost::numeric*scale.factor) AS amount) prior
WHERE p.status IN('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND e.measured=(i.secondary_unit_label IS NOT NULL)
  AND e.priced>0 AND prior.amount BETWEEN 0 AND 9007199254740991 AND e.amount<=9007199254740991
  AND prior.amount=trunc(prior.amount) AND (NOT e.verify_live OR prior.amount=l.unit_cost::numeric*scale.factor)
  AND e.amount > prior.amount*e.priced`;

const lists=`SELECT f.sku_code AS sku,s.name AS supplier,NULL AS po,'Price list' AS kind,p.id AS source_id,
  p.filename AS document,f.currency,f.amount_minor AS amount,f.pricing_quantity AS priced,
  f.prior->>'amountMinor' AS prior_amount,f.prior->>'pricing_quantity' AS prior_priced,
  (f.prior->>'kind')||' '||(f.prior->>'reference')||' · '||f.sheet||', row '||f.row_number AS basis,
  '/autopilot/supplier-price-lists/'||p.id AS href,p.reviewed_at IS NULL AS actionable,f.prior->>'unit' AS unit
FROM stockchief_runtime.agent_supplier_price_lists p
JOIN stockchief_runtime.agent_supplier_price_list_findings f ON f.workspace_id=p.workspace_id AND f.source_id=p.id
LEFT JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
WHERE p.workspace_id=$1 AND p.status='READY' AND f.result='HIGHER'`;

const findings=`(${invoices}) UNION ALL ${lists}`;
const notices=`SELECT DISTINCT 91 AS job,kind,source_id AS ref,href AS link,$3::date AS due
  FROM (${findings}) increases WHERE actionable`;

function format(amount,quantity,currency){
  const price=money.format(String(amount).replace(/\.0+$/,''),currency);
  const priced=String(quantity).replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1');
  return priced==='1'?price:price+' per '+priced+' pricing units';
}

async function readPage(db,ctx,{filter,page,adviceOnly}){
  const {rows}=await db.query(`SELECT * FROM (${findings}) increases
    WHERE ($2='' OR lower(sku)=lower($2) OR lower(supplier)=lower($2) OR lower(document)=lower($2) OR lower(po)=lower($2))
    ORDER BY actionable DESC,supplier,sku,document,kind,source_id,amount
    LIMIT $3 OFFSET $4`,[ctx.workspaceId,filter,adviceOnly?1:101,(page-1)*100]);
  return {summary,more:rows.length>100,rows:rows.slice(0,100).map(r=>({
    SKU:r.sku,Supplier:r.supplier,Order:r.po,Source:r.kind,Document:r.document,Currency:r.currency,
    'Previous trusted price':format(r.prior_amount,r.prior_priced,r.currency),
    'Supplier unit price':format(r.amount,r.priced,r.currency),'Pricing unit':r.unit,Basis:r.basis,link:r.href
  }))};
}

module.exports={summary,notices,readPage,format};
