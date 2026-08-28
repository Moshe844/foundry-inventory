'use strict';

/**
 * Deterministic authority fixture built through the real inventory engine.
 *
 * Four sales are spread across 28 days. The destination therefore clears the
 * production evidence floor (7 observed days, 2 outbound observations and 3
 * units leaving) without changing that floor for QA. A stated 18-day target
 * and 10-day risk threshold let callers choose whether the real evaluator
 * recommends exactly five units or a larger, known quantity.
 */

const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const preferences = require('../../src/autopilot/preferences');
const policyService = require('../../src/autopilot/policy-service');
const { seedWorkspace } = require('../helpers');

const DAY = 24 * 60 * 60 * 1000;
const ISSUES = [[4, 28], [4, 20], [3, 12], [3, 4]];
const ISSUED_TOTAL = ISSUES.reduce((sum, row) => sum + row[0], 0);
const EVALUATED_TARGET = 9;

function seedAuthorityWorkspace(db, { requiredQuantity = 5, workspaceName = 'Authority QA' } = {}) {
  if (!Number.isInteger(requiredQuantity) || requiredQuantity < 2 || requiredQuantity >= EVALUATED_TARGET) {
    throw new Error('requiredQuantity must be an integer from 2 through 8 for this fixture.');
  }

  const workspace = seedWorkspace(db, { workspaceName });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const created = itemService.createItem(db, workspace.ctx, {
    name: 'Dated Demand Fixture',
    baseCode: `DDF-${requiredQuantity}`,
    trackingMode: 'quantity',
  });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, created.itemId)[0];
  const destinationFinal = EVALUATED_TARGET - requiredQuantity;

  inventory.receive(db, workspace.ctx, {
    skuId: sku.id,
    locationId: workspace.main.id,
    quantity: ISSUED_TOTAL + destinationFinal,
  });
  inventory.receive(db, workspace.ctx, {
    skuId: sku.id,
    locationId: workspace.store.id,
    quantity: 60,
  });

  const now = Date.now();
  db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  const backdate = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
  for (const [quantity, daysAgo] of ISSUES) {
    const result = inventory.issue(db, workspace.ctx, {
      skuId: sku.id,
      locationId: workspace.main.id,
      quantity,
      reasonCode: 'sold',
    });
    const occurredAt = new Date(now - daysAgo * DAY).toISOString();
    for (const movementId of result.movementIds) backdate.run(occurredAt, movementId);
  }
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
     BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
  );

  preferences.set(db, workspace.ctx, membership, {
    key: preferences.KEYS.RISK_DAYS.key,
    value: 10,
    source: 'configuration',
    statedAs: 'Treat a location as at risk below 10 days of cover.',
  });
  preferences.set(db, workspace.ctx, membership, {
    key: preferences.KEYS.TARGET_DAYS_OF_STOCK.key,
    value: 18,
    source: 'configuration',
    statedAs: 'Restore an at-risk location to 18 days of cover.',
  });

  return {
    db,
    workspace,
    membership,
    ctx: workspace.ctx,
    itemId: created.itemId,
    sku,
    source: workspace.store,
    destination: workspace.main,
    requiredQuantity,
    now,
  };
}

function approveTransferPolicy(env, { maximumQuantity = 5, name = 'Approved transfer boundary' } = {}) {
  const proposed = policyService.propose(env.db, env.ctx, env.membership, {
    name,
    description: 'Move stock only when dated location demand proves the need.',
    allowedActionTypes: ['transfer'],
    locationScope: [env.source.id, env.destination.id],
    conditions: [
      policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK,
      policyService.CONDITIONS.SOURCE_ABOVE_SAFETY,
      policyService.CONDITIONS.SUFFICIENT_HISTORY,
    ],
    maximumQuantity,
  });
  return policyService.approve(env.db, env.ctx, env.membership, proposed.id);
}

function balanceAt(env, locationId) {
  return repo.getBalance(env.db, env.workspace.workspaceId, env.sku.id, locationId);
}

module.exports = {
  seedAuthorityWorkspace,
  approveTransferPolicy,
  balanceAt,
  ISSUES,
  ISSUED_TOTAL,
};
