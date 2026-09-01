'use strict';

const express = require('express');
const authService = require('../../domain/auth-service');
const locationService = require('../../domain/location-service');
const { inTransaction } = require('../../db');
const connections = require('../../connections/service');
const catalogImport = require('../../connections/catalog-import');
const ingestion = require('../../connections/event-ingestion');
const providerService = require('../../connections/provider-service');
const mailboxInventory = require('../../connections/mailbox-inventory');
const documentRestorations = require('../../manager/document-restorations');
const shopifyBootstrap = require('../../connections/shopify-bootstrap');
const providers = require('../../connections/providers/registry');
const supplierService = require('../../purchasing/supplier-service');
const repo = require('../../domain/repository');
const { ValidationError } = require('../../domain/errors');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');

const router = express.Router();
router.use('/settings/connections', requireAuth);

function mailboxStateSignature(db, workspaceId, connectorId) {
  const connection = db.prepare(`SELECT status, paused_at, last_error FROM workspace_connectors
    WHERE workspace_id = ? AND id = ?`).get(workspaceId, connectorId);
  const messages = db.prepare(`SELECT COUNT(*) AS total, COALESCE(MAX(rowid), 0) AS last,
      COALESCE(MAX(processed_at), '') AS processed,
      SUM(CASE WHEN processing_status = 'AWAITING_INVENTORY_REVIEW' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN processing_status = 'DUPLICATE_IGNORED' THEN 1 ELSE 0 END) AS duplicates
    FROM connection_email_messages WHERE workspace_id = ? AND connector_id = ?`)
    .get(workspaceId, connectorId);
  const issues = db.prepare(`SELECT COUNT(*) AS total, COALESCE(MAX(updated_at), '') AS updated
    FROM connection_issues WHERE workspace_id = ? AND connector_id = ? AND status = 'OPEN'`)
    .get(workspaceId, connectorId);
  return JSON.stringify({ connection, messages, issues });
}

router.get('/settings/connections', (req, res, next) => {
  // With Shopify's legacy install flow, the Dev Dashboard opens the configured
  // app URL with the shop in the query string. Continue that launch into the
  // authorization-code grant; merely rendering this page leaves the app in a
  // misleading "current install" state without an access token.
  if (req.query.shop) return requireOwner(req, res, next);
  return next();
}, asyncRoute(async (req, res) => {
  if (req.query.shop) {
    const started = await providerService.beginAuthorization(req.db, req.ctx, {
      providerType: 'shopify',
      shop: req.query.shop,
      displayName: 'Shopify',
      forceOAuth: true,
    }, `${req.protocol}://${req.get('host')}`);
    return res.redirect(303, started.redirectUrl);
  }
  const rows = connections.refreshHealth(req.db, req.ctx.workspaceId);
  const token = req.session.newConnectionToken || null;
  delete req.session.newConnectionToken;
  res.page('connections/index', { title: 'Connections', nav: 'connections', connections: rows,
    providerCatalog: providers.catalog(), newConnectionToken: token });
}));

router.post('/settings/connections', requireOwner, asyncRoute(async (req, res) => {
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  const created = connections.create(req.db, req.ctx, membership, {
    providerType: req.body.providerType,
    displayName: req.body.displayName,
    expectedIntervalMinutes: req.body.expectedIntervalMinutes,
  });
  req.session.newConnectionToken = { connectorId: created.connection.id, token: created.token };
  req.flash('success', `${created.connection.display_name} is ready. Copy its token now.`);
  res.redirect(303, `/settings/connections/${created.connection.id}`);
}));

router.post('/settings/connections/connect', requireOwner, asyncRoute(async (req, res) => {
  const started = await providerService.beginAuthorization(req.db, req.ctx, req.body, `${req.protocol}://${req.get('host')}`);
  if (started.connected) {
    req.flash('success', `${started.connection.display_name} is connected. Foundry discovered its products and locations.`);
    return res.redirect(303, `/settings/connections/${started.connection.id}`);
  }
  res.redirect(303, started.redirectUrl);
}));

router.get('/settings/connections/:provider/callback', requireOwner, asyncRoute(async (req, res) => {
  if (!['shopify', 'square', 'clover', 'gmail', 'microsoft365'].includes(req.params.provider)) return res.status(404).page('error', {
    title: 'Not found', status: 404, message: 'Provider not found.' });
  const connection = await providerService.completeOAuth(req.db, req.params.provider, req.query,
    `${req.protocol}://${req.get('host')}`);
  req.session.workspaceId = connection.workspace_id;
  req.flash('success', ['gmail', 'microsoft365'].includes(req.params.provider)
    ? `${connection.display_name} is connected. Choose the supplier senders Foundry should watch.`
    : `${connection.display_name} is connected. Foundry discovered its products and locations.`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.get('/settings/connections/woocommerce/return', requireOwner, asyncRoute(async (req, res) => {
  if (String(req.query.success) !== '1') {
    req.flash('error', 'WooCommerce authorization was not completed.');
    return res.redirect(303, '/settings/connections');
  }
  const connection = providerService.stateConnection(req.db, req.query.state || req.query.user_id, 'woocommerce');
  req.session.workspaceId = connection.workspace_id;
  req.flash('success', 'WooCommerce authorized the connection. Foundry is finishing catalog discovery.');
  return res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.get('/settings/connections/:id', asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const token = req.session.newConnectionToken && req.session.newConnectionToken.connectorId === connection.id
    ? req.session.newConnectionToken.token : null;
  delete req.session.newConnectionToken;
  const issues = req.db.prepare(`SELECT * FROM connection_issues WHERE workspace_id = ? AND connector_id = ?
    ORDER BY CASE status WHEN 'OPEN' THEN 0 ELSE 1 END, updated_at DESC LIMIT 100`)
    .all(req.ctx.workspaceId, connection.id).map((row) => ({ ...row,
      candidates: connections.parseJson(row.candidate_matches, []) }));
  const events = req.db.prepare(`SELECT * FROM connector_feed_events WHERE workspace_id = ? AND connector_id = ?
    ORDER BY received_at DESC, rowid DESC LIMIT 100`).all(req.ctx.workspaceId, connection.id);
  const mappings = req.db.prepare(`SELECT * FROM connection_mappings WHERE workspace_id = ? AND connector_id = ?
    ORDER BY entity_type, external_id COLLATE NOCASE`).all(req.ctx.workspaceId, connection.id);
  const reconciliations = req.db.prepare(`SELECT * FROM connection_reconciliations WHERE workspace_id = ? AND connector_id = ?
    ORDER BY created_at DESC LIMIT 20`).all(req.ctx.workspaceId, connection.id);
  const isMailbox = ['supplier_email', 'gmail', 'microsoft365'].includes(connection.provider_type);
  const messages = isMailbox ? req.db.prepare(`SELECT m.*,
    (SELECT s.name FROM suppliers s WHERE s.id = m.supplier_id) AS supplier_name,
    (SELECT COUNT(*) FROM connection_email_attachments a WHERE a.message_id = m.id) AS attachment_count,
    (SELECT d.status FROM supplier_documents d WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1)
      AS supplier_document_status,
    (SELECT d.document_type FROM supplier_documents d WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1)
      AS supplier_document_type,
    (SELECT d.facts FROM supplier_documents d WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1)
      AS supplier_document_facts,
    (SELECT d.discrepancies FROM supplier_documents d WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1)
      AS supplier_document_discrepancies,
    (SELECT d.purchase_order_id FROM supplier_documents d WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1)
      AS matched_po_id,
    (SELECT po.po_number FROM supplier_documents d JOIN purchase_orders po ON po.id = d.purchase_order_id
      WHERE d.message_id = m.id ORDER BY d.processed_at DESC LIMIT 1) AS matched_po_number
    ,(SELECT r.status FROM document_restore_reviews r WHERE r.message_id = m.id AND r.workspace_id = m.workspace_id
      ORDER BY r.created_at DESC LIMIT 1) AS restoration_status
    ,(SELECT r.result FROM document_restore_reviews r WHERE r.message_id = m.id AND r.workspace_id = m.workspace_id
      ORDER BY r.created_at DESC LIMIT 1) AS restoration_result
    FROM connection_email_messages m WHERE m.workspace_id = ? AND m.connector_id = ?
    ORDER BY received_at DESC LIMIT 50`).all(req.ctx.workspaceId, connection.id).map((row) => ({
      ...row,
      supplierDocumentFacts: connections.parseJson(row.supplier_document_facts, {}),
      supplierDocumentDiscrepancies: connections.parseJson(row.supplier_document_discrepancies, []),
      restorationResult: connections.parseJson(row.restoration_result, {}),
    })) : [];
  const messageAttachments = isMailbox ? req.db.prepare(`SELECT a.*,
      COALESCE(d.id, duplicate.id) AS document_id,
      COALESCE(d.understanding_id, duplicate.understanding_id) AS understanding_id,
      COALESCE(d.status, duplicate.status) AS document_status,
      COALESCE(d.source_name, duplicate.source_name) AS document_source_name,
      COALESCE(d.created_at, duplicate.created_at) AS document_created_at,
      COALESCE(d.applied_at, duplicate.applied_at) AS document_applied_at,
      COALESCE(d.purchase_order_id, duplicate.purchase_order_id) AS document_purchase_order_id,
      COALESCE(d.result, duplicate.result) AS document_result
    FROM connection_email_attachments a
    JOIN connection_email_messages m ON m.id = a.message_id AND m.workspace_id = a.workspace_id
    LEFT JOIN setup_documents d ON d.id = a.setup_document_id AND d.workspace_id = a.workspace_id
    LEFT JOIN setup_documents duplicate ON duplicate.id = (
      SELECT prior.id FROM setup_documents prior
      WHERE prior.workspace_id = a.workspace_id AND prior.content_hash = a.content_hash
        AND prior.status = 'APPLIED' ORDER BY prior.created_at LIMIT 1)
    WHERE a.workspace_id = ? AND m.connector_id = ? ORDER BY a.created_at, a.rowid`)
    .all(req.ctx.workspaceId, connection.id).map((row) => ({
      ...row, documentResult: connections.parseJson(row.document_result, {}),
    })) : [];
  const emailRules = isMailbox ? req.db.prepare(`SELECT r.*, s.name AS supplier_name
    FROM connection_email_rules r LEFT JOIN suppliers s ON s.id = r.supplier_id
    WHERE r.workspace_id = ? AND r.connector_id = ? ORDER BY r.sender_pattern COLLATE NOCASE`)
    .all(req.ctx.workspaceId, connection.id) : [];
  const externalRecords = req.db.prepare(`SELECT * FROM connection_external_records
    WHERE workspace_id = ? AND connector_id = ? ORDER BY entity_type, mapping_status DESC, display_name COLLATE NOCASE`)
    .all(req.ctx.workspaceId, connection.id);
  const syncRuns = req.db.prepare(`SELECT * FROM connection_sync_runs WHERE workspace_id = ? AND connector_id = ?
    ORDER BY started_at DESC LIMIT 20`).all(req.ctx.workspaceId, connection.id);
  const bootstrapCounts = req.db.prepare(`SELECT
    (SELECT COUNT(*) FROM items WHERE workspace_id = ?) AS items,
    (SELECT COUNT(*) FROM locations WHERE workspace_id = ?) AS locations,
    (SELECT COUNT(*) FROM movements WHERE workspace_id = ?) AS movements`)
    .get(req.ctx.workspaceId, req.ctx.workspaceId, req.ctx.workspaceId);
  const canBootstrapShopify = connection.provider_type === 'shopify' && !connection.config.catalogBootstrap
    && !bootstrapCounts.items && !bootstrapCounts.locations && !bootstrapCounts.movements;
  const provider = providers.get(connection.provider_type)?.metadata() || providers.generic;
  const view = isMailbox ? 'connections/detail-mailbox'
    : connection.provider_type === 'square' && provider.sandboxMode
      ? 'connections/detail-square-sandbox' : 'connections/detail';
  res.page(view, { title: connection.display_name, nav: 'connections', connection, token,
    issues, events, mappings, reconciliations, messages, messageAttachments, emailRules, externalRecords, syncRuns, canBootstrapShopify,
    provider, mailboxSignature: isMailbox
      ? mailboxStateSignature(req.db, req.ctx.workspaceId, connection.id) : null,
    skus: dbSkus(req.db, req.ctx.workspaceId), locations: repo.listLocations(req.db, req.ctx.workspaceId),
    customers: req.db.prepare('SELECT id, name FROM customers WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.ctx.workspaceId),
    suppliers: req.db.prepare('SELECT id, name FROM suppliers WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.ctx.workspaceId) });
}));

router.get('/settings/connections/:id/state', asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!['supplier_email', 'gmail', 'microsoft365'].includes(connection.provider_type)) {
    return res.status(404).json({ error: 'This connection does not have mailbox state.' });
  }
  return res.json({ signature: mailboxStateSignature(req.db, req.ctx.workspaceId, connection.id) });
}));

router.post('/settings/connections/:id/sync', requireOwner, asyncRoute(async (req, res) => {
  const result = await providerService.sync(req.db, req.ctx.workspaceId, req.params.id, req.ctx.actorId);
  req.flash('success', `Sync complete: ${result.products} product${result.products === 1 ? '' : 's'}, ${result.locations} location${result.locations === 1 ? '' : 's'}; ${result.needsMapping} need your match.`);
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/sync-mailbox', requireOwner, asyncRoute(async (req, res) => {
  const result = await providerService.syncMailbox(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', result.messages
    ? `Mailbox checked. Foundry processed ${result.messages} message${result.messages === 1 ? '' : 's'} safely.`
    : 'Mailbox checked. No new supplier messages needed processing.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/mailbox-cadence', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!['gmail', 'microsoft365'].includes(connection.provider_type)) throw new Error('This is not a connected mailbox.');
  const minutes = [1, 5, 10, 15, 30].includes(Number(req.body.minutes)) ? Number(req.body.minutes) : 5;
  const next = { ...connection.config, mailboxCheckMinutes: minutes };
  req.db.prepare(`UPDATE workspace_connectors SET config = ?, expected_interval_minutes = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(JSON.stringify(next), Math.max(15, minutes * 3),
      new Date().toISOString(), req.ctx.workspaceId, connection.id);
  req.flash('success', `Foundry will check this mailbox automatically every ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/email-attachments/:attachmentId/inventory-preview', requireOwner,
  asyncRoute(async (req, res) => {
    const result = await mailboxInventory.prepare(req.db, req.ctx, req.user, req.params.id,
      req.params.attachmentId, { provider: req.app.locals.aiProvider || undefined });
    if (req.body.rememberFuture === '1') {
      const row = mailboxInventory.attachment(req.db, req.ctx.workspaceId, req.params.id, req.params.attachmentId);
      req.db.prepare(`UPDATE connection_email_rules SET document_mode = 'inventory_list'
        WHERE workspace_id = ? AND connector_id = ? AND sender_pattern = ? COLLATE NOCASE`)
        .run(req.ctx.workspaceId, req.params.id, row.sender);
    }
    if (result.alreadyApplied) {
      req.flash('warning', result.duplicate
        ? 'Duplicate ignored: this exact file was already imported. Foundry added no products or quantities.'
        : 'This file was already imported. Foundry added nothing again.');
      return res.redirect(303, `/settings/connections/${req.params.id}`);
    }
    req.flash('success', result.replayed
      ? 'This file is already waiting for review. Foundry did not create another copy.'
      : 'Foundry read the attachment as inventory. Review every match, new item, quantity, cost, and location before approving.');
    return res.redirect(303, `/foundry/proposal/${result.understandingId}`);
  }));

router.post('/settings/connections/:id/email-messages/:messageId/supplier-preview', requireOwner,
  asyncRoute(async (req, res) => {
    const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
    if (!['gmail', 'microsoft365', 'supplier_email'].includes(connection.provider_type)) {
      throw new ValidationError('Supplier-document review belongs to a supplier mailbox.');
    }
    const message = req.db.prepare(`SELECT * FROM connection_email_messages
      WHERE id = ? AND workspace_id = ? AND connector_id = ? AND trust_status = 'TRUSTED'`)
      .get(req.params.messageId, req.ctx.workspaceId, connection.id);
    if (!message) throw new ValidationError('That approved supplier email is no longer available.');
    const supplierEvidence = require('../../purchasing/supplier-evidence');
    const result = await supplierEvidence.interpretAndProcess(req.db, message.id, {
      provider: req.app.locals.aiProvider || undefined,
    });
    const current = req.db.prepare('SELECT processing_status FROM connection_email_messages WHERE id = ?')
      .get(message.id);
    if (!result && current?.processing_status === 'DUPLICATE_IGNORED') {
      req.flash('warning', 'Exact duplicate: this file was already imported earlier. Foundry did not add the same stock twice.');
    } else if (result?.status === 'NEEDS_REVIEW') {
      req.flash('warning', 'Foundry read the purchasing document and needs your decision on the unmatched or changed details.');
    } else {
      req.flash('success', 'Foundry processed the supplier document. Purchasing expectations may be updated; physical inventory was not received.');
    }
    return res.redirect(303, `/settings/connections/${connection.id}${result?.status === 'NEEDS_REVIEW' ? '#needs-you' : `#message-${message.id}`}`);
  }));

router.post('/settings/connections/:id/email-messages/:messageId/save-only', requireOwner,
  asyncRoute(async (req, res) => {
    const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
    const changed = req.db.prepare(`UPDATE connection_email_messages
      SET processing_status = 'SAVED_NO_ACTION', processed_at = ?
      WHERE id = ? AND workspace_id = ? AND connector_id = ? AND trust_status = 'TRUSTED'
        AND processing_status = 'CAPTURED'`)
      .run(new Date().toISOString(), req.params.messageId, req.ctx.workspaceId, connection.id).changes;
    if (!changed) throw new ValidationError('That email no longer needs a choice.');
    req.flash('success', 'Saved the email and attachment in history only. Purchasing and inventory were not changed.');
    return res.redirect(303, `/settings/connections/${connection.id}#message-${req.params.messageId}`);
  }));

router.get('/settings/connections/:id/email-messages/:messageId/restore-import', requireOwner,
  asyncRoute(async (req, res) => {
    const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
    if (!['gmail', 'microsoft365', 'supplier_email'].includes(connection.provider_type)) {
      throw new ValidationError('Import restoration belongs to a connected supplier mailbox.');
    }
    const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
    const review = documentRestorations.prepare(req.db, req.ctx, membership, connection.id, req.params.messageId);
    return res.page('connections/restore-import', {
      title: review.status === 'COMPLETED' ? 'Import restored' : 'Restore the removed import?',
      nav: 'connections', connection, provider: providers.get(connection.provider_type)?.metadata() || providers.generic,
      review,
    });
  }));

router.post('/settings/connections/:id/email-messages/:messageId/restore-import', requireOwner,
  asyncRoute(async (req, res) => {
    const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
    const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
    const review = documentRestorations.prepare(req.db, req.ctx, membership, connection.id, req.params.messageId);
    const completed = documentRestorations.approve(req.db, req.ctx, membership, review.id, req.body.integrityHash);
    req.flash('success', `Restored ${completed.result.productsRestored} products, ${completed.result.variantsRestored} variants, and ${completed.result.unitsRestored} ${completed.result.unitLabel}${completed.result.unitsRestored === 1 ? '' : 's'}. No duplicate products were created.`);
    return res.redirect(303, `/settings/connections/${connection.id}#message-${req.params.messageId}`);
  }));

router.post('/settings/connections/:id/email-messages/:messageId/keep-removed', requireOwner,
  asyncRoute(async (req, res) => {
    const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
    const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
    const review = documentRestorations.prepare(req.db, req.ctx, membership, connection.id, req.params.messageId);
    documentRestorations.decline(req.db, req.ctx.workspaceId, review.id);
    req.flash('success', 'Kept the earlier import removed. This email remains in message history and inventory was not changed.');
    return res.redirect(303, `/settings/connections/${connection.id}#message-${req.params.messageId}`);
  }));

router.post('/settings/connections/:id/bootstrap-shopify', requireOwner, asyncRoute(async (req, res) => {
  const result = await shopifyBootstrap.bootstrap(req.db, req.ctx, req.params.id);
  req.flash('success', result.replayed
    ? 'Shopify’s opening catalogue was already imported; nothing was duplicated.'
    : `Shopify setup complete: ${result.items} products, ${result.skus} variants, ${result.locations} locations, and ${result.openingUnits} opening units.`);
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/reconcile', requireOwner, asyncRoute(async (req, res) => {
  const result = await providerService.reviewHistory(req.db, req.ctx.workspaceId, req.params.id);
  req.flash(result.status === 'MATCHED' ? 'success' : 'warning', result.status === 'MATCHED'
    ? `Provider history matches the ${result.observed} operational records Foundry safely processed.`
    : `History mismatch: provider ${result.expected}, Foundry ${result.observed}. No inventory balance was overwritten.`);
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/square-sandbox-checkout', requireOwner, asyncRoute(async (req, res) => {
  const checkout = await providerService.createSandboxCheckout(req.db, req.ctx.workspaceId, req.params.id, req.body);
  res.redirect(303, checkout.url);
}));

router.post('/settings/connections/:id/locations', requireOwner, asyncRoute(async (req, res) => {
  providerService.setSelectedLocations(req.db, req.ctx.workspaceId, req.params.id, req.body.externalLocationIds || []);
  req.flash('success', 'Locations saved. Foundry will accept activity only for the selected provider locations.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/ignore', requireOwner, asyncRoute(async (req, res) => {
  providerService.ignoreExternal(req.db, req.ctx.workspaceId, req.params.id, req.body.entityType, req.body.externalId);
  req.flash('success', 'That external record will be ignored. It will not change Foundry.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

function dbSkus(db, workspaceId) {
  return db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? ORDER BY i.name COLLATE NOCASE, s.variant_label COLLATE NOCASE`)
    .all(workspaceId);
}

router.post('/settings/connections/:id/map', requireOwner, asyncRoute(async (req, res) => {
  connections.mapExternal(req.db, req.ctx, req.params.id, req.body);
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const auth = { connectorId: connection.id, workspaceId: req.ctx.workspaceId, actorId: req.ctx.actorId,
    accountId: req.ctx.accountId, providerType: connection.provider_type, displayName: connection.display_name };
  const retried = ingestion.retryPending(req.db, auth);
  const completed = retried.filter((row) => row.accepted).length;
  req.flash('success', completed ? `Mapping saved. Foundry safely completed ${completed} waiting event${completed === 1 ? '' : 's'}.`
    : 'Mapping saved. Foundry will remember it for future events.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/supplier-sku-map', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!['gmail', 'microsoft365', 'supplier_email'].includes(connection.provider_type)) {
    throw new Error('Supplier SKU matches belong to a supplier mailbox.');
  }
  const issue = req.db.prepare(`SELECT * FROM connection_issues
    WHERE id = ? AND workspace_id = ? AND connector_id = ? AND status = 'OPEN'
      AND issue_type = 'SUPPLIER_DOCUMENT_REVIEW'`)
    .get(req.body.issueId, req.ctx.workspaceId, connection.id);
  if (!issue) throw new Error('That supplier-document decision is no longer waiting.');
  const candidates = connections.parseJson(issue.candidate_matches, []);
  const candidate = candidates.find((entry) => entry.kind === 'supplier_sku'
    && entry.supplierSku === req.body.supplierSku);
  if (!candidate?.supplierId) throw new Error('That supplier SKU cannot be matched from this decision.');
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  supplierService.linkItem(req.db, req.ctx, membership, {
    supplierId: candidate.supplierId, skuId: req.body.skuId, supplierSku: candidate.supplierSku,
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
  });
  const now = new Date().toISOString();
  req.db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ?`).run(now, now, issue.id, req.ctx.workspaceId);
  req.flash('success', `Matched supplier SKU ${candidate.supplierSku}. Future documents will use this product automatically.`);
  return res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/supplier-document-decision', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!['gmail', 'microsoft365', 'supplier_email'].includes(connection.provider_type)) {
    throw new Error('Supplier-document decisions belong to a supplier mailbox.');
  }
  const result = require('../../purchasing/supplier-evidence').decide(
    req.db, req.ctx, req.body.issueId, req.body.decision
  );
  req.flash('success', result.decision === 'accept'
    ? 'Accepted the supplier changes and updated the purchase order. Inventory was not received.'
    : 'Kept the original purchase order. The supplier document remains in the audit history.');
  return res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/supplier-document-ignore', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  if (!['gmail', 'microsoft365', 'supplier_email'].includes(connection.provider_type)) {
    throw new Error('Supplier-document decisions belong to a supplier mailbox.');
  }
  require('../../purchasing/supplier-evidence').ignoreReview(req.db, req.ctx, req.body.issueId);
  req.flash('success', 'Ignored this document as a purchasing update. The original email remains in message history and inventory was not changed.');
  return res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/create-location-map', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const externalId = String(req.body.externalId || '');
  const external = req.db.prepare(`SELECT * FROM connection_external_records
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'location'
      AND external_id = ? COLLATE NOCASE AND mapping_status = 'UNMAPPED'`)
    .get(req.ctx.workspaceId, connection.id, externalId);
  if (!external) throw new Error('That external location no longer needs a match. Refresh the connection and try again.');
  const location = inTransaction(req.db, () => {
    const created = locationService.createLocation(req.db, req.ctx, {
      name: req.body.name,
      kind: req.body.kind,
      note: `Created while connecting ${connection.display_name}`,
    });
    connections.mapExternal(req.db, req.ctx, connection.id, {
      entityType: 'location', externalId: external.external_id, foundryRecordId: created.id,
    });
    return created;
  });
  const auth = { connectorId: connection.id, workspaceId: req.ctx.workspaceId, actorId: req.ctx.actorId,
    accountId: req.ctx.accountId, providerType: connection.provider_type, displayName: connection.display_name };
  const completed = ingestion.retryPending(req.db, auth).filter((row) => row.accepted).length;
  req.flash('success', `Created ${location.name} and matched it to ${external.display_name}. Future activity will use it automatically.${completed ? ` ${completed} waiting event${completed === 1 ? '' : 's'} completed safely.` : ''}`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/create-product-map', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const result = catalogImport.importProducts(req.db, req.ctx, connection, [req.body.externalId]);
  if (!result.mapped) throw new Error('That external product no longer needs a match. Refresh the connection and try again.');
  const auth = { connectorId: connection.id, workspaceId: req.ctx.workspaceId, actorId: req.ctx.actorId,
    accountId: req.ctx.accountId, providerType: connection.provider_type, displayName: connection.display_name };
  const completed = ingestion.retryPending(req.db, auth).filter((row) => row.accepted).length;
  req.flash('success', `Created ${result.mapped} product variant${result.mapped === 1 ? '' : 's'} from ${connection.display_name}, including ${result.priceCount} price${result.priceCount === 1 ? '' : 's'} and ${result.openingUnits} opening unit${result.openingUnits === 1 ? '' : 's'}. Future activity is mapped automatically.${completed ? ` ${completed} waiting event${completed === 1 ? '' : 's'} completed safely.` : ''}`);
  res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/create-products-map', requireOwner, asyncRoute(async (req, res) => {
  const connection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  const result = catalogImport.importProducts(req.db, req.ctx, connection, req.body.externalIds);
  if (!result.mapped) {
    req.flash('success', 'Those products are already in Foundry. Nothing was added twice.');
    return res.redirect(303, `/settings/connections/${connection.id}`);
  }
  const auth = { connectorId: connection.id, workspaceId: req.ctx.workspaceId, actorId: req.ctx.actorId,
    accountId: req.ctx.accountId, providerType: connection.provider_type, displayName: connection.display_name };
  const completed = ingestion.retryPending(req.db, auth).filter((row) => row.accepted).length;
  req.flash('success', `Added ${result.items} product${result.items === 1 ? '' : 's'} (${result.mapped} variant${result.mapped === 1 ? '' : 's'}) from ${connection.display_name}, including ${result.priceCount} price${result.priceCount === 1 ? '' : 's'} and ${result.openingUnits} opening unit${result.openingUnits === 1 ? '' : 's'}. Future activity is mapped automatically.${completed ? ` ${completed} waiting event${completed === 1 ? '' : 's'} completed safely.` : ''}`);
  return res.redirect(303, `/settings/connections/${connection.id}`);
}));

router.post('/settings/connections/:id/email-rules', requireOwner, asyncRoute(async (req, res) => {
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  const senderPattern = String(req.body.senderPattern || '').trim();
  const supplierChoice = String(req.body.supplierChoice || '').trim();
  let supplierId = String(req.body.supplierId || '').trim() || null;
  const existingRule = senderPattern ? req.db.prepare(`SELECT supplier_id FROM connection_email_rules
    WHERE workspace_id = ? AND connector_id = ? AND sender_pattern = ? COLLATE NOCASE`)
    .get(req.ctx.workspaceId, req.params.id, senderPattern) : null;
  if (!supplierChoice && existingRule?.supplier_id && !supplierId) supplierId = existingRule.supplier_id;

  let supplier;
  if (supplierChoice === 'new') {
    if (supplierId) throw new ValidationError('Choose an existing supplier or create a new one, not both.');
    const supplierName = String(req.body.supplierName || '').trim();
    if (!supplierName) throw new ValidationError('Enter the new supplier name before creating it.');
    const duplicate = req.db.prepare(`SELECT id FROM suppliers
      WHERE workspace_id = ? AND name = ? COLLATE NOCASE`).get(req.ctx.workspaceId, supplierName);
    if (duplicate) {
      throw new ValidationError(`“${supplierName}” already exists. Select it from the existing-supplier list instead.`);
    }
    supplier = supplierService.createSupplier(req.db, req.ctx, membership, {
      name: supplierName,
      email: senderPattern.startsWith('@') ? null : senderPattern,
      watchedConnectorId: req.params.id,
    });
    supplierId = supplier.id;
  } else {
    if (supplierChoice && supplierChoice !== 'existing') {
      throw new ValidationError('Choose an existing supplier or explicitly create a new supplier.');
    }
    if (!supplierId) {
      throw new ValidationError('Choose which existing supplier sends from this address, or explicitly create a new supplier.');
    }
    supplier = supplierService.getSupplier(req.db, req.ctx.workspaceId, supplierId);
  }

  connections.addEmailRule(req.db, req.ctx, req.params.id, {
    senderPattern, supplierId, documentMode: req.body.documentMode,
  });
  supplierService.updateSupplier(req.db, req.ctx, membership, supplierId, {
    watchedConnectorId: req.params.id,
  });
  let found = 0;
  const mailboxConnection = connections.get(req.db, req.ctx.workspaceId, req.params.id);
  try {
    // The approved message may already be in the inbox. Looking back after the
    // rule is saved prevents the normal setup order (connect, approve sender)
    // from skipping the very file the owner connected Gmail to retrieve.
    if (['gmail', 'microsoft365'].includes(mailboxConnection.provider_type)) {
      const result = await providerService.syncMailbox(req.db, req.ctx.workspaceId, req.params.id, {
        since: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
      });
      found = result.messages || 0;
    }
  } catch (error) {
    req.flash('error', `The sender rule was saved, but the mailbox check could not finish: ${error.message}`);
  }
  req.flash('success', found
    ? `Foundry is watching ${senderPattern} and checked the mailbox now. Open Home to review what it found.`
    : `Foundry is watching ${senderPattern}. It will check automatically and put any required review on Home.`);
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/pause', requireOwner, asyncRoute(async (req, res) => {
  connections.pause(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'Foundry has stopped trusting new events from this connection.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/resume', requireOwner, asyncRoute(async (req, res) => {
  connections.resume(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'Foundry is accepting trusted events from this connection again.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/disconnect', requireOwner, asyncRoute(async (req, res) => {
  connections.disconnect(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'Connection disconnected. Its mappings and audit history were kept.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/rotate', requireOwner, asyncRoute(async (req, res) => {
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  const rotated = connections.rotateToken(req.db, req.ctx, membership, req.params.id);
  req.session.newConnectionToken = { connectorId: req.params.id, token: rotated.token };
  req.flash('success', 'Connection token rotated. The old token no longer works.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

router.post('/settings/connections/:id/checkout-token', requireOwner, asyncRoute(async (req, res) => {
  const membership = authService.getMembership(req.db, req.ctx.workspaceId, req.ctx.accountId);
  const issued = connections.issueCheckoutToken(req.db, req.ctx, membership, req.params.id);
  req.session.newConnectionToken = { connectorId: req.params.id, token: issued.token };
  req.flash('success', 'Checkout key created. Copy it now; Foundry will not show it again.');
  res.redirect(303, `/settings/connections/${req.params.id}`);
}));

module.exports = router;
