'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const inventory = require('../domain/inventory-engine');
const repo = require('../domain/repository');
const reevaluate = require('../attention/reevaluate');
const registry = require('../onboarding/connectors/registry');
const { AuthenticationError, ValidationError } = require('../domain/errors');
const { newId, nowIso, requireText, trimOrNull } = require('../lib/util');

const CONNECTOR_KEY = 'foundry_event_feed';
const DISPLAY_NAME = 'Foundry operating event feed';
const TOKEN_PREFIX = 'fnd_live_';
const MAX_BATCH = 500;

const json = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function state(db, workspaceId) {
  const connector = db.prepare(
    'SELECT * FROM workspace_connectors WHERE workspace_id = ? AND connector_key = ?'
  ).get(workspaceId, CONNECTOR_KEY);
  if (!connector) return { configured: false, connected: false, connector: null, activeTokens: 0, recentEvents: [] };
  const activeTokens = db.prepare(
    'SELECT COUNT(*) AS n FROM connector_feed_tokens WHERE workspace_id = ? AND connector_id = ? AND revoked_at IS NULL'
  ).get(workspaceId, connector.id).n;
  const recentEvents = db.prepare(
    `SELECT external_event_id, event_type, status, movement_ids, error_message, occurred_at, received_at, processed_at
       FROM connector_feed_events WHERE workspace_id = ? AND connector_id = ?
      ORDER BY received_at DESC, rowid DESC LIMIT 12`
  ).all(workspaceId, connector.id).map((row) => ({
    eventId: row.external_event_id,
    type: row.event_type,
    status: row.status,
    movementIds: json(row.movement_ids, []),
    error: row.error_message,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  }));
  return {
    configured: connector.status === 'connected' && activeTokens > 0,
    // A token proves only that the endpoint is configured. A real connection
    // is claimed only after authenticated data has crossed the boundary.
    connected: connector.status === 'connected' && activeTokens > 0 && Boolean(connector.last_synced_at),
    connector: {
      id: connector.id,
      status: connector.status,
      displayName: connector.display_name,
      lastSyncedAt: connector.last_synced_at,
      lastError: connector.last_error,
      capabilities: json(connector.capabilities, []),
    },
    activeTokens,
    recentEvents,
  };
}

/** Creates a usable credential and returns it exactly once. */
function enable(db, ctx, membership) {
  const now = nowIso();
  let connector = db.prepare(
    'SELECT * FROM workspace_connectors WHERE workspace_id = ? AND connector_key = ?'
  ).get(ctx.workspaceId, CONNECTOR_KEY);
  const connectorId = connector ? connector.id : newId('con');
  const tokenId = newId('ctok');
  const visiblePrefix = crypto.randomBytes(6).toString('hex');
  const token = `${TOKEN_PREFIX}${visiblePrefix}.${crypto.randomBytes(32).toString('base64url')}`;

  inTransaction(db, () => {
    if (!connector) {
      db.prepare(
        `INSERT INTO workspace_connectors
           (id, workspace_id, connector_key, display_name, status, capabilities, credential_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?)`
      ).run(connectorId, ctx.workspaceId, CONNECTOR_KEY, DISPLAY_NAME,
        JSON.stringify([registry.CAPABILITIES.READ_MOVEMENTS]), `connector_feed_tokens:${tokenId}`, now, now);
    } else {
      db.prepare(
        `UPDATE workspace_connectors SET status = 'connected', capabilities = ?, credential_ref = ?,
           last_error = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`
      ).run(JSON.stringify([registry.CAPABILITIES.READ_MOVEMENTS]), `connector_feed_tokens:${tokenId}`,
        now, connectorId, ctx.workspaceId);
    }
    // Regenerating a credential is an intentional rotation: old copies stop
    // working immediately, while their event audit remains intact.
    db.prepare(
      `UPDATE connector_feed_tokens SET revoked_at = ?
        WHERE workspace_id = ? AND connector_id = ? AND revoked_at IS NULL`
    ).run(now, ctx.workspaceId, connectorId);
    db.prepare(
      `INSERT INTO connector_feed_tokens
         (id, workspace_id, connector_id, token_prefix, token_hash, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tokenId, ctx.workspaceId, connectorId, visiblePrefix, hashToken(token), membership.id, now);
  });

  return { ...state(db, ctx.workspaceId), token, tokenPrefix: visiblePrefix };
}

function disconnect(db, ctx) {
  const now = nowIso();
  const connector = db.prepare(
    'SELECT id FROM workspace_connectors WHERE workspace_id = ? AND connector_key = ?'
  ).get(ctx.workspaceId, CONNECTOR_KEY);
  if (!connector) return state(db, ctx.workspaceId);
  inTransaction(db, () => {
    db.prepare(
      "UPDATE workspace_connectors SET status = 'disconnected', updated_at = ? WHERE id = ? AND workspace_id = ?"
    ).run(now, connector.id, ctx.workspaceId);
    db.prepare(
      `UPDATE connector_feed_tokens SET revoked_at = ?
        WHERE workspace_id = ? AND connector_id = ? AND revoked_at IS NULL`
    ).run(now, ctx.workspaceId, connector.id);
  });
  return state(db, ctx.workspaceId);
}

function authenticate(db, authorization) {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || '').trim());
  const token = match && match[1];
  if (!token || token.length > 200 || !token.startsWith(TOKEN_PREFIX)) {
    throw new AuthenticationError('A valid Foundry event-feed bearer token is required.');
  }
  const visiblePrefix = token.slice(TOKEN_PREFIX.length).split('.')[0];
  const row = db.prepare(
    `SELECT t.*, c.status AS connector_status, c.connector_key, u.account_id
       FROM connector_feed_tokens t
       JOIN workspace_connectors c ON c.id = t.connector_id AND c.workspace_id = t.workspace_id
       JOIN users u ON u.id = t.created_by_user_id AND u.workspace_id = t.workspace_id
      WHERE t.token_prefix = ? AND t.token_hash = ? AND t.revoked_at IS NULL
        AND c.status = 'connected' AND c.connector_key = ?`
  ).get(visiblePrefix, hashToken(token), CONNECTOR_KEY);
  if (!row) throw new AuthenticationError('That Foundry event-feed token is invalid or has been revoked.');
  db.prepare('UPDATE connector_feed_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  return {
    tokenId: row.id,
    connectorId: row.connector_id,
    workspaceId: row.workspace_id,
    actorId: row.created_by_user_id,
    accountId: row.account_id,
  };
}

function resolveSku(db, workspaceId, event) {
  let rows = [];
  if (trimOrNull(event.skuId)) {
    const sku = repo.getSku(db, workspaceId, event.skuId);
    rows = sku ? [sku] : [];
  } else if (trimOrNull(event.skuCode)) {
    rows = db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? AND s.code = ? COLLATE NOCASE`)
      .all(workspaceId, event.skuCode.trim());
  } else if (trimOrNull(event.supplierCode)) {
    const supplierClause = trimOrNull(event.supplierName) ? ' AND sup.name = ? COLLATE NOCASE' : '';
    const params = [workspaceId, event.supplierCode.trim()];
    if (supplierClause) params.push(event.supplierName.trim());
    rows = db.prepare(
      `${repo.SKU_SELECT}
       JOIN supplier_items si ON si.sku_id = s.id AND si.workspace_id = s.workspace_id
       JOIN suppliers sup ON sup.id = si.supplier_id AND sup.workspace_id = si.workspace_id
       WHERE s.workspace_id = ? AND si.supplier_sku = ? COLLATE NOCASE${supplierClause}`
    ).all(...params);
  } else {
    throw new ValidationError('Each feed event needs skuId, skuCode, or supplierCode.');
  }
  if (rows.length === 0) throw new ValidationError('The feed event did not match a product in this inventory.');
  if (rows.length > 1) throw new ValidationError('The feed event matched more than one product. Include a more specific identifier.');
  return rows[0];
}

function resolveLocation(db, workspaceId, event, field = 'location') {
  const id = trimOrNull(event[`${field}Id`]);
  const name = trimOrNull(event[`${field}Name`]);
  if (id) {
    const location = repo.getLocation(db, workspaceId, id);
    if (!location) throw new ValidationError(`The ${field} in that feed event was not found.`);
    return location;
  }
  if (name) {
    const rows = db.prepare(
      'SELECT * FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1'
    ).all(workspaceId, name);
    if (rows.length !== 1) throw new ValidationError(`The ${field} name in that feed event was not unique.`);
    return rows[0];
  }
  const active = repo.listLocations(db, workspaceId);
  if (active.length === 1) return active[0];
  throw new ValidationError(`That feed event needs a ${field} because this inventory has more than one active location.`);
}

function serialUnitIds(db, workspaceId, skuId, rawSerials) {
  const serials = Array.isArray(rawSerials) ? rawSerials.filter(Boolean).map(String) : [];
  if (!serials.length) return null;
  return serials.map((serial) => {
    const rows = db.prepare(
      `SELECT id FROM serial_units WHERE workspace_id = ? AND sku_id = ? AND serial = ? COLLATE NOCASE
        AND status = 'in_stock'`
    ).all(workspaceId, skuId, serial.trim());
    if (rows.length !== 1) throw new ValidationError(`Serial ${serial} is not uniquely available in stock.`);
    return rows[0].id;
  });
}

function lotId(db, workspaceId, skuId, event) {
  if (trimOrNull(event.lotId)) return event.lotId;
  if (!trimOrNull(event.lotCode)) return null;
  const lot = repo.getLotByCode(db, workspaceId, skuId, event.lotCode.trim());
  return lot && lot.id;
}

function applyEvent(db, auth, event) {
  const type = requireText(event.type, 'Event type', { max: 40 }).toLowerCase().replaceAll('-', '_');
  const sku = resolveSku(db, auth.workspaceId, event);
  const occurredAt = trimOrNull(event.occurredAt);
  const reference = trimOrNull(event.reference) || `feed:${event.eventId}`;
  const notes = trimOrNull(event.notes) || `Received from ${DISPLAY_NAME}.`;
  const ctx = { workspaceId: auth.workspaceId, actorId: auth.actorId, accountId: auth.accountId };

  if (['sale', 'issue', 'shipment_out', 'damage'].includes(type)) {
    const location = resolveLocation(db, auth.workspaceId, event);
    return { type: 'issue', skuId: sku.id, result: inventory.issue(db, ctx, {
      skuId: sku.id, locationId: location.id, quantity: event.quantity,
      serialUnitIds: serialUnitIds(db, auth.workspaceId, sku.id, event.serials),
      lotId: lotId(db, auth.workspaceId, sku.id, event),
      reasonCode: type === 'damage' ? 'damaged' : (trimOrNull(event.reasonCode) || 'sold'),
      reference, notes, occurredAt,
    }) };
  }
  if (['receive', 'receipt', 'customer_return'].includes(type)) {
    const location = resolveLocation(db, auth.workspaceId, event);
    return { type: 'receive', skuId: sku.id, result: inventory.receive(db, ctx, {
      skuId: sku.id, locationId: location.id, quantity: event.quantity,
      serials: event.serials, lotCode: event.lotCode, expiresAt: event.expiresAt,
      reasonCode: trimOrNull(event.reasonCode), reference, notes, occurredAt,
    }) };
  }
  if (['count', 'adjust', 'adjustment'].includes(type)) {
    const location = resolveLocation(db, auth.workspaceId, event);
    return { type: 'adjust', skuId: sku.id, result: inventory.adjust(db, ctx, {
      skuId: sku.id, locationId: location.id, countedQty: event.countedQty,
      serialUnitIds: serialUnitIds(db, auth.workspaceId, sku.id, event.serials),
      lotId: lotId(db, auth.workspaceId, sku.id, event),
      reasonCode: trimOrNull(event.reasonCode) || 'physical_count', reference, notes, occurredAt,
    }) };
  }
  if (type === 'transfer') {
    const from = resolveLocation(db, auth.workspaceId, event, 'fromLocation');
    const to = resolveLocation(db, auth.workspaceId, event, 'toLocation');
    return { type: 'transfer', skuId: sku.id, result: inventory.transfer(db, ctx, {
      skuId: sku.id, fromLocationId: from.id, toLocationId: to.id, quantity: event.quantity,
      serialUnitIds: serialUnitIds(db, auth.workspaceId, sku.id, event.serials),
      lotId: lotId(db, auth.workspaceId, sku.id, event),
      reference, notes, occurredAt,
    }) };
  }
  throw new ValidationError('Event type must be sale, issue, shipment_out, damage, receive, receipt, customer_return, count, adjustment, or transfer.');
}

function ingest(db, auth, input) {
  const event = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const externalEventId = requireText(event.eventId, 'Event id', { max: 120 });
  const existing = db.prepare(
    `SELECT * FROM connector_feed_events
      WHERE workspace_id = ? AND connector_id = ? AND external_event_id = ?`
  ).get(auth.workspaceId, auth.connectorId, externalEventId);
  if (existing) return {
    accepted: existing.status === 'COMPLETED', replayed: true, eventId: externalEventId,
    type: existing.event_type, status: existing.status, movementIds: json(existing.movement_ids, []),
    error: existing.error_message,
  };

  const receivedAt = nowIso();
  try {
    const applied = inTransaction(db, () => {
      // Re-check under the write lock. If another process won, doing nothing is
      // the only safe response.
      const raced = db.prepare(
        `SELECT * FROM connector_feed_events
          WHERE workspace_id = ? AND connector_id = ? AND external_event_id = ?`
      ).get(auth.workspaceId, auth.connectorId, externalEventId);
      if (raced) return { raced };

      const operation = applyEvent(db, auth, { ...event, eventId: externalEventId });
      const movementIds = operation.result.movementIds || [];
      const processedAt = nowIso();
      db.prepare(
        `INSERT INTO connector_feed_events
           (id, workspace_id, connector_id, external_event_id, event_type, payload, status,
            movement_ids, occurred_at, received_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?)`
      ).run(newId('cfe'), auth.workspaceId, auth.connectorId, externalEventId, operation.type,
        JSON.stringify(event), JSON.stringify(movementIds), trimOrNull(event.occurredAt), receivedAt, processedAt);
      db.prepare(
        `UPDATE workspace_connectors SET last_synced_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ?`
      ).run(processedAt, processedAt, auth.connectorId, auth.workspaceId);
      return { operation, movementIds };
    });

    if (applied.raced) return ingest(db, auth, event);
    reevaluate.afterMovement(db, auth.workspaceId, [applied.operation.skuId], `connector:${applied.operation.type}`);
    return {
      accepted: true, replayed: false, eventId: externalEventId,
      type: applied.operation.type, status: 'COMPLETED', movementIds: applied.movementIds,
    };
  } catch (error) {
    const failedAt = nowIso();
    try {
      inTransaction(db, () => {
        db.prepare(
          `INSERT OR IGNORE INTO connector_feed_events
             (id, workspace_id, connector_id, external_event_id, event_type, payload, status,
              movement_ids, error_message, occurred_at, received_at, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'REJECTED', '[]', ?, ?, ?, ?)`
        ).run(newId('cfe'), auth.workspaceId, auth.connectorId, externalEventId,
          trimOrNull(event.type) || 'unknown', JSON.stringify(event), error.message,
          trimOrNull(event.occurredAt), receivedAt, failedAt);
        db.prepare(
          `UPDATE workspace_connectors SET last_error = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ?`
        ).run(error.message, failedAt, auth.connectorId, auth.workspaceId);
      });
    } catch { /* the original rejection is the useful result */ }
    return {
      accepted: false, replayed: false, eventId: externalEventId,
      type: trimOrNull(event.type) || 'unknown', status: 'REJECTED', movementIds: [], error: error.message,
    };
  }
}

function ingestBatch(db, auth, body) {
  const events = Array.isArray(body && body.events) ? body.events : [body];
  if (!events.length) throw new ValidationError('Send at least one event.');
  if (events.length > MAX_BATCH) throw new ValidationError(`Send at most ${MAX_BATCH} events at once.`);
  const results = events.map((event) => ingest(db, auth, event));
  return {
    accepted: results.filter((entry) => entry.accepted && !entry.replayed).length,
    replayed: results.filter((entry) => entry.replayed).length,
    rejected: results.filter((entry) => !entry.accepted).length,
    results,
  };
}

module.exports = {
  CONNECTOR_KEY,
  DISPLAY_NAME,
  MAX_BATCH,
  state,
  enable,
  disconnect,
  authenticate,
  ingest,
  ingestBatch,
};
