'use strict';

/**
 * Read-only checkout decisions for external selling systems.
 *
 * This deliberately delegates all stock facts and hard limits to the existing
 * Sales Order, purchasing-policy, and operating-guard engines. It never writes
 * a balance, commitment, or inventory movement.
 */

const connections = require('./service');
const repo = require('../domain/repository');
const salesOrders = require('../sales/sales-order-service');
const operatingGuards = require('../domain/operating-guards');
const purchasingPolicy = require('../purchasing/policy-service');
const { ValidationError } = require('../domain/errors');
const { trimOrNull } = require('../lib/util');

const RANK = Object.freeze({ ALLOW: 0, WARN: 1, BLOCK: 2 });

function positive(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > 1000000) {
    throw new ValidationError('Every checkout line quantity must be a positive whole number.');
  }
  return number;
}

function exactSku(db, auth, line) {
  const externalId = trimOrNull(line.externalSku || line.externalSkuId);
  if (externalId) {
    const mapped = connections.mapping(db, auth.workspaceId, auth.connectorId, 'sku', externalId);
    if (mapped) return repo.getSku(db, auth.workspaceId, mapped.foundry_record_id);
  }
  const code = trimOrNull(line.skuCode);
  if (!code) return null;
  const rows = db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? AND s.code = ? COLLATE NOCASE AND s.is_active = 1`)
    .all(auth.workspaceId, code);
  return rows.length === 1 ? rows[0] : null;
}

function exactLocation(db, auth, input) {
  const externalId = trimOrNull(input.externalLocationId);
  if (externalId) {
    const mapped = connections.mapping(db, auth.workspaceId, auth.connectorId, 'location', externalId);
    if (mapped) return repo.getLocation(db, auth.workspaceId, mapped.foundry_record_id);
  }
  const name = trimOrNull(input.locationName);
  if (name) {
    const rows = db.prepare('SELECT * FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1')
      .all(auth.workspaceId, name);
    if (rows.length === 1) return rows[0];
  }
  const rows = repo.listLocations(db, auth.workspaceId);
  return !externalId && !name && rows.length === 1 ? rows[0] : null;
}

function unresolved(db, auth, type, externalId, label) {
  const value = externalId || label || 'unknown';
  connections.issue(db, {
    workspaceId: auth.workspaceId,
    connectorId: auth.connectorId,
    issueType: `UNKNOWN_${type.toUpperCase()}`,
    fingerprint: `precheckout-unknown-${type}:${auth.connectorId}:${value}`,
    title: `${label || value} needs a Foundry match`,
    detail: `${auth.displayName} asked Foundry to check this ${type}, but it is not safely mapped yet.`,
    resolutionHint: 'Match this record in Connections before relying on checkout protection.',
  });
  return {
    decision: 'WARN',
    code: `UNKNOWN_${type.toUpperCase()}`,
    message: `Foundry cannot verify ${label || value} until it is mapped.`,
  };
}

function evaluate(db, auth, input = {}) {
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!lines.length || lines.length > 250) {
    throw new ValidationError('Send between 1 and 250 checkout lines.');
  }
  const location = exactLocation(db, auth, input);
  const locationUnknown = (input.externalLocationId || input.locationName) && !location;
  const grouped = new Map();
  const results = [];

  for (const line of lines) {
    const quantity = positive(line.quantity);
    const sku = exactSku(db, auth, line);
    if (!sku) {
      results.push({ ...unresolved(db, auth, 'sku', line.externalSku || line.externalSkuId,
        line.skuCode || line.name), quantity });
      continue;
    }
    const key = `${sku.id}:${location?.id || ''}`;
    const existing = grouped.get(key) || { sku, quantity: 0, sourceLines: [] };
    existing.quantity += quantity;
    existing.sourceLines.push(line);
    grouped.set(key, existing);
  }

  if (locationUnknown) {
    results.push(unresolved(db, auth, 'location', input.externalLocationId, input.locationName));
  }

  for (const group of grouped.values()) {
    const { sku, quantity } = group;
    const availability = salesOrders.availabilityForSku(db, auth.workspaceId, sku.id);
    const position = location
      ? availability.positions.find((row) => row.location_id === location.id)
      : null;
    const available = position ? position.available : availability.available;
    const onHand = position ? Number(position.on_hand) : availability.onHand;
    const projectedAvailable = available - quantity;
    const guard = operatingGuards.evaluateIssue(db, auth.workspaceId, {
      skuId: sku.id, locationId: location?.id || null, quantity,
    });
    const policy = purchasingPolicy.effectivePolicy(db, auth.workspaceId, sku.id);
    let decision = 'ALLOW';
    let code = 'AVAILABLE';
    let message = `${sku.item_name}${sku.variant_label ? ` / ${sku.variant_label}` : ''} has ${available} available.`;

    if (guard) {
      decision = 'BLOCK';
      code = 'STOCK_PROTECTION_RULE';
      message = guard.message;
    } else if (!sku.allow_negative && projectedAvailable < 0) {
      decision = 'WARN';
      code = 'INSUFFICIENT_AVAILABLE_STOCK';
      message = `This checkout requests ${quantity}, but only ${available} ${sku.unit_label || 'unit'}${available === 1 ? '' : 's'} are available.`;
    } else if (policy.reorderPoint !== null && projectedAvailable <= Number(policy.reorderPoint)) {
      decision = 'WARN';
      code = 'BELOW_REORDER_POINT';
      message = `This checkout would leave ${projectedAvailable} available, at or below the reorder point of ${policy.reorderPoint}.`;
    }
    results.push({ decision, code, message, skuId: sku.id, skuCode: sku.code,
      itemName: sku.item_name, quantity, onHand, committed: availability.committed,
      available, projectedAvailable, locationId: location?.id || null, locationName: location?.name || null });
  }

  const decision = results.reduce((highest, row) => RANK[row.decision] > RANK[highest] ? row.decision : highest, 'ALLOW');
  return {
    decision,
    mayProceed: decision !== 'BLOCK',
    checkedAt: new Date().toISOString(),
    source: 'foundry-live-inventory',
    lines: results,
  };
}

module.exports = { evaluate };
