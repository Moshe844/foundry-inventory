'use strict';

/**
 * Mission 7, item 26: operational memory that cannot learn.
 *
 * The requirement is unusual in that most of it is a prohibition. A preference
 * store is easy; a preference store that refuses to acquire preferences by
 * watching the customer is the actual work, and that is what these tests pin
 * down — every value traceable to a deliberate act, nothing accepted that
 * nothing reads, and no widening of authority.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const preferences = require('../../src/autopilot/preferences');
const planner = require('../../src/autopilot/planner');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Prefs Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, membership, ctx: workspace.ctx };
}

test('a preference has to come from something someone did', () => {
  const env = setup();

  assert.throws(
    () =>
      preferences.set(env.db, env.ctx, env.membership, {
        key: preferences.KEYS.TARGET_DAYS_OF_STOCK.key,
        value: 45,
        source: 'inferred',
      }),
    /has to come from something someone did/
  );

  assert.deepEqual(preferences.all(env.db, env.workspace.workspaceId), {});
});

test('a setting nothing reads is refused rather than stored', () => {
  const env = setup();
  assert.throws(
    () =>
      preferences.set(env.db, env.ctx, env.membership, {
        key: 'order_only_on_tuesdays',
        value: true,
        source: 'instruction',
      }),
    /does not have a setting for that/
  );
});

test('values outside their range are refused', () => {
  const env = setup();
  assert.throws(
    () =>
      preferences.set(env.db, env.ctx, env.membership, {
        key: preferences.KEYS.TARGET_DAYS_OF_STOCK.key,
        value: 5000,
        source: 'configuration',
      }),
    /between 1 and 365/
  );
});

test('what the customer actually said is kept, in their words', () => {
  const env = setup();
  preferences.set(env.db, env.ctx, env.membership, {
    key: preferences.KEYS.TARGET_DAYS_OF_STOCK.key,
    value: 45,
    source: 'instruction',
    statedAs: 'I like about six weeks of cover on the fast movers',
  });

  const [stored] = preferences.list(env.db, env.workspace.workspaceId);
  assert.equal(stored.value, 45);
  assert.equal(stored.source, 'instruction');
  assert.match(stored.statedAs, /six weeks/);
  assert.match(stored.description, /45 days/);
  assert.equal(stored.setByName, env.membership.name);
});

test('a stated preference changes what the planner aims for', () => {
  const env = setup();
  const DEFAULTS = { riskDays: 14, sourceSafetyDays: 30, targetDays: 30 };

  assert.deepEqual(
    preferences.balanceSettings(env.db, env.workspace.workspaceId, DEFAULTS),
    { ...DEFAULTS, neverAutomateSerialized: false },
    'with nothing set, Foundry uses its own numbers'
  );

  preferences.set(env.db, env.ctx, env.membership, {
    key: preferences.KEYS.TARGET_DAYS_OF_STOCK.key,
    value: 60,
    source: 'configuration',
  });
  preferences.set(env.db, env.ctx, env.membership, {
    key: preferences.KEYS.NEVER_AUTOMATE_SERIALIZED.key,
    value: true,
    source: 'instruction',
  });

  const applied = preferences.balanceSettings(env.db, env.workspace.workspaceId, DEFAULTS);
  assert.equal(applied.targetDays, 60);
  assert.equal(applied.neverAutomateSerialized, true);
  assert.equal(applied.riskDays, 14, 'what was not set is left alone');
});

test('a value stored before a limit changed cannot slip past it', () => {
  const env = setup();
  preferences.set(env.db, env.ctx, env.membership, {
    key: preferences.KEYS.TARGET_DAYS_OF_STOCK.key,
    value: 60,
    source: 'configuration',
  });
  // Something writes an impossible value directly — a bad migration, a hand-run
  // UPDATE. The reader must not trust it.
  env.db
    .prepare('UPDATE operational_preferences SET value = ? WHERE workspace_id = ? AND key = ?')
    .run(JSON.stringify(99999), env.workspace.workspaceId, preferences.KEYS.TARGET_DAYS_OF_STOCK.key);

  const applied = preferences.balanceSettings(env.db, env.workspace.workspaceId, { riskDays: 14, sourceSafetyDays: 30, targetDays: 30 });
  assert.equal(applied.targetDays, 30, 'out of range falls back rather than being obeyed');
});

test('a preference never grants Foundry anything new', () => {
  const env = setup();
  // Every key is a number or a yes/no about how work is sized — none of them
  // name an action, a location, or an amount Foundry may move unattended. That
  // is a policy's job, and this is the test that keeps the two apart.
  for (const definition of Object.values(preferences.KEYS)) {
    assert.ok(['number', 'boolean'].includes(definition.kind));
    assert.ok(
      !/allow|permit|authorise|authorize|automate_transfer/.test(definition.key),
      `${definition.key} sounds like permission, which belongs in a policy`
    );
  }
});

test('the planner says why it is leaving a product alone', () => {
  const env = setup();
  const reasons = [];
  const sku = {
    skuId: 'sku_1',
    itemId: 'itm_1',
    displayName: 'Brass Widget',
    measured: { issueEventsInWindow: 0, issuedInWindow: 0, windowDays: 30, observedDays: 30 },
    perLocation: [],
  };

  assert.equal(planner.planBalanceTransfer(env.db, env.workspace.workspaceId, sku, { reasons }), null);
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].reason, 'not_enough_history');
  assert.match(reasons[0].detail, /does not have enough history to automate this safely yet/);
});
