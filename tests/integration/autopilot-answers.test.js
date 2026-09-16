'use strict';

/**
 * Mission 7: StockChief answering for itself.
 *
 * Once StockChief does work of its own, three questions become inevitable — what
 * did you do, why did you do it, and stop doing that. Each is answered from the
 * work records, so the answer is the same thing the history page shows. A model
 * is used to read the question and nothing else; it is never asked to recall
 * what happened, because it does not know and would guess.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const modes = require('../../src/autopilot/modes');
const capabilities = require('../../src/autopilot/capabilities');
const policyService = require('../../src/autopilot/policy-service');
const runner = require('../../src/autopilot/runner');
const queryService = require('../../src/attention/query-service');
const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const ledger = require('../../src/accounting/ledger');
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

  inventory.receive(db, workspace.ctx, { skuId: black5.id, locationId: workspace.main.id, quantity: 26 });
  inventory.receive(db, workspace.ctx, { skuId: black5.id, locationId: workspace.store.id, quantity: 65 });

  db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  const backdate = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
  const issue = (locationId, quantity, daysAgo) => {
    const result = inventory.issue(db, workspace.ctx, { skuId: black5.id, locationId, quantity, reasonCode: 'sold' });
    const when = new Date(Date.now() - daysAgo * DAY).toISOString();
    for (const id of result.movementIds) backdate.run(when, id);
  };
  for (const [quantity, daysAgo] of [[4, 28], [4, 22], [3, 16], [3, 10], [4, 4]]) issue(workspace.main.id, quantity, daysAgo);
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

test('customer-money questions include confirmed unpaid orders without calling them earned revenue', () => {
  const env = tights();
  ledger.configure(env.db, env.ctx, env.membership, {
    startDate: new Date().toISOString().slice(0, 10), currency: 'USD',
    costingMethod: 'WEIGHTED_AVERAGE',
  });
  prices.setPrice(env.db, env.ctx, { skuId: env.black5.id, amount: '25.00', currency: 'USD' });
  const order = sales.confirm(env.db, env.ctx, sales.createOrder(env.db, env.ctx, {
    customerName: 'ABC School', fulfillmentLocationId: env.workspace.main.id,
    lines: [{ skuId: env.black5.id, quantity: 4 }],
  }).id);

  const answer = queryService.execute(env.db, env.workspace.workspaceId,
    { intent: 'receivables_aging' }, { question: 'Does any customer owe me money?' });
  assert.match(answer.answer, /Yes.*\$100\.00.*confirmed order/i);
  assert.equal(answer.rows.some((row) => row.document === order.order_number), true);
  assert.equal(answer.handoff.href, `/sales/orders/${order.id}`);
});

// --- what did you do ---------------------------------------------------------

test('"what did you do today" is answered from the work records', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  // The mode is a ceiling; the jobs are granted separately.
  capabilities.apply(env.db, env.ctx, env.membership, { inventory_transfers: true, replenishment: true });
  runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });

  const answer = ask(env, { intent: 'foundry_activity' });

  assert.match(answer.answer, /Prepared transfer for 12 Kids Tights/);
  assert.match(answer.answer, /Downtown Store to Main Warehouse/);
  assert.equal(answer.rows.length, 1);
  assert.equal(answer.rows[0].verified, 'yes');
  assert.deepEqual(answer.columns, ['what', 'detail', 'verified']);
});

test('a quiet day says so rather than inventing activity', () => {
  const env = tights();
  // No policy, so StockChief has done nothing on its own.
  const answer = ask(env, { intent: 'foundry_activity' });

  assert.equal(answer.rows.length, 0);
  assert.match(answer.answer, /Nothing/i);
  assert.doesNotMatch(answer.answer, /Moved/);
});

test('StockChief explains inventory it created from an invoice and what still needs the owner', () => {
  const env = tights();
  const now = new Date().toISOString();
  env.db.prepare(
    `INSERT INTO setup_documents
       (id, workspace_id, uploaded_by_user_id, source_name, source_content, content_hash,
        extracted_text, interpretation, supplier_code_label, status, result, created_at, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'Style #', 'APPLIED', ?, ?, ?)`
  ).run('sdoc_activity_test', env.workspace.workspaceId, env.workspace.ownerId, 'first-invoice.pdf',
    Buffer.from('invoice'), 'activity-test-hash', 'invoice text', JSON.stringify({
      products: 4, variants: 8, units: 76, unitLabel: 'pair', location: 'Main Warehouse',
      supplier: 'Step & Style', poNumber: 'INV-100',
    }), now, now);

  const answer = queryService.execute(env.db, env.workspace.workspaceId, { intent: 'foundry_activity' }, {
    question: 'What did you create from the invoice, and what do you need from me now?',
  });

  assert.match(answer.answer, /Created 4 products and 8 variants/);
  assert.match(answer.answer, /received 76 pairs into Main Warehouse/);
  assert.match(answer.answer, /purchase order INV-100/);
  assert.match(answer.answer, /Nothing needs you right now/);
  assert.equal(answer.rows[0].verified, 'yes');
});

// --- why did you do it -------------------------------------------------------

test('"why did you move the tights" gives the measurements, not a story', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  // The mode is a ceiling; the jobs are granted separately.
  capabilities.apply(env.db, env.ctx, env.membership, { inventory_transfers: true, replenishment: true });
  runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });

  const answer = ask(env, { intent: 'foundry_why', entityQuery: 'kids tights' });

  assert.match(answer.answer, /Main Warehouse/);
  assert.match(answer.answer, /Automatic Warehouse Balancing/);
  assert.match(answer.answer, /Total unchanged/);
  assert.ok(answer.rows.length, 'the numbers it went on are shown');
  assert.deepEqual(answer.columns, ['measure', 'value']);
});

test('asking why about something StockChief never touched admits it', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  // The mode is a ceiling; the jobs are granted separately.
  capabilities.apply(env.db, env.ctx, env.membership, { inventory_transfers: true, replenishment: true });
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
  // The mode is a ceiling; the jobs are granted separately.
  capabilities.apply(env.db, env.ctx, env.membership, { inventory_transfers: true, replenishment: true });

  const answer = ask(env, { intent: 'stop_automation' });

  assert.match(answer.answer, /Automatic Warehouse Balancing/);
  assert.ok(answer.handoff, 'it points at the page where this is switched off');
  assert.equal(answer.handoff.href, '/autopilot');

  // Asking is not doing. The policy is still on until someone presses the button.
  const after = policyService.get(env.db, env.workspace.workspaceId, policy.id);
  assert.equal(after.isActive, true, 'a question never changes what StockChief is allowed to do');

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

  // Supervised, no policy: StockChief prepares and asks.
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

test('once preparation is done, it says exactly what is and is not complete', () => {
  const env = tights();
  balancing(env);
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  // The mode is a ceiling; the jobs are granted separately.
  capabilities.apply(env.db, env.ctx, env.membership, { inventory_transfers: true, replenishment: true });
  runner.run(env.db, env.ctx, env.membership, { trigger: 'test' });

  const presenter = require('../../src/autopilot/presenter');
  const workItems = require('../../src/autopilot/work-items');
  const [done] = workItems.list(env.db, env.workspace.workspaceId, { category: 'balance_transfer' });

  const prose = presenter.explain(env.db, env.workspace.workspaceId, done.id).paragraphs.join(' ');
  assert.match(prose, /I prepared TR-\d+ for 12/);
  assert.match(prose, /Approval did not move stock/);
  assert.match(prose, /Total unchanged/);
  assert.match(presenter.describeCompleted(done).headline, /^Prepared transfer for 12/);
});

test('prepared suggestions are not misrepresented as automatic work', () => {
  const env = tights();
  const presenter = require('../../src/autopilot/presenter');

  runner.planWork(env.db, env.ctx, env.membership, { trigger: 'test' });
  const did = presenter.whatStockChiefDid(env.db, env.workspace.workspaceId);

  assert.doesNotMatch(did.headline, /Nothing needed doing/);
  assert.match(did.headline, /Prepared suggestions are available/);
  assert.match(did.headline, /completed no automatic action/);
});

test('the handled-without-you count excludes owner sales and includes connector work', () => {
  const env = tights();
  const presenter = require('../../src/autopilot/presenter');
  prices.setPrice(env.db, env.ctx, { skuId: env.black5.id, amount: '20.00', currency: 'USD' });
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'Counter customer' });

  const ownerOrder = sales.createOrder(env.db, env.ctx, {
    customerId: customer.id,
    lines: [{ skuId: env.black5.id, quantity: 1 }],
  });
  sales.confirm(env.db, env.ctx, ownerOrder.id, { idempotencyKey: `web-confirm:${ownerOrder.id}` });

  let did = presenter.whatStockChiefDid(env.db, env.workspace.workspaceId);
  assert.equal(did.counts.handled, 0, 'an owner confirmation is not credited to StockChief');
  assert.ok(!did.actions.some((entry) => entry.link === `/sales/orders/${ownerOrder.id}`));

  const connectorOrder = sales.createOrder(env.db, env.ctx, {
    customerId: customer.id,
    lines: [{ skuId: env.black5.id, quantity: 1 }],
  });
  sales.confirm(env.db, env.ctx, connectorOrder.id, {
    idempotencyKey: `external:square:test:${connectorOrder.id}:confirm`,
  });

  did = presenter.whatStockChiefDid(env.db, env.workspace.workspaceId);
  assert.equal(did.counts.handled, 1);
  assert.equal(did.actions[0].link, `/sales/orders/${connectorOrder.id}`,
    'the handled record links to the exact order rather than a general activity page');
});
