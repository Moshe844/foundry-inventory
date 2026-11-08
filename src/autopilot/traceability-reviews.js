'use strict';

module.exports=[
  {id:1,key:'stock-lookup',label:'Look up an item, lot or serial',requiresFilter:true,prompt:'item name, SKU, lot or serial',summary:'SKU balances, lot positions and individual serials are separate views of the same stock. A serial that has left stock is marked issued.',sql:`
    WITH positions AS (
      SELECT s.code AS sku,i.name AS product,l.name AS location,'SKU balance' AS kind,s.variant_label AS identifier,b.on_hand AS units
      FROM balances b JOIN skus s ON s.id=b.sku_id JOIN items i ON i.id=s.item_id JOIN locations l ON l.id=b.location_id
      WHERE b.workspace_id=$1 AND (lower(s.code)=lower($2) OR lower(i.name)=lower($2) OR lower(s.variant_label)=lower($2))
      UNION ALL SELECT s.code,i.name,l.name,'Lot',lot.code,b.quantity FROM lot_balances b JOIN lots lot ON lot.id=b.lot_id
      JOIN skus s ON s.id=lot.sku_id JOIN items i ON i.id=s.item_id JOIN locations l ON l.id=b.location_id
      WHERE b.workspace_id=$1 AND (lower(lot.code)=lower($2) OR lower(s.code)=lower($2))
      UNION ALL SELECT s.code,i.name,coalesce(l.name,'Issued'),'Serial',u.serial,(u.status='in_stock')::int FROM serial_units u JOIN skus s ON s.id=u.sku_id
      JOIN items i ON i.id=s.item_id LEFT JOIN locations l ON l.id=u.location_id WHERE u.workspace_id=$1 AND lower(u.serial)=lower($2))
    SELECT sku AS "SKU",product AS "Product",kind AS "View",identifier AS "Variant or identifier",location AS "Location",units AS "Units" FROM positions
    ORDER BY sku,kind,location,identifier`},
  {id:191,key:'expiring-lots',label:'Review expiring stock and waiting orders',summary:'Lots expiring within 30 days are paired with the earliest unfilled order for the SKU at that warehouse, due by expiry. Verify availability before assigning it.',usesDate:true,sql:`
    SELECT s.code AS "SKU",lot.code AS "Lot",l.name AS "Location",b.quantity AS "Units",lot.expires_at::date::text AS "Expires",
      CASE WHEN lot.recalled_at IS NOT NULL THEN 'Under recall' WHEN lot.expires_at::date<$3::date THEN 'Expired' ELSE coalesce(d.order_number,'No dated order found') END AS "Priority"
    FROM lots lot JOIN lot_balances b ON b.lot_id=lot.id AND b.workspace_id=lot.workspace_id JOIN locations l ON l.id=b.location_id
    JOIN skus s ON s.id=lot.sku_id LEFT JOIN LATERAL (SELECT o.order_number FROM sales_orders o JOIN sales_order_lines ol ON ol.sales_order_id=o.id
      WHERE o.workspace_id=$1 AND ol.sku_id=lot.sku_id AND o.fulfillment_location_id=b.location_id AND ol.quantity_ordered>ol.quantity_fulfilled
      AND o.status IN ('CONFIRMED','PARTIALLY_FULFILLED') AND o.needed_by::date<=lot.expires_at::date ORDER BY o.needed_by,o.id LIMIT 1)d ON true
    WHERE lot.workspace_id=$1 AND b.quantity>0 AND lot.expires_at::date<=$3::date+30 AND ($2='' OR lower(lot.code)=lower($2) OR lower(s.code)=lower($2))
    ORDER BY lot.expires_at,lot.id,l.id`},
  {id:193,key:'recall-trace',label:'Trace customers who received a lot',requiresFilter:true,prompt:'lot number',summary:'Affected sales are linked by the posted stock issue and its order. Units include tracked components consumed when fulfilling a kit.',sql:`
    WITH affected AS (
      SELECT m.id,m.sku_id,lot.code,-m.quantity_delta AS units FROM movements m JOIN lots lot ON lot.id=m.lot_id AND lot.workspace_id=m.workspace_id
      WHERE m.workspace_id=$1 AND m.operation='issue' AND lower(lot.code)=lower($2)
      UNION ALL SELECT m.id,m.sku_id,lot.code,count(*) FROM movements m JOIN stockchief_runtime.inventory_movement_serial_units x ON x.workspace_id=m.workspace_id AND x.movement_id=m.id
      JOIN serial_units u ON u.id=x.serial_unit_id JOIN lots lot ON lot.id=u.lot_id
      WHERE m.workspace_id=$1 AND m.operation='issue' AND m.lot_id IS NULL AND lower(lot.code)=lower($2) GROUP BY m.id,m.sku_id,lot.code)
    SELECT c.name AS "Customer",o.order_number AS "Order",s.code AS "SKU",a.code AS "Lot",sum(a.units) AS "Units issued",c.email AS "Contact",
      '/orders/'||o.id AS link FROM affected a JOIN accounting_inventory_cost_movements v ON v.inventory_movement_id=a.id AND v.workspace_id=$1
      JOIN sales_orders o ON o.workspace_id=v.workspace_id AND o.id=v.cost_source_record_id JOIN customers c ON c.id=o.customer_id JOIN skus s ON s.id=a.sku_id
    WHERE v.cost_source_type IN ('sales_order_fulfillment','sales_order_kit_fulfillment') GROUP BY c.id,c.name,o.id,o.order_number,s.code,a.code
    ORDER BY c.name,o.order_number,s.code,a.code`},
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
