'use strict';

/**
 * Finishing setup with a real record.
 *
 * Somebody who described their product and listed its option values has already
 * done the data entry; asking them to repeat it is the setup failing to finish
 * its own sentence. So Foundry offers to create what they described.
 *
 * The line these tests defend is quantity. Foundry may create the *shape* of
 * what a customer described, because they described it. It must never write a
 * balance — what is physically on a shelf is a fact nobody has told it, and the
 * whole product rests on never guessing at those.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const firstItemService = require('../../src/foundry/first-item-service');
const itemService = require('../../src/domain/item-service');
const repo = require('../../src/domain/repository');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, csrfFrom, plain, signIn } = require('../helpers');

test.after(cleanupAll);

/** A configured workspace that described a product with two option axes. */
function described(db, workspace, {
  // Exactly what a real run returns: worked examples with the option values in
  // them, not the bare product. An optimistic fixture here once hid a bug that
  // would have created an item called "Baby headband - White, 0-6 month".
  examples = [
    'Baby headband - White, 0-6 months',
    'Baby headband - Blue, 6-12 months',
    'Baby headband - Purple, 12-24 months',
  ],
  usesVariants = true,
  dimensions = [
    { name: 'Size', exampleValues: ['0-6 months', '6-12 months', '12-24 months'] },
    { name: 'Colour', exampleValues: ['White', 'Red', 'Blue', 'Purple', 'Green'] },
  ],
} = {}) {
  db.prepare(
    `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
       operational_defaults, inventory_model, updated_at)
     VALUES (?, datetime('now'), 1, '{}', '{}', ?, datetime('now'))`
  ).run(
    workspace.workspaceId,
    JSON.stringify({ primaryArchetype: 'quantity', usesVariants, variantDimensions: dimensions })
  );

  db.prepare(
    `INSERT INTO foundry_understandings
       (id, workspace_id, source_description, payload, provider, model, confidence, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, 'test', 'test', 'medium', ?, datetime('now'))`
  ).run(
    'fu_test',
    workspace.workspaceId,
    'i wholesale baby headbands',
    JSON.stringify({ inventoryExamples: examples }),
    workspace.ctx.actorId
  );
  db.prepare(
    `INSERT INTO foundry_plans
       (id, workspace_id, understanding_id, kind, status, configuration_version, payload,
        integrity_hash, applied_summary, actor_user_id, created_at, applied_at)
     VALUES (?, ?, 'fu_test', 'initial', 'applied', 1, ?, 'hash', '{}', ?, datetime('now'), datetime('now'))`
  ).run(
    'plan_test',
    workspace.workspaceId,
    JSON.stringify({
      configurationVersion: 1,
      inventoryModel: { primaryArchetype: 'quantity', usesVariants },
      variantDimensions: dimensions,
      locations: [],
      terminology: {},
      operationalDefaults: { adjustmentsRequireReason: true, allowNegativeStock: false, transfersEnabled: true },
      serialRules: { enabled: false },
      lotRules: { enabled: false },
      expirationRules: { enabled: false },
      trackingModes: ['quantity'],
    }),
    workspace.ctx.actorId
  );

}

function setup(options) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Headbands Co' });
  described(store.db, workspace, options);
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'first-item' });
  return { db: store.db, workspace, ctx: workspace.ctx, app };
}

// --- what it offers ----------------------------------------------------------

test('what was described becomes an offer, with every combination counted', () => {
  const env = setup();
  const suggestion = firstItemService.suggest(env.db, env.workspace.workspaceId);

  assert.equal(suggestion.name, 'Baby headband');
  assert.equal(suggestion.hasVariants, true);
  assert.equal(suggestion.combinations, 15, 'three sizes by five colours');
  assert.deepEqual(suggestion.options.map((o) => o.name), ['Size', 'Colour']);
  assert.equal(suggestion.trackingMode, 'quantity');
});

test('an inventory that already has something in it is not offered a first item', () => {
  const env = setup();
  itemService.createItem(env.db, env.ctx, { name: 'Something', trackingMode: 'quantity' });

  assert.equal(firstItemService.suggest(env.db, env.workspace.workspaceId), null);
});

test('a business that named no product gets no offer', () => {
  const env = setup({ examples: [] });
  assert.equal(firstItemService.suggest(env.db, env.workspace.workspaceId), null);
});

test('variants configured without any values named produce no offer', () => {
  // Rather than inventing option values to fill the gap.
  const env = setup({ dimensions: [{ name: 'Size', exampleValues: [] }] });
  assert.equal(firstItemService.suggest(env.db, env.workspace.workspaceId), null);
});

test('a business with no option axes is offered the plain product', () => {
  const env = setup({ usesVariants: false, dimensions: [] });
  const suggestion = firstItemService.suggest(env.db, env.workspace.workspaceId);

  assert.equal(suggestion.hasVariants, false);
  assert.equal(suggestion.combinations, 1);
  assert.deepEqual(suggestion.options, []);
});

// --- what it creates ---------------------------------------------------------

test('accepting the offer creates the combinations and no stock whatsoever', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get('/foundry/ready/plan_test');
  assert.match(plain(page.text), /Shall I create it\?/);
  assert.match(plain(page.text), /all 15 combinations/);

  const res = await agent
    .post('/foundry/first-item')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), name: 'Baby headband' });
  assert.equal(res.status, 303);

  const [item] = env.db.prepare('SELECT * FROM items WHERE workspace_id = ?').all(env.workspace.workspaceId);
  assert.equal(item.name, 'Baby headband');
  assert.equal(repo.listSkusForItem(env.db, env.workspace.workspaceId, item.id).length, 15);

  // The whole point: shape yes, quantity never.
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(env.workspace.workspaceId).n,
    0,
    'Foundry has not been told what is on the shelf and must not invent it'
  );
  const balances = env.db
    .prepare('SELECT COALESCE(SUM(on_hand), 0) AS total FROM balances WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).total;
  assert.equal(balances, 0);
});

test('the name can be changed before accepting', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get('/foundry/ready/plan_test');
  await agent
    .post('/foundry/first-item')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), name: 'Infant Headband' });

  const [item] = env.db.prepare('SELECT name FROM items WHERE workspace_id = ?').all(env.workspace.workspaceId);
  assert.equal(item.name, 'Infant Headband');

  // And the confirmation says which item, rather than "Created undefined".
  const after = plain((await agent.get('/inventory')).text);
  assert.match(after, /Infant Headband/);
});

test('accepting twice does not create it twice', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get('/foundry/ready/plan_test');
  const token = csrfFrom(page.text);
  await agent.post('/foundry/first-item').type('form').send({ _csrf: token, name: 'Baby headband' });
  await agent.post('/foundry/first-item').type('form').send({ _csrf: token, name: 'Baby headband' });

  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n,
    1,
    'the offer is gone once the inventory has something in it'
  );
});

test('the offer disappears once it has been taken', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get('/foundry/ready/plan_test');
  await agent
    .post('/foundry/first-item')
    .type('form')
    .send({ _csrf: csrfFrom(page.text), name: 'Baby headband' });

  const after = plain((await agent.get('/foundry/ready/plan_test')).text);
  assert.doesNotMatch(after, /Shall I create it\?/);
  assert.match(after, /Add my first/, 'the ordinary route back is still there');
});
