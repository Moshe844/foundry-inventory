'use strict';

const inventory = require('../domain/postgres-inventory-engine');
const ledger = require('../accounting/postgres-ledger');
const workflows = require('./postgres-business-workflows');

function scopedDatabase(client) {
  return {
    query: (statement, values = []) => client.query(statement, values),
    transaction: (operation) => operation(client),
  };
}

function context(job) {
  const actorId = job.payload?.actorId;
  if (!job.workspaceId || !actorId) {
    throw Object.assign(new Error('A business job requires workspace and actor identity.'), {
      code: 'invalid_business_job', retryable: false,
    });
  }
  return { workspaceId: job.workspaceId, actorId };
}

function input(job) {
  return { ...(job.payload?.input || {}), idempotencyKey: job.idempotencyKey };
}

function create() {
  return {
    'inventory.receive': async (job, client) => inventory.receive(scopedDatabase(client), context(job), input(job)),
    'inventory.issue': async (job, client) => inventory.issue(scopedDatabase(client), context(job), input(job)),
    'inventory.transfer': async (job, client) => inventory.transfer(scopedDatabase(client), context(job), input(job)),
    'inventory.adjust': async (job, client) => inventory.adjust(scopedDatabase(client), context(job), input(job)),
    'accounting.post': async (job, client) => ledger.post(scopedDatabase(client), context(job), input(job)),
    'purchase-order.create': async (job, client) => workflows.createPurchaseOrder(
      scopedDatabase(client), context(job), input(job)),
    'purchase-order.approve': async (job, client) => workflows.approvePurchaseOrder(
      scopedDatabase(client), context(job), job.payload.purchaseOrderId, input(job)),
    'purchase-order.place': async (job, client) => workflows.placePurchaseOrder(
      scopedDatabase(client), context(job), job.payload.purchaseOrderId, input(job)),
    'purchase-order.receive': async (job, client) => workflows.receivePurchaseOrder(
      scopedDatabase(client), context(job), job.payload.purchaseOrderId, input(job)),
    'supplier-invoice.record': async (job, client) => workflows.recordSupplierInvoice(
      scopedDatabase(client), context(job), input(job)),
    'sales-order.create': async (job, client) => workflows.createSalesOrder(
      scopedDatabase(client), context(job), input(job)),
    'sales-order.confirm': async (job, client) => workflows.confirmSalesOrder(
      scopedDatabase(client), context(job), job.payload.salesOrderId, input(job)),
    'sales-order.fulfill': async (job, client) => workflows.fulfillSalesOrder(
      scopedDatabase(client), context(job), job.payload.salesOrderId, input(job)),
    'customer-payment.record': async (job, client) => workflows.recordCustomerPayment(
      scopedDatabase(client), context(job), input(job)),
    'supplier-payment.record': async (job, client) => workflows.recordSupplierPayment(
      scopedDatabase(client), context(job), input(job)),
  };
}

module.exports = { create, scopedDatabase };
