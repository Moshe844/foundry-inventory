'use strict';

const reports = [
  {id:2,key:'movement-history',label:'Explain stock changes',readPage:require('./stock-reading').movements},
  {id:4,key:'count-priorities',label:'Plan a cycle count',filterLabel:'Exact SKU',readPage:require('../operations/agent-daily-cycle-counts').review},
  require('./stock-loss-patterns').definition,
  {id:44,key:'delivery-check',label:'Compare deliveries with purchase orders',summary:'Ordered, received and outstanding quantities per item. An over-receipt is shown separately from an incomplete delivery.',sql:`
    SELECT p.po_number AS "Order",v.name AS "Supplier",s.code AS "SKU",l.quantity_units AS "Ordered",l.quantity_received_units AS "Received",
      greatest(l.quantity_units-l.quantity_received_units,0) AS "Still due",greatest(l.quantity_received_units-l.quantity_units,0) AS "Extra units",
      '/purchasing/orders/'||p.id AS link FROM purchase_orders p JOIN purchase_order_lines l ON l.purchase_order_id=p.id AND l.workspace_id=p.workspace_id
      JOIN skus s ON s.id=l.sku_id JOIN suppliers v ON v.id=p.supplier_id
    WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND ($2='' OR lower(p.po_number)=lower($2) OR lower(s.code)=lower($2))
    ORDER BY p.order_date DESC,p.id,l.line_number`},
  {id:90,key:'supplier-scorecard',label:'Review supplier performance',summary:'Delivery, fill and price figures cover warehouse purchases. On-time rate uses completed, dated POs. Fill rate counts stock units up to the quantity ordered. Exceptions count disputed bills. Price increases compare consecutive ordered unit prices in the same currency and pack.',sql:`
    WITH po AS (SELECT id,workspace_id,supplier_id,status,currency,ordered_at,expected_date FROM purchase_orders p
      WHERE workspace_id=$1 AND status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
        AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'),
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
  {id:195,key:'serial-history',label:'Trace a serial number',summary:'Receipts, transfers, issues, supplier dispatches and returns in time order. The SKU identifies the product when a serial number appears on more than one product.',requiresFilter:true,sql:`
    WITH serial_moves AS (SELECT u.id,u.serial,m.id AS movement FROM serial_units u JOIN movements m ON m.workspace_id=u.workspace_id AND m.serial_unit_id=u.id
      WHERE u.workspace_id=$1 AND lower(u.serial)=lower($2) UNION
      SELECT u.id,u.serial,x.movement_id FROM serial_units u JOIN stockchief_runtime.inventory_movement_serial_units x ON x.workspace_id=u.workspace_id AND x.serial_unit_id=u.id
      WHERE u.workspace_id=$1 AND lower(u.serial)=lower($2))
    SELECT x.serial AS "Serial",s.code AS "SKU",m.occurred_at AS "When",m.operation AS "Action",
      CASE WHEN m.quantity_delta<0 THEN 'Out' ELSE 'In' END AS "Direction",
      l.name AS "Location",m.reference AS "Reference",u.name AS "Recorded by",'/inventory/'||m.item_id AS link,m.seq AS sequence
    FROM serial_moves x JOIN movements m ON m.workspace_id=$1 AND m.id=x.movement
    JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id
    JOIN locations l ON l.workspace_id=m.workspace_id AND l.id=m.location_id
    JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.actor_user_id`}
];
module.exports=reports;
