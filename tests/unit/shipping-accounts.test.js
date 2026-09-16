'use strict';

/*
 * Whose carrier account a parcel ships on.
 *
 * The first version read the key from the environment, which is right for one
 * shop on one machine and wrong the moment there are two: every merchant's
 * parcels would ship on the same account, every label would be billed to
 * whoever runs the server, and one merchant's webhook secret would verify
 * another's messages.
 *
 * These are the three claims that have to hold once a shipping account belongs
 * to a workspace: the key is theirs, it is not readable off the record, and one
 * workspace's key never reaches another's parcel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const accounts = require('../../src/shipping/accounts');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

/*
 * A developer's own .env is not part of the test.
 *
 * config.js loads .env at require time, so a machine that happens to hold a
 * real EASYPOST_API_KEY would fail every "nothing connected" assertion here —
 * and pass on a machine that did not, which is the kind of test that only ever
 * breaks for somebody else.
 */
function withoutServerKey(run) {
  const held = { ...process.env };
  for (const name of ['SHIPENGINE_API_KEY', 'SHIPENGINE_WEBHOOK_SECRET',
    'SHIPSTATION_API_KEY', 'SHIPSTATION_WEBHOOK_SECRET',
    'EASYPOST_API_KEY', 'EASYPOST_WEBHOOK_SECRET',
    'SHIPPO_API_KEY', 'SHIPPO_WEBHOOK_SECRET', 'SHIPPING_PROVIDER',
    'SHIPPING_SINGLE_TENANT']) delete process.env[name];
  try { return run(); } finally {
    for (const name of ['SHIPENGINE_API_KEY', 'SHIPENGINE_WEBHOOK_SECRET',
      'SHIPSTATION_API_KEY', 'SHIPSTATION_WEBHOOK_SECRET',
      'EASYPOST_API_KEY', 'EASYPOST_WEBHOOK_SECRET',
      'SHIPPO_API_KEY', 'SHIPPO_WEBHOOK_SECRET', 'SHIPPING_PROVIDER',
      'SHIPPING_SINGLE_TENANT']) {
      if (held[name] !== undefined) process.env[name] = held[name];
    }
  }
}

function setup(name) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: name || 'Shop' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, ctx: workspace.ctx, membership };
}

test('a workspace ships on its own account, and the key is not on the record', () => withoutServerKey(() => {
  const env = setup();
  assert.equal(accounts.describe(env.db, env.workspace.workspaceId).connected, false,
    'no account is a normal state, not a broken one');

  accounts.connect(env.db, env.ctx, env.membership, {
    provider: 'easypost', apiKey: 'EZTK_pretend_key_9999', webhookSecret: 'a-long-random-string',
  });

  const described = accounts.describe(env.db, env.workspace.workspaceId);
  assert.equal(described.connected, true);
  assert.equal(described.provider, 'easypost');
  assert.equal(described.source, 'workspace');
  assert.equal(described.testMode, true, 'a test key is recognised, because that is the question');
  assert.equal(described.keyEndsWith, '9999');
  assert.ok(!JSON.stringify(described).includes('EZTK_pretend_key_9999'),
    'the whole key is never handed back to a screen');

  /*
   * And it is not sitting in the connector row either. That row holds a
   * reference and nothing else, which is what stops a plan, a prompt or a log
   * from carrying a secret by accident.
   */
  const connector = accounts.connectorFor(env.db, env.workspace.workspaceId);
  assert.ok(!JSON.stringify(connector).includes('EZTK_pretend_key_9999'));
  assert.match(connector.credential_ref, /^credentials:/);

  // The adapter gets it, because that is the whole point.
  const held = accounts.contextFor(env.db, env.ctx);
  assert.equal(held.ctx.easypostApiKey, 'EZTK_pretend_key_9999');
  assert.equal(held.account.webhookSecret, 'a-long-random-string');
  env.db.close();
}));

test('one inventory never ships on another inventory account', () => withoutServerKey(() => {
  /*
   * The failure this whole change exists to prevent: two merchants on one
   * server, and a parcel billed to the wrong one.
   */
  const { db } = makeDatabase();
  const one = seedWorkspace(db, { workspaceName: 'Shop One' });
  const two = seedWorkspace(db, { workspaceName: 'Shop Two' });
  const oneMember = authService.getMembership(db, one.workspaceId, one.accountId);

  accounts.connect(db, one.ctx, oneMember, { provider: 'easypost', apiKey: 'EZTK_one_1111' });

  assert.equal(accounts.forWorkspace(db, one.workspaceId).apiKey, 'EZTK_one_1111');
  assert.equal(accounts.forWorkspace(db, two.workspaceId), null,
    'the other inventory has no account, and does not inherit one');
  assert.equal(accounts.contextFor(db, two.ctx), null);
  db.close();
}));

test('the server key is a fallback that says it is one', () => {
  /*
   * Kept so a developer running a single inventory locally does not have to
   * click through a connection screen to try a label. It answers only when the
   * workspace has nothing of its own, and it says out loud that it is shared —
   * "who is paying for this label" should not be a question anybody guesses at.
   */
  const env = setup();
  // Saved, not just deleted afterwards: unsetting a real key would break every
  // test that runs after this one.
  const held = process.env.EASYPOST_API_KEY;
  process.env.EASYPOST_API_KEY = 'EZTK_server_2222';
  try {
    const shared = accounts.describe(env.db, env.workspace.workspaceId);
    assert.equal(shared.connected, true);
    assert.equal(shared.source, 'server');
    assert.match(shared.because, /every inventory on it shares/);

    // And a workspace's own account wins the moment it exists.
    accounts.connect(env.db, env.ctx, env.membership, {
      provider: 'easypost', apiKey: 'EZTK_theirs_3333',
    });
    const own = accounts.forWorkspace(env.db, env.workspace.workspaceId);
    assert.equal(own.source, 'workspace');
    assert.equal(own.apiKey, 'EZTK_theirs_3333');
  } finally {
    if (held === undefined) delete process.env.EASYPOST_API_KEY;
    else process.env.EASYPOST_API_KEY = held;
    env.db.close();
  }
});

test('a server live key cannot make the developer pay for tenant labels', () => withoutServerKey(() => {
  const env = setup();
  process.env.EASYPOST_API_KEY = 'EZAK_live_platform_key';
  assert.equal(accounts.forWorkspace(env.db, env.workspace.workspaceId), null,
    'a shared live key is ignored unless this installation explicitly declares itself single-tenant');

  process.env.SHIPPING_SINGLE_TENANT = 'true';
  const single = accounts.forWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(single.source, 'server');
  assert.equal(single.apiKey, 'EZAK_live_platform_key');
  env.db.close();
}));

test('disconnecting takes the key with it', () => withoutServerKey(() => {
  const env = setup();
  accounts.connect(env.db, env.ctx, env.membership, { provider: 'shippo', apiKey: 'shippo_test_4444' });
  assert.equal(accounts.forWorkspace(env.db, env.workspace.workspaceId).provider, 'shippo');

  accounts.disconnect(env.db, env.ctx, env.membership);
  assert.equal(accounts.forWorkspace(env.db, env.workspace.workspaceId), null,
    'no key, and no connector claiming to be connected');
  env.db.close();
}));

test('only a provider StockChief actually has an adapter for can be connected', () => withoutServerKey(() => {
  const env = setup();
  assert.throws(() => accounts.connect(env.db, env.ctx, env.membership,
    { provider: 'someone-else', apiKey: 'x' }), /shipstation.*easypost.*shippo/);
  assert.throws(() => accounts.connect(env.db, env.ctx, env.membership,
    { provider: 'easypost', apiKey: '' }), /API key/);
  env.db.close();
}));
