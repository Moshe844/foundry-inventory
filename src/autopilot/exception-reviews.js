'use strict';

// The date is the inventory's business date. A parcel past its promise has
// a delivery exception, but only carrier evidence can establish a loss.
const lateParcels = `
  SELECT h.shipment_number AS reference, c.name AS partner, h.expected_delivery_date AS due,
    h.tracking_number AS tracking, h.tracking_status AS carrier_status, '/orders/'||o.id AS link
  FROM sales_shipments h JOIN sales_orders o ON o.workspace_id=h.workspace_id AND o.id=h.sales_order_id
  JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
  WHERE h.workspace_id=$1 AND h.status='SHIPPED' AND h.customer_return_id IS NULL
    AND coalesce(h.tracking_status,'') NOT IN ('DELIVERED','CANCELLED')
    AND (h.expected_delivery_date::date<$3::date OR h.tracking_status IN ('RETURNED','FAILURE','LOST'))`;

const stuckTransfers = `
  SELECT t.transfer_number AS reference, s.code, dest.name AS location,
    l.shipped_quantity-l.received_quantity-l.lost_quantity-l.damaged_quantity AS units, '/transfers/'||t.id AS link
  FROM inventory_transfers t JOIN inventory_transfer_lines l ON l.workspace_id=t.workspace_id AND l.transfer_id=t.id
  JOIN skus s ON s.workspace_id=t.workspace_id AND s.id=l.sku_id
  JOIN locations dest ON dest.workspace_id=t.workspace_id AND dest.id=t.destination_location_id
  WHERE t.workspace_id=$1 AND t.status IN ('SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')
    AND t.expected_arrival_date::date<$3::date AND l.shipped_quantity>l.received_quantity+l.lost_quantity+l.damaged_quantity`;

module.exports = [
  {id:3, key:'stock-exceptions', label:'Find stock discrepancies', usesDate:true,
    summary:'Negative stock, overdue in-transit units and positions with repeated negative adjustments in the past seven days.',
    sql:`WITH problems AS (
      SELECT 'Negative stock' AS problem,s.code,l.name AS location,b.on_hand AS units,'/inventory/'||s.item_id AS link
      FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id
      JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id WHERE b.workspace_id=$1 AND b.on_hand<0
      UNION ALL SELECT 'Overdue transfer '||reference,code,location,units,link FROM (${stuckTransfers}) transfers
      UNION ALL SELECT 'Repeated stock reductions',s.code,l.name,-sum(m.quantity_delta),'/inventory/'||s.item_id
      FROM movements m JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id
      JOIN locations l ON l.workspace_id=m.workspace_id AND l.id=m.location_id
      WHERE m.workspace_id=$1 AND m.operation='adjust' AND m.quantity_delta<0 AND m.occurred_at::timestamptz BETWEEN now()-interval '7 days' AND now()
      GROUP BY s.id,s.code,s.item_id,l.id,l.name HAVING count(*)>=2)
      SELECT problem AS "Problem",code AS "SKU",location AS "Location",units AS "Units",link FROM problems
      WHERE ($2='' OR lower(code)=lower($2) OR lower(location)=lower($2)) ORDER BY problem,code,location,link`},
  {id:62, key:'parcel-exceptions', label:'Find late parcels and carrier exceptions', usesDate:true,
    summary:'Parcels still marked shipped with a missed delivery date or a recorded carrier exception.',
    sql:`SELECT reference AS "Shipment",partner AS "Customer",due AS "Expected",tracking AS "Tracking",
      CASE WHEN carrier_status='FAILURE' THEN 'Carrier reported a delivery failure'
           WHEN carrier_status='RETURNED' THEN 'Returned by carrier' WHEN carrier_status='LOST' THEN 'Carrier reported lost'
           ELSE 'Past expected delivery' END AS "Problem",link FROM (${lateParcels}) parcel
      WHERE ($2='' OR lower(reference)=lower($2) OR lower(partner)=lower($2) OR lower(tracking)=lower($2))
      ORDER BY due NULLS LAST,reference`},
  {id:64, key:'waiting-orders', label:'Prioritize backorders', summary:'Outstanding ordered units after fulfilled units and current allocations. Orders follow the recorded allocation priority, then needed-by date and order date.',
    sql:`WITH waiting AS (
      SELECT o.id,o.order_number,o.allocation_priority,o.needed_by,o.order_date,c.name,s.code,
        l.quantity_ordered-l.quantity_fulfilled-coalesce(reserved.units,0)-coalesce(kits.units,0) AS shortage
      FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
      JOIN customers c ON c.id=o.customer_id AND c.workspace_id=o.workspace_id JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
      LEFT JOIN LATERAL (SELECT sum(a.quantity) AS units FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id) reserved ON true
      LEFT JOIN LATERAL (SELECT min(floor(coalesce(held.units,0)/k.quantity_per_kit)) AS units
        FROM sales_order_kit_components k LEFT JOIN LATERAL (SELECT sum(a.quantity) AS units FROM sales_order_kit_allocations a
          WHERE a.workspace_id=k.workspace_id AND a.kit_component_id=k.id) held ON true
        WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id) kits ON true
      WHERE o.workspace_id=$1 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
        AND ($2='' OR lower(s.code)=lower($2) OR lower(o.order_number)=lower($2) OR lower(c.name)=lower($2)))
      SELECT order_number AS "Order",name AS "Customer",code AS "SKU",shortage AS "Waiting units",needed_by AS "Needed by",
        allocation_priority AS "Priority",'/orders/'||id AS link FROM waiting WHERE shortage>0
      ORDER BY allocation_priority,needed_by NULLS LAST,order_date,id,code`},
  {id:116, key:'customer-return-rates', salesHistory:true, label:'Compare item and customer return rates',
    summary:'Ranked by the share of fulfilled units physically returned. Requested or authorized returns enter the figures only when received. Compare the unit counts alongside the percentage.',
    sql:`WITH line_history AS (
      SELECT s.code AS sku,c.id AS customer_id,c.name AS customer,l.quantity_fulfilled AS shipped,
        coalesce(r.units,0) AS returned,s.item_id FROM sales_order_lines l
      JOIN sales_orders o ON o.id=l.sales_order_id AND o.workspace_id=l.workspace_id
      JOIN customers c ON c.id=o.customer_id AND c.workspace_id=o.workspace_id JOIN skus s ON s.id=l.sku_id AND s.workspace_id=l.workspace_id
      LEFT JOIN LATERAL (SELECT sum(rl.quantity_received) AS units FROM customer_return_lines rl
        WHERE rl.workspace_id=l.workspace_id AND rl.sales_order_line_id=l.id) r ON true
      WHERE l.workspace_id=$1 AND l.quantity_fulfilled>0 AND ($3::text IS NULL OR o.order_date >= $3)),
    rates AS (SELECT 'SKU' AS kind,sku AS name,sum(shipped) AS shipped,sum(returned) AS returned,'/inventory/'||item_id AS link
      FROM line_history WHERE ($2='' OR lower(sku)=lower($2)) GROUP BY sku,item_id
      UNION ALL SELECT 'Customer',customer,sum(shipped),sum(returned),'/sales/customers/'||customer_id
      FROM line_history WHERE ($2='' OR lower(customer)=lower($2)) GROUP BY customer,customer_id)
    SELECT kind AS "Group",name AS "Name",shipped AS "Fulfilled units",returned AS "Returned units",
      round(100.0*returned/shipped,1) AS "Returned %",link FROM rates WHERE returned>0 ORDER BY returned/shipped::numeric DESC,returned DESC,kind,name,link`},
  {id:168, key:'overdue-work', label:'Find late orders, shipments and invoices', usesDate:true,
    summary:'Open purchase orders and unpaid invoices past their due dates, plus shipped parcels past their delivery dates.',
    sql:`WITH late AS (
      SELECT 'Purchase order' AS kind,p.po_number AS reference,s.name AS partner,p.expected_date::date AS due,'/purchasing/orders/'||p.id AS link
      FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
      WHERE p.workspace_id=$1 AND p.status IN ('ORDERED','PARTIALLY_RECEIVED') AND p.expected_date::date<$3::date
        AND EXISTS(SELECT 1 FROM purchase_order_lines l WHERE l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id AND l.quantity_units>l.quantity_received_units)
      UNION ALL SELECT 'Shipment',reference,partner,due::date,link FROM (${lateParcels}) parcels WHERE due::date<$3::date
      UNION ALL SELECT 'Customer invoice',i.invoice_number,c.name,i.due_date::date,'/money/invoices/'||i.id
      FROM accounting_customer_invoices i JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id
      WHERE i.workspace_id=$1 AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor>0 AND i.due_date::date<$3::date
      UNION ALL SELECT 'Supplier bill',coalesce(i.supplier_invoice_number,i.bill_number),s.name,i.due_date::date,'/money/bills/'||i.id
      FROM accounting_supplier_bills i JOIN suppliers s ON s.workspace_id=i.workspace_id AND s.id=i.supplier_id
      WHERE i.workspace_id=$1 AND i.status IN ('OPEN','PARTIALLY_PAID','DISPUTED') AND i.balance_minor>0 AND i.due_date::date<$3::date)
      SELECT kind AS "Type",reference AS "Reference",partner AS "Contact",due::text AS "Due",
        $3::date-due AS "Days late",link FROM late WHERE ($2='' OR lower(reference)=lower($2) OR lower(partner)=lower($2))
      ORDER BY due,kind,reference,link`}
];
