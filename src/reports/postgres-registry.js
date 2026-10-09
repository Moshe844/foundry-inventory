'use strict';

const permissions=require('../actions/permissions');

// A dataset is a reviewed projection of canonical PostgreSQL records. The
// builder never accepts SQL, table names, expressions, or joins from a user or
// model. Adding a field here is a deliberate product/permission decision.
const datasets=Object.freeze({
  catalogue:{label:'Product and SKU catalogue',permission:permissions.VIEW,
    source:`SELECT i.id AS record_id,i.name AS product,s.code AS sku,
      COALESCE(s.variant_label,'') AS variant,COALESCE(s.barcode,'') AS barcode,
      i.unit_label AS unit,i.tracking_mode AS tracking,
      CASE WHEN i.is_active=1 AND s.is_active=1 THEN 'active' ELSE 'inactive' END AS status,
      LEFT(i.created_at,10) AS created_on
      FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      WHERE s.workspace_id=$1`,recordHref:(row)=>`/inventory/${row.record_id}`,
    enumFields:['status'],fields:{product:'text',sku:'text',variant:'text',barcode:'text',unit:'text',tracking:'text',
      status:'text',created_on:'date'}},
  stock:{label:'Stock by product and location',permission:permissions.VIEW,
    source:`SELECT i.id AS record_id,i.name AS product,s.code AS sku,l.name AS location,
      b.on_hand::bigint AS on_hand,LEFT(b.updated_at,10) AS as_of
      FROM balances b JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=b.workspace_id
      JOIN locations l ON l.id=b.location_id AND l.workspace_id=b.workspace_id
      WHERE b.workspace_id=$1`,recordHref:(row)=>`/inventory/${row.record_id}`,
    fields:{product:'text',sku:'text',location:'text',on_hand:'number',as_of:'date'}},
  movements:{label:'Inventory movements',permission:permissions.VIEW,
    source:`SELECT m.item_id AS record_id,LEFT(m.occurred_at,10) AS occurred_on,
      i.name AS product,s.code AS sku,l.name AS location,m.operation,
      m.quantity_delta::bigint AS quantity_delta,COALESCE(m.reference,'') AS reference
      FROM movements m JOIN items i ON i.id=m.item_id AND i.workspace_id=m.workspace_id
      JOIN skus s ON s.id=m.sku_id AND s.workspace_id=m.workspace_id
      JOIN locations l ON l.id=m.location_id AND l.workspace_id=m.workspace_id
      WHERE m.workspace_id=$1`,recordHref:(row)=>`/inventory/${row.record_id}`,
    fields:{occurred_on:'date',product:'text',sku:'text',location:'text',operation:'text',quantity_delta:'number',reference:'text'}},
  inventory_valuation:{label:'Recorded inventory book value',permission:permissions.VIEW,
    source:`SELECT i.id AS record_id,i.name AS product,s.code AS sku,l.name AS location,
      b.quantity_units::bigint AS costed_units,b.total_cost_minor::bigint AS book_cost_minor,
      a.base_currency AS currency,LEFT(b.updated_at,10) AS as_of
      FROM accounting_inventory_cost_balances b
      JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=b.workspace_id
      JOIN locations l ON l.id=b.location_id AND l.workspace_id=b.workspace_id
      JOIN accounting_settings a ON a.workspace_id=b.workspace_id AND a.enabled=1
      WHERE b.workspace_id=$1`,recordHref:(row)=>`/inventory/${row.record_id}`,
    fields:{product:'text',sku:'text',location:'text',costed_units:'number',
      book_cost_minor:'money_minor',currency:'text',as_of:'date'}},
  inventory_cost_movements:{label:'Recorded inventory cost changes',permission:permissions.VIEW,
    source:`SELECT i.id AS record_id,i.name AS product,s.code AS sku,l.name AS location,
      cm.quantity_delta::bigint AS quantity_delta,cm.cost_delta_minor::bigint AS book_cost_change_minor,
      cm.cost_source_type AS source_kind,a.base_currency AS currency,
      LEFT(cm.created_at,10) AS recorded_on,COALESCE(m.reference,'') AS reference
      FROM accounting_inventory_cost_movements cm
      JOIN skus s ON s.id=cm.sku_id AND s.workspace_id=cm.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=cm.workspace_id
      JOIN locations l ON l.id=cm.location_id AND l.workspace_id=cm.workspace_id
      JOIN movements m ON m.id=cm.inventory_movement_id AND m.workspace_id=cm.workspace_id
      JOIN accounting_settings a ON a.workspace_id=cm.workspace_id AND a.enabled=1
      WHERE cm.workspace_id=$1`,recordHref:(row)=>`/inventory/${row.record_id}`,
    enumFields:['source_kind'],fields:{product:'text',sku:'text',location:'text',quantity_delta:'number',
      book_cost_change_minor:'money_minor',source_kind:'text',currency:'text',
      recorded_on:'date',reference:'text'}},
  customers:{label:'Customer directory',permission:permissions.VIEW_SALES,
    source:`SELECT c.id AS record_id,c.name AS customer,COALESCE(c.company,'') AS company,
      COALESCE(c.email,'') AS email,c.record_state,LEFT(c.created_at,10) AS created_on
      FROM customers c WHERE c.workspace_id=$1`,
    recordHref:(row)=>`/sales/customers/${row.record_id}`,
    enumFields:['record_state'],
    fields:{customer:'text',company:'text',email:'text',record_state:'text',created_on:'date'}},
  sales_orders:{label:'Customer orders',permission:permissions.VIEW_SALES,
    source:`SELECT o.id AS record_id,o.order_number,c.name AS customer,o.status,o.currency,
      o.order_date,o.needed_by,COALESCE(lines.units,0)::bigint AS ordered_units,
      CASE WHEN COALESCE(lines.unpriced,0)=0 THEN COALESCE(lines.quoted_minor,0)::bigint
        ELSE NULL END AS quoted_line_total_minor,
      CASE WHEN COALESCE(lines.unpriced,0)=0 THEN 'yes' ELSE 'no' END AS pricing_complete
      FROM sales_orders o JOIN customers c ON c.id=o.customer_id AND c.workspace_id=o.workspace_id
      LEFT JOIN LATERAL (SELECT SUM(quantity_ordered) AS units,
        SUM(quantity_ordered*unit_price_minor) AS quoted_minor,
        COUNT(*) FILTER (WHERE unit_price_minor IS NULL) AS unpriced
        FROM sales_order_lines WHERE workspace_id=o.workspace_id AND sales_order_id=o.id) lines ON TRUE
      WHERE o.workspace_id=$1`,recordHref:(row)=>`/orders/${row.record_id}`,
    moneyCompleteness:{quoted_line_total_minor:{field:'pricing_complete',value:'yes'}},
    fields:{order_number:'text',customer:'text',status:'text',currency:'text',order_date:'date',needed_by:'date',
      ordered_units:'number',quoted_line_total_minor:'money_minor',pricing_complete:'text'}},
  sales_order_lines:{label:'Customer order lines by product',permission:permissions.VIEW_SALES,
    source:`SELECT o.id AS record_id,o.order_number,c.name AS customer,o.status,
      o.order_date,o.needed_by,i.name AS product,s.code AS sku,
      l.quantity_ordered::bigint AS ordered_units,l.quantity_fulfilled::bigint AS fulfilled_units,
      (l.quantity_ordered-l.quantity_fulfilled)::bigint AS open_units
      FROM sales_order_lines l JOIN sales_orders o ON o.id=l.sales_order_id AND o.workspace_id=l.workspace_id
      JOIN customers c ON c.id=o.customer_id AND c.workspace_id=l.workspace_id
      JOIN skus s ON s.id=l.sku_id AND s.workspace_id=l.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=l.workspace_id
    WHERE l.workspace_id=$1`,recordHref:(row)=>`/orders/${row.record_id}`,
    metrics:{fulfillment_percent:{label:'Fulfilled units %',kind:'ratio',numerator:'fulfilled_units',
      denominator:'ordered_units'}},
    fields:{order_number:'text',customer:'text',status:'text',order_date:'date',needed_by:'date',
      product:'text',sku:'text',ordered_units:'number',fulfilled_units:'number',open_units:'number'}},
  suppliers:{label:'Supplier directory',permission:permissions.VIEW_PURCHASING,
    source:`SELECT s.id AS record_id,s.name AS supplier,COALESCE(s.code,'') AS supplier_code,
      COALESCE(s.email,'') AS email,s.status,s.currency,
      s.default_lead_time_days::bigint AS lead_time_days,LEFT(s.created_at,10) AS created_on
      FROM suppliers s WHERE s.workspace_id=$1`,
    recordHref:(row)=>`/suppliers/${row.record_id}`,
    enumFields:['status'],fields:{supplier:'text',supplier_code:'text',email:'text',
      status:'text',currency:'text',lead_time_days:'number',created_on:'date'}},
  purchase_orders:{label:'Supplier purchase orders',permission:permissions.VIEW_PURCHASING,
    source:`SELECT o.id AS record_id,o.po_number,s.name AS supplier,o.status,
      o.order_date,o.expected_date,COALESCE(lines.units,0)::bigint AS ordered_units,
      COALESCE(lines.received,0)::bigint AS received_units
      FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id AND s.workspace_id=o.workspace_id
      LEFT JOIN LATERAL (SELECT SUM(quantity_units) AS units,SUM(quantity_received_units) AS received
        FROM purchase_order_lines WHERE workspace_id=o.workspace_id AND purchase_order_id=o.id) lines ON TRUE
      WHERE o.workspace_id=$1`,recordHref:(row)=>`/purchasing/orders/${row.record_id}`,
    fields:{po_number:'text',supplier:'text',status:'text',order_date:'date',expected_date:'date',
      ordered_units:'number',received_units:'number'}},
  purchase_order_lines:{label:'Supplier purchase order lines by product',permission:permissions.VIEW_PURCHASING,
    source:`SELECT o.id AS record_id,o.po_number,v.name AS supplier,o.status,
      o.order_date,o.expected_date,i.name AS product,s.code AS sku,
      l.quantity_units::bigint AS ordered_units,l.quantity_received_units::bigint AS received_units,
      (l.quantity_units-l.quantity_received_units)::bigint AS outstanding_units
      FROM purchase_order_lines l JOIN purchase_orders o ON o.id=l.purchase_order_id AND o.workspace_id=l.workspace_id
      JOIN suppliers v ON v.id=o.supplier_id AND v.workspace_id=l.workspace_id
      JOIN skus s ON s.id=l.sku_id AND s.workspace_id=l.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=l.workspace_id
    WHERE l.workspace_id=$1`,recordHref:(row)=>`/purchasing/orders/${row.record_id}`,
    metrics:{receipt_percent:{label:'Received units %',kind:'ratio',numerator:'received_units',
      denominator:'ordered_units'}},
    fields:{po_number:'text',supplier:'text',status:'text',order_date:'date',expected_date:'date',
      product:'text',sku:'text',ordered_units:'number',received_units:'number',outstanding_units:'number'}},
  customer_invoices:{label:'Customer invoices',permission:permissions.VIEW_ACCOUNTING,
    commercialCapability:'accounting.reports',
    source:`SELECT v.id AS record_id,v.invoice_number,c.name AS customer,v.status,v.currency,
      v.issue_date,v.due_date,v.total_minor::bigint AS total_minor,
      v.balance_minor::bigint AS balance_minor
      FROM accounting_customer_invoices v JOIN customers c ON c.id=v.customer_id AND c.workspace_id=v.workspace_id
      WHERE v.workspace_id=$1`,recordHref:()=>'/accounting/receivables',
    fields:{invoice_number:'text',customer:'text',status:'text',currency:'text',issue_date:'date',due_date:'date',
      total_minor:'money_minor',balance_minor:'money_minor'}},
  supplier_bills:{label:'Supplier bills',permission:permissions.VIEW_ACCOUNTING,
    commercialCapability:'accounting.reports',
    source:`SELECT v.id AS record_id,v.bill_number,s.name AS supplier,v.status,v.currency,
      v.issue_date,v.due_date,v.total_minor::bigint AS total_minor,
      v.balance_minor::bigint AS balance_minor
      FROM accounting_supplier_bills v JOIN suppliers s ON s.id=v.supplier_id AND s.workspace_id=v.workspace_id
      WHERE v.workspace_id=$1`,recordHref:()=>'/accounting/payables',
    fields:{bill_number:'text',supplier:'text',status:'text',currency:'text',issue_date:'date',due_date:'date',
      total_minor:'money_minor',balance_minor:'money_minor'}},
  payments:{label:'Recorded payments',permission:permissions.VIEW_ACCOUNTING,
    commercialCapability:'accounting.reports',
    source:`SELECT p.id AS record_id,p.payment_number,p.direction,p.status,p.payment_date,p.currency,
      p.amount_minor::bigint AS amount_minor,COALESCE(c.name,s.name,'') AS counterparty
      FROM accounting_payments p LEFT JOIN customers c ON c.id=p.customer_id AND c.workspace_id=p.workspace_id
      LEFT JOIN suppliers s ON s.id=p.supplier_id AND s.workspace_id=p.workspace_id
      WHERE p.workspace_id=$1`,recordHref:()=>'/accounting/transactions',
    fields:{payment_number:'text',direction:'text',status:'text',payment_date:'date',currency:'text',amount_minor:'money_minor',counterparty:'text'}},
  payment_requests:{label:'Customer payment requests',permission:permissions.VIEW_ACCOUNTING,
    commercialCapability:'accounting.reports',
    source:`SELECT p.id AS record_id,COALESCE(v.invoice_number,'') AS invoice_number,
      COALESCE(o.order_number,'') AS order_number,COALESCE(c.name,'') AS customer,
      p.provider,p.purpose,p.status,p.currency,p.amount_minor::bigint AS requested_minor,
      p.paid_minor::bigint AS confirmed_paid_minor,LEFT(p.created_at,10) AS created_on,
      LEFT(p.paid_at,10) AS paid_on
      FROM payment_requests p
      LEFT JOIN accounting_customer_invoices v ON v.id=p.invoice_id AND v.workspace_id=p.workspace_id
      LEFT JOIN sales_orders o ON o.id=p.sales_order_id AND o.workspace_id=p.workspace_id
      LEFT JOIN customers c ON c.id=p.customer_id AND c.workspace_id=p.workspace_id
      WHERE p.workspace_id=$1`,recordHref:()=>'/accounting/receivables',
    fields:{invoice_number:'text',order_number:'text',customer:'text',provider:'text',purpose:'text',
      status:'text',currency:'text',requested_minor:'money_minor',confirmed_paid_minor:'money_minor',
      created_on:'date',paid_on:'date'}},
  mail:{label:'Business messages',permission:permissions.VIEW,
    source:`SELECT m.id AS record_id,m.sender,COALESCE(m.subject,'') AS subject,
      LEFT(m.received_at,10) AS received_on,m.trust_status,m.classification,
      m.processing_status,m.reply_state
      FROM connection_email_messages m WHERE m.workspace_id=$1`,
    recordHref:(row)=>`/mail/${row.record_id}`,
    fields:{sender:'text',subject:'text',received_on:'date',trust_status:'text',classification:'text',
      processing_status:'text',reply_state:'text'}},
  shipments:{label:'Shipment progress',permission:permissions.VIEW_SALES,
    source:`SELECT s.id AS record_id,s.shipment_number,o.order_number,s.status,s.currency,
      COALESCE(s.carrier,'') AS carrier,COALESCE(s.tracking_number,'') AS tracking_number,
      s.shipping_cost_minor::bigint AS shipping_cost_minor,
      CASE WHEN s.shipping_cost_minor IS NULL THEN 'no' ELSE 'yes' END AS cost_recorded,
      LEFT(s.created_at,10) AS created_on
      FROM sales_shipments s JOIN sales_orders o ON o.id=s.sales_order_id AND o.workspace_id=s.workspace_id
      WHERE s.workspace_id=$1`,recordHref:(row)=>`/fulfilment/${row.record_id}`,
    moneyCompleteness:{shipping_cost_minor:{field:'cost_recorded',value:'yes'}},
    fields:{shipment_number:'text',order_number:'text',status:'text',currency:'text',carrier:'text',tracking_number:'text',
      shipping_cost_minor:'money_minor',cost_recorded:'text',created_on:'date'}},
  shipment_rates:{label:'Recorded carrier rate quotes',permission:permissions.VIEW_SALES,
    source:`SELECT r.shipment_id AS record_id,s.shipment_number,o.order_number,
      r.provider,r.carrier,r.service,r.amount_minor::bigint AS quoted_charge_minor,
      r.currency,r.delivery_days,LEFT(r.delivery_date,10) AS estimated_delivery_on,
      LEFT(r.quoted_at,10) AS quoted_on
      FROM shipment_rates r
      JOIN sales_shipments s ON s.id=r.shipment_id AND s.workspace_id=r.workspace_id
      JOIN sales_orders o ON o.id=s.sales_order_id AND o.workspace_id=s.workspace_id
      WHERE r.workspace_id=$1`,recordHref:(row)=>`/fulfilment/${row.record_id}`,
    fields:{shipment_number:'text',order_number:'text',provider:'text',carrier:'text',service:'text',
      quoted_charge_minor:'money_minor',currency:'text',delivery_days:'number',
      estimated_delivery_on:'date',quoted_on:'date'}},
  shipping_label_activity:{label:'Shipping label purchases and adjustments',permission:permissions.VIEW_SALES,
    source:`SELECT t.shipment_id AS record_id,s.shipment_number,t.provider,t.operation,t.status,
      t.amount_minor::bigint AS recorded_charge_minor,t.currency,
      CASE WHEN t.amount_minor IS NULL THEN 'no' ELSE 'yes' END AS charge_recorded,
      LEFT(t.requested_at,10) AS requested_on,LEFT(t.completed_at,10) AS completed_on
      FROM shipping_label_transactions t
      JOIN sales_shipments s ON s.id=t.shipment_id AND s.workspace_id=t.workspace_id
      WHERE t.workspace_id=$1`,recordHref:(row)=>`/fulfilment/${row.record_id}`,
    moneyCompleteness:{recorded_charge_minor:{field:'charge_recorded',value:'yes'}},
    fields:{shipment_number:'text',provider:'text',operation:'text',status:'text',
      recorded_charge_minor:'money_minor',currency:'text',charge_recorded:'text',
      requested_on:'date',completed_on:'date'}},
  shipment_tracking:{label:'Carrier tracking events',permission:permissions.VIEW_SALES,
    source:`SELECT t.shipment_id AS record_id,s.shipment_number,o.order_number,
      t.provider,COALESCE(s.carrier,'') AS carrier,t.status,
      COALESCE(t.location,'') AS location,COALESCE(t.detail,'') AS detail,
      LEFT(t.occurred_at,10) AS occurred_on
      FROM shipment_tracking_events t
      JOIN sales_shipments s ON s.id=t.shipment_id AND s.workspace_id=t.workspace_id
      JOIN sales_orders o ON o.id=s.sales_order_id AND o.workspace_id=s.workspace_id
      WHERE t.workspace_id=$1`,recordHref:(row)=>`/fulfilment/${row.record_id}`,
    fields:{shipment_number:'text',order_number:'text',provider:'text',carrier:'text',status:'text',
      location:'text',detail:'text',occurred_on:'date'}},
  transfers:{label:'Inventory transfers',permission:permissions.VIEW_TRANSFERS,
    source:`SELECT t.id AS record_id,t.transfer_number,t.status,
      origin.name AS source_location,destination.name AS destination_location,
      t.expected_arrival_date,LEFT(t.created_at,10) AS requested_on,
      COALESCE(lines.requested,0)::bigint AS requested_units,
      COALESCE(lines.received,0)::bigint AS received_units
      FROM inventory_transfers t JOIN locations origin ON origin.id=t.source_location_id AND origin.workspace_id=t.workspace_id
      JOIN locations destination ON destination.id=t.destination_location_id AND destination.workspace_id=t.workspace_id
      LEFT JOIN LATERAL (SELECT SUM(requested_quantity) AS requested,SUM(received_quantity) AS received
        FROM inventory_transfer_lines WHERE workspace_id=t.workspace_id AND transfer_id=t.id) lines ON TRUE
      WHERE t.workspace_id=$1`,recordHref:(row)=>`/transfers/${row.record_id}`,
    fields:{transfer_number:'text',status:'text',source_location:'text',destination_location:'text',
      expected_arrival_date:'date',requested_on:'date',requested_units:'number',received_units:'number'}},
  customer_returns:{label:'Customer returns',permission:permissions.VIEW_SALES,
    source:`SELECT r.id AS record_id,r.return_number,o.order_number,r.status,r.resolution,
      LEFT(r.created_at,10) AS requested_on,COALESCE(lines.authorized,0)::bigint AS authorized_units,
      COALESCE(lines.received,0)::bigint AS received_units
      FROM customer_returns r JOIN sales_orders o ON o.id=r.sales_order_id AND o.workspace_id=r.workspace_id
      LEFT JOIN LATERAL (SELECT SUM(quantity_authorized) AS authorized,SUM(quantity_received) AS received
        FROM customer_return_lines WHERE workspace_id=r.workspace_id AND customer_return_id=r.id) lines ON TRUE
      WHERE r.workspace_id=$1`,recordHref:(row)=>`/returns/${row.record_id}`,
    fields:{return_number:'text',order_number:'text',status:'text',resolution:'text',requested_on:'date',
      authorized_units:'number',received_units:'number'}},
  supplier_returns:{label:'Supplier returns',permission:permissions.VIEW_PURCHASING,
    source:`SELECT r.id AS record_id,r.return_number,s.name AS supplier,r.status,
      r.expected_credit_minor::bigint AS expected_credit_minor,
      r.actual_credit_minor::bigint AS actual_credit_minor,
      LEFT(r.created_at,10) AS requested_on
      FROM supplier_returns r JOIN suppliers s ON s.id=r.supplier_id AND s.workspace_id=r.workspace_id
      WHERE r.workspace_id=$1`,recordHref:(row)=>`/supplier-returns/${row.record_id}`,
    fields:{return_number:'text',supplier:'text',status:'text',expected_credit_minor:'money_minor',
      actual_credit_minor:'money_minor',requested_on:'date'}},
  replenishment_rules:{label:'Replenishment settings',permission:permissions.VIEW_PURCHASING,
    source:`SELECT p.id AS record_id,s.code AS sku,i.name AS product,
      COALESCE(l.name,'Whole business') AS location,
      p.reorder_point::bigint AS reorder_point,p.target_stock::bigint AS target_stock,
      p.safety_stock::bigint AS safety_stock,COALESCE(v.name,'') AS preferred_supplier,
      p.source,LEFT(p.updated_at,10) AS updated_on
      FROM reorder_policies p JOIN skus s ON s.id=p.sku_id AND s.workspace_id=p.workspace_id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=p.workspace_id
      LEFT JOIN locations l ON l.id=p.location_id AND l.workspace_id=p.workspace_id
      LEFT JOIN suppliers v ON v.id=p.preferred_supplier_id AND v.workspace_id=p.workspace_id
      WHERE p.workspace_id=$1`,recordHref:()=>'/purchasing',
    fields:{sku:'text',product:'text',location:'text',reorder_point:'number',target_stock:'number',
      safety_stock:'number',preferred_supplier:'text',source:'text',updated_on:'date'}},
  journal_lines:{label:'Posted general ledger lines',permission:permissions.VIEW_ACCOUNTING,
    commercialCapability:'accounting.reports',
    source:`SELECT e.id AS record_id,e.entry_number::text AS entry_number,e.posting_date,
      a.code AS account_code,a.name AS account_name,a.account_type,l.currency,
      e.source_type,e.description,l.debit_minor::bigint AS debit_minor,
      l.credit_minor::bigint AS credit_minor
      FROM accounting_journal_entries e JOIN accounting_journal_lines l
        ON l.entry_id=e.id AND l.workspace_id=e.workspace_id
      JOIN accounting_accounts a ON a.id=l.account_id AND a.workspace_id=e.workspace_id
      WHERE e.workspace_id=$1 AND e.status='POSTED'`,
    recordHref:(row)=>`/accounting/entries/${row.record_id}`,
    fields:{entry_number:'text',posting_date:'date',account_code:'text',account_name:'text',
      account_type:'text',currency:'text',source_type:'text',description:'text',
      debit_minor:'money_minor',credit_minor:'money_minor'}},
  posted_sales_activity:{label:'Posted sales revenue and product cost',permission:permissions.VIEW_ACCOUNTING,
    commercialCapability:'accounting.reports',
    // Aggregate canonical journal lines at the entry/SKU grain before the
    // report builder applies user-selected dimensions. Contra revenue and
    // returned product cost retain their ledger signs; unassigned SKU lines
    // remain visible instead of being silently attributed to a product.
    source:`SELECT e.id AS record_id,e.entry_number::text AS entry_number,e.posting_date,
      e.source_type,COALESCE(s.code,'Unattributed') AS sku,
      COALESCE(i.name,'Unattributed') AS product,COALESCE(c.name,'Unattributed') AS customer,
      l.currency,
      SUM(CASE WHEN a.system_key IN ('SALES_REVENUE','SALES_RETURNS')
        THEN l.credit_minor-l.debit_minor ELSE 0 END)::bigint AS revenue_minor,
      SUM(CASE WHEN a.system_key='COST_OF_GOODS_SOLD'
        THEN l.debit_minor-l.credit_minor ELSE 0 END)::bigint AS cogs_minor,
      SUM(CASE WHEN a.system_key IN ('SALES_REVENUE','SALES_RETURNS')
        THEN l.credit_minor-l.debit_minor
        WHEN a.system_key='COST_OF_GOODS_SOLD' THEN l.credit_minor-l.debit_minor
        ELSE 0 END)::bigint AS gross_profit_minor
      FROM accounting_journal_entries e
      JOIN accounting_journal_lines l ON l.entry_id=e.id AND l.workspace_id=e.workspace_id
      JOIN accounting_accounts a ON a.id=l.account_id AND a.workspace_id=l.workspace_id
      LEFT JOIN skus s ON s.id=l.sku_id AND s.workspace_id=l.workspace_id
      LEFT JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      LEFT JOIN customers c ON c.id=l.customer_id AND c.workspace_id=l.workspace_id
      WHERE e.workspace_id=$1 AND e.status='POSTED'
        AND a.system_key IN ('SALES_REVENUE','SALES_RETURNS','COST_OF_GOODS_SOLD')
      GROUP BY e.id,e.entry_number,e.posting_date,e.source_type,s.code,i.name,c.name,l.currency`,
    recordHref:(row)=>`/accounting/entries/${row.record_id}`,
    metrics:{gross_margin_percent:{label:'Gross margin %',kind:'ratio',numerator:'gross_profit_minor',
      denominator:'revenue_minor',currencySensitive:true}},
    fields:{entry_number:'text',posting_date:'date',source_type:'text',sku:'text',product:'text',
      customer:'text',currency:'text',revenue_minor:'money_minor',cogs_minor:'money_minor',
      gross_profit_minor:'money_minor'}},
  imports:{label:'Import history',permission:permissions.VIEW,
    source:`SELECT p.id AS record_id,p.source_name,p.source_kind,p.detected_type,p.status,
      p.approval_status,p.records_detected::bigint AS records_detected,
      p.records_valid::bigint AS records_valid,p.records_invalid::bigint AS records_invalid,
      LEFT(p.created_at,10) AS created_on
      FROM import_plans p WHERE p.workspace_id=$1`,recordHref:(row)=>`/imports/${row.record_id}`,
    fields:{source_name:'text',source_kind:'text',detected_type:'text',status:'text',approval_status:'text',
      records_detected:'number',records_valid:'number',records_invalid:'number',created_on:'date'}},
  attention:{label:'Operational exceptions',permission:permissions.VIEW,
    source:`SELECT a.id AS record_id,a.title,a.category,a.severity,a.status,a.confidence,
      LEFT(a.first_detected_at,10) AS detected_on,
      LEFT(a.last_evaluated_at,10) AS evaluated_on
      FROM attention_items a WHERE a.workspace_id=$1`,recordHref:()=>'/needs-you',
    fields:{title:'text',category:'text',severity:'text',status:'text',confidence:'text',
      detected_on:'date',evaluated_on:'date'}},
  connections:{label:'Connected systems',permission:permissions.ADMIN,
    source:`SELECT c.id AS record_id,c.display_name,c.provider_type,c.status,
      LEFT(c.last_synced_at,10) AS last_synced_on,
      LEFT(c.last_activity_at,10) AS last_activity_on,
      CASE WHEN c.paused_at IS NULL THEN 'active' ELSE 'paused' END AS processing
      FROM workspace_connectors c WHERE c.workspace_id=$1`,
    recordHref:(row)=>`/settings/connections/${row.record_id}`,
    fields:{display_name:'text',provider_type:'text',status:'text',last_synced_on:'date',
      last_activity_on:'date',processing:'text'}},
});

function list(actor){return Object.entries(datasets).filter(([,dataset])=>permissions.can(actor,dataset.permission))
  .map(([key,dataset])=>({key,label:dataset.label,fields:dataset.fields,
    metrics:dataset.metrics||{},moneyCompleteness:dataset.moneyCompleteness||null}));}
function get(key){return datasets[key]||null;}
module.exports={datasets,list,get};
