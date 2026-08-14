'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const request = require('supertest');

const { openDatabase } = require('../../src/db');
const { createApp } = require('../../src/app');
const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const activityService = require('../../src/domain/activity-service');
const searchService = require('../../src/domain/search-service');
const {
  makeDatabase,
  cleanupAll,
  seedWorkspace,
  makeQuantityItem,
  makeVariantItem,
  makeSerialItem,
  makeLotItem,
  lotsFor,
  unitsFor,
  signIn,
  plain,
} = require('../helpers');

test.after(cleanupAll);

/** Builds one of everything, then hands back the file path. */
function buildEverything() {
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);

  const elbow = makeQuantityItem(db, workspace.ctx, { name: 'Copper Elbow', baseCode: 'CE-100' });
  engine.receive(db, workspace.ctx, { skuId: elbow.skuId, locationId: workspace.main.id, quantity: 100 });
  engine.transfer(db, workspace.ctx, {
    skuId: elbow.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    quantity: 25,
  });
  engine.issue(db, workspace.ctx, { skuId: elbow.skuId, locationId: workspace.store.id, quantity: 5 });
  engine.adjust(db, workspace.ctx, {
    skuId: elbow.skuId,
    locationId: workspace.main.id,
    countedQty: 72,
    reasonCode: 'physical_count',
  });

  const sweater = makeVariantItem(db, workspace.ctx);
  engine.receive(db, workspace.ctx, { skuId: sweater.byLabel('Navy / 4').id, locationId: workspace.store.id, quantity: 12 });
  engine.receive(db, workspace.ctx, { skuId: sweater.byLabel('Cream / 4').id, locationId: workspace.store.id, quantity: 16 });

  const laptop = makeSerialItem(db, workspace.ctx, { name: 'Dell Latitude', baseCode: 'DL-5450' });
  engine.receive(db, workspace.ctx, {
    skuId: laptop.skuId,
    locationId: workspace.main.id,
    serials: [{ serial: 'DL-829193' }, { serial: 'DL-829194' }],
  });
  const units = unitsFor(db, workspace.workspaceId, laptop.skuId);
  engine.transfer(db, workspace.ctx, {
    skuId: laptop.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    serialUnitIds: [units[0].id],
  });

  const rations = makeLotItem(db, workspace.ctx, { name: 'Trail Ration Pack', baseCode: 'FOOD-200' });
  engine.receive(db, workspace.ctx, {
    skuId: rations.skuId,
    locationId: workspace.main.id,
    quantity: 84,
    lotCode: 'L240812',
    expiresAt: '2026-10-30',
  });
  engine.receive(db, workspace.ctx, {
    skuId: rations.skuId,
    locationId: workspace.main.id,
    quantity: 120,
    lotCode: 'L240902',
  });
  const lots = lotsFor(db, workspace.workspaceId, rations.skuId);
  engine.transfer(db, workspace.ctx, {
    skuId: rations.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    lotId: lots[0].id,
    quantity: 24,
  });

  const snapshot = {
    movements: db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspace.workspaceId).n,
    activity: activityService.countActivity(db, workspace.workspaceId, {}),
  };

  return { db, databasePath, workspace, elbow, sweater, laptop, rations, units, lots, snapshot };
}

test('everything survives closing and reopening the database', () => {
  const built = buildEverything();
  const { workspace, elbow, sweater, laptop, rations, units, lots, databasePath, snapshot } = built;

  built.db.close();
  assert.ok(fs.existsSync(databasePath), 'the database is a real file on disk');

  const db = openDatabase(databasePath);

  // Balances
  assert.equal(repo.getBalance(db, workspace.workspaceId, elbow.skuId, workspace.main.id), 72);
  assert.equal(repo.getBalance(db, workspace.workspaceId, elbow.skuId, workspace.store.id), 20);

  // Variants stay independent
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, sweater.byLabel('Navy / 4').id), 12);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, sweater.byLabel('Cream / 4').id), 16);
  assert.equal(repo.getSkuTotal(db, workspace.workspaceId, sweater.byLabel('Navy / 5').id), 0);

  // Serial units keep their identity and their location
  const reloadedUnits = unitsFor(db, workspace.workspaceId, laptop.skuId);
  assert.equal(reloadedUnits.length, 2);
  assert.equal(reloadedUnits.find((u) => u.serial === 'DL-829193').location_id, workspace.store.id);
  assert.equal(reloadedUnits.find((u) => u.serial === 'DL-829194').location_id, workspace.main.id);

  // Lots keep their quantities and expiry
  const reloadedLots = lotsFor(db, workspace.workspaceId, rations.skuId);
  assert.equal(reloadedLots.length, 2);
  assert.equal(reloadedLots[0].expires_at.slice(0, 10), '2026-10-30');
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, lots[0].id, workspace.main.id), 60);
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, lots[0].id, workspace.store.id), 24);
  assert.equal(repo.getLotBalance(db, workspace.workspaceId, lots[1].id, workspace.main.id), 120);

  // History, adjustments and locations
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspace.workspaceId).n, snapshot.movements);
  assert.equal(activityService.countActivity(db, workspace.workspaceId, {}), snapshot.activity);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adjustments WHERE workspace_id = ?').get(workspace.workspaceId).n, 1);
  assert.equal(repo.listLocations(db, workspace.workspaceId).length, 2);
  assert.equal(searchService.search(db, workspace.workspaceId, 'DL-829193').results.length, 1);

  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
  db.close();
});

test('a restarted application serves the same numbers to the browser', async () => {
  const built = buildEverything();
  const { workspace, elbow, databasePath } = built;

  const firstApp = createApp({ db: built.db, env: 'test', sessionSecret: 'persist-secret' });
  const firstAgent = request.agent(firstApp);
  await signIn(firstAgent, workspace.account.email, workspace.account.password);
  const before = plain((await firstAgent.get(`/inventory/${elbow.itemId}`)).text);
  assert.match(before, /72/);
  built.db.close();

  // Restart: brand new database handle and application on the same file.
  const db = openDatabase(databasePath);
  const secondApp = createApp({ db, env: 'test', sessionSecret: 'persist-secret' });
  const agent = request.agent(secondApp);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const item = plain((await agent.get(`/inventory/${elbow.itemId}`)).text);
  assert.match(item, /Copper Elbow/);
  assert.match(item, /Main Warehouse/);
  assert.match(item, /Adjusted Copper Elbow at Main Warehouse from 75 to 72\./);

  const overview = plain((await agent.get('/')).text);
  assert.match(overview, /Units on hand/);

  const activity = plain((await agent.get('/activity')).text);
  assert.match(activity, /Transferred 25 × Copper Elbow from Main Warehouse to Downtown Store\./);

  const search = await agent.get('/api/search?q=DL-8291').set('Accept', 'application/json');
  assert.equal(search.body.results.length, 2);

  db.close();
});

test('a signed-in session survives a restart', async () => {
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);
  const secret = 'shared-session-secret';

  // Sign in against the first "server", keeping the cookie the browser would.
  const firstApp = createApp({ db, env: 'test', sessionSecret: secret });
  const loginPage = await request(firstApp).get('/login');
  const setupCookie = loginPage.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  const token = loginPage.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const loggedIn = await request(firstApp)
    .post('/login')
    .set('Cookie', setupCookie)
    .type('form')
    .send({ _csrf: token, email: workspace.account.email, password: workspace.account.password, next: '/' });
  assert.equal(loggedIn.status, 302);
  const sessionCookie = (loggedIn.headers['set-cookie'] || [setupCookie])
    .map((c) => c.split(';')[0])
    .join('; ');

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n > 0,
    true,
    'the session lives in the database, not in memory'
  );

  // Restart: the process goes away, the database file stays.
  db.close();
  const reopened = openDatabase(databasePath);
  const secondApp = createApp({ db: reopened, env: 'test', sessionSecret: secret });

  const after = await request(secondApp).get('/').set('Cookie', sessionCookie);
  assert.equal(after.status, 200, 'the same cookie still authenticates after a restart');
  assert.match(plain(after.text), new RegExp(workspace.account.workspaceName));

  reopened.close();
});

test('writes made by another process are visible immediately', () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeQuantityItem(db, workspace.ctx);
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 10 });

  execFileSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'helpers', 'mutation-worker.js'),
      databasePath,
      JSON.stringify({
        operation: 'receive',
        workspaceId: workspace.workspaceId,
        actorId: workspace.ownerId,
        skuId: item.skuId,
        locationId: workspace.main.id,
        quantity: 5,
        iterations: 3,
      }),
    ],
    { encoding: 'utf8' }
  );

  assert.equal(repo.getBalance(db, workspace.workspaceId, item.skuId, workspace.main.id), 25);
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
  db.close();
});

/**
 * A database created before the attention layer gained its item/sku columns
 * must open, upgrade, and keep everything it already held. `CREATE TABLE IF NOT
 * EXISTS` will not add a column, so this is the case that proves the ALTER runs.
 */
test('an older database gains new columns without losing anything', () => {
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeQuantityItem(db, workspace.ctx);
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 40 });

  const attention = require('../../src/attention/attention-engine');
  attention.evaluate(db, workspace.workspaceId, { trigger: 'before' });

  // Wind the schema back to what shipped before this change.
  db.exec('DROP INDEX IF EXISTS idx_attention_item');
  db.exec('ALTER TABLE attention_items DROP COLUMN item_id');
  db.exec('ALTER TABLE attention_items DROP COLUMN sku_id');
  db.exec('DROP TABLE IF EXISTS attention_sweep_lease');
  db.prepare("UPDATE schema_meta SET value = '6' WHERE key = 'version'").run();
  db.close();

  const reopened = openDatabase(databasePath);
  const columns = reopened.prepare('PRAGMA table_info(attention_items)').all().map((c) => c.name);
  assert.ok(columns.includes('item_id'), 'the column was added on open');
  assert.ok(columns.includes('sku_id'));
  // Compared with what a brand-new database stamps rather than a literal, so a
  // later schema version does not need this test edited to keep passing — the
  // property being checked is that an upgraded database ends up identical to a
  // fresh one, not that the number is any particular value.
  const fresh = openDatabase(':memory:');
  const current = fresh.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get().value;
  fresh.close();
  assert.equal(reopened.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get().value, current);
  assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'attention_sweep_lease'").get());

  // Inventory truth survived untouched, and detection still works.
  assert.equal(repo.getBalance(reopened, workspace.workspaceId, item.skuId, workspace.main.id), 40);
  assert.equal(engine.verifyIntegrity(reopened, workspace.workspaceId).ok, true);
  assert.doesNotThrow(() => attention.evaluate(reopened, workspace.workspaceId, { trigger: 'after' }));

  // Opening twice more is a no-op, not a repeated ALTER.
  reopened.close();
  const again = openDatabase(databasePath);
  assert.equal(repo.getBalance(again, workspace.workspaceId, item.skuId, workspace.main.id), 40);
  again.close();
});

/**
 * The tenancy migration must reach every table, including ones added after it
 * was written. A hardcoded list of tables silently missed one and left a column
 * no query could find; this proves the discovery-based rename covers the lot.
 */
test('the workspace migration renames every tenancy column, whatever the table', () => {
  const { db, databasePath } = makeDatabase();
  const workspace = seedWorkspace(db);
  const item = makeQuantityItem(db, workspace.ctx);
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 30 });

  // Wind the whole database back to the pre-workspace shape.
  const scoped = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name)
    .filter((name) => db.prepare(`PRAGMA table_info(${name})`).all().some((c) => c.name === 'workspace_id'));
  assert.ok(scoped.length >= 15, `expected many scoped tables, saw ${scoped.length}`);

  db.pragma('foreign_keys = OFF');
  for (const name of scoped) db.exec(`ALTER TABLE ${name} RENAME COLUMN workspace_id TO org_id`);
  db.exec('ALTER TABLE workspaces RENAME TO organizations');
  db.exec('ALTER TABLE workspace_configuration RENAME TO org_configuration');
  db.pragma('foreign_keys = ON');
  db.close();

  const reopened = openDatabase(databasePath);
  const stale = reopened
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name)
    .filter((name) => reopened.prepare(`PRAGMA table_info(${name})`).all().some((c) => c.name === 'org_id'));

  assert.deepEqual(stale, [], 'no table may keep the old tenancy column');
  assert.ok(reopened.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workspaces'").get());
  assert.equal(repo.getBalance(reopened, workspace.workspaceId, item.skuId, workspace.main.id), 30);
  assert.equal(engine.verifyIntegrity(reopened, workspace.workspaceId).ok, true);

  // And every scoped table is queryable by the new name.
  for (const name of scoped) {
    assert.doesNotThrow(
      () => reopened.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE workspace_id = ?`).get(workspace.workspaceId),
      `${name} must be queryable by workspace_id`
    );
  }
  reopened.close();
});
