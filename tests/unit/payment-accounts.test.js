'use strict';

/*
 * Whose Stripe account a customer pays into.
 *
 * The same correction as the carrier account, and a worse problem than that one
 * was. A single key for the whole server does not mean a label billed to the
 * wrong person — it means the money arriving in the wrong bank, and one
 * merchant's webhook secret verifying another merchant's messages.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const accounts = require('../../src/payments/accounts');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

/*
 * A developer's own .env is not part of the test.
 *
 * config.js loads .env at require time, so a machine that has a real
 * STRIPE_SECRET_KEY would make every "no account connected" assertion here
 * fail — and worse, would pass on a machine that did not, which is the kind of
 * test that only breaks for somebody else.
 */
const SERVER_SETTINGS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'STRIPE_CONNECT_ENABLED', 'STRIPE_CONNECT_CLIENT_ID'];

function withoutServerKey(run) {
  const held = {};
  for (const name of SERVER_SETTINGS) { held[name] = process.env[name]; delete process.env[name]; }
  try { return run(); } finally {
    for (const name of SERVER_SETTINGS) {
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

test('an inventory takes money into its own account, and the key is not on the record', () => withoutServerKey(() => {
  const env = setup();
  assert.equal(accounts.describe(env.db, env.workspace.workspaceId).connected, false,
    'no account is an ordinary state — cash and cheques need none of this');

  accounts.connect(env.db, env.ctx, env.membership, {
    secretKey: 'sk_test_pretend_key_8888', webhookSecret: 'whsec_pretend',
  });

  const described = accounts.describe(env.db, env.workspace.workspaceId);
  assert.equal(described.connected, true);
  assert.equal(described.source, 'workspace');
  assert.equal(described.liveMode, false, 'a test key is recognised, because that is the question');
  assert.equal(described.keyEndsWith, '8888');
  assert.ok(!JSON.stringify(described).includes('sk_test_pretend_key_8888'),
    'the whole key is never handed back to a screen');

  const connector = accounts.connectorFor(env.db, env.workspace.workspaceId);
  assert.ok(!JSON.stringify(connector).includes('sk_test_pretend_key_8888'),
    'and it is not sitting on the connector row either');
  assert.match(connector.credential_ref, /^credentials:/);

  assert.equal(accounts.contextFor(env.db, env.ctx).stripeSecretKey, 'sk_test_pretend_key_8888',
    'the adapter gets it, which is the whole point');
  env.db.close();
}));

test('one inventory never takes money into another inventory account', () => withoutServerKey(() => {
  const { db } = makeDatabase();
  const one = seedWorkspace(db, { workspaceName: 'Shop One' });
  const two = seedWorkspace(db, { workspaceName: 'Shop Two' });
  const oneMember = authService.getMembership(db, one.workspaceId, one.accountId);

  accounts.connect(db, one.ctx, oneMember, { secretKey: 'sk_test_one_1111' });

  assert.equal(accounts.forWorkspace(db, one.workspaceId).secretKey, 'sk_test_one_1111');
  assert.equal(accounts.forWorkspace(db, two.workspaceId), null,
    'the other inventory has no account, and does not inherit one');
  assert.equal(accounts.contextFor(db, two.ctx).stripeSecretKey, undefined,
    'so nothing of the first one reaches it');
  db.close();
}));

test('a publishable key is refused rather than stored and left to fail later', () => withoutServerKey(() => {
  /*
   * Both keys are on the same Stripe page and one is easier to copy. Accepted,
   * it would look connected and fail on the first customer — and nobody would
   * suspect the key.
   */
  const env = setup();
  assert.throws(() => accounts.connect(env.db, env.ctx, env.membership,
    { secretKey: 'pk_test_publishable' }), /not the publishable key|starts with sk_test_/);
  assert.throws(() => accounts.connect(env.db, env.ctx, env.membership,
    { secretKey: 'sk_test_fine', webhookSecret: 'not-a-signing-secret' }), /whsec_/);
  assert.equal(accounts.describe(env.db, env.workspace.workspaceId).connected, false);
  env.db.close();
}));

test('the server key is a fallback that says whose money it is', () => {
  const env = setup();
  // Saved, not just deleted afterwards: this process may hold a real key, and
  // a test that quietly unsets it breaks every test that runs after it.
  const held = process.env.STRIPE_SECRET_KEY;
  /*
   * And Connect is explicitly off, because that is the condition being tested.
   *
   * The server key stands in for a shop's till only on a single-tenant
   * install. Where Connect is switched on, the same key is the platform's own
   * identity and deliberately stops being anybody's till — so a machine whose
   * .env has Connect enabled would fail this, and one without it would pass:
   * the kind of test that only ever breaks for somebody else.
   */
  const heldConnect = process.env.STRIPE_CONNECT_ENABLED;
  const heldClient = process.env.STRIPE_CONNECT_CLIENT_ID;
  delete process.env.STRIPE_CONNECT_ENABLED;
  delete process.env.STRIPE_CONNECT_CLIENT_ID;
  process.env.STRIPE_SECRET_KEY = 'sk_test_server_2222';
  try {
    const shared = accounts.describe(env.db, env.workspace.workspaceId);
    assert.equal(shared.source, 'server');
    assert.match(shared.because, /every customer pays into the same Stripe account/);

    accounts.connect(env.db, env.ctx, env.membership, { secretKey: 'sk_test_theirs_3333' });
    const own = accounts.forWorkspace(env.db, env.workspace.workspaceId);
    assert.equal(own.source, 'workspace');
    assert.equal(own.secretKey, 'sk_test_theirs_3333', 'their own account wins the moment it exists');
  } finally {
    if (held === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = held;
    if (heldConnect !== undefined) process.env.STRIPE_CONNECT_ENABLED = heldConnect;
    if (heldClient !== undefined) process.env.STRIPE_CONNECT_CLIENT_ID = heldClient;
    env.db.close();
  }
});

test('disconnecting takes the key with it', () => withoutServerKey(() => {
  const env = setup();
  accounts.connect(env.db, env.ctx, env.membership, { secretKey: 'sk_test_gone_4444' });
  accounts.disconnect(env.db, env.ctx, env.membership);
  assert.equal(accounts.forWorkspace(env.db, env.workspace.workspaceId), null);
  env.db.close();
}));
