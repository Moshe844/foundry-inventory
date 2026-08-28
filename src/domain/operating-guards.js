'use strict';

/**
 * Structured inventory-operation guards.
 *
 * This is deliberately below Tell Foundry and below the web routes. The same
 * row is readable from Settings and is enforced by the inventory engine, so a
 * connector, manual issue, grouped action or autonomous action cannot bypass
 * it. Conversation supplies typed values; this module alone decides whether
 * the current inventory state satisfies them.
 */

const { newId, nowIso } = require('../lib/util');
const { ValidationError, InvariantError, NotFoundError } = require('./errors');
const permissions = require('../actions/permissions');

const ACTIONS = Object.freeze({ ISSUE: 'issue' });
const METRICS = Object.freeze({ NETWORK_ON_HAND: 'network_on_hand', LOCATION_ON_HAND: 'location_on_hand' });
const COMPARATORS = Object.freeze({ BELOW: 'below', AT_OR_BELOW: 'at_or_below' });
const RELEASES = Object.freeze({ ON_ORDER: 'on_order', STOCK_RECOVERED: 'stock_recovered', MANUAL: 'manual' });

/**
 * One source of truth for explaining a numeric guard to a person.
 *
 * The configured threshold and the lowest permitted balance are not always
 * the same number. "Below 8" permits 8; "at or below 8" permits no less than
 * 9. Keeping both names explicit prevents a proactive warning at 9 from
 * quietly relabelling the owner's configured limit as 9.
 */
function describeBoundary(rule) {
  const threshold = Number(rule.threshold);
  const inclusive = rule.comparator === COMPARATORS.AT_OR_BELOW;
  const lowestPermitted = threshold + (inclusive ? 1 : 0);
  return {
    configuredLimit: threshold,
    lowestPermitted,
    blockedWhen: inclusive ? `at or below ${threshold}` : `below ${threshold}`,
    permittedExplanation: inclusive
      ? `The lowest permitted balance is ${lowestPermitted}.`
      : `A balance of ${threshold} is allowed.`,
  };
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, skuId: row.sku_id, locationId: row.location_id,
    actionType: row.action_type, metric: row.metric, comparator: row.comparator,
    threshold: row.threshold, releaseCondition: row.release_condition,
    releaseThreshold: row.release_threshold, source: row.source, statedAs: row.stated_as,
    isActive: Boolean(row.is_active), createdByUserId: row.created_by_user_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function wholeNumber(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1000000) {
    throw new ValidationError(`${label} must be a whole number between 0 and 1,000,000.`);
  }
  return number;
}

function set(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_REPLENISHMENT, 'set stock-protection rules');
  const actionType = input.actionType || ACTIONS.ISSUE;
  const metric = input.locationId ? METRICS.LOCATION_ON_HAND : (input.metric || METRICS.NETWORK_ON_HAND);
  const comparator = input.comparator || COMPARATORS.BELOW;
  const releaseCondition = input.releaseCondition || RELEASES.STOCK_RECOVERED;
  if (!Object.values(ACTIONS).includes(actionType)) throw new ValidationError('That operation cannot currently be guarded.');
  if (!Object.values(METRICS).includes(metric)) throw new ValidationError('Choose a supported stock measurement.');
  if (!Object.values(COMPARATORS).includes(comparator)) throw new ValidationError('Choose whether the threshold means below or at-or-below.');
  if (!Object.values(RELEASES).includes(releaseCondition)) throw new ValidationError('Choose what releases the stock protection.');
  const threshold = wholeNumber(input.threshold, 'Stock-protection threshold');
  const releaseThreshold = releaseCondition === RELEASES.STOCK_RECOVERED
    ? wholeNumber(input.releaseThreshold == null ? threshold : input.releaseThreshold, 'Release threshold')
    : null;
  const sku = db.prepare('SELECT id FROM skus WHERE id = ? AND workspace_id = ? AND is_active = 1').get(input.skuId, ctx.workspaceId);
  if (!sku) throw new NotFoundError('That product variant is not in this inventory.');
  if (input.locationId) {
    const location = db.prepare('SELECT id FROM locations WHERE id = ? AND workspace_id = ? AND is_active = 1').get(input.locationId, ctx.workspaceId);
    if (!location) throw new NotFoundError('That location is not in this inventory.');
  }
  const existing = db.prepare(
    `SELECT * FROM operating_guards WHERE workspace_id = ? AND sku_id = ?
       AND IFNULL(location_id, '') = IFNULL(?, '') AND action_type = ? AND is_active = 1`
  ).get(ctx.workspaceId, input.skuId, input.locationId || null, actionType);
  const now = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE operating_guards SET metric = ?, comparator = ?, threshold = ?, release_condition = ?,
         release_threshold = ?, source = ?, stated_as = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`
    ).run(metric, comparator, threshold, releaseCondition, releaseThreshold, input.source || 'settings',
      input.statedAs || null, now, existing.id, ctx.workspaceId);
    return get(db, ctx.workspaceId, existing.id);
  }
  const id = newId('ogr');
  db.prepare(
    `INSERT INTO operating_guards
       (id, workspace_id, sku_id, location_id, action_type, metric, comparator, threshold,
        release_condition, release_threshold, source, stated_as, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.workspaceId, input.skuId, input.locationId || null, actionType, metric, comparator,
    threshold, releaseCondition, releaseThreshold, input.source || 'settings', input.statedAs || null,
    ctx.actorId, now, now);
  return get(db, ctx.workspaceId, id);
}

function get(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM operating_guards WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new NotFoundError('That stock-protection rule is not in this inventory.');
  return hydrate(row);
}

function list(db, workspaceId, { activeOnly = false, skuId = null } = {}) {
  const clauses = [];
  const params = [workspaceId];
  if (activeOnly) clauses.push('g.is_active = 1');
  if (skuId) { clauses.push('g.sku_id = ?'); params.push(skuId); }
  const where = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
  return db.prepare(
    `SELECT g.*, i.name AS item_name, s.variant_label, l.name AS location_name
       FROM operating_guards g JOIN skus s ON s.id = g.sku_id JOIN items i ON i.id = s.item_id
       LEFT JOIN locations l ON l.id = g.location_id
      WHERE g.workspace_id = ?${where} ORDER BY g.is_active DESC, g.updated_at DESC`
  ).all(...params).map((row) => ({ ...hydrate(row), itemName: row.item_name, variantLabel: row.variant_label, locationName: row.location_name }));
}

function disable(db, ctx, membership, id) {
  permissions.assertCan(membership, permissions.MANAGE_REPLENISHMENT, 'remove stock-protection rules');
  get(db, ctx.workspaceId, id);
  db.prepare('UPDATE operating_guards SET is_active = 0, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(nowIso(), id, ctx.workspaceId);
  return get(db, ctx.workspaceId, id);
}

function currentOnHand(db, workspaceId, skuId, locationId) {
  const row = locationId
    ? db.prepare('SELECT COALESCE(on_hand, 0) AS n FROM balances WHERE workspace_id = ? AND sku_id = ? AND location_id = ?').get(workspaceId, skuId, locationId)
    : db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ? AND sku_id = ?').get(workspaceId, skuId);
  return Number(row?.n || 0);
}

function placedOnOrder(db, workspaceId, skuId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(l.quantity_units - l.quantity_received_units), 0) AS n
       FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
      WHERE l.workspace_id = ? AND l.sku_id = ? AND po.status IN ('ORDERED','PARTIALLY_RECEIVED')
        AND l.quantity_units > l.quantity_received_units`
  ).get(workspaceId, skuId);
  return Number(row?.n || 0);
}

function compare(value, comparator, threshold) {
  return comparator === COMPARATORS.AT_OR_BELOW ? value <= threshold : value < threshold;
}

/** Return the first deterministic reason an issue is blocked, or null. */
function evaluateIssue(db, workspaceId, { skuId, locationId, quantity }) {
  const rules = list(db, workspaceId, { activeOnly: true, skuId })
    .filter((rule) => rule.actionType === ACTIONS.ISSUE && (!rule.locationId || rule.locationId === locationId));
  for (const rule of rules) {
    const scopeLocationId = rule.metric === METRICS.LOCATION_ON_HAND ? rule.locationId || locationId : null;
    const before = currentOnHand(db, workspaceId, skuId, scopeLocationId);
    const after = before - Number(quantity || 0);
    if (!compare(after, rule.comparator, rule.threshold)) continue;
    const onOrder = placedOnOrder(db, workspaceId, skuId);
    const released = rule.releaseCondition === RELEASES.ON_ORDER && onOrder > 0;
    if (released) continue;
    const scope = rule.locationName ? ` at ${rule.locationName}` : ' across this inventory';
    const boundary = describeBoundary(rule);
    const release = rule.releaseCondition === RELEASES.ON_ORDER
      ? 'Place a supplier order for this variant before recording another sale or issue.'
      : rule.releaseCondition === RELEASES.STOCK_RECOVERED
        ? `Receive enough stock to bring it back to at least ${rule.releaseThreshold}.`
        : 'An owner must remove or change this stock-protection rule.';
    return {
      rule,
      before,
      after,
      onOrder,
      message:
        `This would leave ${after} on hand${scope}. `
        + `The rule blocks any result ${boundary.blockedWhen}; its configured limit is ${boundary.configuredLimit}. `
        + `${boundary.permittedExplanation} ${release}`,
    };
  }
  return null;
}

function assertIssueAllowed(db, workspaceId, input) {
  const blocked = evaluateIssue(db, workspaceId, input);
  if (blocked) throw new InvariantError(blocked.message, 'operating_guard', blocked);
  return true;
}

module.exports = {
  ACTIONS,
  METRICS,
  COMPARATORS,
  RELEASES,
  describeBoundary,
  set,
  get,
  list,
  disable,
  evaluateIssue,
  assertIssueAllowed,
};
