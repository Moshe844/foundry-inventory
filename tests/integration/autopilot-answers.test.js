'use strict';

/**
 * Mission 7: Foundry answering for itself.
 *
 * Once Foundry does work of its own, three questions become inevitable — what
 * did you do, why did you do it, and stop doing that. Each is answered from the
 * work records, so the answer is the same thing the history page shows. A model
 * is used to read the question and nothing else; it is never asked to recall
 * what happened, because it does not know and would guess.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const modes = require('../../src/autopilot/modes');
const policyService = require('../../src/autopilot/policy-service');
const runner = require('../../src/autopilot/runner');
const queryService = require('../../src/attention/query-service');
const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

const DAY = 24 * 60 * 60 * 1000;

/** The kids-tights workspace: Brooklyn selling, New Jersey sitting on stock. */
function tights() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Kids Tights' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);

  const created = itemService.createItem(db, workspace.ctx, {
    name: 'Kids Tights',
    baseCode: 'KT-100',
    trackingMode: 'quantity',
    hasVariants: true,
    options: [
      { name: 'Colour', values: 'Black, White' },
      { name: 'Size', values: '2, 5, 8' },
    ],
  });
  const skus = repo.listSkusForItem(db, workspace.workspaceId, created.itemId);
  const black5 = skus.find((sku) => sku.variant_label === 'Black / 5');

  inventory.receive(db, workspace.ctx, { skuId: black5.id, locationId: workspace.main.id, quantity: 29 });
  inventory.receive(db, workspace.ctx, { skuId: black5.id, locationId: workspace.store.id, quantity: 65 });

  db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  const backdate = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
  const issue = (locationId, quantity, daysAgo) => {
    const result = inventory.issue(db, workspace.ctx, { skuId: black5.id, locationId, quantity, reasonCode: 'sold' });
    const when = new Date(Date.now() - daysAgo * DAY).toISOString();
    for (const id of result.movementIds) backdate.run(when, id);
  };
  for (const [quantity, daysAgo] of [[5, 28], [4, 22], [3, 16], [4, 10], [5, 4]]) issue(workspace.main.id, quantity, daysAgo);
  issue(workspace.store.id, 4, 12);
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
     BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
  );

  return { db, workspace, membership, ctx: workspace.ctx, black5 };
}

function balancing(env) {
  const policy = policyService.propose(env.db, env.ctx, env.membership, {
    name: 'Automatic Warehouse Balancing',
    description: 'Move stock between our warehouses when one is about to run out.',
    allowedActionTypes: ['transfer'],
    locationScope: [env.workspace.main.id, env.workspace.store.id],
    conditions: [
      policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK,
      policyService.CONDITIONS.SOURCE_ABOVE_SAFETY,
    ],
    maximumQuantity: 12,
  });
  return policyService.approve(env.db, env.ctx, env.membership, policy.id);
}

const ask = (env, plan) => queryService.execute(env.db, env.workspace.workspaceId, plan);

// --- what did you do ---------------------------------------------------------

test('"what did you do today" is answered from the work records', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });

  const answer = ask(env, { intent: 'foundry_activity' });

  assert.match(answer.answer, /Moved 12 Kids Tights/);
  assert.match(answer.answer, /Downtown Store to Main Warehouse/);
  assert.equal(answer.rows.length, 1);
  assert.equal(answer.rows[0].verified, 'yes');
  assert.deepEqual(answer.columns, ['what', 'detail', 'verified']);
});

test('a quiet day says so rather than inventing activity', () => {
  const env = tights();
  // No policy, so Foundry has done nothing on its own.
  const answer = ask(env, { intent: 'foundry_activity' });

  assert.equal(answer.rows.length, 0);
  assert.match(answer.answer, /Nothing/i);
  assert.doesNotMatch(answer.answer, /Moved/);
});

// --- why did you do it -------------------------------------------------------

test('"why did you move the tights" gives the measurements, not a story', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });

  const answer = ask(env, { intent: 'foundry_why', entityQuery: 'kids tights' });

  assert.match(answer.answer, /Main Warehouse/);
  assert.match(answer.answer, /Automatic Warehouse Balancing/);
  assert.match(answer.answer, /Total unchanged/);
  assert.ok(answer.rows.length, 'the numbers it went on are shown');
  assert.deepEqual(answer.columns, ['measure', 'value']);
});

test('asking why about something Foundry never touched admits it', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });

  const answer = ask(env, { intent: 'foundry_why', entityQuery: 'garden hoses' });

  assert.match(answer.answer, /has not done anything to garden hoses/i);
  assert.equal(answer.rows.length, 0);
});

// --- stop doing that ---------------------------------------------------------

test('"stop doing that" names the policy and hands over — it does not silently disable it', () => {
  const env = tights();
  const policy = balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

  const answer = ask(env, { intent: 'stop_automation' });

  assert.match(answer.answer, /Automatic Warehouse Balancing/);
  assert.ok(answer.handoff, 'it points at the page where this is switched off');
  assert.equal(answer.handoff.href, '/autopilot');

  // Asking is not doing. The policy is still on until someone presses the button.
  const after = policyService.get(env.db, env.workspace.workspaceId, policy.id);
  assert.equal(after.isActive, true, 'a question never changes what Foundry is allowed to do');

  // And it does not get routed to the actions page, which changes stock.
  assert.equal(answer.isAction, false);
});

test('with nothing automated, "stop doing that" says there is nothing to stop', () => {
  const env = tights();
  const answer = ask(env, { intent: 'stop_automation' });

  assert.match(answer.answer, /not doing anything automatically/i);
  assert.equal(answer.rows.length, 0);
});

// --- saying what actually happened -------------------------------------------
//
// Found by clicking through it: the explanation page described a proposal in the
// past tense and claimed an approval nobody had given. Everything else on that
// page is evidence, so a false sentence at the top makes the rest worthless.

test('work that is only proposed is never described as done', () => {
  const env = tights();
  const presenter = require('../../src/autopilot/presenter');
  const workItems = require('../../src/autopilot/work-items');

  // Supervised, no policy: Foundry prepares and asks.
  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'test' });
  const [proposed] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });
  assert.equal(proposed.executionStatus, 'WAITING_FOR_APPROVAL');

  const explained = presenter.explain(env.db, env.workspace.workspaceId, proposed.id);
  const prose = explained.paragraphs.join(' ');

  assert.doesNotMatch(prose, /I transferred/, 'nothing has been transferred');
  assert.doesNotMatch(prose, /You approved this/, 'nobody approved anything');
  assert.match(prose, /Nothing has moved yet/);

  // And the one-liner on the history page agrees with it.
  assert.match(presenter.describeCompleted(proposed).headline, /^Wants to move/);
});

test('once it is done, it says so in the past tense', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });

  const presenter = require('../../src/autopilot/presenter');
  const workItems = require('../../src/autopilot/work-items');
  const [done] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });

  const prose = presenter.explain(env.db, env.workspace.workspaceId, done.id).paragraphs.join(' ');
  assert.match(prose, /I transferred 12\./);
  assert.match(prose, /Total unchanged/);
  assert.match(presenter.describeCompleted(done).headline, /^Moved 12/);
});

test('"nothing needed doing" is not said while something is waiting', () => {
  const env = tights();
  const presenter = require('../../src/autopilot/presenter');

  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'test' });
  const did = presenter.whatFoundryDid(env.db, env.workspace.workspaceId);

  assert.doesNotMatch(did.headline, /Nothing needed doing/);
  assert.match(did.headline, /prepared 1 thing for you/);
  assert.match(did.headline, /Carried nothing out on its own/);
});
