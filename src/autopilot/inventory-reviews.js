'use strict';

const reports = [
  {id:2,key:'movement-history',label:'Explain stock changes',readPage:require('./stock-reading').movements},
  {id:4,key:'count-priorities',label:'Plan a cycle count',usesDate:true,summary:'Count negative positions first, then shelves with frequent adjustments, monthly A products, monthly B products and the highest recorded stock value.',sql:`
    WITH differences AS (SELECT sku_id,location_id,count(*) AS n FROM movements WHERE workspace_id=$1 AND operation='adjust'
      AND occurred_at::timestamptz>=now()-interval '90 days' GROUP BY sku_id,location_id)
    SELECT l.name AS "Shelf",s.code AS "SKU",i.name AS "Product",b.on_hand AS "Recorded units",coalesce(d.n,0) AS "Recent adjustments",
      CASE WHEN b.on_hand<0 THEN 'Negative stock' WHEN d.n IS NOT NULL THEN 'Prior adjustments' WHEN v.total_cost_minor IS NULL THEN 'Missing valuation' ELSE 'Recorded stock value' END AS "Reason"
    FROM balances b JOIN skus s ON s.id=b.sku_id JOIN items i ON i.id=s.item_id JOIN locations l ON l.id=b.location_id
    LEFT JOIN accounting_inventory_cost_balances v ON v.workspace_id=b.workspace_id AND v.sku_id=b.sku_id AND v.location_id=b.location_id
    LEFT JOIN differences d ON d.sku_id=b.sku_id AND d.location_id=b.location_id
    LEFT JOIN stockchief_runtime.product_class_values abc ON abc.workspace_id=b.workspace_id AND abc.item_id=i.id AND abc.month_start=date_trunc('month',$3::date)::date
    WHERE b.workspace_id=$1 AND ($2='' OR lower(s.code)=lower($2)) AND b.on_hand<>0
    ORDER BY (b.on_hand<0) DESC,coalesce(d.n,0) DESC,CASE abc.class WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END,v.total_cost_minor DESC NULLS LAST,l.id,s.id`},
  {id:10,key:'repeat-loss',label:'Find repeated stock losses',summary:'Repeated negative adjustments for the same item and warehouse in the same eight-hour local time band over 90 days. Review the original movements.',sql:`
    WITH loss AS (SELECT m.*,floor(extract(hour FROM (m.occurred_at::timestamptz AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC')))/8)::int*8 AS start_hour
      FROM movements m JOIN workspaces w ON w.id=m.workspace_id JOIN accounts a ON a.id=w.owner_account_id
      WHERE m.workspace_id=$1 AND m.operation='adjust' AND m.quantity_delta<0 AND m.occurred_at::timestamptz>=now()-interval '90 days')
    SELECT s.code AS "SKU",l.name AS "Warehouse",m.start_hour AS "Time band starts",count(*) AS "Adjustments",-sum(m.quantity_delta) AS "Units removed"
    FROM loss m JOIN skus s ON s.id=m.sku_id JOIN locations l ON l.id=m.location_id WHERE ($2='' OR lower(s.code)=lower($2))
    GROUP BY s.id,s.code,l.id,l.name,m.start_hour HAVING count(*)>1 ORDER BY count(*) DESC,s.id,l.id,m.start_hour`},
  {id:44,key:'delivery-check',label:'Compare deliveries with purchase orders',summary:'Ordered, received and outstanding quantities per item. An over-receipt is shown separately from an incomplete delivery.',sql:`
    SELECT p.po_number AS "Order",v.name AS "Supplier",s.code AS "SKU",l.quantity_units AS "Ordered",l.quantity_received_units AS "Received",
      greatest(l.quantity_units-l.quantity_received_units,0) AS "Still due",greatest(l.quantity_received_units-l.quantity_units,0) AS "Extra units",
      '/purchasing/orders/'||p.id AS link FROM purchase_orders p JOIN purchase_order_lines l ON l.purchase_order_id=p.id AND l.workspace_id=p.workspace_id
      JOIN skus s ON s.id=l.sku_id JOIN suppliers v ON v.id=p.supplier_id
    WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND ($2='' OR lower(p.po_number)=lower($2) OR lower(s.code)=lower($2))
    ORDER BY p.order_date DESC,p.id,l.line_number`},
  {id:90,key:'supplier-scorecard',label:'Review supplier performance',summary:'On-time rate uses completed, dated POs. Fill rate counts each stock unit up to the quantity ordered. Exceptions count disputed bills. Price increases compare consecutive ordered unit prices in the same currency and pack.',sql:`
    WITH po AS (SELECT * FROM purchase_orders WHERE workspace_id=$1 AND status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')),
    receipt AS (SELECT purchase_order_id,max(r.received_at::timestamptz AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC')) AS delivered FROM purchase_order_receipts r JOIN workspaces w ON w.id=r.workspace_id JOIN accounts a ON a.id=w.owner_account_id WHERE r.workspace_id=$1 GROUP BY r.purchase_order_id),
    delivery AS (SELECT p.supplier_id,count(*) AS orders,round(100*avg((r.delivered::date<=p.expected_date::date)::int) FILTER(WHERE p.status='RECEIVED'),1) AS on_time
      FROM po p LEFT JOIN receipt r ON r.purchase_order_id=p.id GROUP BY p.supplier_id),
    prices AS (SELECT p.supplier_id,l.*,lag(unit_cost) OVER(PARTITION BY p.supplier_id,l.sku_id,p.currency,l.units_per_purchase_unit ORDER BY p.ordered_at::timestamptz,p.id,l.line_number) AS prior
      FROM po p JOIN purchase_order_lines l ON l.purchase_order_id=p.id AND l.workspace_id=p.workspace_id),
    fill AS (SELECT supplier_id,round(100*sum(least(quantity_received_units,quantity_units))::numeric/nullif(sum(quantity_units),0),1) AS filled,
      count(*) FILTER(WHERE unit_cost>prior) AS increases FROM prices GROUP BY supplier_id),
    disputed AS (SELECT supplier_id,count(*) AS n FROM accounting_supplier_bills WHERE workspace_id=$1 AND status='DISPUTED' GROUP BY supplier_id)
    SELECT s.name AS "Supplier",d.orders AS "Placed orders",d.on_time AS "On time %",f.filled AS "Filled %",f.increases AS "Price increases",coalesce(e.n,0) AS "Disputed bills"
    FROM delivery d JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN fill f ON f.supplier_id=s.id LEFT JOIN disputed e ON e.supplier_id=s.id
    WHERE ($2='' OR lower(s.name)=lower($2)) ORDER BY s.name,s.id`},
  {id:92,key:'compare-quotes',label:'Compare supplier quotations',summary:'Latest documented quotation per supplier, SKU and currency. Unit prices use the stocking unit. Open the originating order to check quantities and terms.',sql:`
    WITH latest AS (SELECT DISTINCT ON (d.supplier_id,line->>'skuId',d.facts::jsonb->>'currency') d.supplier_id,d.purchase_order_id,d.status,line,
      d.document_reference AS ref,d.facts::jsonb->>'currency' AS currency,d.processed_at FROM supplier_documents d
      CROSS JOIN LATERAL jsonb_array_elements(d.facts::jsonb->'lines') line
      WHERE d.workspace_id=$1 AND d.document_type='quotation' AND d.status IN ('MATCHED','RECORDED','NEEDS_REVIEW') AND line->>'unitCostMinor' IS NOT NULL
      ORDER BY d.supplier_id,line->>'skuId',d.facts::jsonb->>'currency',d.processed_at::timestamptz DESC,d.id DESC)
    SELECT s.code AS "SKU",v.name AS "Supplier",q.currency AS "Currency",(q.line->>'unitCostMinor')::bigint AS price_minor,q.ref AS "Quote reference",
      q.status AS "Review status",q.processed_at AS "Recorded",'/purchasing/orders/'||q.purchase_order_id AS link
    FROM latest q JOIN skus s ON s.workspace_id=$1 AND s.id=q.line->>'skuId' JOIN suppliers v ON v.id=q.supplier_id
    WHERE ($2='' OR lower(s.code)=lower($2)) ORDER BY s.code,q.currency,price_minor,v.id`},
  {id:117,key:'stock-by-location',label:'Show stock across locations',summary:'Current recorded balances by item and location.',sql:`
    SELECT s.code AS "SKU",i.name AS "Product",l.name AS "Location",b.on_hand AS "Units",'/inventory/'||i.id AS link
    FROM balances b JOIN skus s ON s.id=b.sku_id JOIN items i ON i.id=s.item_id JOIN locations l ON l.id=b.location_id
    WHERE b.workspace_id=$1 AND ($2='' OR lower(s.code)=lower($2)) ORDER BY s.code,s.id,l.name,l.id`},
  {id:195,key:'serial-history',label:'Trace a serial number',summary:'Recorded receipts, movements and issues in chronological order for the selected serial.',requiresFilter:true,sql:`
    WITH serial_moves AS (SELECT u.id,u.serial,m.id AS movement FROM serial_units u JOIN movements m ON m.workspace_id=u.workspace_id AND m.serial_unit_id=u.id
      WHERE u.workspace_id=$1 AND lower(u.serial)=lower($2) UNION
      SELECT u.id,u.serial,x.movement_id FROM serial_units u JOIN stockchief_runtime.inventory_movement_serial_units x ON x.workspace_id=u.workspace_id AND x.serial_unit_id=u.id
      WHERE u.workspace_id=$1 AND lower(u.serial)=lower($2))
    SELECT x.serial AS "Serial",s.code AS "SKU",m.occurred_at AS "When",m.operation AS "Action",l.name AS "Location",m.reference AS "Reference",u.name AS "Recorded by"
    FROM serial_moves x JOIN movements m ON m.workspace_id=$1 AND m.id=x.movement JOIN skus s ON s.id=m.sku_id
    JOIN locations l ON l.id=m.location_id JOIN users u ON u.id=m.actor_user_id ORDER BY m.seq,x.id`}
];
module.exports=reports;
