'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const permissions = require('../actions/permissions');
const { ValidationError } = require('../domain/errors');
const orders = require('../purchasing/po-service');
const policies = require('./policy-service');
const capabilities = require('./capabilities');
const modes = require('./modes');
const autonomous = require('../autonomous/service');
const supplierService = require('../purchasing/supplier-service');

const DAY = 86400000;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function propose(db, workspaceId, { now = Date.now() } = {}) {
  const hasStandingGrants = db.prepare('SELECT 1 FROM autonomous_operation_authority WHERE workspace_id = ? AND enabled = 1 AND revoked_at IS NULL LIMIT 1').get(workspaceId);
  const alreadyConfigured = policies.list(db, workspaceId, { activeOnly: true }).length > 0
    || Boolean(hasStandingGrants) || capabilities.list(db, workspaceId).some((job) => job.granted)
    || require('../shipping/rules').list(db, workspaceId).length > 0;
  if (alreadyConfigured) return { workspaceId, available: false, alreadyConfigured: true };
  const since = new Date(now - 90 * DAY).toISOString();
  const rows = db.prepare(`SELECT p.id FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.workspace_id = ? AND s.workspace_id = ? AND s.status = 'active'
      AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND p.currency = 'USD'
      AND p.ordered_at >= ? AND p.ordered_at <= ? ORDER BY p.ordered_at, p.id`)
    .all(workspaceId, workspaceId, since, new Date(now).toISOString());
  const evidence = rows.map((row) => orders.get(db, workspaceId, row.id))
    .filter((order) => order.hasCosts && order.subtotal > 0 && Number.isFinite(order.subtotal)
      && !db.prepare('SELECT 1 FROM purchase_order_charges WHERE workspace_id = ? AND purchase_order_id = ? LIMIT 1').get(workspaceId, order.id))
    .map((order) => ({ id: order.id, hash: order.integrityHash, orderedAt: order.orderedAt,
      supplierId: order.supplierId, supplierName: order.supplierName,
      valueMinor: Math.round(order.subtotal * 100), skuIds: order.lines.map((line) => line.skuId).sort() }));
  const counts = new Map();
  for (const order of evidence) counts.set(order.supplierId, (counts.get(order.supplierId) || 0) + 1);
  const usual = evidence.filter((order) => counts.get(order.supplierId) >= 3);
  const suppliers = [...new Map(usual.map((order) => [order.supplierId, { id: order.supplierId, name: order.supplierName }])).values()];
  let weeklyMinor = 0;
  for (const order of usual) {
    const end = Date.parse(order.orderedAt);
    const total = usual.filter((entry) => Date.parse(entry.orderedAt) > end - 7 * DAY && Date.parse(entry.orderedAt) <= end)
      .reduce((sum, entry) => sum + entry.valueMinor, 0);
    weeklyMinor = Math.max(weeklyMinor, total);
  }
  const maximumValue = usual.length ? Math.max(...usual.map((order) => order.valueMinor)) / 100 : null;
  const maximumValuePerWeek = weeklyMinor ? weeklyMinor / 100 : null;
  const itemScope = [...new Set(usual.flatMap((order) => order.skuIds))].sort();
  const email = suppliers.map((supplier) => {
    const current = supplierService.getSupplier(db, workspaceId, supplier.id);
    const connector = current.watchedConnectorId ? db.prepare(`SELECT id, display_name, provider_type, provider_account_name
      FROM workspace_connectors WHERE workspace_id = ? AND id = ? AND status = 'connected' AND paused_at IS NULL
        AND provider_type IN ('gmail','microsoft365')
        AND EXISTS (SELECT 1 FROM connection_credentials credentials WHERE credentials.workspace_id = workspace_connectors.workspace_id
          AND credentials.connector_id = workspace_connectors.id AND credentials.credential_kind = 'provider')
        AND EXISTS (SELECT 1 FROM json_each(workspace_connectors.capabilities) WHERE value = 'MAIL_SEND')`).get(workspaceId, current.watchedConnectorId) : null;
    return current.currency === 'USD' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(current.email || '') && connector
      ? { supplierId: current.id, supplierName: current.name, recipient: current.email, connectorId: connector.id,
        mailboxName: connector.provider_account_name || connector.display_name,
        maximumValueMinor: Math.max(...usual.filter((order) => order.supplierId === current.id).map((order) => order.valueMinor)) } : null;
  }).filter(Boolean);
  const shippingConnector = require('../shipping/accounts').connectorFor(db, workspaceId);
  const hasShippingCredentials = shippingConnector && db.prepare("SELECT 1 FROM connection_credentials WHERE workspace_id = ? AND connector_id = ? AND credential_kind = 'provider'").get(workspaceId, shippingConnector.id);
  const accounting = require('../accounting/ledger').settings(db, workspaceId);
  const labelEvidence = hasShippingCredentials && (!accounting.enabled || accounting.currency === 'USD') ? db.prepare(`SELECT t.id, t.amount_minor, t.currency, t.completed_at, s.carrier, s.service
    FROM shipping_label_transactions t JOIN sales_shipments s ON s.id = t.shipment_id AND s.workspace_id = t.workspace_id
    WHERE t.workspace_id = ? AND t.provider = ? AND t.operation = 'PURCHASE' AND t.status = 'SUCCEEDED'
      AND t.provider_reference IS NOT NULL AND t.provider_reference != '' AND t.currency = 'USD' AND t.amount_minor > 0
      AND t.completed_at >= ? AND t.completed_at <= ? AND s.carrier IS NOT NULL AND s.service IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM shipping_label_transactions reversal WHERE reversal.shipment_id = t.shipment_id
        AND reversal.workspace_id = t.workspace_id AND reversal.operation IN ('VOID','REFUND') AND reversal.status = 'SUCCEEDED')
    ORDER BY t.completed_at, t.id`).all(workspaceId, shippingConnector.provider_type, since, new Date(now).toISOString()) : [];
  const shippingGroups = new Map();
  for (const label of labelEvidence) {
    const key = JSON.stringify([label.carrier, label.service]);
    if (!shippingGroups.has(key)) shippingGroups.set(key, []);
    shippingGroups.get(key).push(label);
  }
  const shipping = [...shippingGroups.values()].filter((labels) => labels.length >= 3).map((labels) => ({
    provider: shippingConnector.provider_type, connectorId: shippingConnector.id,
    carrier: labels[0].carrier, service: labels[0].service,
    maximumValueMinor: Math.max(...labels.map((label) => label.amount_minor)), evidence: labels }));
  const snapshot = { workspaceId, suppliers, maximumValue, maximumValuePerWeek, itemScope, evidence: usual, email, shipping };
  return { ...snapshot, available: suppliers.length > 0 || shipping.length > 0, excludedCount: rows.length - usual.length,
    integrityHash: hash(snapshot), alreadyConfigured: false };
}

function approve(db, ctx, membership, expectedHash, options = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'approve data-backed routine authority');
  return inTransaction(db, () => {
    const proposal = propose(db, ctx.workspaceId, options);
    if (!proposal.available || proposal.alreadyConfigured || proposal.integrityHash !== expectedHash) {
      throw new ValidationError('Your records or authority changed. Review the current proposal before confirming.');
    }
    if (proposal.suppliers.length) policies.configureRoutine(db, ctx, membership, { enablePurchasing: true,
      supplierScope: proposal.suppliers.map((supplier) => supplier.id), itemScope: proposal.itemScope,
      maximumValue: proposal.maximumValue, maximumValuePerWeek: proposal.maximumValuePerWeek });
    if (proposal.suppliers.length) capabilities.set(db, ctx, membership, 'replenishment', true);
    if (proposal.email.length) {
      for (const email of proposal.email) supplierService.updateSupplier(db, ctx, membership, email.supplierId,
        { prepareCommunications: true, autoSendEnabled: true, autoSendLimit: email.maximumValueMinor / 100 });
      autonomous.grant(db, ctx, membership, 'supplier.communicate', { currency: 'USD',
        supplierIds: proposal.email.map((email) => email.supplierId),
        maximumValueMinor: Math.max(...proposal.email.map((email) => email.maximumValueMinor)), minimumConfidence: 'high', maximumRisk: 'high' });
      capabilities.set(db, ctx, membership, 'supplier_emails', true);
    }
    if (proposal.shipping.length) {
      for (const shipping of proposal.shipping) require('../shipping/rules').save(db, ctx, {
        name: `History-backed ${shipping.carrier} ${shipping.service}`, carrier: shipping.carrier, service: shipping.service,
        maxCostMinor: shipping.maximumValueMinor, requireByPromised: true });
      autonomous.grant(db, ctx, membership, 'shipping.purchase_label', { currency: 'USD',
        maximumValueMinor: Math.max(...proposal.shipping.map((shipping) => shipping.maximumValueMinor)),
        minimumConfidence: 'high', maximumRisk: 'high' });
      capabilities.set(db, ctx, membership, 'shipping_labels', true);
      require('../shipping/operation-policy').set(db, ctx, 'AUTOMATIC');
    }
    modes.setMode(db, ctx, membership, modes.MODES.POLICY_AUTOMATED);
    return proposal;
  });
}

module.exports = { propose, approve };
