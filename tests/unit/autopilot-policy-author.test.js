'use strict';

/**
 * Mission 7, item 6: writing a policy from a sentence.
 *
 * The model is given exactly one job — reading English — and these tests are
 * about the fence around it. A stubbed provider stands in for the model and is
 * made to return the most dangerous answers it could plausibly produce: an
 * action Foundry must never automate, a missing limit, an invented limit, a
 * location that does not exist. None of them may reach a live policy.
 *
 * No API key is involved. The point is not whether a model gets this right on a
 * good day; it is that a wrong answer cannot do any harm.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const policyAuthor = require('../../src/autopilot/policy-author');
const policyService = require('../../src/autopilot/policy-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Author Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, membership, ctx: workspace.ctx };
}

/** A model that says whatever the test needs it to say. */
const provider = (data) => ({ complete: async () => ({ data }) });

const GOOD = {
  understood: true,
  name: 'Automatic warehouse balancing',
  maximumQuantity: 20,
  dailyLimit: 0,
  locationNames: ['Main Warehouse', 'Downtown Store'],
  unsupportedReason: '',
};

test('a plain instruction becomes a readable draft with the limit they said', async () => {
  const env = setup();
  const drafted = await policyAuthor.draft(
    env.db,
    env.workspace.workspaceId,
    'You can move stock between the warehouse and the store when one runs low, never more than 20 at a time',
    { provider: provider(GOOD) }
  );

  assert.equal(drafted.understood, true);
  assert.equal(drafted.draft.maximumQuantity, 20);
  assert.equal(drafted.draft.locationScope.length, 2);
  assert.deepEqual(drafted.questions, []);
  assert.ok(drafted.preview.some((line) => /20 units in one go/.test(line)));
});

test('the model cannot authorise an action Foundry does not automate', async () => {
  const env = setup();
  // Even if the model says "yes, automate adjustments", the draft only ever
  // carries transfer — and the policy service would refuse anything else anyway.
  const drafted = await policyAuthor.draft(
    env.db,
    env.workspace.workspaceId,
    'Fix any count discrepancies yourself',
    { provider: provider({ ...GOOD, name: 'Auto adjustments' }) }
  );

  assert.deepEqual(drafted.draft.allowedActionTypes, ['transfer']);
  assert.throws(
    () =>
      policyService.propose(env.db, env.ctx, env.membership, {
        ...drafted.draft,
        allowedActionTypes: ['adjust'],
      }),
    /will not automate adjust/
  );
});

test('a request Foundry cannot automate is refused, not quietly narrowed', async () => {
  const env = setup();
  const drafted = await policyAuthor.draft(
    env.db,
    env.workspace.workspaceId,
    'Just order from the supplier when we run low',
    {
      provider: provider({
        understood: false,
        name: '',
        maximumQuantity: 0,
        dailyLimit: 0,
        locationNames: [],
        unsupportedReason: 'Foundry never sends orders to a supplier.',
      }),
    }
  );

  assert.equal(drafted.understood, false);
  assert.match(drafted.unsupportedReason, /never sends orders/);
  assert.equal(drafted.draft, undefined, 'nothing to approve when the answer is no');
});

test('no limit given means a question, never a number Foundry chose', async () => {
  const env = setup();
  const drafted = await policyAuthor.draft(
    env.db,
    env.workspace.workspaceId,
    'Handle ordinary transfers yourself',
    { provider: provider({ ...GOOD, maximumQuantity: 0 }) }
  );

  assert.equal(drafted.draft.maximumQuantity, null);
  assert.ok(drafted.questions.some((q) => /most Foundry may move/.test(q)));
  assert.deepEqual(drafted.preview, [], 'nothing is previewed as agreed while a limit is missing');

  // And it genuinely cannot be written in that state.
  assert.throws(
    () => policyService.propose(env.db, env.ctx, env.membership, drafted.draft),
    /A policy without a limit is not a limit/
  );
});

test('a location the model invented is dropped rather than created', async () => {
  const env = setup();
  const drafted = await policyAuthor.draft(
    env.db,
    env.workspace.workspaceId,
    'Balance between Brooklyn and New Jersey',
    { provider: provider({ ...GOOD, locationNames: ['Brooklyn Warehouse', 'New Jersey Warehouse'] }) }
  );

  // This workspace has neither of those. Rather than inventing them, the draft
  // falls back to every real location and says so out loud.
  assert.ok(drafted.questions.some((q) => /all \d+ of your locations/.test(q)));
  for (const id of drafted.draft.locationScope) {
    assert.ok(id.startsWith('loc_'), 'every scoped location is a real one');
  }
});

test('the safety conditions are not the model’s to choose', async () => {
  const env = setup();
  const drafted = await policyAuthor.draft(
    env.db,
    env.workspace.workspaceId,
    'Move stock around whenever you like, no conditions',
    { provider: provider(GOOD) }
  );

  assert.deepEqual(drafted.draft.conditions.sort(), [
    policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK,
    policyService.CONDITIONS.NO_CONFLICTING_TRANSFER,
    policyService.CONDITIONS.SOURCE_ABOVE_SAFETY,
    policyService.CONDITIONS.SUFFICIENT_HISTORY,
  ].sort());
});

test('reading a sentence writes nothing and approves nothing', async () => {
  const env = setup();
  await policyAuthor.draft(env.db, env.workspace.workspaceId, 'Handle transfers yourself', {
    provider: provider(GOOD),
  });

  assert.equal(policyService.list(env.db, env.workspace.workspaceId).length, 0);

  // Written from the draft, it is still inert until a person approves it.
  const written = policyService.propose(env.db, env.ctx, env.membership, {
    ...(await policyAuthor.draft(env.db, env.workspace.workspaceId, 'Handle transfers yourself', {
      provider: provider(GOOD),
    })).draft,
  });
  assert.equal(written.isApproved, false);
  assert.equal(written.isActive, false);
});
