'use strict';

/**
 * Multi-inventory tenancy.
 *
 * One account, several completely separate inventories. The property that
 * matters most here is negative: nothing measured, configured, detected or
 * recorded in one may ever be visible from another, and a workspace id from
 * outside must behave exactly like a record that does not exist.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const authService = require('../../src/domain/auth-service');
const workspaceService = require('../../src/domain/workspace-service');
const entitlements = require('../../src/entitlements/service');
const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const itemService = require('../../src/domain/item-service');
const locationService = require('../../src/domain/location-service');
const searchService = require('../../src/domain/search-service');
const activityService = require('../../src/domain/activity-service');
const inventoryQuery = require('../../src/domain/inventory-query');
const attention = require('../../src/attention/attention-engine');
const planApplier = require('../../src/foundry/plan-applier');
const queryService = require('../../src/attention/query-service');
const { makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace, makeQuantityItem } = require('../helpers');
const scenarios = require('../helpers/scenarios');

test.after(cleanupAll);

// --- creating and holding several -------------------------------------------

test('one account can create and hold several inventories', () => {
  const { db } = makeDatabase();
  const first = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const second = seedAnotherWorkspace(db, first.accountId, 'Equipment Company');
  const third = seedAnotherWorkspace(db, first.accountId, 'School Inventory');

  const mine = workspaceService.listForAccount(db, first.accountId);
  assert.deepEqual(
    mine.map((w) => w.name).sort(),
    ['Clothing Business', 'Equipment Company', 'School Inventory']
  );
  for (const workspace of mine) {
    assert.equal(workspace.role, 'owner');
    assert.equal(workspace.isOwner, true);
  }
  assert.notEqual(first.workspaceId, second.workspaceId);
  assert.notEqual(second.workspaceId, third.workspaceId);

  // Each is its own membership, so the ledger can name who acted in which.
  assert.notEqual(first.ctx.actorId, second.ctx.actorId);
});

test('a workspace is not a location: one holds many', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Equipment Company' });
  locationService.createLocation(db, workspace.ctx, { name: 'Service Center', kind: 'other' });

  const locations = repo.listLocations(db, workspace.workspaceId);
  assert.equal(locations.length, 3, 'the seeded two plus one more, all in one inventory');
  for (const location of locations) {
    assert.equal(location.workspace_id, workspace.workspaceId);
  }
});

// --- isolation ---------------------------------------------------------------

test('balances are completely independent between inventories', () => {
  const { db } = makeDatabase();
  const clothing = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const equipment = seedAnotherWorkspace(db, clothing.accountId, 'Equipment Company');

  const shirt = makeQuantityItem(db, clothing.ctx, { name: 'Oxford Shirt', baseCode: 'OS-1' });
  const drill = makeQuantityItem(db, equipment.ctx, { name: 'Core Drill', baseCode: 'CD-1' });

  engine.receive(db, clothing.ctx, { skuId: shirt.skuId, locationId: clothing.main.id, quantity: 120 });
  engine.receive(db, equipment.ctx, { skuId: drill.skuId, locationId: equipment.main.id, quantity: 7 });

  assert.equal(repo.getSkuTotal(db, clothing.workspaceId, shirt.skuId), 120);
  assert.equal(repo.getSkuTotal(db, equipment.workspaceId, drill.skuId), 7);

  // Neither total is reachable from the other inventory.
  assert.equal(repo.getSkuTotal(db, equipment.workspaceId, shirt.skuId), 0);
  assert.equal(repo.getSkuTotal(db, clothing.workspaceId, drill.skuId), 0);

  assert.equal(inventoryQuery.overview(db, clothing.workspaceId).unitsOnHand, 120);
  assert.equal(inventoryQuery.overview(db, equipment.workspaceId).unitsOnHand, 7);
  assert.equal(engine.verifyIntegrity(db, clothing.workspaceId).ok, true);
  assert.equal(engine.verifyIntegrity(db, equipment.workspaceId).ok, true);
});

test('items, locations, search and activity never cross', () => {
  const { db } = makeDatabase();
  const clothing = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const equipment = seedAnotherWorkspace(db, clothing.accountId, 'Equipment Company');

  const shirt = makeQuantityItem(db, clothing.ctx, { name: 'Oxford Shirt', baseCode: 'OS-1' });
  engine.receive(db, clothing.ctx, { skuId: shirt.skuId, locationId: clothing.main.id, quantity: 30 });
  locationService.createLocation(db, equipment.ctx, { name: 'Service Center', kind: 'other' });

  assert.equal(inventoryQuery.listItems(db, equipment.workspaceId).items.length, 0);
  assert.equal(inventoryQuery.listItems(db, clothing.workspaceId).items.length, 1);

  assert.equal(searchService.search(db, equipment.workspaceId, 'Oxford').results.length, 0);
  assert.ok(searchService.search(db, clothing.workspaceId, 'Oxford').results.length >= 1);

  assert.equal(activityService.listActivity(db, equipment.workspaceId, { limit: 20 }).groups.length, 0);
  assert.ok(activityService.listActivity(db, clothing.workspaceId, { limit: 20 }).groups.length >= 1);

  const clothingLocations = repo.listLocations(db, clothing.workspaceId).map((l) => l.name);
  assert.ok(!clothingLocations.includes('Service Center'), 'the other inventory\'s location is not here');
});

test('Foundry configuration is per inventory', () => {
  const { db } = makeDatabase();
  const clothing = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const equipment = seedAnotherWorkspace(db, clothing.accountId, 'Equipment Company');

  scenarios.configure(db, clothing.workspaceId, {
    terminology: { item: 'Style', variant: 'Color/Size' },
    inventoryModel: { primaryArchetype: 'quantity', usesVariants: true },
  });
  scenarios.configure(db, equipment.workspaceId, {
    terminology: { item: 'Machine' },
    inventoryModel: { primaryArchetype: 'serial', serialRules: { enabled: true } },
  });

  const a = planApplier.getConfiguration(db, clothing.workspaceId);
  const b = planApplier.getConfiguration(db, equipment.workspaceId);

  assert.equal(a.terminology.item, 'Style');
  assert.equal(b.terminology.item, 'Machine');
  assert.equal(a.inventoryModel.usesVariants, true);
  assert.equal(b.inventoryModel.primaryArchetype, 'serial');
  assert.notEqual(a.inventoryModel.primaryArchetype, b.inventoryModel.primaryArchetype);
});

test('attention items are detected and held per inventory', () => {
  const { db } = makeDatabase();
  const clothing = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const equipment = seedAnotherWorkspace(db, clothing.accountId, 'Equipment Company');

  scenarios.stockoutScenario(db, clothing);
  scenarios.configure(db, equipment.workspaceId);
  scenarios.healthyScenario(db, equipment);

  attention.evaluate(db, clothing.workspaceId, { trigger: 'test' });
  attention.evaluate(db, equipment.workspaceId, { trigger: 'test' });

  const clothingItems = attention.listAttention(db, clothing.workspaceId);
  const equipmentItems = attention.listAttention(db, equipment.workspaceId);

  assert.equal(clothingItems.length, 1);
  assert.equal(equipmentItems.length, 0, 'a healthy inventory is not given its neighbour\'s problems');
  assert.equal(clothingItems[0].workspaceId, clothing.workspaceId);

  // The other inventory cannot open it, even with the exact id.
  assert.equal(attention.getAttention(db, equipment.workspaceId, clothingItems[0].attentionId), null);
});

test('Ask Foundry only ever sees the inventory that asked', () => {
  const { db } = makeDatabase();
  const clothing = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const equipment = seedAnotherWorkspace(db, clothing.accountId, 'Equipment Company');

  const shirt = makeQuantityItem(db, clothing.ctx, { name: 'Oxford Shirt', baseCode: 'OS-1' });
  engine.receive(db, clothing.ctx, { skuId: shirt.skuId, locationId: clothing.main.id, quantity: 55 });

  const here = queryService.execute(db, clothing.workspaceId, { intent: 'stock_level', entityQuery: 'oxford shirt' });
  assert.equal(here.rows[0].onHand, 55);

  const there = queryService.execute(db, equipment.workspaceId, { intent: 'stock_level', entityQuery: 'oxford shirt' });
  assert.equal(there.rows.length, 0);
  assert.match(there.answer, /could not find/);
});

// --- membership and access ---------------------------------------------------

test('a person can belong to inventories they do not own', () => {
  const { db } = makeDatabase();
  const owner = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const guest = seedWorkspace(db, { workspaceName: 'Their Own Thing' });

  authService.createTeamMember(db, owner.ctx, { role: 'owner' }, {
    name: 'Visiting Vic',
    email: guest.account.email,
    role: 'staff',
  });

  const theirs = workspaceService.listForAccount(db, guest.accountId);
  assert.equal(theirs.length, 2);

  const shared = theirs.find((w) => w.workspaceId === owner.workspaceId);
  assert.equal(shared.role, 'staff', 'the role is per inventory');
  assert.equal(shared.isOwner, false);

  const own = theirs.find((w) => w.workspaceId === guest.workspaceId);
  assert.equal(own.role, 'owner', 'and unchanged in their own');
});

test('roles are per inventory, not per person', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const b = seedWorkspace(db, { workspaceName: 'Equipment Company' });

  authService.createTeamMember(db, b.ctx, { role: 'owner' }, {
    name: 'Olive Owner',
    email: a.account.email,
    role: 'staff',
  });

  const inA = authService.getMembership(db, a.workspaceId, a.accountId);
  const inB = authService.getMembership(db, b.workspaceId, a.accountId);
  assert.equal(inA.role, 'owner');
  assert.equal(inB.role, 'staff');

  assert.doesNotThrow(() => authService.requireOwner(inA));
  assert.throws(() => authService.requireOwner(inB), /Only an owner/);
});

test('an account cannot resolve an inventory it does not belong to', () => {
  const { db } = makeDatabase();
  const mine = seedWorkspace(db, { workspaceName: 'Mine' });
  const theirs = seedWorkspace(db, { workspaceName: 'Theirs' });

  assert.equal(workspaceService.resolveForAccount(db, mine.accountId, theirs.workspaceId), null);
  assert.ok(workspaceService.resolveForAccount(db, mine.accountId, mine.workspaceId));

  // A fabricated id is the same answer as someone else's.
  assert.equal(workspaceService.resolveForAccount(db, mine.accountId, 'wsp_made_up'), null);
  assert.equal(workspaceService.resolveForAccount(db, mine.accountId, null), null);
});

test('a signed-in account is not an authorization for every inventory', () => {
  const { db } = makeDatabase();
  const mine = seedWorkspace(db, { workspaceName: 'Mine' });
  const theirs = seedWorkspace(db, { workspaceName: 'Theirs' });
  const item = makeQuantityItem(db, theirs.ctx, { name: 'Their Widget', baseCode: 'TW-1' });
  engine.receive(db, theirs.ctx, { skuId: item.skuId, locationId: theirs.main.id, quantity: 10 });

  // Their item id, read with my scope: not found, not "forbidden".
  assert.throws(() => repo.requireItem(db, mine.workspaceId, item.itemId), /not found|could not be found/i);
  assert.equal(repo.getSkuTotal(db, mine.workspaceId, item.skuId), 0);
  assert.equal(inventoryQuery.listItems(db, mine.workspaceId).items.length, 0);
});

test('leaving an inventory ends access without touching its records', () => {
  const { db } = makeDatabase();
  const owner = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const guest = seedWorkspace(db, { workspaceName: 'Their Own Thing' });
  authService.createTeamMember(db, owner.ctx, { role: 'owner' }, {
    name: 'Visiting Vic',
    email: guest.account.email,
    role: 'staff',
  });

  const item = makeQuantityItem(db, owner.ctx, { name: 'Oxford Shirt', baseCode: 'OS-1' });
  engine.receive(db, owner.ctx, { skuId: item.skuId, locationId: owner.main.id, quantity: 60 });

  workspaceService.leaveWorkspace(db, owner.workspaceId, guest.accountId);

  assert.equal(workspaceService.resolveForAccount(db, guest.accountId, owner.workspaceId), null);
  assert.equal(workspaceService.listForAccount(db, guest.accountId).length, 1);
  // The inventory itself is untouched.
  assert.equal(repo.getSkuTotal(db, owner.workspaceId, item.skuId), 60);
  assert.equal(engine.verifyIntegrity(db, owner.workspaceId).ok, true);
});

test('the last owner cannot leave an inventory unreachable', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Only Mine' });
  assert.throws(
    () => workspaceService.leaveWorkspace(db, workspace.workspaceId, workspace.accountId),
    /only owner/i
  );
  assert.ok(workspaceService.resolveForAccount(db, workspace.accountId, workspace.workspaceId));
});

test('a membership that recorded movements is kept so the ledger still resolves', () => {
  const { db } = makeDatabase();
  const owner = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const guest = seedWorkspace(db, { workspaceName: 'Their Own Thing' });
  const member = authService.createTeamMember(db, owner.ctx, { role: 'owner' }, {
    name: 'Visiting Vic',
    email: guest.account.email,
    role: 'staff',
  });

  const item = makeQuantityItem(db, owner.ctx, { name: 'Oxford Shirt', baseCode: 'OS-1' });
  engine.receive(db, { workspaceId: owner.workspaceId, actorId: member.id }, {
    skuId: item.skuId,
    locationId: owner.main.id,
    quantity: 12,
  });

  const result = workspaceService.leaveWorkspace(db, owner.workspaceId, guest.accountId);
  assert.equal(result.retainedForLedger, true);

  // Access is gone…
  assert.equal(workspaceService.resolveForAccount(db, guest.accountId, owner.workspaceId), null);
  // …but the history still says who did it.
  const groups = activityService.listActivity(db, owner.workspaceId, { limit: 5 }).groups;
  assert.match(groups[0].actorName, /Visiting Vic/);
  assert.equal(engine.verifyIntegrity(db, owner.workspaceId).ok, true);
});

// --- entitlements ------------------------------------------------------------

test('the plan limits how many inventories an account may own', () => {
  const { db } = makeDatabase();
  const first = seedWorkspace(db, { workspaceName: 'One' });
  const limit = require('../../src/entitlements/plans').limitFor('free', 'workspaces');

  for (let i = 1; i < limit; i += 1) {
    seedAnotherWorkspace(db, first.accountId, `Number ${i + 1}`);
  }
  assert.equal(workspaceService.listForAccount(db, first.accountId).length, limit);

  assert.throws(
    () => workspaceService.createWorkspace(db, first.accountId, 'One Too Many'),
    (err) => err.code === 'limit_exceeded'
  );
  assert.equal(workspaceService.listForAccount(db, first.accountId).length, limit, 'nothing was written');
});

test('a larger plan lifts the limit without any call site changing', () => {
  const { db } = makeDatabase();
  const account = seedWorkspace(db, { workspaceName: 'One' });
  const limit = require('../../src/entitlements/plans').limitFor('free', 'workspaces');
  for (let i = 1; i < limit; i += 1) seedAnotherWorkspace(db, account.accountId, `Number ${i + 1}`);

  db.prepare("UPDATE accounts SET plan = 'unlimited' WHERE id = ?").run(account.accountId);
  assert.doesNotThrow(() => workspaceService.createWorkspace(db, account.accountId, 'One More'));
  assert.equal(workspaceService.listForAccount(db, account.accountId).length, limit + 1);
});

test('usage is reported per scope, and counts only what belongs there', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'A' });
  const b = seedAnotherWorkspace(db, a.accountId, 'B');
  makeQuantityItem(db, a.ctx, { name: 'Thing', baseCode: 'TH-1' });

  const scopeA = { accountId: a.accountId, workspaceId: a.workspaceId };
  const scopeB = { accountId: a.accountId, workspaceId: b.workspaceId };

  assert.equal(entitlements.usage(db, scopeA, 'workspaces').used, 2, 'inventories are counted per account');
  assert.equal(entitlements.usage(db, scopeA, 'skus').used, 1);
  assert.equal(entitlements.usage(db, scopeB, 'skus').used, 0, 'items are counted per inventory');
  assert.equal(entitlements.usage(db, scopeA, 'locations').used, 2);

  const summary = entitlements.summarise(db, scopeA);
  assert.equal(summary.plan.id, 'free');
  assert.ok(summary.limits.every((l) => typeof l.used === 'number'));
});

test('every declared limit has a way to be counted', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const { LIMITS } = require('../../src/entitlements/plans');
  const scope = { accountId: workspace.accountId, workspaceId: workspace.workspaceId };

  for (const limit of LIMITS) {
    const state = entitlements.usage(db, scope, limit.key);
    assert.equal(typeof state.used, 'number', `${limit.key} must report usage`);
    assert.ok(state.limit === null || typeof state.limit === 'number');
  }
});

// --- the engine still refuses to mix them ------------------------------------

test('an operation cannot use a location from another inventory', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'A' });
  const b = seedAnotherWorkspace(db, a.accountId, 'B');
  const item = makeQuantityItem(db, a.ctx, { name: 'Thing', baseCode: 'TH-1' });

  assert.throws(
    () => engine.receive(db, a.ctx, { skuId: item.skuId, locationId: b.main.id, quantity: 5 }),
    /not found|could not be found/i
  );
  assert.equal(repo.getSkuTotal(db, a.workspaceId, item.skuId), 0);
});

test('an operation cannot use a SKU from another inventory', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'A' });
  const b = seedAnotherWorkspace(db, a.accountId, 'B');
  const item = makeQuantityItem(db, b.ctx, { name: 'Theirs', baseCode: 'TH-2' });

  assert.throws(
    () => engine.receive(db, a.ctx, { skuId: item.skuId, locationId: a.main.id, quantity: 5 }),
    /not found|could not be found/i
  );
  assert.equal(repo.getSkuTotal(db, b.workspaceId, item.skuId), 0);
});

test('two inventories can hold the same item code without colliding', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'A' });
  const b = seedAnotherWorkspace(db, a.accountId, 'B');

  const inA = itemService.createItem(db, a.ctx, { name: 'Widget', baseCode: 'W-1', trackingMode: 'quantity' });
  const inB = itemService.createItem(db, b.ctx, { name: 'Widget', baseCode: 'W-1', trackingMode: 'quantity' });

  assert.notEqual(inA.itemId, inB.itemId);
  assert.equal(inventoryQuery.listItems(db, a.workspaceId).items.length, 1);
  assert.equal(inventoryQuery.listItems(db, b.workspaceId).items.length, 1);
});
