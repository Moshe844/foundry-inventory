'use strict';

module.exports=[
  {id:1,key:'stock-lookup',label:'Look up an item, lot or serial',readPage:require('./stock-reading').lookup,requiresFilter:true,prompt:'item name, SKU, size, lot or serial'},
  {id:191,key:'expiring-lots',label:'Review expiring stock and waiting orders',summary:'Lots expiring within 30 days are paired with the earliest unfilled order for the SKU at that warehouse, due by expiry. Verify availability before assigning it.',usesDate:true,sql:`
    SELECT s.code AS "SKU",lot.code AS "Lot",l.name AS "Location",b.quantity AS "Units",lot.expires_at::date::text AS "Expires",
      CASE WHEN lot.recalled_at IS NOT NULL THEN 'Under recall' WHEN lot.expires_at::date<$3::date THEN 'Expired' ELSE coalesce(d.order_number,'No dated order found') END AS "Priority"
    FROM lots lot JOIN lot_balances b ON b.lot_id=lot.id AND b.workspace_id=lot.workspace_id JOIN locations l ON l.id=b.location_id
    JOIN skus s ON s.id=lot.sku_id LEFT JOIN LATERAL (SELECT o.order_number FROM sales_orders o JOIN sales_order_lines ol ON ol.sales_order_id=o.id
      WHERE o.workspace_id=$1 AND ol.sku_id=lot.sku_id AND o.fulfillment_location_id=b.location_id AND ol.quantity_ordered>ol.quantity_fulfilled
      AND o.status IN ('CONFIRMED','PARTIALLY_FULFILLED') AND o.needed_by::date<=lot.expires_at::date ORDER BY o.needed_by,o.id LIMIT 1)d ON true
    WHERE lot.workspace_id=$1 AND b.quantity>0 AND lot.expires_at::date<=$3::date+30 AND ($2='' OR lower(lot.code)=lower($2) OR lower(s.code)=lower($2))
    ORDER BY lot.expires_at,lot.id,l.id`},
  {id:193,key:'recall-trace',label:'Trace customers who received a lot',requiresFilter:true,prompt:'lot number',summary:'Shows customers who received this lot through sales, rentals or consignment. The totals record original handoffs, including units that were later returned.',sql:`
    WITH matching_lots AS (
      SELECT id,code FROM lots WHERE workspace_id=$1 AND lower(code)=lower($2)
    ), serial_movements AS (
      SELECT x.movement_id,u.id AS serial_id,l.code FROM matching_lots l
      JOIN serial_units u ON u.workspace_id=$1 AND u.lot_id=l.id
      JOIN stockchief_runtime.inventory_movement_serial_units x ON x.workspace_id=u.workspace_id AND x.serial_unit_id=u.id
      UNION
      SELECT m.id,u.id,l.code FROM matching_lots l
      JOIN serial_units u ON u.workspace_id=$1 AND u.lot_id=l.id
      JOIN movements m ON m.workspace_id=u.workspace_id AND m.serial_unit_id=u.id
    ), affected AS (
      SELECT m.id,m.sku_id,l.code,-m.quantity_delta AS units FROM matching_lots l
      JOIN movements m ON m.workspace_id=$1 AND m.lot_id=l.id
      WHERE m.operation='issue' OR (m.operation='transfer' AND m.leg='out')
      UNION ALL
      SELECT m.id,m.sku_id,x.code,count(*) FROM serial_movements x
      JOIN movements m ON m.workspace_id=$1 AND m.id=x.movement_id
      WHERE m.lot_id IS NULL AND (m.operation='issue' OR (m.operation='transfer' AND m.leg='out'))
      GROUP BY m.id,m.sku_id,x.code
    ), handoffs AS (
      SELECT a.sku_id,a.code,a.units,o.customer_id,o.order_number AS reference,'Sale' AS kind,'/orders/'||o.id AS link
      FROM affected a JOIN accounting_inventory_cost_movements v ON v.workspace_id=$1 AND v.inventory_movement_id=a.id
      JOIN sales_orders o ON o.workspace_id=v.workspace_id AND o.id=v.cost_source_record_id
      WHERE v.cost_source_type IN ('sales_order_fulfillment','sales_order_kit_fulfillment')
      UNION ALL
      SELECT a.sku_id,a.code,a.units,g.customer_id,g.agreement_number,
        CASE g.kind WHEN 'RENTAL' THEN 'Rental' ELSE 'Consignment' END,'/custody/'||g.id
      FROM affected a JOIN accounting_inventory_cost_movements v ON v.workspace_id=$1 AND v.inventory_movement_id=a.id
      JOIN custody_agreements g ON g.workspace_id=v.workspace_id AND g.id=v.cost_source_record_id
      WHERE v.cost_source_type='custody_dispatch' AND g.kind IN ('RENTAL','CONSIGN_OUT')
    )
    SELECT c.name AS "Customer",h.reference AS "Order",h.kind AS "Type",s.code AS "SKU",h.code AS "Lot",
      sum(h.units) AS "Units issued",c.email AS "Contact",h.link
    FROM handoffs h JOIN customers c ON c.workspace_id=$1 AND c.id=h.customer_id
    JOIN skus s ON s.workspace_id=$1 AND s.id=h.sku_id
    GROUP BY c.id,c.name,h.reference,h.kind,s.code,h.code,h.link
    ORDER BY c.name,h.reference,s.code,h.code,h.link`},
  {id:196,key:'lot-documents',label:'Check lot certificates',usesDate:true,summary:'Required certificates for each SKU and lot with stock. Missing and expired documents appear first.',sql:`
    SELECT s.code AS "SKU",l.code AS "Lot",r.kind AS "Document",c.expires_on::text AS "Expires",CASE WHEN c.lot_id IS NULL THEN 'Missing'
      WHEN c.expires_on<$3::date THEN 'Expired' ELSE 'On file' END AS "Status"
    FROM stockchief_runtime.lot_certificate_requirements r JOIN skus s ON s.id=r.sku_id JOIN lots l ON l.workspace_id=r.workspace_id AND l.sku_id=r.sku_id
      LEFT JOIN stockchief_runtime.lot_certificates c ON c.workspace_id=l.workspace_id AND c.lot_id=l.id AND c.kind=r.kind
    WHERE r.workspace_id=$1 AND ($2='' OR lower(l.code)=lower($2) OR lower(s.code)=lower($2)) AND EXISTS(SELECT 1 FROM lot_balances b WHERE b.lot_id=l.id AND b.quantity>0)
    ORDER BY (c.lot_id IS NOT NULL AND (c.expires_on IS NULL OR c.expires_on>=$3::date)),s.code,l.code,r.kind`},
  {id:197,key:'recall-audit',label:'Prepare the lot recall audit',summary:'Recall decisions in order, with the responsible person, time and recorded reason.',sql:`
    SELECT s.code AS "SKU",l.code AS "Lot",e.occurred_at AT TIME ZONE 'UTC' AS "Decision time UTC",u.name AS "Decided by",
      CASE WHEN e.held THEN 'Recall placed' ELSE 'Released' END AS "Decision",e.reason AS "Reason",e.revision AS "Revision"
    FROM stockchief_runtime.lot_recall_events e JOIN lots l ON l.id=e.lot_id JOIN skus s ON s.id=l.sku_id JOIN users u ON u.id=e.actor_id
    WHERE e.workspace_id=$1 AND ($2='' OR lower(l.code)=lower($2) OR lower(s.code)=lower($2)) ORDER BY e.occurred_at DESC,e.id`}
];
