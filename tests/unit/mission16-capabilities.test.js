'use strict';

/*
 * One job at a time.
 *
 * "Handle routine work" used to be a single workspace-wide switch. Turning it
 * on so Foundry could email a payment request also let it place supplier
 * orders, move stock between locations, and answer customers. One authority,
 * six unrelated consequences, and no way to want one without the others.
 *
 * The mode is now a ceiling rather than a grant. Underneath it every job is
 * authorised separately and starts off, and the two have to agree: raising the
 * mode grants nothing, and granting a job does nothing while the mode is below
 * it. The point of the whole arrangement is the last test in this file —
 * authorising Foundry to chase an invoice must not authorise it to spend money.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const capabilities = require('../../src/autopilot/capabilities');
const intent = require('../../src/autopilot/authority-intent');
const modes = require('../../src/autopilot/modes');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, ctx: workspace.ctx, membership, ws: workspace.workspaceId };
}

test('every job starts off, whatever the mode says', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  for (const job of capabilities.list(env.db, env.ws)) {
    assert.equal(job.granted, false, `${job.capability} should start off`);
    assert.equal(capabilities.may(env.db, env.ws, job.capability).allowed, false,
      'the mode is a ceiling, not a grant');
  }
});

test('a granted job still waits for the mode to allow it', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'SUPERVISED');
  capabilities.set(env.db, env.ctx, env.membership, 'payment_requests', true);

  const verdict = capabilities.may(env.db, env.ws, 'payment_requests');
  assert.equal(verdict.allowed, false, 'both have to agree');
  assert.match(verdict.because, /ask before acting/);

  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  assert.equal(capabilities.may(env.db, env.ws, 'payment_requests').allowed, true);
});

test('authorising one job authorises exactly one job', () => {
  /*
   * The complaint, as a test. Everything else must be exactly where it was.
   */
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  capabilities.set(env.db, env.ctx, env.membership, 'payment_requests', true);

  assert.equal(capabilities.may(env.db, env.ws, 'payment_requests').allowed, true);
  for (const other of ['replenishment', 'inventory_transfers', 'supplier_emails',
    'customer_replies', 'shipping_notices']) {
    assert.equal(capabilities.may(env.db, env.ws, other).allowed, false,
      `chasing an invoice must not authorise ${other}`);
  }
});

test('pausing stops every job at once, however much was granted', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  for (const name of capabilities.NAMES) capabilities.set(env.db, env.ctx, env.membership, name, true);
  modes.pause(env.db, env.ctx, env.membership, 'Owner pressed pause.');

  for (const name of capabilities.NAMES) {
    const verdict = capabilities.may(env.db, env.ws, name);
    assert.equal(verdict.allowed, false);
    assert.match(verdict.because, /paused/i);
  }
});

test('a job nobody has heard of is refused rather than allowed', () => {
  const env = setup();
  assert.throws(() => capabilities.may(env.db, env.ws, 'launch_missiles'),
    /no Foundry job called/);
});

test('taking authority back is not harder than giving it', () => {
  /*
   * Granting needs ADMIN. Revoking deliberately does not: making it harder to
   * stop an automaton than to start one is the wrong way round.
   */
  const env = setup();
  const operator = { role: 'operator', permissions: JSON.stringify(['VIEW', 'OPERATE']) };
  assert.throws(() => capabilities.set(env.db, env.ctx, operator, 'replenishment', true), /permission|authoris/i);
  capabilities.set(env.db, env.ctx, env.membership, 'replenishment', true);
  assert.doesNotThrow(() => capabilities.set(env.db, env.ctx, operator, 'replenishment', false));
  assert.equal(capabilities.granted(env.db, env.ws, 'replenishment'), false);
});

test('one sentence sets two jobs in opposite directions and touches nothing else', () => {
  const env = setup();
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  capabilities.set(env.db, env.ctx, env.membership, 'shipping_notices', true);

  const said = intent.applySentence(env.db, env.ctx, env.membership,
    'Automatically send payment requests to customers, but always ask me before placing supplier orders.');

  assert.equal(said.applied, true);
  assert.deepEqual(said.grants, { payment_requests: true, replenishment: false });
  assert.match(said.summary, /may ask customers to pay/i);
  assert.match(said.summary, /may not reorder/i);

  assert.equal(capabilities.granted(env.db, env.ws, 'payment_requests'), true);
  assert.equal(capabilities.granted(env.db, env.ws, 'replenishment'), false);
  assert.equal(capabilities.granted(env.db, env.ws, 'shipping_notices'), true,
    'a job the sentence never mentioned keeps whatever it had');
});

test('the words people actually use, read the way they meant them', () => {
  const cases = [
    ['Handle shipping notifications yourself.', { shipping_notices: true }],
    ['Never email suppliers without my approval.', { supplier_emails: false }],
    ['You can move stock between locations on your own.', { inventory_transfers: true }],
    ['Stop asking customers for money automatically.', { payment_requests: false }],
    ['Go ahead and reply to customers.', { customer_replies: true }],
  ];
  for (const [sentence, expected] of cases) {
    assert.deepEqual(intent.read(sentence).grants, expected, sentence);
  }
});

test('an ambiguous sentence grants nothing and says which job it was about', () => {
  const vague = intent.read('Something about payment requests.');
  assert.equal(vague.understood, false, 'authority is never guessed at');
  assert.deepEqual(vague.grants, {});
  assert.deepEqual(vague.unclear, ['payment_requests'], 'but it knows what was being discussed');
});

test('a sentence carrying both signals grants the smaller thing', () => {
  /*
   * "Prepare orders automatically but ask me before placing them" is one
   * clause with both a granting and a withholding phrase in it. The safe
   * reading of an ambiguous sentence about authority is the one that gives
   * less away.
   */
  const both = intent.read('Automatically place supplier orders but ask me first.');
  assert.equal(both.grants.replenishment, false);
});
