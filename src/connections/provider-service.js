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
const mailRelevance = require('./mail-relevance');
const setAside = require('./mail-set-aside');
const locationService = require('../domain/location-service');
const catalogImport = require('./catalog-import');
const accountingSync = require('../accounting/integration-sync');

const stateHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function mailboxEventId(providerType, messageId) {
  const raw = `${providerType}:${messageId}`;
  // Microsoft Graph message ids can exceed the shared external-event limit.
  // Keep ordinary provider ids readable, but use a stable transport hash when
  // necessary. The original provider id is still preserved on the email row.
  return raw.length <= 160 ? raw : `${providerType}:message:${stateHash(messageId)}`;
}

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

/*
 * Xero explicitly permits http://localhost OAuth returns while developing.
 * Prefer that direct loopback route when the owner is already using StockChief
 * on localhost: it removes the temporary public tunnel (and its DNS/edge
 * availability) from the interactive authorization round trip. Production,
 * and every non-loopback provider flow, still uses the configured public
 * origin exactly as before.
 */
function authorizationOrigin(providerType, requestOrigin) {
  if (providerType === 'xero' && config.env !== 'production') {
    try {
      const requested = new URL(requestOrigin);
      if (requested.hostname === 'localhost') return requested.origin;
    } catch (_) {
      // Use the normal validated public-origin path below.
    }
  }
  return providerOrigin(requestOrigin);
}

async function beginAuthorization(db, ctx, input, requestOrigin) {
  const providerType = requireText(input.providerType, 'Provider', { max: 40 }).toLowerCase();
  const adapter = providers.get(providerType);
  if (!adapter) throw new ValidationError('Choose a supported connection provider.');
  const meta = adapter.metadata();
  if (!meta.available) throw new ValidationError(meta.unavailableReason);
  if (adapter.validateInput) adapter.validateInput(input);
  const now = nowIso();
  const connectorId = input.connectorId || newId('con');
  const origin = authorizationOrigin(providerType, requestOrigin);
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
    .run(JSON.stringify({
      ...(auth.metadata || {}),
      // The OAuth callback may arrive through the public HTTPS hostname while
      // the owner has StockChief open on localhost. Preserve the exact opener so
      // the return page can notify that window and send the owner back to the
      // same installation without relying on cross-host cookies.
      returnOrigin: requestOrigin,
      popup: String(input.popup || '') === '1',
    }), stateHash(state));
  return { connectorId, redirectUrl: auth.url };
}

function callbackContext(db, stateValue, providerType) {
  const state = readState(db, stateValue, providerType, false);
  const connection = connections.get(db, state.workspace_id, state.connector_id);
  return {
    connection,
    returnOrigin: state.metadata.returnOrigin || null,
    popup: Boolean(state.metadata.popup),
  };
}

async function loadProviderCredentials(db, connection, adapter, options = {}) {
  if (connection.setup_status === 'REAUTHORIZATION_REQUIRED') throw new AuthenticationError('Reconnect this provider before using its authorization again.');
  let providerCredentials = credentialsStore.get(db, connection.workspace_id, connection.id, 'provider');
  if (!providerCredentials) throw new AuthenticationError('Reconnect this provider before syncing.');
  if (adapter?.refreshCredentials) {
    let refreshed;
    try {
      refreshed = await adapter.refreshCredentials(providerCredentials,{force:Boolean(options.forceRefresh)});
    } catch (error) {
      const now = nowIso();
      if (error.transient || error.status === 429 || error.status >= 500) {
        db.prepare(`UPDATE workspace_connectors SET last_error=?,updated_at=? WHERE workspace_id=? AND id=?`)
          .run('Mailbox authorization could not be checked because the provider is temporarily unavailable. Retry safely; no authorization was discarded.',now,connection.workspace_id,connection.id);
        throw error;
      }
      db.prepare(`UPDATE workspace_connectors SET status = 'error', setup_status = 'REAUTHORIZATION_REQUIRED',
        last_error = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
        .run(String(error.message).slice(0, 500), now, connection.workspace_id, connection.id);
      connections.issue(db, { workspaceId: connection.workspace_id, connectorId: connection.id,
        issueType: 'CONNECTION_AUTHORIZATION_REVOKED', fingerprint: `provider-auth:${connection.id}`,
        title: `${connection.display_name} needs to be reconnected`,
        detail: 'The provider rejected StockChief\'s saved authorization or token refresh. No external write was attempted.',
        resolutionHint: 'Reconnect on the provider authorization screen. Existing mappings and audit history are preserved.' });
      throw error;
    }
    providerCredentials = refreshed.credentials;
    if (refreshed.refreshed) {
      credentialsStore.put(db, connection.workspace_id, connection.id, 'provider', providerCredentials,
        refreshed.expiresAt || null);
      require('../operations/checkpoints').record(db, 'integration.token_refresh', 'PASS', {
        refreshed: true, provider: connection.provider_type, connectorId: connection.id,
        liveMode: refreshed.credentials?.environment !== 'sandbox',
        releaseRef: config.operations.releaseRef,
      });
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
  try {
    const result = await adapter.exchangeAuthorization({ query, metadata: state.metadata });
    return finishAuthorization(db, connection, state.actor_id, result, requestOrigin, adapter);
  } catch (error) {
    db.prepare(`UPDATE workspace_connectors
      SET status = 'error', setup_status = 'AUTHORIZATION_FAILED', last_error = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ?`)
      .run(String(error.message || 'Authorization failed.').slice(0, 500), nowIso(),
        connection.workspace_id, connection.id);
    throw error;
  }
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
  // Accounting providers are deliberately not catalog/event providers.  A
  // successful OAuth return proves only that StockChief can read one real fact.
  // It must not start importing, reconciling, or posting until the owner has
  // chosen a source of truth and an authority level on the next screen.
  if (adapter.integrationClass === 'accounting') {
    const verifiedFact = result.verifiedFact
      || await adapter.verifyReadOnly({ credentials: result.credentials, connection: current });
    accountingSync.initialize(db, current, actorId, verifiedFact);
    return connections.get(db, current.workspace_id, current.id);
  }
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
      } else {
        connections.resolveIssues(db, connection.workspace_id, connection.id,
          'CONNECTION_WEBHOOK_SETUP_FAILED');
      }
    }
    catch (error) {
      db.prepare('UPDATE workspace_connectors SET last_error = ?, updated_at = ? WHERE id = ?')
        .run(`Webhook setup: ${error.message}`, nowIso(), connection.id);
    }
  }
  if (['gmail', 'microsoft365'].includes(current.provider_type)) {
    db.prepare("UPDATE workspace_connectors SET setup_status = 'CONNECTED', updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(nowIso(), current.workspace_id, current.id);
  } else {
    await sync(db, current.workspace_id, current.id, actorId, { adapter, bootstrapEmpty: true });
  }
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
  db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
    WHERE workspace_id = ? AND status = 'OPEN' AND connector_id IN (
      SELECT id FROM workspace_connectors
      WHERE workspace_id = ? AND provider_type = ? AND provider_account_id = ? AND id <> ?
        AND status = 'disconnected' AND setup_status = 'DUPLICATE_CONNECTION'
    )`).run(now, now, workspaceId, workspaceId, providerType, providerAccountId, connectorId);
  return result.changes;
}

function exactTarget(db, workspaceId, record) {
  if (record.entityType === 'sku') {
    if (record.code) {
      const rows = db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? AND s.code = ? COLLATE NOCASE`)
        .all(workspaceId, record.code);
      if (rows.length === 1) return rows[0].id;
    }
    if (record.providerData?.barcode) {
      const rows = db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? AND s.barcode = ? COLLATE NOCASE`)
        .all(workspaceId, record.providerData.barcode);
      if (rows.length === 1) return rows[0].id;
    }
    // A provider may omit SKU codes. An exact, unique product + variant name
    // is still deterministic evidence; partial or duplicate names remain for
    // the owner instead of being guessed.
    const itemName = String(record.providerData?.itemName || '').trim();
    const variantName = String(record.providerData?.variationName || '').trim();
    if (itemName) {
      const rows = db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? AND i.name = ? COLLATE NOCASE
        AND COALESCE(s.variant_label, '') = ? COLLATE NOCASE`).all(workspaceId, itemName, variantName);
      if (rows.length === 1) return rows[0].id;
    }
    return null;
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
    title: `${record.displayName} needs a StockChief match`,
    detail: `${connection.display_name} supplied ${record.entityType === 'sku' ? `SKU ${record.code || record.externalId}` : 'this location'}, but StockChief cannot safely match it yet.`,
    resolutionHint: 'Choose the matching StockChief record once. Future activity will use that mapping automatically.',
  });
  return 'unmapped';
}

async function sync(db, workspaceId, connectorId, actorId, options = {}) {
  const connection = connections.get(db, workspaceId, connectorId);
  const adapter = options.adapter || providers.get(connection.provider_type);
  if (!adapter?.discover) throw new ValidationError('This connection does not use provider catalog discovery.');
  const registeredAdapter = providers.get(connection.provider_type);
  const providerMetadata = (typeof adapter.metadata === 'function' ? adapter.metadata() : null)
    || (typeof registeredAdapter?.metadata === 'function' ? registeredAdapter.metadata() : {});
  const providerCredentials = await loadProviderCredentials(db, connection, adapter);
  const runId = newId('csync'); const started = nowIso();
  db.prepare(`INSERT INTO connection_sync_runs (id, workspace_id, connector_id, sync_kind, status, started_at)
    VALUES (?, ?, ?, 'CATALOG_AND_LOCATIONS', 'RUNNING', ?)`)
    .run(runId, workspaceId, connectorId, started);
  try {
    const found = await adapter.discover({ credentials: providerCredentials, connection });
    let autoMapped = 0; let needsMapping = 0; let imported = null;
    const mayBootstrap = options.bootstrapEmpty && connection.provider_type === 'square'
      && db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspaceId).n === 0;
    const importsCatalogAutomatically = providerMetadata.catalogImportMode === 'automatic';
    inTransaction(db, () => {
      for (const record of [...(found.products || []), ...(found.locations || [])]) {
        const result = cacheRecord(db, connection, actorId, record);
        if (result === 'mapped') autoMapped += 1;
        else if (result === 'unmapped') needsMapping += 1;
      }
      if (mayBootstrap || importsCatalogAutomatically) {
        const ctx = { workspaceId, actorId,
          accountId: db.prepare('SELECT account_id FROM users WHERE id = ? AND workspace_id = ?').get(actorId, workspaceId)?.account_id };
        for (const external of found.locations || []) {
          const cached = db.prepare(`SELECT mapping_status FROM connection_external_records
            WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'location' AND external_id = ?`)
            .get(workspaceId, connectorId, String(external.externalId));
          if (cached?.mapping_status === 'MAPPED') continue;
          let location = db.prepare('SELECT id FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1')
            .get(workspaceId, external.displayName);
          if (!location) location = locationService.createLocation(db, ctx, { name: external.displayName, kind: 'store' });
          connections.mapExternal(db, ctx, connectorId, { entityType: 'location', externalId: String(external.externalId), foundryRecordId: location.id });
        }
        imported = catalogImport.importProducts(db, ctx, connection, (found.products || []).map((row) => String(row.externalId)));
        needsMapping = db.prepare(`SELECT COUNT(*) AS n FROM connection_external_records
          WHERE workspace_id = ? AND connector_id = ? AND selected = 1 AND mapping_status = 'UNMAPPED'`)
          .get(workspaceId, connectorId).n;
        autoMapped = (found.products || []).length + (found.locations || []).length - needsMapping;
      }
      const done = nowIso();
      db.prepare(`UPDATE connection_sync_runs SET status = 'COMPLETED', discovered_products = ?,
        discovered_locations = ?, auto_mapped = ?, needs_mapping = ?, completed_at = ? WHERE id = ?`)
        .run((found.products || []).length, (found.locations || []).length, autoMapped, needsMapping, done, runId);
      db.prepare(`UPDATE workspace_connectors SET status = 'connected', setup_status = ?, last_synced_at = ?,
        last_error = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?`)
        .run(needsMapping ? 'MAPPING' : 'CONNECTED', done, done, workspaceId, connectorId);
    });
    return { products: (found.products || []).length, locations: (found.locations || []).length, autoMapped, needsMapping, imported };
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

/**
 * Write an answer to a customer and leave it unsent.
 *
 * Only once per message, and never over a draft somebody has already touched
 * or a reply that has already gone. StockChief re-writing the owner's own words
 * on the next poll would be worse than not writing anything.
 */
async function prepareReply(db, auth, messageId) {
  const row = db.prepare(`SELECT draft_at, draft_source, reply_sent_at FROM connection_email_messages
    WHERE workspace_id = ? AND id = ?`).get(auth.workspaceId, messageId);
  if (!row || row.draft_at || row.reply_sent_at) return null;
  return require('./reply-drafting').draft(db, auth, messageId);
}

/**
 * A person disagrees with the gate, so the message comes in.
 *
 * The envelope is all StockChief kept, so the message itself is fetched from the
 * provider again and put through exactly the pipeline it would have gone
 * through in the first place. The set-aside row stays as the record that this
 * was once turned away and who overruled it.
 */
async function bringInSetAside(db, ctx, setAsideId, options = {}) {
  const row = setAside.get(db, ctx.workspaceId, setAsideId);
  if (row.brought_in_message_id) return { messageId: row.brought_in_message_id, replayed: true };
  const connection = connections.get(db, ctx.workspaceId, row.connector_id);
  const adapter = options.adapter || providers.get(connection.provider_type);
  if (!adapter?.fetchMessage) {
    throw new ValidationError('This mailbox cannot fetch a single message back, so it cannot be brought in.');
  }
  const providerCredentials = await loadProviderCredentials(db, connection, adapter);
  const message = await adapter.fetchMessage({ credentials: providerCredentials,
    messageId: row.external_message_id, connection });
  if (!message) throw new NotFoundError('That message is no longer in the mailbox.');
  const auth = actorAuth(db, connection);
  require('./event-ingestion').ingest(db, auth, {
    eventId: mailboxEventId(connection.provider_type, message.messageId),
    type: 'supplier_document.received', occurredAt: message.receivedAt, data: message,
  });
  const captured = db.prepare(`SELECT id, classification FROM connection_email_messages
    WHERE workspace_id = ? AND connector_id = ? AND external_message_id = ?`)
    .get(ctx.workspaceId, row.connector_id, message.messageId);
  if (captured) {
    setAside.markBroughtIn(db, ctx.workspaceId, setAsideId, captured.id, ctx.actorId);
    if (captured.classification === 'customer_order_request') {
      const orders = require('../sales/order-from-email');
      try { await orders.draft(db, auth, captured.id); }
      catch (error) { orders.noteReason(db, auth, captured.id,
        `StockChief could not draft an order from this: ${error.message}`); }
    }
  }
  return { messageId: captured?.id || null, replayed: false };
}

async function refreshMailboxAuthorization(db,workspaceId,connectorId) {
  const connection = connections.get(db,workspaceId,connectorId);
  if (!['gmail','microsoft365'].includes(connection.provider_type) || !connection.credential_ref
      || !connection.provider_account_id || connection.paused_at || connection.status === 'disconnected') {
    throw new ValidationError('Resume or reconnect an authorized mailbox before refreshing its authorization.');
  }
  const adapter = providers.get(connection.provider_type);
  const credentials = await loadProviderCredentials(db,connection,adapter,{forceRefresh:true});
  const profile = connection.provider_type === 'gmail'
    ? (await adapter.api(credentials,'/gmail/v1/users/me/profile')).body
    : (await adapter.graph(credentials,'/me?$select=id,mail,userPrincipalName')).body;
  const accountId = connection.provider_type === 'gmail' ? profile.emailAddress : profile.id;
  if (!accountId || String(accountId).toLowerCase() !== String(connection.provider_account_id).toLowerCase()) {
    db.prepare(`UPDATE workspace_connectors SET status='error',setup_status='REAUTHORIZATION_REQUIRED',last_error=?,updated_at=?
      WHERE workspace_id=? AND id=?`).run('Refreshed authorization returned a different mailbox identity. Reconnect the correct account before any mailbox operation.',
        nowIso(),workspaceId,connectorId);
    throw new ValidationError('The refreshed authorization does not match this mailbox. Nothing was read or sent; reconnect the correct account.');
  }
  return {accountName:connection.provider_account_name,refreshed:true};
}

function ownOutboundMessage(db, workspaceId, connectorId, message) {
  const providerMessageId = String(message.messageId || message.externalMessageId || '');
  const stockChiefMessageId = String(message.stockChiefMessageId || '');
  const supplier = db.prepare(`SELECT id FROM supplier_communications
    WHERE workspace_id = ? AND connector_id = ?
      AND ((? <> '' AND external_message_id = ?) OR (? <> '' AND id = ?)) LIMIT 1`)
    .get(workspaceId, connectorId, providerMessageId, providerMessageId,
      stockChiefMessageId, stockChiefMessageId);
  if (supplier) return { kind: 'supplier', id: supplier.id };
  const customer = db.prepare(`SELECT id FROM customer_communications
    WHERE workspace_id = ? AND connector_id = ?
      AND ((? <> '' AND external_message_id = ?) OR (? <> '' AND id = ?)) LIMIT 1`)
    .get(workspaceId, connectorId, providerMessageId, providerMessageId,
      stockChiefMessageId, stockChiefMessageId);
  if (customer) return { kind: 'customer', id: customer.id };
  const reply = db.prepare(`SELECT id FROM connection_email_messages
    WHERE workspace_id = ? AND connector_id = ?
      AND ((? <> '' AND reply_external_message_id = ?)
        OR (? <> '' AND id = ? AND reply_sent_at IS NOT NULL)) LIMIT 1`)
    .get(workspaceId, connectorId, providerMessageId, providerMessageId,
      stockChiefMessageId, stockChiefMessageId);
  return reply ? { kind: 'reply', id: reply.id } : null;
}

function neutralizeCapturedOutbound(db, workspaceId, connectorId, message) {
  const providerMessageId = String(message.messageId || message.externalMessageId || '');
  if (!providerMessageId) return;
  const captured = db.prepare(`SELECT id FROM connection_email_messages
    WHERE workspace_id = ? AND connector_id = ? AND external_message_id = ?`)
    .get(workspaceId, connectorId, providerMessageId);
  if (!captured) return;
  const now = nowIso();
  inTransaction(db, () => {
    const documents = db.prepare(`SELECT id FROM supplier_documents
      WHERE workspace_id = ? AND message_id = ?`).all(workspaceId, captured.id);
    for (const document of documents) {
      db.prepare(`DELETE FROM purchase_order_line_expectations
        WHERE workspace_id = ? AND source_document_id = ?`).run(workspaceId, document.id);
      db.prepare('DELETE FROM supplier_price_history WHERE workspace_id = ? AND source_document_id = ?')
        .run(workspaceId, document.id);
      db.prepare('DELETE FROM supplier_operational_facts WHERE workspace_id = ? AND source_document_id = ?')
        .run(workspaceId, document.id);
      db.prepare('DELETE FROM supplier_response_plans WHERE workspace_id = ? AND source_document_id = ?')
        .run(workspaceId, document.id);
      db.prepare(`UPDATE domain_events SET status = 'PROCESSED', result = ?, error_message = NULL,
        processed_at = COALESCE(processed_at, ?) WHERE workspace_id = ?
          AND source_record_type = 'supplier_document' AND source_record_id = ?`)
        .run(JSON.stringify({ ignored: true, reason: 'own_outbound_copy' }), now, workspaceId, document.id);
      const purchaseEvents = db.prepare(`SELECT id, detail FROM purchase_order_events
        WHERE workspace_id = ?`).all(workspaceId);
      for (const event of purchaseEvents) {
        let detail = {};
        try { detail = JSON.parse(event.detail || '{}'); } catch { /* Keep unrelated malformed audit data. */ }
        if (detail.documentId === document.id) {
          db.prepare(`UPDATE purchase_order_events SET event = 'supplier_message_ignored', detail = ?
            WHERE id = ? AND workspace_id = ?`)
            .run(JSON.stringify({ documentId: document.id, reason: 'own_outbound_copy' }),
              event.id, workspaceId);
        }
      }
      db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
        WHERE workspace_id = ? AND status = 'OPEN'
          AND (external_event_id = ? OR candidate_matches LIKE ?)`)
        .run(now, now, workspaceId, providerMessageId, `%${document.id}%`);
      db.prepare(`UPDATE supplier_documents SET status = 'IGNORED', discrepancies = '[]', processed_at = ?
        WHERE workspace_id = ? AND id = ?`).run(now, workspaceId, document.id);
    }
    db.prepare(`UPDATE connection_email_messages SET supplier_id = NULL,
      classification = 'outbound_copy', processing_status = 'IGNORED', processed_at = ?,
      reply_state = 'HANDLED', reply_reason = 'Sent by StockChief; this is not an incoming reply.',
      reply_state_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(now, now, workspaceId, captured.id);
  });
}

async function syncMailbox(db, workspaceId, connectorId, options = {}) {
  const connection = connections.get(db, workspaceId, connectorId);
  const adapter = options.adapter || providers.get(connection.provider_type);
  if (!adapter?.poll || !['gmail', 'microsoft365'].includes(connection.provider_type)) {
    throw new ValidationError('This connection is not a supplier mailbox.');
  }
  if (connection.paused_at || connection.status === 'disconnected') {
    throw new ValidationError('Resume or reconnect this mailbox before checking it.');
  }
  const checkStartedAt = nowIso();
  const providerCredentials = await loadProviderCredentials(db, connection, adapter);
  const found = await adapter.poll({ credentials: providerCredentials,
    since: options.since || connection.last_synced_at || new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    connection });
  const auth = actorAuth(db, connection);
  /*
   * A connected mailbox is not permission to act on the owner's whole inbox,
   * but refusing to read anything from an unknown sender meant a customer
   * writing for the first time did not exist. Their order was fetched from
   * Gmail and dropped here, and the owner saw nothing at all.
   *
   * So the gate moved rather than opened. An unapproved sender is captured
   * UNTRUSTED, which is a resting place, not an instruction: nothing is
   * extracted from it, no purchasing evidence is read, no stock moves. It can
   * be read and answered, and the owner can approve the sender. An owner who
   * wants the older behaviour turns this off on the connection.
   */
  let openToStrangers = true;
  try {
    // connections.get already parses this column; a raw row would not have.
    const config = typeof connection.config === 'string'
      ? JSON.parse(connection.config || '{}') : (connection.config || {});
    if (config.captureUnknownSenders === false) openToStrangers = false;
  } catch { /* Unreadable config is not consent to change behaviour; the default stands. */ }
  const results = [];
  for (const message of found.messages || []) {
    if (ownOutboundMessage(db, workspaceId, connectorId, message)) {
      neutralizeCapturedOutbound(db, workspaceId, connectorId, message);
      continue;
    }
    const rule = require('./email-ingestion').matchingRule(db, auth, message.sender || message.from || '');
    if (!rule && !openToStrangers) continue;
    /*
     * A connected mailbox is the business's mailbox, not StockChief's inbox.
     *
     * Everything that arrived used to become a record here — newsletters, bank
     * alerts, the owner's personal mail — and then be triaged, listed, and
     * counted as work. The gate asks the only question that matters: is this
     * about the business StockChief runs. What it turns away is not deleted and
     * not silently dropped; the envelope and the reason are kept so the owner
     * can find it and overrule the decision.
     */
    const verdict = mailRelevance.judge(db, workspaceId, connectorId, message);
    const mappedCounterparty = verdict.counterparty
      && ['customer', 'supplier'].includes(verdict.relationship)
      && verdict.counterparty.id;
    if (!mappedCounterparty) {
      continue;
    }
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
      eventId: mailboxEventId(connection.provider_type, message.messageId),
      type: 'supplier_document.received', occurredAt: message.receivedAt, data: message,
    }));
    const captured = db.prepare(`SELECT m.id, m.classification, r.document_mode FROM connection_email_messages m
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
    /*
     * A customer asking to buy something becomes a draft order, and stops
     * there. Drafting is the whole point of capturing a stranger's mail: the
     * owner asked to be handed a prepared order to approve, not a mailbox to
     * read. Failure is quiet on purpose — the message is already captured and
     * already shows as needing an answer, so a model that could not read it
     * costs the owner an email to answer, not a lost customer.
     */
    const orders = require('../sales/order-from-email');
    let answeredPendingDelivery = false;
    if (captured?.id) {
      try {
        answeredPendingDelivery = Boolean((await orders.applyPendingDeliveryReply(db, auth, captured.id))?.handled);
      } catch {
        // The answer remains captured. A reply that is not safe to apply is
        // visible work, never a guessed destination.
      }
    }
    if (!answeredPendingDelivery && captured?.id && captured.classification === 'customer_order_request') {
      try { await orders.draft(db, auth, captured.id); }
      catch (error) {
        // The message stands on its own; a draft is an improvement on it, not
        // a condition of it. But the reason is written down, because a
        // customer's order that silently produced nothing is the one failure
        // the owner most needs to hear about.
        orders.noteReason(db, auth, captured.id, `StockChief could not draft an order from this: ${error.message}`);
      }
    }
    /*
     * A customer writing about anything else gets an answer prepared, and
     * that is where it stops.
     *
     * The owner asked for an assistant that has already done the work by the
     * time they look, not one that waits to be told to start. Drafting is
     * safe to do unasked because sending is a separate act with a separate
     * button: nothing leaves the building without a person reading it. The
     * facts in the reply come from the records before a word is written, so
     * a draft nobody sends has still cost nothing but the writing.
     */
    if (!answeredPendingDelivery && captured?.id && captured.classification === 'customer_message') {
      try { await prepareReply(db, auth, captured.id); }
      catch { /* The message is captured and shows as needing an answer; a missing draft is not a lost customer. */ }
    }
  }
  // Anything from an earlier check that still has neither an order nor a reason.
  try { await require('../sales/order-from-email').draftPending(db, auth); }
  catch { /* Each message records its own reason; a sweep that fails leaves them for the next one. */ }
  const now = nowIso();
  require('./mailbox-inventory').reconcileStatuses(db, workspaceId, connectorId);
  db.prepare(`UPDATE workspace_connectors SET status = 'connected', setup_status = 'CONNECTED',
    last_synced_at = ?, last_activity_at = CASE WHEN ? > 0 THEN ? ELSE last_activity_at END,
    last_error = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?`)
    .run(checkStartedAt, results.length, now, now, workspaceId, connectorId);
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
    title: `${connection.display_name} history does not match StockChief`,
    detail: `${connection.display_name} reports ${expected.operationalRecords} operational record(s) since connection; StockChief safely processed ${observed}.`,
    resolutionHint: 'Review the missing or conflicting provider events. StockChief did not overwrite inventory.' });
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
  if (!mappedSku) throw new ValidationError('Choose a Square product that is already matched to StockChief.');
  if (!mappedLocation) throw new ValidationError('Choose a selected Square location that is already matched to StockChief.');
  const providerCredentials = await loadProviderCredentials(db, connection, adapter);
  return adapter.createSandboxCheckout({ credentials: providerCredentials, externalSku, externalLocationId, quantity });
}

module.exports = { beginAuthorization, completeOAuth, completeWooCallback, sync, syncMailbox,refreshMailboxAuthorization,
  bringInSetAside, prepareReply, maintainMailboxWatch, sendMailboxMessage,
  reviewHistory, setSelectedLocations,
  createSandboxCheckout, ignoreExternal, webhookContext, createState, readState, stateConnection,
  callbackContext, providerOrigin, authorizationOrigin,
  deactivateDuplicateProviderAccounts, loadProviderCredentials };
