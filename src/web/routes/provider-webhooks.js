'use strict';

const express = require('express');
const { DomainError } = require('../../domain/errors');
const ingestion = require('../../connections/event-ingestion');
const providerService = require('../../connections/provider-service');
const providers = require('../../connections/providers/registry');
const { newId, nowIso } = require('../../lib/util');
const config = require('../../config');
const { safeEqual } = require('../../connections/providers/common');

function createProviderWebhooks(db) {
  const router = express.Router();

  router.post('/woocommerce/callback', async (req, res) => {
    try {
      const connection = await providerService.completeWooCallback(db, req.body || {}, `${req.protocol}://${req.get('host')}`);
      return res.status(200).json({ connected: true, connectionId: connection.id });
    } catch (error) { return apiError(res, error, 'WooCommerce authorization could not be completed.'); }
  });

  router.post('/:provider/webhooks/:connectorId?', async (req, res) => {
    try {
      const providerType = String(req.params.provider || '').toLowerCase();
      const adapter = providers.get(providerType);
      if (!adapter) return res.status(404).json({ error: { code: 'provider_not_found', message: 'Provider not found.' } });
      if (providerType === 'microsoft365' && req.query.validationToken) {
        return res.type('text/plain').status(200).send(String(req.query.validationToken));
      }
      if (providerType === 'gmail') return handleGmailWebhook(db, req, res);
      if (providerType === 'microsoft365') return handleMicrosoftWebhook(db, req, res, adapter);
      if (providerType === 'clover' && req.body?.verificationCode) {
        return res.status(200).json({ verificationCode: req.body.verificationCode });
      }
      if (providerType === 'clover') return handleCloverWebhook(db, req, res, adapter);
      const providerAccountId = providerType === 'square' ? req.body?.merchant_id
        : null;
      const context = await providerService.webhookContext(db, providerType, req.params.connectorId, providerAccountId);
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
      const webhookUrl = `${providerService.providerOrigin(`${req.protocol}://${req.get('host')}`)}${req.originalUrl}`;
      adapter.verifyWebhook({ headers: req.headers, rawBody, webhookUrl, credentials: context.credentials,
        connection: context.connection });
      const events = await adapter.normalizeWebhook({ headers: req.headers, body: req.body || {}, rawBody,
        credentials: context.credentials, connection: context.connection });
      const result = await processEvents(db, context, events);
      return res.status(200).json({ received: true, ...result });
    } catch (error) { return apiError(res, error, 'The provider event could not be processed.'); }
  });
  return router;
}

async function handleGmailWebhook(db, req, res) {
  const expectedToken = config.connections.gmail.pubsubVerificationToken;
  if (!expectedToken || !safeEqual(String(req.query.token || ''), expectedToken)) {
    return res.status(401).json({ error: { code: 'webhook_authentication_failed', message: 'Gmail push notification was not authenticated.' } });
  }
  let notice = {};
  try { notice = JSON.parse(Buffer.from(req.body?.message?.data || '', 'base64').toString('utf8')); } catch { /* invalid becomes ignored */ }
  const email = String(notice.emailAddress || '').toLowerCase();
  const connections = db.prepare(`SELECT * FROM workspace_connectors WHERE provider_type = 'gmail'
    AND lower(provider_account_id) = ? AND status = 'connected' AND paused_at IS NULL
    ORDER BY updated_at DESC`).all(email);
  if (!connections.length) return res.status(202).json({ received: true, message: 'No active Gmail mailbox matched.' });

  // The same mailbox may be deliberately connected to separate workspaces.
  // Pub/Sub identifies the mailbox, not a Foundry connector, so every active
  // workspace must run its own isolated sender rules and idempotency checks.
  // A failure in one workspace must not prevent the others from seeing mail;
  // scheduled polling remains the safe retry path for the failed one.
  let messages = 0; let failed = 0;
  for (const connection of connections) {
    try {
      const result = await providerService.syncMailbox(db, connection.workspace_id, connection.id);
      messages += Number(result.messages || 0);
    } catch {
      failed += 1;
    }
  }
  return res.status(200).json({ received: true, mailboxes: connections.length, messages, failed });
}

async function handleMicrosoftWebhook(db, req, res, adapter) {
  const first = (req.body?.value || [])[0];
  const subscriptionId = first?.subscriptionId;
  let connection = null;
  if (req.params.connectorId) connection = db.prepare(`SELECT * FROM workspace_connectors WHERE id = ?
    AND provider_type = 'microsoft365' AND status = 'connected'`).get(req.params.connectorId);
  if (!connection && subscriptionId) {
    const rows = db.prepare(`SELECT * FROM workspace_connectors WHERE provider_type = 'microsoft365'
      AND status = 'connected'`).all();
    const credentials = require('../../connections/credentials');
    connection = rows.find((row) => credentials.get(db, row.workspace_id, row.id, 'provider')?.subscriptionId === subscriptionId) || null;
  }
  if (!connection) return res.status(202).json({ received: true, message: 'No active Microsoft mailbox matched.' });
  const context = await providerService.webhookContext(db, 'microsoft365', connection.id, null);
  adapter.verifyWebhook({ body: req.body || {}, credentials: context.credentials });
  const result = await providerService.syncMailbox(db, connection.workspace_id, connection.id, { adapter });
  return res.status(202).json({ received: true, ...result });
}

async function handleCloverWebhook(db, req, res, adapter) {
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const webhookUrl = `${providerService.providerOrigin(`${req.protocol}://${req.get('host')}`)}${req.originalUrl}`;
  const totals = { accepted: 0, replayed: 0, needsMapping: 0, failed: 0, retried: 0, ignored: 0, results: [] };
  let handled = 0;
  for (const [merchantId, updates] of Object.entries(req.body?.merchants || {})) {
    let context;
    try { context = await providerService.webhookContext(db, 'clover', null, merchantId); }
    catch (error) {
      if (error.status === 404) { totals.ignored += updates.length; continue; }
      throw error;
    }
    adapter.verifyWebhook({ headers: req.headers, rawBody, webhookUrl, credentials: context.credentials,
      connection: context.connection, body: req.body });
    const body = { ...req.body, merchants: { [merchantId]: updates } };
    const events = await adapter.normalizeWebhook({ headers: req.headers, body, rawBody,
      credentials: context.credentials, connection: context.connection });
    const result = await processEvents(db, context, events);
    for (const key of ['accepted', 'replayed', 'needsMapping', 'failed', 'retried', 'ignored']) {
      totals[key] += Number(result[key] || 0);
    }
    totals.results.push(...(result.results || []));
    handled += 1;
  }
  if (!handled) return res.status(202).json({ received: true, message: 'No active Foundry connection matched this Clover merchant.', ...totals });
  return res.status(200).json({ received: true, ...totals });
}

async function processEvents(db, context, events) {
  const acceptedEvents = []; let ignored = 0;
  for (const event of events) {
    const externalLocationId = event.data?.externalLocationId || event.data?.fulfillmentLocationExternalId;
    const location = externalLocationId ? db.prepare(`SELECT selected FROM connection_external_records
      WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'location' AND external_id = ?`)
      .get(context.connection.workspace_id, context.connection.id, String(externalLocationId)) : null;
    if (location && !location.selected) {
      ignored += 1; recordIgnored(db, context, event, 'Provider location is not selected for this connection.');
    } else acceptedEvents.push(event);
  }
  const result = acceptedEvents.length ? ingestion.ingestBatch(db, context.auth, { events: acceptedEvents })
    : { accepted: 0, replayed: 0, needsMapping: 0, failed: 0, retried: 0, results: [] };
  if (events.some((event) => event.type === 'product.changed' || event.type === 'location.changed')) {
    try { await providerService.sync(db, context.connection.workspace_id, context.connection.id, context.auth.actorId); }
    catch { /* The durable sync issue is the user-facing outcome; webhook still succeeded. */ }
  }
  return { ignored, ...result };
}

function recordIgnored(db, context, event, reason) {
  const now = nowIso();
  db.prepare(`INSERT INTO connector_feed_events
    (id, workspace_id, connector_id, external_event_id, event_type, payload, status, normalized_payload,
     payload_hash, movement_ids, error_message, occurred_at, received_at, processed_at, last_attempt_at)
    VALUES (?, ?, ?, ?, ?, '{}', 'IGNORED', ?, ?, '[]', ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, connector_id, external_event_id) DO NOTHING`)
    .run(newId('cevent'), context.connection.workspace_id, context.connection.id, event.eventId, event.type,
      JSON.stringify(event), require('node:crypto').createHash('sha256').update(JSON.stringify(event)).digest('hex'),
      reason, event.occurredAt || null, now, now, now);
}

function apiError(res, error, fallback) {
  const status = error instanceof DomainError ? error.status : 500;
  if (!(error instanceof DomainError)) console.error('[provider-webhook] unexpected error', error);
  return res.status(status).json({ error: { code: error.code || 'provider_error',
    message: error instanceof DomainError ? error.message : fallback } });
}

module.exports = { createProviderWebhooks };
