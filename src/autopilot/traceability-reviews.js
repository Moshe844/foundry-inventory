'use strict';

module.exports=[
  {id:1,key:'stock-lookup',label:'Look up an item, lot or serial',readPage:require('./stock-reading').lookup,requiresFilter:true,prompt:'item name, SKU, size, lot or serial'},
  require('../operations/agent-expiry-warnings').definition,
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
  {id:196,key:'lot-documents',label:'Check lot certificates',filterLabel:'SKU or lot',readPage:require('./lot-certificate-coverage').rows},
  {id:197,key:'recall-audit',label:'Prepare the lot recall audit',summary:'Recall decisions in order, with the responsible person, time and recorded reason.',sql:`
    SELECT s.code AS "SKU",l.code AS "Lot",e.occurred_at AT TIME ZONE 'UTC' AS "Decision time UTC",u.name AS "Decided by",
      CASE WHEN e.held THEN 'Recall placed' ELSE 'Released' END AS "Decision",e.reason AS "Reason",e.revision AS "Revision"
    FROM stockchief_runtime.lot_recall_events e JOIN lots l ON l.id=e.lot_id JOIN skus s ON s.id=l.sku_id JOIN users u ON u.id=e.actor_id
    WHERE e.workspace_id=$1 AND ($2='' OR lower(l.code)=lower($2) OR lower(s.code)=lower($2)) ORDER BY e.occurred_at DESC,e.id`}
];
