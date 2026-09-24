'use strict';

const { seedWorkspace, makeQuantityItem } = require('../helpers');
const auth = require('../../src/domain/auth-service');
const suppliers = require('../../src/purchasing/supplier-service');
const orders = require('../../src/purchasing/po-service');
const work = require('../../src/autopilot/work-items');

function seed(db, overrides = {}) {
  const workspace = seedWorkspace(db, { workspaceName: 'Months Running Business', email: 'autonomy-owner@example.test', password: 'disposable-autonomy-password', ...overrides });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Regular coffee', baseCode: 'COFFEE' });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, { name: 'Usual Coffee Supplier', currency: 'USD' });
  suppliers.linkItem(db, workspace.ctx, membership, { supplierId: supplier.id, skuId: item.skuId, lastUnitCost: 10, isPreferred: true });
  const historical = [];
  for (const [days, quantity] of [[65, 10], [33, 15], [8, 20]]) {
    const order = orders.createOrder(db, workspace.ctx, membership, { supplierId: supplier.id,
      destinationLocationId: workspace.main.id, lines: [{ skuId: item.skuId, quantityUnits: quantity }] });
    orders.approve(db, workspace.ctx, membership, order.id, { expectedHash: order.integrityHash, markOrdered: true });
    const when = new Date(Date.now() - days * 86400000).toISOString();
    db.prepare('UPDATE purchase_orders SET ordered_at = ?, approved_at = ?, created_at = ? WHERE id = ?').run(when, when, when, order.id);
    historical.push(orders.get(db, workspace.workspaceId, order.id));
  }
  const pending = [];
  for (let index = 0; index < 6; index += 1) {
    const order = orders.createOrder(db, workspace.ctx, membership, { supplierId: supplier.id,
      destinationLocationId: workspace.main.id, lines: [{ skuId: item.skuId, quantityUnits: 2 }] });
    const { item: decision } = work.upsert(db, workspace.workspaceId, { category: 'purchase_approval',
      purchaseOrderId: order.id, idempotencyKey: `fixture-approval-${index}`,
      recommendedAction: { actionType: 'approve_purchase_order', purchaseOrderId: order.id, poNumber: order.poNumber,
        supplierId: supplier.id, supplierName: supplier.name, subtotal: order.subtotal },
      approvalRequirement: 'REQUIRED', executionStatus: 'WAITING_FOR_APPROVAL' });
    pending.push(decision);
  }
  const saturday = new Date();
  saturday.setUTCDate(saturday.getUTCDate() - ((saturday.getUTCDay() + 1) % 7 || 7));
  saturday.setUTCHours(10, 0, 0, 0);
  const verified = work.upsert(db, workspace.workspaceId, { category: 'purchase_preparation',
    idempotencyKey: 'historical-saturday-preparation', recommendedAction: { poNumber: 'Historical Saturday draft' },
    executionStatus: 'AUTHORIZED' }).item;
  work.transition(db, workspace.workspaceId, verified.id, 'COMPLETED', {
    verificationStatus: 'VERIFIED', outcome: { autoApproved: false, value: 15 } });
  db.prepare('UPDATE work_items SET completed_at = ? WHERE id = ?').run(saturday.toISOString(), verified.id);
  const sunday = new Date(saturday.getTime() + 86400000);
  return { workspace, membership, item, supplier, historical, pending, saturday: saturday.toISOString().slice(0, 10), sunday: sunday.toISOString().slice(0, 10) };
}

function seedConnectedAuthority(db, env) {
  const { newId, nowIso } = require('../../src/lib/util');
  const connectorId = newId('con');
  const now = nowIso();
  db.prepare(`INSERT INTO workspace_connectors(id, workspace_id, connector_key, display_name, provider_type,
    status, capabilities, credential_ref, authorized_by_user_id, provider_account_name, created_at, updated_at)
    VALUES (?, ?, ?, 'Disposable test mailbox', 'gmail', 'connected', '["MAIL_READ","MAIL_SEND"]', ?, ?, 'fixture@example.test', ?, ?)`)
    .run(connectorId, env.workspace.workspaceId, `fixture:${connectorId}`, `credentials:${connectorId}`, env.workspace.ownerId, now, now);
  require('../../src/connections/credentials').put(db, env.workspace.workspaceId, connectorId, 'provider',
    { accessToken: 'disposable-fixture-token', refreshToken: 'disposable-fixture-refresh', expiresAt: Date.now() + 86400000 });
  suppliers.updateSupplier(db, env.workspace.ctx, env.membership, env.supplier.id,
    { email: 'supplier@example.test', watchedConnectorId: connectorId });
  require('../../src/shipping/accounts').connect(db, env.workspace.ctx, env.membership,
    { provider: 'easypost', apiKey: 'EZTK_disposable_fixture_only' });
  const customer = require('../../src/sales/sales-order-service').createCustomer(db, env.workspace.ctx, { name: 'Historical fixture customer' });
  const salesOrderId = newId('so');
  db.prepare(`INSERT INTO sales_orders(id, workspace_id, customer_id, order_number, order_date,
    status, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, 'HISTORICAL-FIXTURE', ?, 'FULFILLED', ?, ?, ?)`)
    .run(salesOrderId, env.workspace.workspaceId, customer.id, now.slice(0, 10), env.workspace.ownerId, now, now);
  for (let index = 0; index < 3; index += 1) {
    const shipmentId = newId('shp');
    const when = new Date(Date.now() - (20 + index * 10) * 86400000).toISOString();
    db.prepare(`INSERT INTO sales_shipments(id, workspace_id, sales_order_id, shipment_number, status,
      carrier, service, tracking_number, currency, created_at, updated_at) VALUES (?, ?, ?, ?, 'SHIPPED', 'usps', 'GroundAdvantage', ?, 'USD', ?, ?)`)
      .run(shipmentId, env.workspace.workspaceId, salesOrderId, `FIXTURE-${index}`, `fixture-tracking-${index}`, when, when);
    db.prepare(`INSERT INTO shipping_label_transactions(id, workspace_id, shipment_id, provider, operation, status,
      idempotency_key, provider_reference, amount_minor, currency, requested_at, completed_at, updated_at)
      VALUES (?, ?, ?, 'easypost', 'PURCHASE', 'SUCCEEDED', ?, ?, ?, 'USD', ?, ?, ?)`)
      .run(newId('lbl'), env.workspace.workspaceId, shipmentId, `fixture-label-${index}`, `fixture-provider-${index}`, 500 + index * 100, when, when, when);
  }
}

module.exports = { seed, seedConnectedAuthority };
