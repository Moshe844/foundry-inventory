'use strict';

module.exports=[
  {id:22,key:'supplier-options',label:'Compare buying options',summary:'Active supplier terms for each SKU. Cost ranks compare the same currency. Lead-time ranks use observed delivery times after three received orders, then saved item or supplier terms if available. Check minimums before ordering.',sql:`
    WITH offers AS (SELECT si.*,s.currency,s.name,lead.effective_lead AS days
      FROM supplier_items si JOIN suppliers s ON s.id=si.supplier_id AND s.workspace_id=si.workspace_id
      JOIN stockchief_runtime.supplier_planning_leads lead ON lead.supplier_item_id=si.id
      WHERE si.workspace_id=$1 AND si.is_active=1 AND s.status='active')
    SELECT k.code AS "SKU",o.name AS "Supplier",o.currency AS "Currency",o.last_unit_cost AS "Unit price",o.days AS "Lead days",
      o.minimum_order_quantity AS "Minimum quantity",o.units_per_purchase_unit AS "Pack size",
      CASE WHEN o.last_unit_cost IS NOT NULL THEN dense_rank() OVER(PARTITION BY o.sku_id,o.currency ORDER BY o.last_unit_cost NULLS LAST) END AS "Cost rank",
      CASE WHEN o.days IS NOT NULL THEN dense_rank() OVER(PARTITION BY o.sku_id ORDER BY o.days NULLS LAST) END AS "Speed rank"
    FROM offers o JOIN skus k ON k.id=o.sku_id WHERE ($2='' OR lower(k.code)=lower($2))
    ORDER BY k.code,o.currency,o.last_unit_cost NULLS LAST,o.days NULLS LAST,o.id`},
  {id:34,key:'measured-lead-times',label:'Compare promised and actual supplier lead times',summary:'First accepted receipt of this item on each of the last 12 received POs in a year. After three orders the reorder calculation uses the observed average, rounded up to whole days.',sql:`
    SELECT k.code AS "SKU",s.name AS "Supplier",l.samples AS "Delivered orders",l.configured_lead AS "Configured days",
      l.promised_days AS "Average promised days",l.measured_days AS "Average actual days",l.effective_lead AS "Supplier planning days"
    FROM stockchief_runtime.supplier_planning_leads l JOIN skus k ON k.id=l.sku_id JOIN suppliers s ON s.id=l.supplier_id
    WHERE l.workspace_id=$1 AND ($2='' OR lower(k.code)=lower($2) OR lower(s.name)=lower($2)) ORDER BY k.code,s.name,s.id`},
  {id:32,key:'overdue-incoming',label:'Review overdue incoming stock',summary:'Open POs past the recorded delivery date with units still due. Verify with the supplier before changing incoming stock.',sql:`
    SELECT p.po_number AS "Order",v.name AS "Supplier",p.expected_date AS "Promised",s.code AS "SKU",
      l.quantity_units-l.quantity_received_units AS "Still due",'/purchasing/orders/'||p.id AS link
    FROM purchase_orders p JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    JOIN skus s ON s.id=l.sku_id JOIN suppliers v ON v.id=p.supplier_id
    WHERE p.workspace_id=$1 AND p.expected_date::date<$3::date AND p.status IN ('ORDERED','PARTIALLY_RECEIVED')
      AND l.quantity_units>l.quantity_received_units AND ($2='' OR lower(s.code)=lower($2) OR lower(v.name)=lower($2))
    ORDER BY p.expected_date,p.id,l.line_number`,usesDate:true},
  {id:78,key:'customer-check-in',label:'Draft check-ins for inactive customers',summary:'Customers with at least two shipped orders and no shipment in 90 days. Review the draft before contacting anyone.',sql:`
    WITH sales AS (SELECT o.customer_id,max(h.shipped_at::timestamptz)::date AS last_sale,count(DISTINCT o.id) AS n
      FROM sales_orders o JOIN sales_shipments h ON h.sales_order_id=o.id AND h.workspace_id=o.workspace_id
      WHERE o.workspace_id=$1 AND h.status IN ('SHIPPED','DELIVERED') AND h.shipped_at IS NOT NULL GROUP BY o.customer_id)
    SELECT c.name AS "Customer",s.last_sale::text AS "Last shipment",s.n AS "Previous orders",
      'Hello '||c.name||', our last shipment to you was on '||s.last_sale::text||'. Would you like an updated stock list or help planning your next order?' AS "Draft"
    FROM sales s JOIN customers c ON c.id=s.customer_id AND c.record_state='ACTIVE'
    WHERE s.n>=2 AND s.last_sale<($3::date-90) AND ($2='' OR lower(c.name)=lower($2)) ORDER BY s.last_sale,c.id`,usesDate:true},
  {id:79,key:'bought-together',label:'Find items commonly bought together',requiresFilter:true,summary:'Companion items from other completed or partly fulfilled orders containing the selected SKU. Review these before adding them to a quote.',sql:`
    WITH orders AS (SELECT DISTINCT l.sales_order_id,l.sku_id FROM sales_order_lines l JOIN skus s ON s.id=l.sku_id
      WHERE l.workspace_id=$1 AND lower(s.code)=lower($2) AND l.quantity_fulfilled>0)
    SELECT s.code AS "SKU",i.name AS "Product",count(DISTINCT l.sales_order_id) AS "Shared orders"
    FROM orders o JOIN sales_order_lines l ON l.workspace_id=$1 AND l.sales_order_id=o.sales_order_id AND l.sku_id<>o.sku_id AND l.quantity_fulfilled>0
    JOIN skus s ON s.id=l.sku_id AND s.is_active=1 JOIN items i ON i.id=s.item_id AND i.is_active=1
    GROUP BY s.id,s.code,i.name ORDER BY count(DISTINCT l.sales_order_id) DESC,s.id`},
  {id:88,key:'customer-health',label:'Flag customers buying less',summary:'Compare distinct shipped orders in the last 30 days with the preceding 30 days.',sql:`
    WITH history AS (SELECT o.customer_id,count(DISTINCT o.id) FILTER(WHERE h.shipped_at::timestamptz>=now()-interval '30 days') AS recent,
      count(DISTINCT o.id) FILTER(WHERE h.shipped_at::timestamptz<now()-interval '30 days') AS prior
      FROM sales_orders o JOIN sales_shipments h ON h.workspace_id=o.workspace_id AND h.sales_order_id=o.id
      WHERE o.workspace_id=$1 AND h.status IN ('SHIPPED','DELIVERED') AND h.shipped_at::timestamptz BETWEEN now()-interval '60 days' AND now() GROUP BY o.customer_id)
    SELECT c.name AS "Customer",h.prior AS "Prior orders",h.recent AS "Recent orders",
      CASE WHEN h.prior=0 THEN 'New activity' WHEN h.recent=0 THEN 'Stopped buying' WHEN h.recent<h.prior THEN 'Buying less' WHEN h.recent>h.prior THEN 'Buying more' ELSE 'Stable' END AS "Health"
    FROM history h JOIN customers c ON c.id=h.customer_id WHERE ($2='' OR lower(c.name)=lower($2)) ORDER BY h.recent-h.prior,c.id`},
  {id:91,key:'supplier-price-increases',label:'Flag higher supplier prices',summary:'Supplier document prices compared with the original PO. Each difference retains its source and currency.',sql:`
    WITH evidence AS (
      SELECT d.purchase_order_id,p.id AS line_id,(f->>'unitCostMinor')::numeric AS minor,d.document_reference AS reference,d.document_type AS kind,d.facts::jsonb->>'currency' AS currency
      FROM supplier_documents d CROSS JOIN LATERAL jsonb_array_elements(d.facts::jsonb->'lines') f
      JOIN purchase_order_lines p ON p.workspace_id=$1 AND p.id=f->>'lineId' AND p.purchase_order_id=d.purchase_order_id
      WHERE d.workspace_id=$1 AND d.status<>'IGNORED' AND d.document_type IN ('quotation','price_update') AND f->>'unitCostMinor' IS NOT NULL
      UNION ALL SELECT b.purchase_order_id,l.purchase_order_line_id,l.unit_cost_minor,b.supplier_invoice_number,'invoice',b.currency FROM accounting_supplier_bill_lines l
      JOIN accounting_supplier_bills b ON b.id=l.bill_id AND b.workspace_id=l.workspace_id WHERE l.workspace_id=$1 AND b.status<>'VOID')
    SELECT s.code AS "SKU",v.name AS "Supplier",p.po_number AS "Order",e.kind AS "Source",e.reference AS "Document",p.currency AS "Currency",
      l.unit_cost AS "PO unit price",e.minor AS price_minor,'/purchasing/orders/'||p.id AS link
    FROM evidence e JOIN purchase_orders p ON p.id=e.purchase_order_id AND p.workspace_id=$1 JOIN purchase_order_lines l ON l.id=e.line_id AND l.workspace_id=$1
    JOIN suppliers v ON v.id=p.supplier_id JOIN skus s ON s.id=l.sku_id WHERE p.currency=e.currency AND l.unit_cost IS NOT NULL
      AND ($2='' OR lower(s.code)=lower($2)) ORDER BY v.name,s.code,p.id,e.kind,e.reference`,priceIncrease:true},
  {id:99,key:'invoice-errors',label:'Find supplier invoice errors',summary:'Unresolved three-way matching exceptions on supplier bills. Open the bill to compare it with the approved price, prior billings and physical receipts.',sql:`
    SELECT s.name AS "Supplier",coalesce(b.supplier_invoice_number,b.bill_number) AS "Invoice",p.po_number AS "Order",
      d->>'kind' AS "Problem",d->>'line' AS "Line",d->>'received' AS "Received",d->>'previouslyBilled' AS "Previously billed",
      d->>'billed' AS "Invoiced",'/money/bills/'||b.id AS link
    FROM accounting_supplier_bills b JOIN suppliers s ON s.id=b.supplier_id LEFT JOIN purchase_orders p ON p.id=b.purchase_order_id
    CROSS JOIN LATERAL jsonb_array_elements(b.exception_detail::jsonb->'differences') d
    WHERE b.workspace_id=$1 AND b.status='DISPUTED' AND ($2='' OR lower(s.name)=lower($2) OR lower(b.supplier_invoice_number)=lower($2))
    ORDER BY b.issue_date,b.id,(d->>'line')::integer NULLS LAST,d->>'kind'`},
  {id:105,key:'supplier-credits',label:'Trace supplier credits to their bills',summary:'Posted supplier credit notes with their source bill and posting reference. For returns still awaiting credit, open supplier returns.',sql:`
    SELECT s.name AS "Supplier",coalesce(c.credit_number,'Unnumbered credit') AS "Credit",c.credit_date AS "Credit date",c.amount_minor AS "Amount",
      b.currency AS "Currency",b.bill_number AS "Bill",b.status AS "Bill status",'/money/bills/'||b.id AS link
    FROM accounting_supplier_credits c JOIN suppliers s ON s.id=c.supplier_id JOIN accounting_supplier_bills b ON b.workspace_id=c.workspace_id AND b.id=c.supplier_bill_id
    WHERE c.workspace_id=$1 AND ($2='' OR lower(s.name)=lower($2) OR lower(c.credit_number)=lower($2)) ORDER BY c.credit_date DESC,c.id`},
  {id:148,key:'rising-demand',label:'Find items selling faster',summary:'Shipped units in the last seven days compared with the preceding seven days. Products with no earlier shipments are identified separately.',sql:`
    WITH demand AS (SELECT l.sku_id,coalesce(sum(l.quantity) FILTER(WHERE h.shipped_at::timestamptz>=now()-interval '7 days'),0) AS current_units,
      coalesce(sum(l.quantity) FILTER(WHERE h.shipped_at::timestamptz<now()-interval '7 days'),0) AS previous_units FROM sales_shipments h
      JOIN sales_shipment_lines l ON l.workspace_id=h.workspace_id AND l.shipment_id=h.id WHERE h.workspace_id=$1 AND h.status IN ('SHIPPED','DELIVERED')
      AND h.shipped_at::timestamptz BETWEEN now()-interval '14 days' AND now() GROUP BY l.sku_id)
    SELECT s.code AS "SKU",i.name AS "Product",d.previous_units AS "Previous 7 days",d.current_units AS "Last 7 days",
      CASE WHEN d.previous_units=0 THEN 'New sales' ELSE round(100*(d.current_units-d.previous_units)::numeric/d.previous_units,1)::text||'%' END AS "Increase"
    FROM demand d JOIN skus s ON s.id=d.sku_id JOIN items i ON i.id=s.item_id WHERE d.current_units>d.previous_units AND ($2='' OR lower(s.code)=lower($2))
    ORDER BY d.current_units-d.previous_units DESC,s.id`}
];
