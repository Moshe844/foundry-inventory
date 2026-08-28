'use strict';

const service = require('./service');
const ingestion = require('./event-ingestion');
const queryService = require('../attention/query-service');
const { ValidationError } = require('../domain/errors');

function matches(message) {
  return /\b(?:map\s+(?:(?:the\s+)?external\s+(?:sku|location)|(?:shopify|square|clover|woocommerce))|stop\s+trusting|pause\s+(?:(?:the|this|that)\s*)?(?:pos|feed|connection|shopify|square|clover|woocommerce)(?:\s+ingestion)?|resume\s+(?:(?:the|this|that)\s*)?(?:pos|feed|connection|shopify|square|clover|woocommerce)|reconnect\s+(?:shopify|square|clover|woocommerce|connection))\b/i.test(message);
}

function chooseConnection(db, workspaceId, message) {
  const rows = service.list(db, workspaceId);
  if (!rows.length) throw new ValidationError('No external connection is configured yet. Add one in Settings → Connections.');
  const lower = message.toLowerCase();
  const named = rows.filter((row) => lower.includes(row.display_name.toLowerCase())
    || lower.includes(row.provider_type.replaceAll('_', ' ')));
  if (named.length === 1) return named[0];
  if (rows.length === 1) return rows[0];
  throw new ValidationError('Say which connection you mean, or open Settings → Connections and choose it.');
}

function mappingInstruction(message) {
  const match = /\bmap\s+(?:the\s+)?external\s+(sku|location)\s+["']?([^\s,"']+)["']?\s+(?:to|as)\s+(.+?)[.!?]?$/i.exec(message.trim());
  return match ? { entityType: match[1].toLowerCase(), externalId: match[2], target: match[3].trim() } : null;
}

function providerMappingInstruction(db, connection, message) {
  const match = /^\s*map\s+(?:shopify|square|clover|woocommerce)\s+(.+?)\s+(?:to|as)\s+(.+?)[.!?]?\s*$/i.exec(message);
  if (!match) return null;
  const externalQuery = match[1].trim().toLowerCase();
  const records = db.prepare(`SELECT * FROM connection_external_records WHERE workspace_id = ? AND connector_id = ?
    AND selected = 1 AND mapping_status = 'UNMAPPED'`).all(connection.workspace_id, connection.id)
    .filter((row) => `${row.display_name} ${row.code || ''} ${row.external_id}`.toLowerCase().includes(externalQuery));
  if (records.length !== 1) throw new ValidationError(records.length
    ? `More than one ${connection.display_name} record matches “${match[1].trim()}”. Use its exact external SKU.`
    : `Foundry could not find an unmapped ${connection.display_name} record matching “${match[1].trim()}”.`);
  if (/^this\s+(?:foundry\s+)?(?:variant|item|product)$/i.test(match[2].trim())) {
    throw new ValidationError('Name the Foundry SKU code you want this external product mapped to.');
  }
  return { entityType: records[0].entity_type, externalId: records[0].external_id, target: match[2].trim() };
}

function resolveTarget(db, workspaceId, parsed) {
  if (parsed.entityType === 'sku') {
    const rows = queryService.resolveSkus(db, workspaceId, parsed.target, 3);
    if (rows.length !== 1) throw new ValidationError(rows.length
      ? `More than one inventory line matches “${parsed.target}”. Use its exact SKU code.`
      : `Foundry could not find an inventory line matching “${parsed.target}”.`);
    return rows[0].id;
  }
  const exact = db.prepare('SELECT id FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1')
    .all(workspaceId, parsed.target);
  if (exact.length === 1) return exact[0].id;
  const partial = db.prepare("SELECT id FROM locations WHERE workspace_id = ? AND name LIKE ? ESCAPE '\\' COLLATE NOCASE AND is_active = 1")
    .all(workspaceId, `%${parsed.target.replace(/[%_]/g, (c) => `\\${c}`)}%`);
  if (partial.length !== 1) throw new ValidationError(`Foundry could not match “${parsed.target}” to exactly one location.`);
  return partial[0].id;
}

function apply(db, ctx, user, message) {
  const connection = chooseConnection(db, ctx.workspaceId, message);
  const map = mappingInstruction(message) || providerMappingInstruction(db, connection, message);
  if (map) {
    service.mapExternal(db, ctx, connection.id, { ...map, foundryRecordId: resolveTarget(db, ctx.workspaceId, map) });
    const retried = ingestion.retryPending(db, { connectorId: connection.id, workspaceId: ctx.workspaceId,
      actorId: ctx.actorId, accountId: ctx.accountId, providerType: connection.provider_type,
      displayName: connection.display_name });
    const completed = retried.filter((row) => row.accepted).length;
    return { connection, message: `Mapped external ${map.entityType} ${map.externalId}. ${completed} waiting event${completed === 1 ? '' : 's'} completed safely.` };
  }
  if (/\b(?:stop\s+trusting|pause|hold|suspend)\b/i.test(message)) {
    service.pause(db, ctx.workspaceId, connection.id);
    return { connection, message: `Foundry stopped trusting new events from ${connection.display_name}.` };
  }
  if (/\b(?:resume|start\s+trusting|unpause)\b/i.test(message)) {
    service.resume(db, ctx.workspaceId, connection.id);
    return { connection, message: `Foundry is accepting trusted events from ${connection.display_name} again.` };
  }
  if (/\breconnect\b/i.test(message)) {
    return { connection, message: `Foundry found ${connection.display_name}. Use Reconnect on its connection page to sign in with the provider again; existing mappings and audit history will be kept.` };
  }
  return { connection, message: `Opened ${connection.display_name}.` };
}

module.exports = { matches, mappingInstruction, providerMappingInstruction, chooseConnection, apply };
