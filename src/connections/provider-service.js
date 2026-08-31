'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { inTransaction } = require('../db');
const repo = require('../domain/repository');
const { AuthenticationError, NotFoundError, ValidationError } = require('../domain/errors');
const { newId, nowIso, requireText } = require('../lib/util');
const connections = require('./service');
const credentialsStore = require('./credentials');
const providers = require('./providers/registry');

const stateHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function createState(db, ctx, connectorId, providerType, metadata = {}) {
  const state = crypto.randomBytes(32).toString('base64url');
  const now = nowIso();
  db.prepare(`INSERT INTO connection_authorization_states
    (id, state_hash, workspace_id, connector_id, provider_type, actor_id, metadata, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId('cauth'), stateHash(state), ctx.workspaceId, connectorId, providerType, ctx.actorId,
      JSON.stringify(metadata), new Date(Date.now() + 15 * 60_000).toISOString(), now);
  return state;
}

function readState(db, state, providerType, consume = false) {
  const row = db.prepare(`SELECT * FROM connection_authorization_states
    WHERE state_hash = ? AND provider_type = ?`).get(stateHash(state), providerType);
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) {
    throw new AuthenticationError('This connection request has expired. Please start again.');
  }
  if (consume) db.prepare('UPDATE connection_authorization_states SET used_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { ...row, metadata: connections.parseJson(row.metadata, {}) };
}

function stateConnection(db, state, providerType) {
  const row = db.prepare(`SELECT workspace_id, connector_id FROM connection_authorization_states
    WHERE state_hash = ? AND provider_type = ?`).get(stateHash(state), providerType);
  if (!row) throw new NotFoundError('Connection request not found.');
  return connections.get(db, row.workspace_id, row.connector_id);
}

function providerOrigin(requestOrigin) { return config.connections.publicOrigin || requestOrigin; }

async function beginAuthorization(db, ctx, input, requestOrigin) {
  const providerType = requireText(input.providerType, 'Provider', { max: 40 }).toLowerCase();
  const adapter = providers.get(providerType);
  if (!adapter) throw new ValidationError('Choose a supported connection provider.');
  const meta = adapter.metadata();
  if (!meta.available) throw new ValidationError(meta.unavailableReason);
  const now = nowIso();
  const connectorId = input.connectorId || newId('con');
  const origin = providerOrigin(requestOrigin);
  if (!input.connectorId) {
    const expectedIntervalMinutes = ['gmail', 'microsoft365'].includes(providerType)
      ? Math.max(1, Number(input.expectedIntervalMinutes) || 5)
      : Math.max(0, Number(input.expectedIntervalMinutes) || 360);
    db.prepare(`INSERT INTO workspace_connectors
      (id, workspace_id, connector_key, display_name, provider_type, status, capabilities, provides,
       config, expected_interval_minutes, setup_status, authorized_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'disconnected', '[]', ?, '{}', ?, 'AUTHORIZING', ?, ?, ?)`)
      .run(connectorId, ctx.workspaceId, `${providerType}:${connectorId}`, input.displayName || meta.name,
        providerType, JSON.stringify(meta.provides), expectedIntervalMinutes,
        ctx.actorId, now, now);
  } else {
    const existing = connections.get(db, ctx.workspaceId, connectorId);
    if (existing.provider_type !== providerType) throw new ValidationError('That connection uses a different provider.');
    db.prepare(`UPDATE workspace_connectors SET setup_status = 'AUTHORIZING', status = 'disconnected',
      authorized_by_user_id = ?, last_error = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(ctx.actorId, now, ctx.workspaceId, connectorId);
  }
  const connection = connections.get(db, ctx.workspaceId, connectorId);
  if (!input.forceOAuth && adapter.tryDirectAuthorization) {
    let direct;
    try {
      direct = await adapter.tryDirectAuthorization({ input });
    } catch (error) {
      const failedAt = nowIso();
      db.prepare(`UPDATE workspace_connectors SET status = 'error', setup_status = 'AUTHORIZATION_FAILED',
        last_error = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
        .run(String(error.message).slice(0, 500), failedAt, ctx.workspaceId, connectorId);
      throw error;
    }
    if (direct) {
      const connected = await finishAuthorization(db, connection, ctx.actorId, direct, requestOrigin, adapter);
      return { connectorId, connected: true, connection: connected, redirectUrl: null };
    }
  }
  const state = createState(db, ctx, connectorId, providerType);
  const auth = adapter.authorizationUrl({ state, input: {
    ...input, redirectUri: `${origin}/settings/connections/${providerType}/callback`,
    returnUri: `${origin}/settings/connections/woocommerce/return?state=${encodeURIComponent(state)}`,
    callbackUri: `${origin}/api/v1/connections/woocommerce/callback`,
  } });
  db.prepare('UPDATE connection_authorization_states SET metadata = ? WHERE state_hash = ?')
    .run(JSON.stringify(auth.metadata || {}), stateHash(state));
  return { connectorId, redirectUrl: auth.url };
}

async function loadProviderCredentials(db, connection, adapter) {
  let providerCredentials = credentialsStore.get(db, connection.workspace_id, connection.id, 'provider');
  if (!providerCredentials) throw new AuthenticationError('Reconnect this provider before syncing.');
  if (adapter?.refreshCredentials) {
    const refreshed = await adapter.refreshCredentials(providerCredentials);
    providerCredentials = refreshed.credentials;
    if (refreshed.refreshed) {
      credentialsStore.put(db, connection.workspace_id, connection.id, 'provider', providerCredentials,
        refreshed.expiresAt || null);
    }
  }
  return providerCredentials;
}

function actorAuth(db, connection) {
  const row = db.prepare(`SELECT u.id AS actor_id, u.account_id FROM users u
    WHERE u.workspace_id = ? AND u.id = ?`).get(connection.workspace_id, connection.authorized_by_user_id);
  if (!row) throw new AuthenticationError('The user who authorized this connection no longer has access.');
  return { connectorId: connection.id, workspaceId: connection.workspace_id, actorId: row.actor_id,
    accountId: row.account_id, providerType: connection.provider_type, displayName: connection.display_name };
}

async function completeOAuth(db, providerType, query, requestOrigin) {
  const adapter = providers.get(providerType);
  if (!adapter) throw new NotFoundError('Provider not found.');
  const state = readState(db, query.state, providerType, true);
  const connection = connections.get(db, state.workspace_id, state.connector_id);
  const result = await adapter.exchangeAuthorization({ query, metadata: state.metadata });
  return finishAuthorization(db, connection, state.actor_id, result, requestOrigin, adapter);
}

async function completeWooCallback(db, body, requestOrigin) {
  const state = readState(db, body.user_id, 'woocommerce', true);
  const connection = connections.get(db, state.workspace_id, state.connector_id);
  const adapter = providers.get('woocommerce');
  const providerCredentials = adapter.credentialsFromCallback(body, state.metadata);
  const result = { credentials: providerCredentials, accountId: state.metadata.storeUrl,
    accountName: new URL(state.metadata.storeUrl).hostname, capabilities: ['read_orders', 'read_products', 'webhooks'] };
  return finishAuthorization(db, connection, state.actor_id, result, requestOrigin, adapter);
}

async function finishAuthorization(db, connection, actorId, result, requestOrigin, adapter) {
  // A fresh "connect another mailbox" attempt may still authorize an address
  // that is already connected. Keep the established connector in that case:
  // it owns the sender rules, message history and audit trail. The fresh row is
  // only an empty authorization placeholder, so remove it and refresh the
  // existing connector's credential instead of replacing the working mailbox.
  if (['gmail', 'microsoft365'].includes(connection.provider_type) && result.accountId
      && connection.setup_status === 'AUTHORIZING' && !connection.credential_ref
      && !connection.provider_account_id) {
    const established = db.prepare(`SELECT id FROM workspace_connectors
      WHERE workspace_id = ? AND provider_type = ? AND provider_account_id = ?
        AND id <> ? AND status = 'connected'
      ORDER BY updated_at DESC LIMIT 1`)
      .get(connection.workspace_id, connection.provider_type, result.accountId, connection.id);
    if (established) {
      db.prepare('DELETE FROM workspace_connectors WHERE workspace_id = ? AND id = ?')
        .run(connection.workspace_id, connection.id);
      connection = connections.get(db, connection.workspace_id, established.id);
    }
  }
  credentialsStore.put(db, connection.workspace_id, connection.id, 'provider', result.credentials, result.expiresAt);
  const now = nowIso();
  const configValue = { ...connection.config };
  if (result.credentials.shop) configValue.shop = result.credentials.shop;
  if (result.credentials.storeUrl) configValue.storeUrl = result.credentials.storeUrl;
  db.prepare(`UPDATE workspace_connectors SET status = 'connected', setup_status = 'DISCOVERING',
    capabilities = ?, config = ?, credential_ref = ?, provider_account_id = ?, provider_account_name = ?,
    authorized_by_user_id = ?, last_error = NULL, paused_at = NULL, updated_at = ?
    WHERE workspace_id = ? AND id = ?`)
    .run(JSON.stringify(result.capabilities || []), JSON.stringify(configValue), `connection_credentials:${connection.id}`,
      result.accountId || null, result.accountName || null, actorId, now, connection.workspace_id, connection.id);
  deactivateDuplicateProviderAccounts(db, connection.workspace_id, connection.id,
    connection.provider_type, result.accountId);
  const current = connections.get(db, connection.workspace_id, connection.id);
  const origin = providerOrigin(requestOrigin);
  if (adapter.registerWebhooks && (origin.startsWith('https://') || process.env.NODE_ENV === 'test')) {
    const webhookUrl = adapter.webhookUrl
      ? adapter.webhookUrl({ origin, connection: current })
      : `${origin}/api/v1/connections/${connection.provider_type}/webhooks/${connection.id}`;
    try {
      const registration = await adapter.registerWebhooks({ credentials: result.credentials, webhookUrl });
      if (registration?.credentials) {
        result.credentials = registration.credentials;
        credentialsStore.put(db, connection.workspace_id, connection.id, 'provider', result.credentials, result.expiresAt);
      }
      const registrationErrors = Array.isArray(registration)
        ? registration.filter((row) => row?.error)
        : [];
      if (registrationErrors.length) {
        const detail = registrationErrors.map((row) => `${row.topic}: ${row.error}`).join('; ');
        db.prepare('UPDATE workspace_connectors SET last_error = ?, updated_at = ? WHERE id = ?')
          .run(`Webhook setup: ${detail}`.slice(0, 500), nowIso(), connection.id);
        connections.issue(db, { workspaceId: connection.workspace_id, connectorId: connection.id,
          issueType: 'CONNECTION_WEBHOOK_SETUP_FAILED', fingerprint: `webhook-setup:${connection.id}`,
          title: `${connection.display_name} could not subscribe to every required event`, detail,
          resolutionHint: 'Approve the required provider permissions, then reconnect this account.' });
      }
    }
    catch (error) {
      db.prepare('UPDATE workspace_connectors SET last_error = ?, updated_at = ? WHERE id = ?')
        .run(`Webhook setup: ${error.message}`, nowIso(), connection.id);
    }
  }
  await sync(db, current.workspace_id, current.id, actorId, { adapter });
  return connections.get(db, current.workspace_id, current.id);
}

function deactivateDuplicateProviderAccounts(db, workspaceId, connectorId, providerType, providerAccountId) {
  if (!providerAccountId) return 0;
  const now = nowIso();
  const result = db.prepare(`UPDATE workspace_connectors
    SET status = 'disconnected', setup_status = 'DUPLICATE_CONNECTION', paused_at = ?,
      last_error = 'Another connection to this provider account is active. Mapping and audit history are preserved.',
      updated_at = ?
    WHERE workspace_id = ? AND provider_type = ? AND provider_account_id = ? AND id <> ?
      AND status <> 'disconnected'`)
    .run(now, now, workspaceId, providerType, providerAccountId, connectorId);
  return result.changes;
}

function exactTarget(db, workspaceId, record) {
  if (record.entityType === 'sku' && record.code) {
    const rows = db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? AND s.code = ? COLLATE NOCASE`)
      .all(workspaceId, record.code);
    return rows.length === 1 ? rows[0].id : null;
  }
  if (record.entityType === 'location') {
    const rows = db.prepare('SELECT id FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1')
      .all(workspaceId, record.displayName);
    return rows.length === 1 ? rows[0].id : null;
  }
  return null;
}

function cacheRecord(db, connection, actorId, record) {
  const now = nowIso();
  const existingMapping = db.prepare(`SELECT foundry_record_id FROM connection_mappings
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = ? AND external_id = ?`)
    .get(connection.workspace_id, connection.id, record.entityType, String(record.externalId));
  const exact = existingMapping ? null : exactTarget(db, connection.workspace_id, record);
  const target = existingMapping?.foundry_record_id || exact;
  db.prepare(`INSERT INTO connection_external_records
    (id, workspace_id, connector_id, entity_type, external_id, parent_external_id, code, display_name,
     provider_data, mapping_status, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, connector_id, entity_type, external_id) DO UPDATE SET
      parent_external_id = excluded.parent_external_id, code = excluded.code, display_name = excluded.display_name,
      provider_data = excluded.provider_data,
      mapping_status = CASE
        WHEN connection_external_records.mapping_status = 'IGNORED' AND excluded.mapping_status = 'UNMAPPED'
          THEN 'IGNORED'
        ELSE excluded.mapping_status
      END,
      last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`)
    .run(newId('cext'), connection.workspace_id, connection.id, record.entityType, String(record.externalId),
      record.parentExternalId ? String(record.parentExternalId) : null, record.code || null, record.displayName,
      JSON.stringify(record.providerData || {}), target ? 'MAPPED' : 'UNMAPPED', now, now, now);
  if (target) {
    if (!existingMapping) {
      db.prepare(`INSERT INTO connection_mappings
        (id, workspace_id, connector_id, entity_type, external_id, foundry_record_id, confidence, approved_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'exact', ?, ?, ?)`)
        .run(newId('cmap'), connection.workspace_id, connection.id, record.entityType, String(record.externalId), target,
          actorId, now, now);
    }
    connections.resolveIssues(db, connection.workspace_id, connection.id, `UNKNOWN_${record.entityType.toUpperCase()}`, String(record.externalId));
    return 'mapped';
  }
  const cached = db.prepare(`SELECT mapping_status FROM connection_external_records
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = ? AND external_id = ?`)
    .get(connection.workspace_id, connection.id, record.entityType, String(record.externalId));
  if (cached?.mapping_status === 'IGNORED') {
    connections.resolveIssues(db, connection.workspace_id, connection.id, `UNKNOWN_${record.entityType.toUpperCase()}`, String(record.externalId));
    return 'ignored';
  }
  connections.issue(db, { workspaceId: connection.workspace_id, connectorId: connection.id,
    issueType: `UNKNOWN_${record.entityType.toUpperCase()}`,
    fingerprint: `unknown-${record.entityType}:${connection.id}:${record.externalId}`,
    title: `${record.displayName} needs a Foundry match`,
    detail: `${connection.display_name} supplied ${record.entityType === 'sku' ? `SKU ${record.code || record.externalId}` : 'this location'}, but Foundry cannot safely match it yet.`,
    resolutionHint: 'Choose the matching Foundry record once. Future activity will use that mapping automatically.',
  });
  return 'unmapped';
}

async function sync(db, workspaceId, connectorId, actorId, options = {}) {
  const connection = connections.get(db, workspaceId, connectorId);
  const adapter = options.adapter || providers.get(connection.provider_type);
  if (!adapter?.discover) throw new ValidationError('This connection does not use provider catalog discovery.');
  const providerCredentials = await loadProviderCredentials(db, connection, adapter);
  const runId = newId('csync'); const started = nowIso();
  db.prepare(`INSERT INTO connection_sync_runs (id, workspace_id, connector_id, sync_kind, status, started_at)
    VALUES (?, ?, ?, 'CATALOG_AND_LOCATIONS', 'RUNNING', ?)`)
    .run(runId, workspaceId, connectorId, started);
  try {
    const found = await adapter.discover({ credentials: providerCredentials, connection });
    let autoMapped = 0; let needsMapping = 0;
    inTransaction(db, () => {
      for (const record of [...(found.products || []), ...(found.locations || [])]) {
        const result = cacheRecord(db, connection, actorId, record);
        if (result === 'mapped') autoMapped += 1;
        else if (result === 'unmapped') needsMapping += 1;
      }
      const done = nowIso();
      db.prepare(`UPDATE connection_sync_runs SET status = 'COMPLETED', discovered_products = ?,
        discovered_locations = ?, auto_mapped = ?, needs_mapping = ?, completed_at = ? WHERE id = ?`)
        .run((found.products || []).length, (found.locations || []).length, autoMapped, needsMapping, done, runId);
      db.prepare(`UPDATE workspace_connectors SET status = 'connected', setup_status = ?, last_synced_at = ?,
        last_error = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?`)
        .run(needsMapping ? 'MAPPING' : 'CONNECTED', done, done, workspaceId, connectorId);
    });
    return { products: (found.products || []).length, locations: (found.locations || []).length, autoMapped, needsMapping };
  } catch (error) {
    const done = nowIso();
    db.prepare(`UPDATE connection_sync_runs SET status = 'FAILED', error_message = ?, completed_at = ? WHERE id = ?`)
      .run(String(error.message).slice(0, 500), done, runId);
    db.prepare(`UPDATE workspace_connectors SET status = 'error', last_error = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(String(error.message).slice(0, 500), done, workspaceId, connectorId);
    connections.issue(db, { workspaceId, connectorId, issueType: 'CONNECTION_SYNC_FAILED',
      fingerprint: `connection-sync:${connectorId}`, title: `${connection.display_name} could not finish syncing`,
      detail: error.message, resolutionHint: 'Check the provider connection and try reconnecting or syncing again.' });
    throw error;
  }
}

async function syncMailbox(db, workspaceId, connectorId, options = {}) {
  const connection = connections.get(db, workspaceId, connectorId);
  const adapter = options.adapter || providers.get(connection.provider_type);
  if (!adapter?.poll || !['gmail', 'microsoft365'].includes(connection.provider_type)) {
    throw new ValidationError('This connection is not a supplier mailbox.');
  }
  const providerCredentials = await loadProviderCredentials(db, connection, adapter);
  const found = await adapter.poll({ credentials: providerCredentials,
    since: options.since || connection.last_synced_at || new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    connection });
  const auth = actorAuth(db, connection);
  const results = [];
  for (const message of found.messages || []) {
    const rule = require('./email-ingestion').matchingRule(db, auth, message.sender || message.from || '');
    // A connected mailbox is not permission to ingest the owner's whole
    // inbox. Provider polling reads only enough envelope data to match an
    // approved sender; everything else is ignored and never becomes a
    // Foundry message, issue, or purchasing record.
    if (!rule) continue;
    // Capturing an approved sender and interpreting a document are separate
    // permissions. Only purchasing rules extract purchasing evidence here;
    // inventory rules go through the preview builder below, and review_each
    // stores the original bytes without reading their contents.
    if (rule?.document_mode === 'supplier_documents') {
      for (const attachment of message.attachments || []) {
        if (!attachment.extractedText && attachment.contentBase64) {
          try {
            attachment.extractedText = await require('../foundry/document-intake').extractText({
              filename: attachment.filename, buffer: Buffer.from(attachment.contentBase64, 'base64'),
            });
          } catch { /* Preserve the original attachment; uncertain extraction remains Needs You evidence. */ }
        }
      }
      if (!message.facts) {
        try { message.facts = await require('../purchasing/supplier-document-extractor').extract(message,
          message.attachments || []); } catch { message.facts = null; }
      }
    }
    results.push(require('./event-ingestion').ingest(db, auth, {
      eventId: `${connection.provider_type}:${message.messageId}`,
      type: 'supplier_document.received', occurredAt: message.receivedAt, data: message,
    }));
    const captured = db.prepare(`SELECT m.id, r.document_mode FROM connection_email_messages m
      LEFT JOIN connection_email_rules r ON r.workspace_id = m.workspace_id AND r.connector_id = m.connector_id
        AND r.is_active = 1 AND (LOWER(r.sender_pattern) = LOWER(m.sender)
          OR (r.sender_pattern LIKE '@%' AND LOWER(m.sender) LIKE '%' || LOWER(r.sender_pattern)))
      WHERE m.workspace_id = ? AND m.connector_id = ? AND m.external_message_id = ?`)
      .get(workspaceId, connectorId, message.messageId);
    if (captured?.document_mode === 'inventory_list') {
      const attachments = db.prepare(`SELECT id FROM connection_email_attachments
        WHERE workspace_id = ? AND message_id = ? AND setup_document_id IS NULL`).all(workspaceId, captured.id);
      for (const attachment of attachments) {
        try {
          await require('./mailbox-inventory').prepare(db, auth, auth, connectorId, attachment.id);
        } catch (error) {
          db.prepare(`UPDATE connection_email_messages SET processing_status = 'INVENTORY_REVIEW_FAILED', processed_at = ?
            WHERE workspace_id = ? AND id = ?`).run(nowIso(), workspaceId, captured.id);
        }
      }
    }
  }
  const now = nowIso();
  require('./mailbox-inventory').reconcileStatuses(db, workspaceId, connectorId);
  db.prepare(`UPDATE workspace_connectors SET status = 'connected', setup_status = 'CONNECTED',
    last_synced_at = ?, last_activity_at = CASE WHEN ? > 0 THEN ? ELSE last_activity_at END,
    last_error = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?`)
    .run(now, results.length, now, now, workspaceId, connectorId);
  connections.resolveIssues(db, workspaceId, connectorId, 'CONNECTION_STALE');
  connections.resolveIssues(db, workspaceId, connectorId, 'MAILBOX_SYNC_FAILED');
  connections.resolveIssues(db, workspaceId, connectorId, 'MAILBOX_AUTH_REQUIRED');
  return { messages: results.length, results };
}

/** Renew expiring Gmail watches and Microsoft Graph subscriptions unattended. */
async function maintainMailboxWatch(db, workspaceId, connectorId, options = {}) {
  const connection = connections.get(db, workspaceId, connectorId);
  const adapter = options.adapter || providers.get(connection.provider_type);
  if (!adapter?.registerWebhooks || !['gmail', 'microsoft365'].includes(connection.provider_type)) {
    throw new ValidationError('This connection is not a renewable supplier mailbox.');
  }
  let providerCredentials = await loadProviderCredentials(db, connection, adapter);
  const now = Number(options.now || Date.now());
  const rawExpiration = connection.provider_type === 'gmail'
    ? providerCredentials.watchExpiration : providerCredentials.subscriptionExpiresAt;
  const expiration = connection.provider_type === 'gmail'
    ? Number(rawExpiration || 0) : Date.parse(rawExpiration || 0);
  const pushHealthy = providerCredentials.deliveryMode === 'push'
    && Number.isFinite(expiration) && expiration > now + 12 * 60 * 60_000;
  if (pushHealthy) return { renewed: false, expiresAt: rawExpiration };

  const origin = providerOrigin('');
  if (!origin || !origin.startsWith('https://')) return { renewed: false, reason: 'public_https_required' };
  const webhookUrl = `${origin}/api/v1/connections/${connection.provider_type}/webhooks/${connection.id}`;
  const renew = adapter.renewWebhooks || adapter.registerWebhooks;
  try {
    const result = await renew({ credentials: providerCredentials, webhookUrl, connection });
    if (result?.credentials) {
      providerCredentials = result.credentials;
      credentialsStore.put(db, workspaceId, connectorId, 'provider', providerCredentials,
        providerCredentials.expiresAt ? new Date(Number(providerCredentials.expiresAt)).toISOString() : null);
    }
    connections.resolveIssues(db, workspaceId, connectorId, 'MAILBOX_WATCH_RENEWAL_FAILED');
    return { renewed: true, expiresAt: connection.provider_type === 'gmail'
      ? providerCredentials.watchExpiration : providerCredentials.subscriptionExpiresAt };
  } catch (error) {
    // Push is an optimization. Scheduled OAuth polling remains active, so a
    // missing Pub/Sub topic is installation diagnostics—not an owner decision.
    connections.resolveIssues(db, workspaceId, connectorId, 'MAILBOX_WATCH_RENEWAL_FAILED');
    // Push is only an accelerator. Do not paint a healthy, automatically
    // polled mailbox red because optional push setup is unavailable.
    return { renewed: false, error: String(error.message || error) };
  }
}

async function sendMailboxMessage(db, workspaceId, connectorId, message) {
  const connection = connections.get(db, workspaceId, connectorId);
  const adapter = providers.get(connection.provider_type);
  if (!adapter?.send || !['gmail', 'microsoft365'].includes(connection.provider_type)) {
    throw new ValidationError('Choose a connected Gmail or Microsoft 365 mailbox for supplier sending.');
  }
  if (connection.status !== 'connected' || connection.paused_at) {
    throw new AuthenticationError('This mailbox is paused or disconnected. No message was sent.');
  }
  const providerCredentials = await loadProviderCredentials(db, connection, adapter);
  return adapter.send({ credentials: providerCredentials, message, connection });
}

function setSelectedLocations(db, workspaceId, connectorId, ids) {
  connections.get(db, workspaceId, connectorId);
  const chosen = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String));
  inTransaction(db, () => {
    db.prepare(`UPDATE connection_external_records SET selected = 0, updated_at = ?
      WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'location'`)
      .run(nowIso(), workspaceId, connectorId);
    const update = db.prepare(`UPDATE connection_external_records SET selected = 1, updated_at = ?
      WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'location' AND external_id = ?`);
    for (const id of chosen) update.run(nowIso(), workspaceId, connectorId, id);
  });
}

function ignoreExternal(db, workspaceId, connectorId, entityType, externalId) {
  connections.get(db, workspaceId, connectorId);
  const now = nowIso();
  db.prepare(`UPDATE connection_external_records SET mapping_status = 'IGNORED', selected = 0, updated_at = ?
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = ? AND external_id = ?`)
    .run(now, workspaceId, connectorId, entityType, externalId);
  connections.resolveIssues(db, workspaceId, connectorId, `UNKNOWN_${entityType.toUpperCase()}`, externalId);
  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM connection_external_records
    WHERE workspace_id = ? AND connector_id = ? AND selected = 1 AND mapping_status = 'UNMAPPED'`)
    .get(workspaceId, connectorId).n;
  if (!remaining) db.prepare(`UPDATE workspace_connectors SET setup_status = 'CONNECTED', updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(now, workspaceId, connectorId);
}

async function webhookContext(db, providerType, connectorId, providerAccountId) {
  let row = connectorId ? db.prepare(`SELECT * FROM workspace_connectors WHERE id = ? AND provider_type = ?`)
    .get(connectorId, providerType) : null;
  if (!row && providerAccountId) row = db.prepare(`SELECT * FROM workspace_connectors
    WHERE provider_type = ? AND provider_account_id = ? AND status = 'connected'`).get(providerType, providerAccountId);
  if (!row) throw new NotFoundError('Connection not found.');
  const connection = connections.get(db, row.workspace_id, row.id);
  if (connection.status !== 'connected' || connection.paused_at) throw new AuthenticationError('This connection is not accepting events.');
  const adapter = providers.get(providerType);
  const providerCredentials = await loadProviderCredentials(db, connection, adapter);
  return { connection, credentials: providerCredentials, auth: actorAuth(db, connection) };
}

async function reviewHistory(db, workspaceId, connectorId) {
  const connection = connections.get(db, workspaceId, connectorId);
  const adapter = providers.get(connection.provider_type);
  if (!adapter?.historySummary) throw new ValidationError('This provider does not offer a history comparison.');
  const providerCredentials = await loadProviderCredentials(db, connection, adapter);
  const locations = db.prepare(`SELECT external_id FROM connection_external_records WHERE workspace_id = ?
    AND connector_id = ? AND entity_type = 'location' AND selected = 1`).all(workspaceId, connectorId).map((row) => row.external_id);
  const expected = await adapter.historySummary({ credentials: providerCredentials, since: connection.created_at, locations });
  const observed = db.prepare(`SELECT COUNT(DISTINCT COALESCE(aggregate_key, external_event_id)) AS n
    FROM connector_feed_events WHERE workspace_id = ? AND connector_id = ? AND status = 'COMPLETED'
      AND event_type IN ('sales_order.created','sale.completed') AND received_at >= ?`)
    .get(workspaceId, connectorId, expected.periodStart || connection.created_at).n;
  const mismatch = Number(expected.operationalRecords) !== Number(observed);
  const now = nowIso();
  db.prepare(`INSERT INTO connection_reconciliations
    (id, workspace_id, connector_id, period_start, period_end, expected, observed, discrepancies, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId('crecon'), workspaceId, connectorId, expected.periodStart || connection.created_at, now,
      JSON.stringify(expected), JSON.stringify({ processedOperationalRecords: observed }),
      JSON.stringify(mismatch ? [{ type: 'event_count', provider: expected.operationalRecords, foundry: observed }] : []),
      mismatch ? 'MISMATCH' : 'MATCHED', now);
  if (mismatch) connections.issue(db, { workspaceId, connectorId, issueType: 'RECONCILIATION_MISMATCH',
    fingerprint: `provider-history:${connectorId}:${expected.periodStart || connection.created_at}`,
    title: `${connection.display_name} history does not match Foundry`,
    detail: `${connection.display_name} reports ${expected.operationalRecords} operational record(s) since connection; Foundry safely processed ${observed}.`,
    resolutionHint: 'Review the missing or conflicting provider events. Foundry did not overwrite inventory.' });
  return { expected: Number(expected.operationalRecords), observed: Number(observed), status: mismatch ? 'MISMATCH' : 'MATCHED' };
}

async function createSandboxCheckout(db, workspaceId, connectorId, input, options = {}) {
  const connection = connections.get(db, workspaceId, connectorId);
  const adapter = options.adapter || providers.get(connection.provider_type);
  if (connection.provider_type !== 'square' || !adapter?.createSandboxCheckout) {
    throw new ValidationError('Sandbox checkout is available only for a Square Sandbox connection.');
  }
  const externalSku = requireText(input.externalSku, 'Square product', { max: 160 });
  const externalLocationId = requireText(input.externalLocationId, 'Square location', { max: 160 });
  const quantity = Number(input.quantity || 1);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100) {
    throw new ValidationError('Test quantity must be between 1 and 100.');
  }
  const mappedSku = db.prepare(`SELECT 1 FROM connection_external_records er
    JOIN connection_mappings cm ON cm.workspace_id = er.workspace_id AND cm.connector_id = er.connector_id
      AND cm.entity_type = er.entity_type AND cm.external_id = er.external_id
    WHERE er.workspace_id = ? AND er.connector_id = ? AND er.entity_type = 'sku'
      AND er.external_id = ? AND er.mapping_status = 'MAPPED'`).get(workspaceId, connectorId, externalSku);
  const mappedLocation = db.prepare(`SELECT 1 FROM connection_external_records er
    JOIN connection_mappings cm ON cm.workspace_id = er.workspace_id AND cm.connector_id = er.connector_id
      AND cm.entity_type = er.entity_type AND cm.external_id = er.external_id
    WHERE er.workspace_id = ? AND er.connector_id = ? AND er.entity_type = 'location'
      AND er.external_id = ? AND er.mapping_status = 'MAPPED' AND er.selected = 1`)
    .get(workspaceId, connectorId, externalLocationId);
  if (!mappedSku) throw new ValidationError('Choose a Square product that is already matched to Foundry.');
  if (!mappedLocation) throw new ValidationError('Choose a selected Square location that is already matched to Foundry.');
  const providerCredentials = await loadProviderCredentials(db, connection, adapter);
  return adapter.createSandboxCheckout({ credentials: providerCredentials, externalSku, externalLocationId, quantity });
}

module.exports = { beginAuthorization, completeOAuth, completeWooCallback, sync, syncMailbox, maintainMailboxWatch, sendMailboxMessage,
  reviewHistory, setSelectedLocations,
  createSandboxCheckout, ignoreExternal, webhookContext, readState, stateConnection, providerOrigin,
  deactivateDuplicateProviderAccounts };
