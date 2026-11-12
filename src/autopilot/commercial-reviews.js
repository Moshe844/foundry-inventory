'use strict';

module.exports=[
  {id:24,key:'combine-draft-orders',label:'Combine unsent supplier orders',summary:'Compare drafts with the same supplier, currency and delivery date. StockChief uses recorded freight terms when the drafts share one receiving location. An approved rule can combine drafts when those terms show a saving. Original drafts stay in the history.',
    sql:`WITH draft AS (SELECT p.*,s.name FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
      WHERE p.workspace_id=$1 AND p.status='DRAFT' AND ($2='' OR lower(s.name)=lower($2)))
      SELECT name AS "Supplier",currency AS "Currency",expected_date AS "Expected date",count(*) AS "Drafts",
      array_to_string((array_agg(po_number ORDER BY order_date,id))[1:20],', ') AS "PO numbers"
      FROM draft GROUP BY supplier_id,name,currency,expected_date HAVING count(*)>1 ORDER BY name,currency,expected_date NULLS LAST,supplier_id`},
  {id:25,key:'split-draft-orders',label:'Split a draft purchase order',summary:'Split a draft into separate orders for each receiving warehouse, a maximum goods value per order, or delivery dates assigned to the original line numbers. Each replacement needs its usual approval before placement.',
    sql:`SELECT p.po_number AS "PO",s.name AS "Supplier",p.expected_date AS "Expected date",count(l.id) AS "Lines",'/purchasing/orders/'||p.id AS link
      FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
      JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
      WHERE p.workspace_id=$1 AND p.status='DRAFT' AND ($2='' OR lower(s.name)=lower($2) OR lower(p.po_number)=lower($2))
      GROUP BY p.id,p.po_number,s.name,p.expected_date ORDER BY p.expected_date NULLS LAST,p.po_number,p.id`},
  {id:77,key:'margin-prices',label:'Review selling prices after a cost increase',readPage:require('../pricing/agent-margin-prices').review},
  {id:23,key:'supplier-minimums',label:'Review supplier minimums and free shipping',readPage:require('../purchasing/agent-order-quantities').supplierMinimums},
  {id:27,key:'supplier-packs',label:'Check supplier pack and case orders',summary:'Replenishment rounds the required units up to a complete purchasing unit and to the supplier’s order multiple.',
    sql:`SELECT k.code AS "SKU",v.name AS "Supplier",si.units_per_purchase_unit AS "Units per pack",
      si.order_multiple AS "Order multiple in packs",si.minimum_order_quantity AS "Minimum packs" FROM supplier_items si
      JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id AND v.status='active'
      JOIN skus k ON k.workspace_id=si.workspace_id AND k.id=si.sku_id AND k.is_active=1
      WHERE si.workspace_id=$1 AND si.is_active=1 AND ($2='' OR lower(k.code)=lower($2) OR lower(v.name)=lower($2))
      ORDER BY k.code,v.name,si.id`},
  {id:26,key:'open-to-buy',label:'Plan purchasing within the monthly budget',filterLabel:'Month (YYYY-MM)',readPage:(db,ctx,options)=>require('../purchasing/agent-budgets').report(db,ctx,options,true)},
  {id:110,key:'purchase-budget',label:'Compare purchase budgets with actual spending',filterLabel:'Month (YYYY-MM)',readPage:require('../purchasing/agent-budgets').report},
  {id:22,key:'supplier-options',label:'Compare buying options',readPage:require('../purchasing/agent-reorder-workflows').review},
  {id:34,key:'measured-lead-times',label:'Compare promised and actual supplier lead times',summary:'First accepted receipt of this item on each of the last 12 received POs in a year. After three orders the reorder calculation uses the observed average, rounded up to whole days.',sql:`
    SELECT k.code AS "SKU",s.name AS "Supplier",l.samples AS "Delivered orders",l.configured_lead AS "Configured days",
      l.promised_days AS "Average promised days",l.measured_days AS "Average actual days",l.effective_lead AS "Supplier planning days"
    FROM stockchief_runtime.supplier_planning_leads l JOIN skus k ON k.id=l.sku_id JOIN suppliers s ON s.id=l.supplier_id
    WHERE l.workspace_id=$1 AND ($2='' OR lower(k.code)=lower($2) OR lower(s.name)=lower($2)) ORDER BY k.code,s.name,s.id`},
  {id:32,key:'overdue-incoming',label:'Review uncertain incoming stock',summary:'Review overdue deliveries, orders without a delivery promise and recorded supplier unavailability. A supplier-reported hold removes its remaining units from dependable incoming. Original order, receipt and invoice records retain their history.',sql:`
    SELECT p.po_number AS "Order",v.name AS "Supplier",p.expected_date AS "Promised",s.code AS "SKU",
      l.quantity_units-l.quantity_received_units AS "Still due",
      CASE WHEN to_jsonb(l)->>'supplier_supply_hold_id' IS NOT NULL THEN 'Supplier reported unavailable'
        WHEN p.expected_date IS NULL THEN 'No delivery promise' ELSE 'Delivery overdue' END AS "Reason",
      'No' AS "Dependable incoming",'/purchasing/orders/'||p.id AS link
    FROM purchase_orders p JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id
    JOIN skus s ON s.id=l.sku_id JOIN suppliers v ON v.id=p.supplier_id
    JOIN workspaces w ON w.id=p.workspace_id JOIN accounts a ON a.id=w.owner_account_id
    WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED')
      AND (p.expected_date::date<$3::date OR to_jsonb(l)->>'supplier_supply_hold_id' IS NOT NULL
        OR p.expected_date IS NULL AND p.ordered_at::timestamptz<
          (($3::date-greatest(1,coalesce(v.follow_up_days,2))::int)::timestamp AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC')))
      AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
      AND l.quantity_units>l.quantity_received_units AND ($2='' OR lower(s.code)=lower($2) OR lower(v.name)=lower($2))
    ORDER BY p.expected_date,p.id,l.line_number`,usesDate:true},
  require('../sales/agent-customer-checkins').definition,
  {id:79,key:'bought-together',label:'Find items commonly bought together',requiresFilter:true,
    readPage:require('../sales/quote-companion-evidence').readReport},
  {id:88,key:'customer-health',label:'Review customer activity',filterLabel:'Customer or company name',
    readPage:require('../sales/customer-health').review},
  {id:91,key:'supplier-price-increases',label:'Flag higher supplier prices',
    filterLabel:'Exact SKU, supplier, purchase order or source reference',
    readPage:require('../purchasing/agent-supplier-price-increases').readPage},
  {id:135,key:'supplier-price-updates',label:'Update costs from supplier price lists',readPage:require('../pricing/agent-supplier-price-updates').readPage},
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
