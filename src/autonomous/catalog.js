'use strict';

/**
 * Closed catalog of work Foundry may perform. Language can select one of these
 * operations, but it cannot create a new mutation or choose its permission.
 */
const permissions = require('../actions/permissions');

const DEFINITIONS = [
  ['inventory.receive', 'inventory', permissions.OPERATE, 'Receive stock', 'medium'],
  ['inventory.issue', 'inventory', permissions.OPERATE, 'Issue stock', 'medium'],
  ['inventory.adjust', 'inventory', permissions.ADJUST, 'Correct inventory', 'high'],
  ['inventory.create_item', 'inventory', permissions.OPERATE, 'Create an item', 'low'],
  ['transfer.request', 'transfers', permissions.REQUEST_TRANSFER, 'Request a transfer', 'low', '../autopilot/runner'],
  ['transfer.approve', 'transfers', permissions.APPROVE_TRANSFER, 'Approve a transfer', 'medium'],
  ['transfer.dispatch', 'transfers', permissions.DISPATCH_TRANSFER, 'Dispatch a transfer', 'high'],
  ['transfer.receive', 'transfers', permissions.RECEIVE_TRANSFER, 'Receive a transfer', 'medium'],
  ['purchasing.prepare_order', 'purchasing', permissions.CREATE_PO, 'Prepare a purchase order', 'low', '../autopilot/runner'],
  ['purchasing.place_order', 'purchasing', permissions.APPROVE_PO, 'Place a purchase order', 'high', '../autopilot/runner'],
  ['purchasing.receive', 'purchasing', permissions.RECEIVE_PO, 'Receive a purchase order', 'medium'],
  ['supplier.communicate', 'purchasing', permissions.MANAGE_SUPPLIERS, 'Contact a supplier', 'high', '../purchasing/supplier-communications'],
  ['sales.allocate', 'sales', permissions.MANAGE_SALES, 'Allocate customer stock', 'medium'],
  ['sales.fulfill', 'sales', permissions.FULFILL_SALES, 'Fulfill a sales order', 'high'],
  ['customer.communicate', 'sales', permissions.MANAGE_SALES, 'Contact a customer', 'high', '../sales/customer-communications'],
  ['shipping.purchase_label', 'shipping', permissions.FULFILL_SALES, 'Purchase shipping', 'high', '../shipping/service'],
  ['shipping.track', 'shipping', permissions.VIEW_SALES, 'Track a shipment', 'low', '../shipping/tracking'],
  ['warehouse.putaway', 'warehouse', permissions.OPERATE, 'Put stock away', 'medium'],
  ['warehouse.pick', 'warehouse', permissions.OPERATE, 'Pick stock', 'medium'],
  ['warehouse.count', 'warehouse', permissions.COUNT_STOCK, 'Count stock', 'medium'],
  ['warehouse.fulfillment_wave', 'warehouse', permissions.MANAGE_FULFILLMENT_WAVES, 'Run a fulfillment wave', 'medium'],
  ['returns.customer', 'returns', permissions.AUTHORIZE_CUSTOMER_RETURN, 'Handle a customer return', 'high'],
  ['returns.supplier', 'returns', permissions.AUTHORIZE_SUPPLIER_RETURN, 'Handle a supplier return', 'high'],
  ['accounting.post', 'accounting', permissions.MANAGE_ACCOUNTING, 'Post accounting', 'high', '../accounting/operational-adapter'],
  ['accounting.sync', 'accounting', permissions.RECONCILE_ACCOUNTS, 'Synchronize accounting', 'high'],
  ['finance.collect', 'accounting', permissions.RECORD_PAYMENTS, 'Collect payment', 'high', '../sales/payment-automation'],
  ['finance.write_off', 'accounting', permissions.MANAGE_ACCOUNTING, 'Write off a balance', 'critical'],
  ['finance.issue_credit', 'accounting', permissions.MANAGE_ACCOUNTING, 'Issue credit', 'critical'],
  ['finance.refund', 'accounting', permissions.RECORD_PAYMENTS, 'Refund a payment', 'critical'],
  ['repair.execute', 'repairs', permissions.ADMIN, 'Repair an inconsistency', 'high', '../repairs/service'],
  ['integration.process_event', 'integrations', permissions.ADMIN, 'Process provider activity', 'medium', '../connections/event-ingestion'],
].map(([type, domain, permission, title, risk, adapterModule = null]) => Object.freeze({
  type, domain, permission, title, risk, adapterModule,
  autonomousNow:Boolean(adapterModule), defaultsToAutomatic:false,
  lifecycle: Object.freeze(['OBSERVE', 'UNDERSTAND', 'REASON', 'COMPARE', 'DECIDE',
    'AUTHORIZE', 'EXECUTE', 'VERIFY', 'RECOVER', 'COMPENSATE', 'LEARN', 'ESCALATE']),
}));

const BY_TYPE = new Map(DEFINITIONS.map((definition) => [definition.type, definition]));

function requireType(type) {
  const definition = BY_TYPE.get(type);
  if (!definition) throw new Error(`Unknown autonomous operation type: ${type}`);
  return definition;
}

module.exports = { DEFINITIONS, requireType, has: (type) => BY_TYPE.has(type) };
