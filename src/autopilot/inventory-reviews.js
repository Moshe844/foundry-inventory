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
  {id:90,key:'supplier-scorecard',label:'Review supplier performance',filterLabel:'Exact supplier name',
    readPage:require('../purchasing/agent-supplier-scorecard').review},
  {id:92,key:'compare-quotes',label:'Compare supplier quotations',filterLabel:'Exact product code',
    readPage:require('../purchasing/agent-supplier-quote-comparison').review},
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
