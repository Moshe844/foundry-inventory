'use strict';

/**
 * The autopilot pages over HTTP.
 *
 * These cover the screens where authority is handed over, which is the one part
 * of Foundry where a rendering mistake has consequences beyond a bad-looking
 * page: someone reading "12 units" and getting 20, or a settings form that
 * appears to save a preference and does not.
 *
 * Also the permission checks, taken straight at the URL rather than through the
 * disabled buttons, because a disabled button is a courtesy and not a control.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const authService = require('../../src/domain/auth-service');
const policyService = require('../../src/autopilot/policy-service');
const preferences = require('../../src/autopilot/preferences');
const modes = require('../../src/autopilot/modes');
const runner = require('../../src/autopilot/runner');
const engine = require('../../src/domain/inventory-engine');
const reevaluate = require('../../src/attention/reevaluate');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, csrfFrom, plain, signIn } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Autopilot Co' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'autopilot-http' });
  return { db: store.db, workspace, membership, ctx: workspace.ctx, app };
}

async function ownerAgent(env) {
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  return agent;
}

/** A form post from a page, carrying that page's CSRF token. */
async function post(agent, path, body, from = '/autopilot') {
  const page = await agent.get(from);
  return agent.post(path).type('form').send({ _csrf: csrfFrom(page.text), ...body });
}

test('the primary home is Foundry managing work, not an inventory dashboard', async () => {
  const env = setup();
  env.db.prepare(
    `INSERT INTO workspace_configuration
       (workspace_id, configured_at, configuration_version, terminology, operational_defaults, inventory_model, updated_at)
     VALUES (?, datetime('now'), 1, '{}', '{}', '{"primaryArchetype":"quantity"}', datetime('now'))`
  ).run(env.workspace.workspaceId);
  const item = makeQuantityItem(env.db, env.ctx);
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 20 });
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'receive' });

  const agent = await ownerAgent(env);
  const page = plain((await agent.get('/')).text);

  assert.match(page, /Foundry is managing Autopilot Co/);
  assert.match(page, /Ask Foundry anything/);
  assert.match(page, /Foundry needs you/);
  assert.match(page, /Foundry prepared this/);
  assert.match(page, /Foundry handled this/);
  assert.match(page, /Open the traditional overview/);
  assert.match(page, /Foundry cannot see stock leaving the business/);
  assert.match(page, /1 real check/);
  assert.match(page, /Checked inventory after stock arrived/);
});

test('Needs you exposes the missing operating input instead of silently showing an empty queue', async () => {
  const env = setup();
  env.db.prepare(
    `INSERT INTO workspace_configuration
       (workspace_id, configured_at, configuration_version, terminology, operational_defaults, inventory_model, updated_at)
     VALUES (?, datetime('now'), 1, '{}', '{}', '{"primaryArchetype":"quantity"}', datetime('now'))`
  ).run(env.workspace.workspaceId);
  const item = makeQuantityItem(env.db, env.ctx, { name: 'Filter' });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 20 });

  const agent = await ownerAgent(env);
  const page = plain((await agent.get('/needs-you')).text);
  assert.match(page, /Operating inputs/);
  assert.match(page, /Foundry cannot see stock leaving the business/);
  assert.match(page, /no live sales or warehouse feed/i);
  assert.match(page, /cannot silently observe another system or invent demand/i);
});

test('completed manager checks appear in durable history even when no action was supported', async () => {
  const env = setup();
  const item = makeQuantityItem(env.db, env.ctx, { name: 'Filter' });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 20 });
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'receive' });

  const agent = await ownerAgent(env);
  const page = plain((await agent.get('/autopilot/history')).text);
  assert.match(page, /Inventory checks/);
  assert.match(page, /Checked inventory after stock arrived/);
  assert.match(page, /1 position lacked enough outbound history for safe demand action/);
  assert.doesNotMatch(page, /Foundry has not had anything to do yet/);
});

test('an active product reaching zero appears automatically in Foundry needs you', async () => {
  const env = setup();
  env.db.prepare(
    `INSERT INTO workspace_configuration
       (workspace_id, configured_at, configuration_version, terminology, operational_defaults, inventory_model, updated_at)
     VALUES (?, datetime('now'), 1, '{}', '{}', '{"primaryArchetype":"quantity"}', datetime('now'))`
  ).run(env.workspace.workspaceId);
  const item = makeQuantityItem(env.db, env.ctx, { name: 'Essential Filter' });
  engine.receive(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 2 });
  engine.issue(env.db, env.ctx, { skuId: item.skuId, locationId: env.workspace.main.id, quantity: 2, reasonCode: 'sold' });
  reevaluate.refresh(env.db, env.workspace.workspaceId, 'test-stockout');

  const agent = await ownerAgent(env);
  const page = plain((await agent.get('/')).text);
  assert.match(page, /I need you for 2 things/i);
  assert.match(page, /Essential Filter is out of stock/i);
  assert.match(page, /0 on hand/i);
});

test('the settings page shows what Foundry may do and how you want it run', async () => {
  const env = setup();
  const agent = await ownerAgent(env);

  const page = plain((await agent.get('/autopilot')).text);

  assert.match(page, /Autopilot needs both/, 'the two gates are stated on the page itself');
  assert.match(page, /Nothing\. Foundry prepares work and waits for you on all of it\./);
  assert.match(page, /Tell Foundry what it may handle/, 'the plain-language route in');
  assert.match(page, /How you want this inventory run/);
  assert.match(page, /never works these out from watching you/);
  assert.match(page, /Days of stock to aim for/);
});

test('a preference set on the page is stored, attributed and applied', async () => {
  const env = setup();
  const agent = await ownerAgent(env);
  assert.equal((await post(agent, '/autopilot/preferences', {
    target_days_of_stock: '45',
    never_automate_serialized: 'true',
  })).status, 303);

  const stored = preferences.list(env.db, env.workspace.workspaceId);
  const target = stored.find((p) => p.key === 'target_days_of_stock');
  assert.equal(target.value, 45);
  assert.equal(target.source, 'configuration', 'set deliberately, on a settings page');
  assert.equal(target.setByName, env.membership.name);

  // And it actually reaches the planner rather than only the database.
  const applied = preferences.balanceSettings(env.db, env.workspace.workspaceId, {
    riskDays: 14, sourceSafetyDays: 30, targetDays: 30,
  });
  assert.equal(applied.targetDays, 45);
  assert.equal(applied.neverAutomateSerialized, true);

  const page = plain((await agent.get('/autopilot')).text);
  assert.match(page, /Keep about 45 days of stock on hand/);
});

test('clearing a preference hands the decision back to Foundry', async () => {
  const env = setup();
  const agent = await ownerAgent(env);
  preferences.set(env.db, env.ctx, env.membership, {
    key: preferences.KEYS.TARGET_DAYS_OF_STOCK.key, value: 45, source: 'configuration',
  });

  assert.equal((await post(agent, '/autopilot/preferences', { target_days_of_stock: '' })).status, 303);

  assert.deepEqual(preferences.all(env.db, env.workspace.workspaceId), {});
});

test('an impossible preference is refused with a reason, and nothing is stored', async () => {
  const env = setup();
  const agent = await ownerAgent(env);
  assert.equal((await post(agent, '/autopilot/preferences', { target_days_of_stock: '9000' })).status, 303);

  assert.deepEqual(preferences.all(env.db, env.workspace.workspaceId), {});
  const page = plain((await agent.get('/autopilot')).text);
  assert.match(page, /must be between 1 and 365/);
});

test('a written policy is shown as inert until somebody approves it', async () => {
  const env = setup();
  const agent = await ownerAgent(env);
  assert.equal((await post(agent, '/autopilot/policies', {
    name: 'Automatic warehouse balancing',
    maximumQuantity: '12',
    locationScope: [env.workspace.main.id, env.workspace.store.id],
  })).status, 303);

  const [policy] = policyService.list(env.db, env.workspace.workspaceId);
  assert.equal(policy.isApproved, false);
  assert.equal(policy.isActive, false);

  const page = plain((await agent.get(`/autopilot/policies/${policy.id}`)).text);
  assert.match(page, /waiting for your approval/);
  assert.match(page, /Never more than 12 units in one go/);
  assert.match(page, /Nothing happens under this policy until you approve it/);
});

test('a policy with no limit is refused rather than written', async () => {
  const env = setup();
  const agent = await ownerAgent(env);
  assert.equal((await post(agent, '/autopilot/policies', {
    name: 'Anything goes',
    locationScope: [env.workspace.main.id],
  })).status, 303);

  assert.equal(policyService.list(env.db, env.workspace.workspaceId).length, 0);
  const page = plain((await agent.get('/autopilot')).text);
  assert.match(page, /A policy without a limit is not a limit/);
});

test('someone who cannot change what Foundry does is stopped at the URL', async () => {
  const env = setup();
  authService.createTeamMember(env.db, env.ctx, env.membership, {
    name: 'Sam Reyes',
    email: 'sam@autopilot.test',
    password: 'autopilot-co-2026',
    role: 'staff',
  });

  const agent = request.agent(env.app);
  await signIn(agent, 'sam@autopilot.test', 'autopilot-co-2026');
  // Staff may not hand Foundry more authority, whatever the page rendered.
  await post(agent, '/autopilot/mode', { mode: 'POLICY_AUTOMATED' });
  assert.equal(modes.get(env.db, env.workspace.workspaceId).mode, 'SUPERVISED');

  await post(agent, '/autopilot/policies', { name: 'Sneaky', maximumQuantity: '5' });
  assert.equal(policyService.list(env.db, env.workspace.workspaceId).length, 0);
});

test('taking authority away is available to anyone who can operate the inventory', async () => {
  const env = setup();
  authService.createTeamMember(env.db, env.ctx, env.membership, {
    name: 'Sam Reyes',
    email: 'sam2@autopilot.test',
    password: 'autopilot-co-2026',
    role: 'staff',
  });
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  const agent = request.agent(env.app);
  await signIn(agent, 'sam2@autopilot.test', 'autopilot-co-2026');
  assert.equal((await post(agent, '/autopilot/pause', {})).status, 303);
  assert.equal(modes.get(env.db, env.workspace.workspaceId).paused, true, 'stopping it is never the harder path');
});
