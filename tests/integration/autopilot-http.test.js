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
const policyEngine = require('../../src/autopilot/policy-engine');
const preferences = require('../../src/autopilot/preferences');
const modes = require('../../src/autopilot/modes');
const runner = require('../../src/autopilot/runner');
const engine = require('../../src/domain/inventory-engine');
const reevaluate = require('../../src/attention/reevaluate');
const supplierService = require('../../src/purchasing/supplier-service');
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

  // Home answers three questions in order: how is the business doing, what
  // needs me, what has Foundry handled. It opens with a verdict a person could
  // say out loud rather than with stock counters.
  assert.match(page, /Good (morning|afternoon|evening), /, 'a briefing, addressed to somebody');
  assert.match(page, /thing needs you|Everything is under control/, 'and one plain verdict');
  assert.match(page, /Needs your attention/);
  assert.match(page, /Foundry handled/);
  // The handling lane appears when there is something in it. An empty one
  // saying "Nothing in progress. There is no routine work in progress." is
  // three sentences reporting that nothing happened.
  assert.doesNotMatch(page, /There is no routine work in progress/);
  // Counters are context underneath the answer, not the answer.
  assert.match(page, /Inventory pulse/);
  assert.ok(
    page.indexOf('Needs your attention') < page.indexOf('Inventory pulse'),
    'what needs a person comes before how much stock there is'
  );
  assert.match(page, /Tell Foundry when you sell something/);
  // "1 real check" and "Checked inventory after stock arrived" are Foundry's
  // own bookkeeping: a routine evaluation that changed nothing. Home says what
  // Foundry handled, and when it handled nothing it says so in a sentence
  // rather than listing its own checks. The evaluation is still recorded — the
  // history test below reads it straight off /autopilot/history.
  assert.match(page, /No new work found|Nothing yet today/);
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
  // Named in the words somebody new to inventory would use, and saying what
  // to do about it rather than which internal input is absent.
  assert.match(page, /Tell Foundry when you sell something/);
  assert.match(page, /not how fast they go/i);
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
  assert.match(page, /Essential Filter is out of stock/i);
  assert.match(page, /0 on hand/i);

  // The stockout is the only thing waiting. This inventory has a real sale
  // behind it — that is how the filter reached zero — so Foundry has already
  // been told what it sells and must not still be asking.
  assert.match(page, /1 thing needs you/i);
  assert.doesNotMatch(page, /Tell Foundry when you sell something/i);
  // "Foundry is still learning demand for 1 tracked variant" was true and
  // unreadable. The plain sentence stays on the page; the thresholds behind it
  // are one disclosure away rather than in the headline.
  assert.match(page, /Still learning what sells/i);
  assert.doesNotMatch(page, /tracked variant/i, 'not in Foundry\'s own vocabulary');
});

test('the settings page shows what Foundry may do and how you want it run', async () => {
  const env = setup();
  const agent = await ownerAgent(env);

  const response = await agent.get('/autopilot');
  const page = plain(response.text);

  assert.match(page, /Ask me first/, 'the safe default is stated on the page itself');
  assert.match(page, /Handle routine work/, 'bounded automatic work is stated on the page itself');
  assert.match(page, /Custom.*Advanced policies, preferences and hard limits/, 'power controls remain available');
  assert.match(page, /Nothing\. Foundry prepares work and waits for you on all of it\./);
  assert.match(page, /Tell Foundry what it may handle/, 'the plain-language route in');
  assert.match(page, /How you want this inventory run/);
  assert.match(page, /never works these out from watching you/);
  assert.match(page, /Days of stock to aim for/);
  assert.match(response.text, /<details class="card section advanced-settings" id="advanced-authority"\s*>/,
    'advanced controls are collapsed by default');

  modes.setMode(env.db, env.ctx, env.membership, 'OBSERVE');
  const watching = await agent.get('/autopilot');
  assert.match(watching.text, /<details class="card section advanced-settings" id="advanced-authority"\s*>/,
    'watch-only mode still requires an explicit Show click');

  const opened = await agent.get('/autopilot?advanced=1');
  assert.match(opened.text, /id="advanced-authority"\s+open>/,
    'an explicit advanced route opens the controls');
});

test('Handle routine work authorises a bounded transfer without opening Custom', async () => {
  const env = setup();
  const agent = await ownerAgent(env);

  assert.equal((await post(agent, '/autopilot/mode', { mode: 'POLICY_AUTOMATED' })).status, 303);
  const setupPage = await agent.get('/autopilot');
  const setupText = plain(setupPage.text);
  assert.match(setupText, /Foundry may automatically:/);
  assert.match(setupText, /Move stock between my locations/);
  assert.match(setupText, /Automatic transfers: never more than/);
  assert.match(setupText, /Start handling routine work/);
  assert.match(setupText, /Nothing is enabled yet/);
  assert.doesNotMatch(setupText, /Open Custom to set them/);
  assert.match(setupPage.text, /id="advanced-authority"\s*>/,
    'Custom stays collapsed while the owner uses the simple setup');

  assert.equal((await post(agent, '/autopilot/routine-authority', {
    enableTransfers: '1',
    maximumQuantity: '5',
  })).status, 303);

  const active = policyService.activeFor(env.db, env.workspace.workspaceId, 'transfer');
  assert.equal(active.length, 1);
  assert.equal(active[0].maximumQuantity, 5);
  assert.equal(active[0].scope.managedBy, policyService.ROUTINE_SETUP);
  assert.equal(active[0].scope.capability, 'transfers');
  assert.deepEqual(new Set(active[0].locationScope), new Set([env.workspace.main.id, env.workspace.store.id]));
  assert.deepEqual(new Set(active[0].conditions), new Set([
    policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK,
    policyService.CONDITIONS.SOURCE_ABOVE_SAFETY,
    policyService.CONDITIONS.NO_CONFLICTING_TRANSFER,
    policyService.CONDITIONS.SUFFICIENT_HISTORY,
  ]));

  const conditions = Object.fromEntries(active[0].conditions.map((condition) => [condition, true]));
  const permitted = policyEngine.evaluate(env.db, env.workspace.workspaceId, {
    actionType: 'transfer',
    skuId: 'sku-guided-authority-test',
    quantity: 5,
    fromLocationId: env.workspace.main.id,
    toLocationId: env.workspace.store.id,
    conditions,
  });
  assert.equal(permitted.decision, 'authorized', 'the normal policy evaluator uses the guided policy');
  assert.equal(permitted.policy.id, active[0].id);

  const tooLarge = policyEngine.evaluate(env.db, env.workspace.workspaceId, {
    actionType: 'transfer',
    skuId: 'sku-guided-authority-test-2',
    quantity: 6,
    fromLocationId: env.workspace.main.id,
    toLocationId: env.workspace.store.id,
    conditions,
  });
  assert.equal(tooLarge.decision, 'refused');
  assert.match(tooLarge.reason, /at most 5 units/);

  const savedPage = await agent.get('/autopilot');
  const savedText = plain(savedPage.text);
  assert.match(savedText, /Currently approved: transfers of no more than 5 units at a time/);
  assert.match(savedText, /Everything outside these limits comes to you first/);
  assert.match(savedText, /Save routine-work limits/);
  assert.match(savedPage.text, /id="advanced-authority"\s*>/,
    'saving simple authority does not open Custom');
});

test('the guided routine setup versions changes and can remove its authority', async () => {
  const env = setup();
  const agent = await ownerAgent(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  await post(agent, '/autopilot/routine-authority', { enableTransfers: '1', maximumQuantity: '5' });
  const first = policyService.activeFor(env.db, env.workspace.workspaceId, 'transfer')[0];
  await post(agent, '/autopilot/routine-authority', { enableTransfers: '1', maximumQuantity: '3' });
  const second = policyService.activeFor(env.db, env.workspace.workspaceId, 'transfer')[0];
  assert.notEqual(second.id, first.id);
  assert.equal(second.version, first.version + 1);
  assert.equal(second.supersedesPolicyId, first.id);
  assert.equal(second.maximumQuantity, 3);
  assert.equal(policyService.get(env.db, env.workspace.workspaceId, first.id).isActive, false);

  await post(agent, '/autopilot/routine-authority', {});
  assert.equal(policyService.activeFor(env.db, env.workspace.workspaceId, 'transfer').length, 0);
  assert.match(plain((await agent.get('/autopilot')).text), /Nothing is enabled yet/);
});

test('guided purchasing requires an explicit limit and selected supplier in the shared policy engine', async () => {
  const env = setup();
  const supplier = supplierService.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Approved Supply Co',
    defaultLeadTimeDays: 7,
  });
  const agent = await ownerAgent(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  const page = plain((await agent.get('/autopilot')).text);
  assert.match(page, /Approve routine purchase orders/);
  assert.match(page, /does not email, upload or transmit the PO to the supplier/);
  assert.match(page, /Automatic purchases: never more than/);
  assert.match(page, /Approved Supply Co/);

  await post(agent, '/autopilot/routine-authority', {
    enablePurchasing: '1', maximumValue: '500', supplierScope: supplier.id,
  });
  const [policy] = policyService.activeFor(env.db, env.workspace.workspaceId, 'approve_purchase_order');
  assert.equal(policy.maximumValue, 500);
  assert.deepEqual(policy.supplierScope, [supplier.id]);
  assert.equal(policy.scope.managedBy, policyService.ROUTINE_SETUP);
  assert.deepEqual(new Set(policy.conditions), new Set([
    policyService.CONDITIONS.REPLENISHMENT_EVIDENCE,
    policyService.CONDITIONS.MOQ_ORDER_MULTIPLE_COMPLIANT,
    policyService.CONDITIONS.NO_DUPLICATE_INCOMING_DEMAND,
    policyService.CONDITIONS.PRICE_WITHIN_POLICY,
  ]));

  const saved = plain((await agent.get('/autopilot')).text);
  assert.match(saved, /purchase orders of no more than \$500 may be approved and recorded as ordered in Foundry for 1 selected supplier/);
  assert.match(saved, /Everything outside these limits comes to you first/);
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

test('a one-location inventory is not offered a policy that cannot fire', async () => {
  // Balancing moves stock between locations. Offering the form to somebody with
  // one location invites them to write a policy that can never do anything, and
  // then wonder why Foundry never acts.
  const env = setup();
  env.db
    .prepare('UPDATE locations SET is_active = 0 WHERE workspace_id = ? AND id != ?')
    .run(env.workspace.workspaceId, env.workspace.main.id);

  const agent = await ownerAgent(env);
  const page = plain((await agent.get('/autopilot')).text);

  assert.match(page, /only location in this inventory/);
  assert.match(page, /nothing to balance yet/);
  assert.doesNotMatch(page, /Write this policy/, 'the form is not offered');
  assert.match(page, /Add a location/, 'and the way forward is named');
});

test('with two locations the balancing policy is offered as normal', async () => {
  const env = setup();
  const agent = await ownerAgent(env);
  const page = plain((await agent.get('/autopilot')).text);

  assert.match(page, /Write this policy/);
  assert.doesNotMatch(page, /nothing to balance yet/);
});
