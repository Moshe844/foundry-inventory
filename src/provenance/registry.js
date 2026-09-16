'use strict';

/*
 * One typed vocabulary for the business graph. Adding a domain record or a
 * relation here is deliberate: it prevents a model, prompt, or page from
 * inventing its own version of the business story.
 */
const NODES = Object.freeze({
  domain_event: { table: 'domain_events', label: 'business event' },
  sales_order: { table: 'sales_orders', label: 'customer order' },
  sales_order_line: { table: 'sales_order_lines', label: 'customer order item' },
  sales_order_event: { table: 'sales_order_events', label: 'customer order event' },
  purchase_order: { table: 'purchase_orders', label: 'purchase order' },
  purchase_order_line: { table: 'purchase_order_lines', label: 'purchase order item' },
  purchase_receipt: { table: 'purchase_order_receipts', label: 'inventory receipt' },
  purchase_receipt_line: { table: 'purchase_order_receipt_lines', label: 'received item' },
  purchase_order_event: { table: 'purchase_order_events', label: 'purchase order event' },
  inventory_movement: { table: 'movements', label: 'inventory movement' },
  inventory_transfer: { table: 'inventory_transfers', label: 'inventory transfer' },
  inventory_transfer_line: { table: 'inventory_transfer_lines', label: 'transfer item' },
  inventory_transfer_event: { table: 'inventory_transfer_events', label: 'transfer event' },
  supplier_document: { table: 'supplier_documents', label: 'supplier document' },
  email_message: { table: 'connection_email_messages', label: 'email' },
  supplier_bill: { table: 'accounting_supplier_bills', label: 'supplier bill' },
  supplier_bill_line: { table: 'accounting_supplier_bill_lines', label: 'supplier bill item' },
  customer_invoice: { table: 'accounting_customer_invoices', label: 'customer invoice' },
  customer_invoice_line: { table: 'accounting_customer_invoice_lines', label: 'customer invoice item' },
  payment: { table: 'accounting_payments', label: 'payment' },
  journal_entry: { table: 'accounting_journal_entries', label: 'accounting entry' },
  attention_item: { table: 'attention_items', label: 'owner decision' },
  planning_recommendation: { table: 'planning_recommendations', label: 'supply recommendation' },
  work_item: { table: 'work_items', label: 'StockChief work item' },
  action_proposal: { table: 'action_proposals', label: 'proposed action' },
  action_execution: { table: 'action_executions', label: 'executed action' },
  action_verification: { table: 'action_verifications', label: 'verified outcome' },
  shipment: { table: 'sales_shipments', label: 'shipment' },
  landed_cost_document: { table: 'landed_cost_documents', label: 'landed-cost document' },
  count_campaign: { table: 'inventory_count_campaigns', label: 'inventory count' },
  count_session: { table: 'inventory_count_sessions', label: 'count pass' },
  count_line: { table: 'inventory_count_lines', label: 'counted stock' },
  customer_return: { table: 'customer_returns', label: 'customer return' },
  customer_return_line: { table: 'customer_return_lines', label: 'returned item' },
  supplier_return: { table: 'supplier_returns', label: 'supplier return' },
  supplier_return_line: { table: 'supplier_return_lines', label: 'supplier return item' },
  sale_refund: { table: 'accounting_sale_refunds', label: 'customer refund' },
  supplier_credit: { table: 'accounting_supplier_credits', label: 'supplier credit' },
  fulfillment_wave: { table: 'fulfillment_waves', label: 'fulfillment wave' },
  fulfillment_wave_line: { table: 'fulfillment_wave_lines', label: 'wave pick line' },
});

const RELATIONS = Object.freeze({
  HAS_PART: { from: ['sales_order','purchase_order','purchase_receipt','supplier_bill','customer_invoice','inventory_transfer','count_campaign','count_session','customer_return','supplier_return','fulfillment_wave'], to: ['sales_order_line','purchase_order_line','purchase_receipt_line','supplier_bill_line','customer_invoice_line','inventory_transfer_line','count_session','count_line','customer_return_line','supplier_return_line','fulfillment_wave_line','shipment'], phrase: 'contains' },
  HAS_EVENT: { from: ['sales_order','purchase_order','inventory_transfer'], to: ['sales_order_event','purchase_order_event','inventory_transfer_event'], phrase: 'has event' },
  EMITTED_EVENT: { from: Object.keys(NODES).filter((key) => key !== 'domain_event'), to: ['domain_event'], phrase: 'emitted' },
  CREATED_FROM: { from: ['sales_order','purchase_order','supplier_bill','customer_invoice','action_proposal'], to: ['email_message','planning_recommendation','work_item','supplier_document','attention_item'], phrase: 'was created from' },
  EVIDENCED_BY: { from: ['sales_order','purchase_order','supplier_bill','customer_invoice','payment','landed_cost_document'], to: ['email_message','supplier_document','domain_event','supplier_bill_line'], phrase: 'is evidenced by' },
  DECIDED_BY: { from: ['purchase_order','work_item','action_execution'], to: ['planning_recommendation','work_item','action_proposal','attention_item'], phrase: 'was decided by' },
  RESPONDS_TO: { from: ['purchase_order','work_item','action_proposal','sales_order_event'], to: ['sales_order','domain_event','attention_item'], phrase: 'responds to' },
  RECEIVED_AS: { from: ['purchase_order','purchase_order_line'], to: ['purchase_receipt','purchase_receipt_line'], phrase: 'was received as' },
  CAUSED_MOVEMENT: { from: ['purchase_receipt_line','sales_order_event','shipment','inventory_transfer_event','count_line','customer_return_line','supplier_return_line'], to: ['inventory_movement'], phrase: 'created inventory movement' },
  SUPPLIES_DEMAND: { from: ['inventory_transfer_line'], to: ['sales_order_line'], phrase: 'supplies customer demand' },
  FULFILLED_BY: { from: ['sales_order','sales_order_line'], to: ['sales_order_event','shipment','fulfillment_wave'], phrase: 'was fulfilled by' },
  BILLED_BY: { from: ['purchase_order','purchase_receipt','sales_order'], to: ['supplier_bill','customer_invoice'], phrase: 'was billed by' },
  PAID_BY: { from: ['supplier_bill','customer_invoice','sales_order'], to: ['payment'], phrase: 'was paid by' },
  POSTED_AS: { from: ['purchase_receipt','sales_order_event','supplier_bill','customer_invoice','payment','inventory_movement','domain_event','inventory_transfer','inventory_transfer_event','landed_cost_document'], to: ['journal_entry'], phrase: 'was posted to accounting as' },
  CAPITALIZES_COST_OF: { from: ['landed_cost_document'], to: ['purchase_receipt','purchase_receipt_line'], phrase: 'capitalizes cost of' },
  EXECUTED_AS: { from: ['action_proposal'], to: ['action_execution'], phrase: 'was executed as' },
  VERIFIED_BY: { from: ['action_execution','work_item'], to: ['action_verification','domain_event'], phrase: 'was verified by' },
  RETURN_OF: { from: ['customer_return','supplier_return'], to: ['sales_order','purchase_order','supplier_bill'], phrase: 'returns goods from' },
  RESOLVED_BY: { from: ['customer_return','supplier_return'], to: ['sale_refund','supplier_credit','sales_order'], phrase: 'was resolved by' },
});

module.exports = { NODES, RELATIONS };
