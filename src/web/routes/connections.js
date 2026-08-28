'use strict';

const express = require('express');
const authService = require('../../domain/auth-service');
const locationService = require('../../domain/location-service');
const { inTransaction } = require('../../db');
const connections = require('../../connections/service');
const catalogImport = require('../../connections/catalog-import');
const ingestion = require('../../connections/event-ingestion');
const providerService = require('../../connections/provider-service');
const shopifyBootstrap = require('../../connections/shopify-bootstrap');
const providers = require('../../connections/providers/registry');
const repo = require('../../domain/repository');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');

const router = express.Router();
router.use('/settings/connections', requireAuth);

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
  res.page('connections/index', { title: 'Connections', nav: 'settings', connections: rows,
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
  if (!['shopify', 'square', 'clover'].includes(req.params.provider)) return res.status(404).page('error', {
    title: 'Not found', status: 404, message: 'Provider not found.' });
  const connection = await providerService.completeOAuth(req.db, req.params.provider, req.query,
    `${req.protocol}://${req.get('host')}`);
  req.session.workspaceId = connection.workspace_id;
  req.flash('success', `${connection.display_name} is connected. Foundry discovered its products and locations.`);
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
  const messages = connection.provider_type === 'supplier_email' ? req.db.prepare(`SELECT m.*,
    (SELECT COUNT(*) FROM connection_email_attachments a WHERE a.message_id = m.id) AS attachment_count
    FROM connection_email_messages m WHERE m.workspace_id = ? AND m.connector_id = ?
    ORDER BY received_at DESC LIMIT 50`).all(req.ctx.workspaceId, connection.id) : [];
  const emailRules = connection.provider_type === 'supplier_email' ? req.db.prepare(`SELECT r.*, s.name AS supplier_name
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
  const view = connection.provider_type === 'square' && provider.sandboxMode
    ? 'connections/detail-square-sandbox' : 'connections/detail';
  res.page(view, { title: connection.display_name, nav: 'settings', connection, token,
    issues, events, mappings, reconciliations, messages, emailRules, externalRecords, syncRuns, canBootstrapShopify,
    provider,
    skus: dbSkus(req.db, req.ctx.workspaceId), locations: repo.listLocations(req.db, req.ctx.workspaceId),
    customers: req.db.prepare('SELECT id, name FROM customers WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.ctx.workspaceId),
    suppliers: req.db.prepare('SELECT id, name FROM suppliers WHERE workspace_id = ? ORDER BY name COLLATE NOCASE').all(req.ctx.workspaceId) });
}));

router.post('/settings/connections/:id/sync', requireOwner, asyncRoute(async (req, res) => {
  const result = await providerService.sync(req.db, req.ctx.workspaceId, req.params.id, req.ctx.actorId);
  req.flash('success', `Sync complete: ${result.products} product${result.products === 1 ? '' : 's'}, ${result.locations} location${result.locations === 1 ? '' : 's'}; ${result.needsMapping} need your match.`);
  res.redirect(303, `/settings/connections/${req.params.id}`);
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
  connections.addEmailRule(req.db, req.ctx, req.params.id, req.body);
  req.flash('success', 'Allowed sender saved. Future messages from it will be trusted supplier evidence.');
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

module.exports = router;
