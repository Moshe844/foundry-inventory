'use strict';

/**
 * Deleting an inventory.
 *
 * The dangerous parts of this are not "does the row go away". They are:
 * everything scoped to it goes with it, nothing belonging to another inventory
 * is touched, the ledger's immutability guard is back in place afterwards, and
 * it cannot happen by accident or by someone without the standing to do it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const deletion = require('../../src/domain/workspace-deletion');
const workspaceService = require('../../src/domain/workspace-service');
const authService = require('../../src/domain/auth-service');
const engine = require('../../src/domain/inventory-engine');
const itemService = require('../../src/domain/item-service');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const entitlements = require('../../src/entitlements/service');
const { createApp } = require('../../src/app');
const {
  makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace, makeQuantityItem, csrfFrom, plain, signIn,
} = require('../helpers');

test.after(cleanupAll);

/** An inventory with something in every layer Foundry has built so far. */
function furnish(db, workspace) {
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx);
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 40 });
  engine.issue(db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 5, reasonCode: 'sold',
  });

  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, {
    name: 'ABC Footwear', defaultLeadTimeDays: 21,
  });
  suppliers.linkItem(db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: item.skuId, purchaseUnit: 'case', unitsPerPurchaseUnit: 12, lastUnitCost: 8.2,
  });
  const order = poService.createOrder(db, workspace.ctx, membership, {
    supplierId: supplier.id,
    destinationLocationId: workspace.main.id,
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 2 }],
  });
  poService.approve(db, workspace.ctx, membership, order.id);

  return { membership, item, supplier, order };
}

const rowsFor = (db, workspaceId) => {
  const counts = {};
  for (const table of deletion.scopedTables(db)) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(workspaceId).n;
  }
  return counts;
};

// --- the service -------------------------------------------------------------

test('the delete order is derived from the schema, children before parents', () => {
  const { db } = makeDatabase();
  const order = deletion.deletionOrder(db, deletion.scopedTables(db));

  // Every table appears exactly once…
  assert.equal(new Set(order).size, order.length);
  assert.equal(order.length, deletion.scopedTables(db).length);

  // …and anything holding a RESTRICT reference is emptied before its target.
  const at = (table) => order.indexOf(table);
  assert.ok(at('movements') < at('users'), 'movements point at the membership that made them');
  assert.ok(at('movements') < at('locations'));
  assert.ok(at('purchase_orders') < at('users'));
  assert.ok(at('purchase_orders') < at('suppliers'));
  assert.ok(at('purchase_order_lines') < at('skus'));
  assert.ok(at('skus') < at('items'));
});

test('deleting an inventory removes everything scoped to it', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Doomed Trading' });
  furnish(db, workspace);

  const before = rowsFor(db, workspace.workspaceId);
  assert.ok(before.movements > 0 && before.purchase_orders > 0 && before.items > 0);

  const summary = deletion.deleteWorkspace(db, workspace.accountId, workspace.workspaceId, {
    confirmName: 'Doomed Trading',
  });

  assert.equal(summary.name, 'Doomed Trading');
  assert.equal(summary.items, before.items);
  assert.equal(summary.movements, before.movements);

  const after = rowsFor(db, workspace.workspaceId);
  for (const [table, count] of Object.entries(after)) {
    assert.equal(count, 0, `${table} still has ${count} row(s)`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?').get(workspace.workspaceId).n, 0);
});

test('the ledger guard is back in place afterwards', () => {
  const { db } = makeDatabase();
  const doomed = seedWorkspace(db, { workspaceName: 'Doomed Trading' });
  furnish(db, doomed);

  const survivor = seedAnotherWorkspace(db, doomed.accountId, 'Still Trading');
  const item = makeQuantityItem(db, survivor.ctx);
  engine.receive(db, survivor.ctx, { skuId: item.skuId, locationId: survivor.main.id, quantity: 10 });

  deletion.deleteWorkspace(db, doomed.accountId, doomed.workspaceId, { confirmName: 'Doomed Trading' });

  // The trigger that makes movements immutable must survive the one operation
  // allowed to bypass it, or the whole Mission 1 guarantee quietly evaporates.
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'movements_no_delete'").get(),
    'the immutability trigger was not restored'
  );
  assert.throws(
    () => db.prepare('DELETE FROM movements WHERE workspace_id = ?').run(survivor.workspaceId),
    /movements are immutable/
  );
});

test('another inventory is left completely untouched', () => {
  const { db } = makeDatabase();
  const doomed = seedWorkspace(db, { workspaceName: 'Doomed Trading' });
  furnish(db, doomed);

  const survivor = seedAnotherWorkspace(db, doomed.accountId, 'Still Trading');
  const kept = furnish(db, { ...survivor, accountId: doomed.accountId });
  const before = rowsFor(db, survivor.workspaceId);

  deletion.deleteWorkspace(db, doomed.accountId, doomed.workspaceId, { confirmName: 'Doomed Trading' });

  assert.deepEqual(rowsFor(db, survivor.workspaceId), before);
  assert.equal(engine.verifyIntegrity(db, survivor.workspaceId).ok, true);
  assert.ok(poService.get(db, survivor.workspaceId, kept.order.id));
});

test('a mistyped name deletes nothing', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Doomed Trading' });
  furnish(db, workspace);

  assert.throws(
    () => deletion.deleteWorkspace(db, workspace.accountId, workspace.workspaceId, { confirmName: 'Doomed' }),
    /Type the inventory's name exactly/
  );
  assert.throws(
    () => deletion.deleteWorkspace(db, workspace.accountId, workspace.workspaceId, { confirmName: '' }),
    /Type the inventory's name exactly/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?').get(workspace.workspaceId).n, 1);
  assert.ok(rowsFor(db, workspace.workspaceId).movements > 0);

  // Case and surrounding space are not the point of the check.
  assert.doesNotThrow(() =>
    deletion.deleteWorkspace(db, workspace.accountId, workspace.workspaceId, { confirmName: '  doomed trading ' })
  );
});

test('only an owner can delete, and only their own inventory', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Doomed Trading' });
  furnish(db, workspace);

  const staffAccount = db
    .prepare('SELECT account_id FROM users WHERE id = ?')
    .get(workspace.staffId).account_id;
  assert.throws(
    () => deletion.deleteWorkspace(db, staffAccount, workspace.workspaceId, { confirmName: 'Doomed Trading' }),
    /Only an owner can delete/
  );

  // Someone with no membership at all is told it does not exist, not that they
  // lack permission — an outsider learns nothing about what does exist.
  const outsider = authService.registerAccount(db, {
    workspaceName: 'Elsewhere', name: 'Ida', email: 'ida-delete@example.test', password: 'password123',
  });
  assert.throws(
    () => deletion.deleteWorkspace(db, outsider.accountId, workspace.workspaceId, { confirmName: 'Doomed Trading' }),
    /could not be found/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?').get(workspace.workspaceId).n, 1);
});

test('deleting frees the plan allowance it was using', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Doomed Trading' });
  seedAnotherWorkspace(db, workspace.accountId, 'Second');

  const before = entitlements.usage(db, { accountId: workspace.accountId }, 'workspaces');
  deletion.deleteWorkspace(db, workspace.accountId, workspace.workspaceId, { confirmName: 'Doomed Trading' });
  const after = entitlements.usage(db, { accountId: workspace.accountId }, 'workspaces');

  assert.equal(after.used, before.used - 1);
});

// --- over HTTP ---------------------------------------------------------------

function app() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Doomed Trading' });
  furnish(store.db, workspace);
  const second = seedAnotherWorkspace(store.db, workspace.accountId, 'Still Trading');
  return {
    ...store,
    workspace,
    second,
    app: createApp({ db: store.db, env: 'test', sessionSecret: 'deletion-test' }),
  };
}

test('the confirmation screen says exactly what will be lost', async () => {
  const env = app();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email);

  const page = await agent.get(`/inventories/${env.workspace.workspaceId}/delete`);
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, /Delete Doomed Trading/);
  assert.match(text, /What will be destroyed/);
  assert.match(text, /Movements in the ledger/);
  assert.match(text, /Type Doomed Trading to confirm/);
  // An open purchase order is called out, because it is not Foundry's to cancel.
  assert.match(text, /does not cancel anything with your suppliers/);
});

test('deleting over HTTP removes it and moves you to another inventory', async () => {
  const env = app();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email);

  const page = await agent.get(`/inventories/${env.workspace.workspaceId}/delete`);
  const done = await agent
    .post(`/inventories/${env.workspace.workspaceId}/delete`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), confirmName: 'Doomed Trading' });

  assert.equal(done.status, 303);
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?').get(env.workspace.workspaceId).n,
    0
  );

  // The app still works, on the inventory that is left.
  const listPage = await agent.get('/inventories');
  const list = plain(listPage.text);
  assert.match(list, /Still Trading/);
  // Its name survives only in the message confirming it went.
  assert.match(list, /Doomed Trading was deleted/);
  assert.ok(!listPage.text.includes(env.workspace.workspaceId), 'the deleted inventory is still listed');
  assert.equal((await agent.get('/')).status, 200);
});

test('a wrong name comes back to the same screen, having deleted nothing', async () => {
  const env = app();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email);

  const page = await agent.get(`/inventories/${env.workspace.workspaceId}/delete`);
  const refused = await agent
    .post(`/inventories/${env.workspace.workspaceId}/delete`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), confirmName: 'wrong name' });

  assert.equal(refused.status, 400);
  assert.match(plain(refused.text), /Type the inventory's name exactly/);
  assert.match(plain(refused.text), /What will be destroyed/);
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?').get(env.workspace.workspaceId).n,
    1
  );
});

test('a member who is not an owner is not offered it and cannot reach it', async () => {
  const env = app();
  const staffEmail = env.workspace.staffEmail;
  const agent = request.agent(env.app);
  await signIn(agent, staffEmail);

  const list = plain((await agent.get('/inventories')).text);
  assert.doesNotMatch(list, /Delete/);

  const page = await agent.get(`/inventories/${env.workspace.workspaceId}/delete`);
  assert.equal(page.status, 303);

  const token = csrfFrom((await agent.get('/inventories')).text);
  const attempt = await agent
    .post(`/inventories/${env.workspace.workspaceId}/delete`)
    .type('form')
    .send({ _csrf: token, confirmName: 'Doomed Trading' });
  assert.equal(attempt.status, 303);
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?').get(env.workspace.workspaceId).n,
    1
  );
});

test("another account's inventory cannot be deleted, or even seen", async () => {
  const env = app();
  authService.registerAccount(env.db, {
    workspaceName: 'Elsewhere', name: 'Ida', email: 'ida-http-delete@example.test', password: 'password123',
  });
  const outsider = request.agent(env.app);
  await signIn(outsider, 'ida-http-delete@example.test');

  const page = await outsider.get(`/inventories/${env.workspace.workspaceId}/delete`);
  assert.equal(page.status, 303);

  const token = csrfFrom((await outsider.get('/inventories')).text);
  const attempt = await outsider
    .post(`/inventories/${env.workspace.workspaceId}/delete`)
    .type('form')
    .send({ _csrf: token, confirmName: 'Doomed Trading' });
  assert.equal(attempt.status, 303);
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?').get(env.workspace.workspaceId).n,
    1
  );
});

test('deleting your only inventory leaves the app usable', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Only One' });
  furnish(store.db, workspace);
  const application = createApp({ db: store.db, env: 'test', sessionSecret: 'deletion-last-test' });

  const agent = request.agent(application);
  await signIn(agent, workspace.account.email);

  const page = await agent.get(`/inventories/${workspace.workspaceId}/delete`);
  assert.match(plain(page.text), /This is your only inventory/);

  const done = await agent
    .post(`/inventories/${workspace.workspaceId}/delete`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), confirmName: 'Only One' });
  assert.equal(done.status, 303);

  // No workspace left: the app sends them to the list, which offers a new one.
  const list = await agent.get('/inventories');
  assert.equal(list.status, 200);
  assert.match(plain(list.text), /New inventory/);
  const console_ = await agent.get('/');
  assert.ok([200, 302, 303].includes(console_.status), `landing page returned ${console_.status}`);
});
