'use strict';

/**
 * What Foundry will say about demand, and when.
 *
 * The distinction that matters here is between having seen nothing leave and
 * having seen something leave but not enough to act on. They are different
 * facts, they call for different words, and only the first is a job for the
 * person. Reporting a real sale as "tell Foundry when you sell something" made
 * the system look broken to somebody who had just used it correctly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const readiness = require('../../src/manager/readiness');
const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const itemService = require('../../src/domain/item-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');
const scenarios = require('../helpers/scenarios');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  scenarios.configure(db, workspace.workspaceId);
  const item = itemService.createItem(db, workspace.ctx, {
    name: 'Cotton Tee', baseCode: 'CT-1', trackingMode: 'quantity',
  });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];
  // Opening stock, established well before anything is sold.
  scenarios.at(db, workspace.ctx, 30, 'receive', {
    skuId: sku.id, locationId: workspace.main.id, quantity: 200,
  });
  return { db, workspace, sku };
}

const outboundItem = (db, workspace) =>
  readiness.decisions(db, workspace.workspaceId).find((entry) => entry.id === 'outbound-source');

test('before anything is sold, Foundry says it has seen nothing leave and asks', () => {
  const { db, workspace } = setup();

  const state = readiness.assess(db, workspace.workspaceId);
  assert.equal(state.demandStage, 'none');
  assert.equal(state.observingCount, 0);
  assert.equal(state.canAssessDemand, false);
  assert.equal(state.positionsWithoutOutbound.length, 1);

  assert.ok(outboundItem(db, workspace), 'with no outbound at all this is a job for the person');
});

test('after the first real sale it is learning, and stops asking to be told', () => {
  const { db, workspace, sku } = setup();
  scenarios.at(db, workspace.ctx, 1, 'issue', {
    skuId: sku.id, locationId: workspace.main.id, quantity: 4, reasonCode: 'sold',
  });

  const state = readiness.assess(db, workspace.workspaceId);
  assert.equal(state.demandStage, 'learning', 'a real sale is evidence, even if it is not enough');
  assert.equal(state.observingCount, 1);
  assert.equal(state.positionsWithOutbound[0].issued, 4);
  assert.equal(state.positionsWithOutbound[0].ready, false);

  // The safety threshold is untouched: still not enough to act on.
  assert.equal(state.canAssessDemand, false);
  assert.equal(state.usageReady, 0);

  assert.equal(outboundItem(db, workspace), undefined, 'it has been told; it must stop asking');
  assert.ok(
    state.notes.some((note) => /not for long enough/i.test(note)),
    'the wording has to say "not enough yet", not "none at all"'
  );
});

test('with enough qualifying history Foundry can judge demand', () => {
  const { db, workspace, sku } = setup();
  for (const daysAgo of [21, 14, 7, 2]) {
    scenarios.at(db, workspace.ctx, daysAgo, 'issue', {
      skuId: sku.id, locationId: workspace.main.id, quantity: 6, reasonCode: 'sold',
    });
  }

  const state = readiness.assess(db, workspace.workspaceId);
  assert.equal(state.demandStage, 'ready');
  assert.equal(state.canAssessDemand, true);
  assert.equal(state.usageReady, 1);
  assert.equal(outboundItem(db, workspace), undefined);
});

test('one product selling does not vouch for another that has never moved', () => {
  const { db, workspace, sku } = setup();
  const second = itemService.createItem(db, workspace.ctx, {
    name: 'Wool Hat', baseCode: 'WH-1', trackingMode: 'quantity',
  });
  const quiet = repo.listSkusForItem(db, workspace.workspaceId, second.itemId)[0];
  engine.receive(db, workspace.ctx, { skuId: quiet.id, locationId: workspace.main.id, quantity: 20 });
  scenarios.at(db, workspace.ctx, 1, 'issue', {
    skuId: sku.id, locationId: workspace.main.id, quantity: 4, reasonCode: 'sold',
  });

  const state = readiness.assess(db, workspace.workspaceId);
  assert.equal(state.demandStage, 'learning');
  assert.deepEqual(state.positionsWithOutbound.map((p) => p.displayName), ['Cotton Tee']);
  assert.deepEqual(state.positionsWithoutOutbound.map((p) => p.displayName), ['Wool Hat']);
});
