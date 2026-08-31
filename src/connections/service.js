'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const { AuthenticationError, NotFoundError, ValidationError } = require('../domain/errors');
const { newId, nowIso, requireText, trimOrNull } = require('../lib/util');

const TOKEN_PREFIX = 'fnd_live_';
const ENTITY_TABLES = Object.freeze({
  sku: ['skus', 'id'],
  location: ['locations', 'id'],
  customer: ['customers', 'id'],
  sales_order: ['sales_orders', 'id'],
  supplier: ['suppliers', 'id'],
});

const parseJson = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function latestConnectionEvidence(row) {
  const candidates = [row.last_activity_at, row.last_synced_at, row.created_at]
    .filter(Boolean).map((value) => ({ value, time: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.time));
  candidates.sort((a, b) => b.time - a.time);
  return candidates[0]?.value || null;
}

function publicStatus(row, openIssues = 0, now = Date.now()) {
  if (!row || row.status === 'disconnected') return 'Disconnected';
  if (row.status === 'error' || row.paused_at || openIssues > 0) return 'Needs attention';
  // A quiet mailbox is healthy when its scheduled check succeeds. Prefer the
  // newest proof of life instead of treating "no new email" as an outage.
  const baseline = latestConnectionEvidence(row);
  if (baseline && row.expected_interval_minutes > 0) {
    const staleAt = Date.parse(baseline) + Number(row.expected_interval_minutes) * 60_000;
    if (Number.isFinite(staleAt) && staleAt < now) return 'Needs attention';
  }
  return 'Connected';
}

function hydrate(db, row, now = Date.now()) {
  if (!row) return null;
  const openIssues = db.prepare(
    "SELECT COUNT(*) AS n FROM connection_issues WHERE workspace_id = ? AND connector_id = ? AND status = 'OPEN'"
  ).get(row.workspace_id, row.id).n;
  const mappingCounts = db.prepare(`SELECT
      SUM(CASE WHEN entity_type = 'sku' THEN 1 ELSE 0 END) AS products,
      SUM(CASE WHEN entity_type = 'location' THEN 1 ELSE 0 END) AS locations
    FROM connection_mappings WHERE workspace_id = ? AND connector_id = ?`)
    .get(row.workspace_id, row.id);
  const needsMapping = db.prepare(`SELECT COUNT(*) AS n FROM connection_external_records
    WHERE workspace_id = ? AND connector_id = ? AND selected = 1 AND mapping_status = 'UNMAPPED'`)
    .get(row.workspace_id, row.id).n;
  return {
    ...row,
    capabilities: parseJson(row.capabilities, []),
    provides: parseJson(row.provides, []),
    config: parseJson(row.config, {}),
    openIssues,
    productsMapped: Number(mappingCounts.products || 0),
    locationsMapped: Number(mappingCounts.locations || 0),
    itemsNeedingMapping: Number(needsMapping || 0),
    publicStatus: publicStatus(row, openIssues, now),
  };
}

function list(db, workspaceId, options = {}) {
  return db.prepare(
    `SELECT * FROM workspace_connectors WHERE workspace_id = ?
       AND NOT (status = 'disconnected' AND setup_status = 'AUTHORIZING'
         AND provider_account_id IS NULL AND credential_ref IS NULL)
     ORDER BY CASE status WHEN 'connected' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,
       updated_at DESC, display_name COLLATE NOCASE`
  ).all(workspaceId).map((row) => hydrate(db, row, options.now));
}

function get(db, workspaceId, connectorId) {
  const row = db.prepare('SELECT * FROM workspace_connectors WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, connectorId);
  if (!row) throw new NotFoundError('Connection not found.');
  return hydrate(db, row);
}

function issue(db, input) {
  const now = nowIso();
  const fingerprint = requireText(input.fingerprint, 'Issue fingerprint', { max: 300 });
  const existing = db.prepare('SELECT id FROM connection_issues WHERE workspace_id = ? AND fingerprint = ?')
    .get(input.workspaceId, fingerprint);
  if (existing) {
    db.prepare(`UPDATE connection_issues SET connector_id = ?, external_event_id = ?, issue_type = ?,
      title = ?, detail = ?, resolution_hint = ?, candidate_matches = ?, status = 'OPEN',
      resolved_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(input.connectorId, trimOrNull(input.externalEventId), input.issueType, input.title, input.detail,
        input.resolutionHint, JSON.stringify(input.candidates || []), now, existing.id, input.workspaceId);
    return existing.id;
  }
  const id = newId('cissue');
  db.prepare(`INSERT INTO connection_issues
    (id, workspace_id, connector_id, external_event_id, issue_type, fingerprint, title, detail,
     resolution_hint, candidate_matches, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`)
    .run(id, input.workspaceId, input.connectorId, trimOrNull(input.externalEventId), input.issueType,
      fingerprint, input.title, input.detail, input.resolutionHint, JSON.stringify(input.candidates || []), now, now);
  return id;
}

function resolveIssues(db, workspaceId, connectorId, issueType, externalId) {
  const now = nowIso();
  if (externalId === undefined || externalId === null || externalId === '') {
    db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
      WHERE workspace_id = ? AND connector_id = ? AND issue_type = ? AND status = 'OPEN'`)
      .run(now, now, workspaceId, connectorId, issueType);
    return;
  }
  db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
    WHERE workspace_id = ? AND connector_id = ? AND issue_type = ? AND status = 'OPEN'
      AND fingerprint LIKE ?`)
    .run(now, now, workspaceId, connectorId, issueType, `%:${externalId}`);
}

function create(db, ctx, membership, input = {}) {
  const providerType = requireText(input.providerType || 'reference_webhook', 'Connection type', { max: 60 })
    .toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  if (!['reference_webhook', 'supplier_email'].includes(providerType)) {
    throw new ValidationError('Real providers must be connected through their authorization screen.');
  }
  const displayName = requireText(input.displayName || (providerType === 'supplier_email' ? 'Supplier email' : 'Custom event connection'),
    'Connection name', { max: 100 });
  const now = nowIso();
  const connectorId = newId('con');
  const tokenId = newId('ctok');
  const visiblePrefix = crypto.randomBytes(6).toString('hex');
  const token = `${TOKEN_PREFIX}${visiblePrefix}.${crypto.randomBytes(32).toString('base64url')}`;
  const provides = Array.isArray(input.provides) ? input.provides : providerType === 'supplier_email'
    ? ['supplier messages and attachments']
    : ['sales', 'customer orders', 'fulfillment', 'returns', 'receipts', 'transfers', 'adjustments',
      'product and location updates'];
  inTransaction(db, () => {
    db.prepare(`INSERT INTO workspace_connectors
      (id, workspace_id, connector_key, display_name, provider_type, status, capabilities, provides,
      config, credential_ref, expected_interval_minutes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?)`)
      .run(connectorId, ctx.workspaceId, `${providerType}:${connectorId}`, displayName, providerType,
        JSON.stringify(['events:ingest']), JSON.stringify(provides), JSON.stringify(input.config || {}),
        `connector_feed_tokens:${tokenId}`, Math.max(0, Number(input.expectedIntervalMinutes) || 360), now, now);
    db.prepare(`UPDATE workspace_connectors SET setup_status = 'CONNECTED', authorized_by_user_id = ?
      WHERE workspace_id = ? AND id = ?`).run(membership.id, ctx.workspaceId, connectorId);
    db.prepare(`INSERT INTO connector_feed_tokens
      (id, workspace_id, connector_id, token_prefix, token_hash, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(tokenId, ctx.workspaceId, connectorId, visiblePrefix, hash(token), membership.id, now);
  });
  return { connection: get(db, ctx.workspaceId, connectorId), token, tokenPrefix: visiblePrefix };
}

function rotateToken(db, ctx, membership, connectorId) {
  get(db, ctx.workspaceId, connectorId);
  const now = nowIso();
  const tokenId = newId('ctok');
  const visiblePrefix = crypto.randomBytes(6).toString('hex');
  const token = `${TOKEN_PREFIX}${visiblePrefix}.${crypto.randomBytes(32).toString('base64url')}`;
  inTransaction(db, () => {
    db.prepare('UPDATE connector_feed_tokens SET revoked_at = ? WHERE workspace_id = ? AND connector_id = ? AND revoked_at IS NULL')
      .run(now, ctx.workspaceId, connectorId);
    db.prepare(`INSERT INTO connector_feed_tokens
      (id, workspace_id, connector_id, token_prefix, token_hash, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(tokenId, ctx.workspaceId, connectorId, visiblePrefix, hash(token), membership.id, now);
    db.prepare(`UPDATE workspace_connectors SET status = 'connected', paused_at = NULL, credential_ref = ?,
      last_error = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(`connector_feed_tokens:${tokenId}`, now, ctx.workspaceId, connectorId);
  });
  return { connection: get(db, ctx.workspaceId, connectorId), token, tokenPrefix: visiblePrefix };
}

/** Issue an additional scoped machine token without replacing provider OAuth credentials. */
function issueCheckoutToken(db, ctx, membership, connectorId) {
  const connection = get(db, ctx.workspaceId, connectorId);
  if (connection.status !== 'connected') throw new ValidationError('Reconnect this provider before creating a checkout key.');
  const now = nowIso();
  const tokenId = newId('ctok');
  const visiblePrefix = crypto.randomBytes(6).toString('hex');
  const token = `${TOKEN_PREFIX}${visiblePrefix}.${crypto.randomBytes(32).toString('base64url')}`;
  db.prepare(`INSERT INTO connector_feed_tokens
    (id, workspace_id, connector_id, token_prefix, token_hash, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(tokenId, ctx.workspaceId, connectorId, visiblePrefix, hash(token), membership.id, now);
  return { token, tokenPrefix: visiblePrefix };
}

function disconnect(db, workspaceId, connectorId) {
  get(db, workspaceId, connectorId);
  const now = nowIso();
  inTransaction(db, () => {
    db.prepare("UPDATE workspace_connectors SET status = 'disconnected', paused_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(now, now, workspaceId, connectorId);
    db.prepare('UPDATE connector_feed_tokens SET revoked_at = ? WHERE workspace_id = ? AND connector_id = ? AND revoked_at IS NULL')
      .run(now, workspaceId, connectorId);
    db.prepare('DELETE FROM connection_credentials WHERE workspace_id = ? AND connector_id = ?')
      .run(workspaceId, connectorId);
  });
  return get(db, workspaceId, connectorId);
}

function pause(db, workspaceId, connectorId) {
  get(db, workspaceId, connectorId);
  const now = nowIso();
  db.prepare("UPDATE workspace_connectors SET paused_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
    .run(now, now, workspaceId, connectorId);
  return get(db, workspaceId, connectorId);
}

function resume(db, workspaceId, connectorId) {
  get(db, workspaceId, connectorId);
  db.prepare("UPDATE workspace_connectors SET paused_at = NULL, status = 'connected', updated_at = ? WHERE workspace_id = ? AND id = ?")
    .run(nowIso(), workspaceId, connectorId);
  return get(db, workspaceId, connectorId);
}

function authenticate(db, authorization) {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || '').trim());
  const token = match && match[1];
  if (!token || token.length > 200 || !token.startsWith(TOKEN_PREFIX)) {
    throw new AuthenticationError('A valid Foundry connection bearer token is required.');
  }
  const prefix = token.slice(TOKEN_PREFIX.length).split('.')[0];
  const row = db.prepare(`SELECT t.*, c.status AS connector_status, c.paused_at, c.provider_type,
      c.display_name, u.account_id
    FROM connector_feed_tokens t
    JOIN workspace_connectors c ON c.id = t.connector_id AND c.workspace_id = t.workspace_id
    JOIN users u ON u.id = t.created_by_user_id AND u.workspace_id = t.workspace_id
    WHERE t.token_prefix = ? AND t.token_hash = ? AND t.revoked_at IS NULL`)
    .get(prefix, hash(token));
  if (!row || row.connector_status !== 'connected') throw new AuthenticationError('That connection token is invalid or has been revoked.');
  if (row.paused_at) throw new AuthenticationError('This connection is paused. Resume it before sending more events.');
  db.prepare('UPDATE connector_feed_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { tokenId: row.id, connectorId: row.connector_id, workspaceId: row.workspace_id,
    actorId: row.created_by_user_id, accountId: row.account_id, providerType: row.provider_type,
    displayName: row.display_name };
}

function mapping(db, workspaceId, connectorId, entityType, externalId) {
  return db.prepare(`SELECT * FROM connection_mappings WHERE workspace_id = ? AND connector_id = ?
    AND entity_type = ? AND external_id = ? COLLATE NOCASE`)
    .get(workspaceId, connectorId, entityType, externalId);
}

function mapExternal(db, ctx, connectorId, input) {
  get(db, ctx.workspaceId, connectorId);
  const entityType = requireText(input.entityType, 'Mapping type', { max: 30 }).toLowerCase();
  const target = ENTITY_TABLES[entityType];
  if (!target) throw new ValidationError('Mapping type must be SKU, location, customer, sales order, or supplier.');
  const externalId = requireText(input.externalId, 'External id', { max: 160 });
  const foundryRecordId = requireText(input.foundryRecordId, 'Foundry record', { max: 160 });
  const found = db.prepare(`SELECT ${target[1]} AS id FROM ${target[0]} WHERE workspace_id = ? AND ${target[1]} = ?`)
    .get(ctx.workspaceId, foundryRecordId);
  if (!found) throw new ValidationError('That Foundry record is not in this inventory.');
  const now = nowIso();
  const id = newId('cmap');
  db.prepare(`INSERT INTO connection_mappings
    (id, workspace_id, connector_id, entity_type, external_id, foundry_record_id, confidence,
     approved_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)
    ON CONFLICT(workspace_id, connector_id, entity_type, external_id) DO UPDATE SET
      foundry_record_id = excluded.foundry_record_id, confidence = 'approved',
      approved_by_user_id = excluded.approved_by_user_id, updated_at = excluded.updated_at`)
    .run(id, ctx.workspaceId, connectorId, entityType, externalId, foundryRecordId, ctx.actorId, now, now);
  resolveIssues(db, ctx.workspaceId, connectorId, `UNKNOWN_${entityType.toUpperCase()}`, externalId);
  db.prepare(`UPDATE connection_external_records SET mapping_status = 'MAPPED', updated_at = ?
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = ? AND external_id = ? COLLATE NOCASE`)
    .run(now, ctx.workspaceId, connectorId, entityType, externalId);
  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM connection_external_records
    WHERE workspace_id = ? AND connector_id = ? AND selected = 1 AND mapping_status = 'UNMAPPED'`)
    .get(ctx.workspaceId, connectorId).n;
  if (!remaining) db.prepare(`UPDATE workspace_connectors SET setup_status = 'CONNECTED', updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(now, ctx.workspaceId, connectorId);
  return mapping(db, ctx.workspaceId, connectorId, entityType, externalId);
}

function addEmailRule(db, ctx, connectorId, input) {
  const connection = get(db, ctx.workspaceId, connectorId);
  if (!['supplier_email', 'gmail', 'microsoft365'].includes(connection.provider_type)) {
    throw new ValidationError('Allowed senders belong to a supplier mailbox connection.');
  }
  const sender = requireText(input.senderPattern, 'Allowed sender', { max: 254 }).toLowerCase();
  const documentMode = ['review_each', 'supplier_documents', 'inventory_list'].includes(input.documentMode)
    ? input.documentMode : 'review_each';
  if (!sender.includes('@')) throw new ValidationError('Enter a full email address or an @domain pattern.');
  if (input.supplierId) {
    const supplier = db.prepare('SELECT id FROM suppliers WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, input.supplierId);
    if (!supplier) throw new ValidationError('That supplier is not in this inventory.');
  }
  const id = newId('emailrule');
  db.prepare(`INSERT INTO connection_email_rules
    (id, workspace_id, connector_id, sender_pattern, supplier_id, document_mode, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, connector_id, sender_pattern) DO UPDATE SET
      supplier_id = excluded.supplier_id, document_mode = excluded.document_mode, is_active = 1`)
    .run(id, ctx.workspaceId, connectorId, sender, trimOrNull(input.supplierId), documentMode, ctx.actorId, nowIso());
  return db.prepare('SELECT * FROM connection_email_rules WHERE workspace_id = ? AND connector_id = ? AND sender_pattern = ? COLLATE NOCASE')
    .get(ctx.workspaceId, connectorId, sender);
}

function refreshHealth(db, workspaceId, options = {}) {
  const at = Number(options.now || Date.now());
  for (const connection of list(db, workspaceId, { now: at })) {
    if (connection.status !== 'connected' || connection.expected_interval_minutes <= 0) continue;
    const baseline = latestConnectionEvidence(connection);
    const staleAt = Date.parse(baseline) + Number(connection.expected_interval_minutes) * 60_000;
    if (Number.isFinite(staleAt) && staleAt < at) {
      issue(db, { workspaceId, connectorId: connection.id, issueType: 'CONNECTION_STALE',
        fingerprint: `connection-stale:${connection.id}`, title: `${connection.display_name} has stopped sending activity`,
        detail: baseline
          ? `Foundry has not completed a successful check or received activity since ${baseline}. It may be missing external events.`
          : 'Foundry has not completed a successful check or received activity since this connection was established.',
        resolutionHint: 'Check the external system, then reconnect or resume this connection.' });
    }
  }
  return list(db, workspaceId, { now: at });
}

module.exports = {
  TOKEN_PREFIX, parseJson, publicStatus, list, get, create, rotateToken, issueCheckoutToken, disconnect, pause, resume,
  authenticate, mapping, mapExternal, issue, resolveIssues, addEmailRule, refreshHealth, latestConnectionEvidence,
};
