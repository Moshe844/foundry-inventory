'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const changes = require('../../src/pricing/price-changes');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Pricing QA' });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Jeans', baseCode: 'JEANS-BLACK-S' });
  return { db, ctx: workspace.ctx, workspace, item };
}

test('selling price is integer money and sales orders snapshot it', () => {
  const env = setup();
  prices.setPrice(env.db, env.ctx, { skuId: env.item.skuId, amount: '12.10', currency: 'USD' });
  const first = sales.createOrder(env.db, env.ctx, { customerName: 'ABC School',
    discount: '1.00', tax: '2.00', lines: [{ skuId: env.item.skuId, quantity: 3 }] });
  assert.equal(first.lines[0].unit_price_minor, 1210);
  assert.equal(first.pricing.subtotalMinor, 3630);
  assert.equal(first.pricing.totalMinor, 3730);

  prices.setPrice(env.db, env.ctx, { skuId: env.item.skuId, amount: '15.00', currency: 'USD' });
  const unchanged = sales.getOrder(env.db, env.workspace.workspaceId, first.id);
  assert.equal(unchanged.lines[0].unit_price_minor, 1210);
  const second = sales.createOrder(env.db, env.ctx, { customerName: 'Second customer',
    lines: [{ skuId: env.item.skuId, quantity: 2 }] });
  assert.equal(second.pricing.totalMinor, 3000);
});

test('a legacy draft with a missing price cannot be confirmed as customer demand', () => {
  const env = setup();
  const draft = sales.createOrder(env.db, env.ctx, {
    customerName: 'ABC School', lines: [{ skuId: env.item.skuId, quantity: 2 }],
  });
  assert.equal(draft.lines[0].unit_price_minor, null);
  assert.throws(() => sales.confirm(env.db, env.ctx, draft.id), /does not have a selling price/i);
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, draft.id).status, 'DRAFT');
});

test('a price instruction is previewed and explicitly approved', () => {
  const env = setup();
  const proposal = changes.createProposal(env.db, env.ctx, { skuId: env.item.skuId,
    amount: '12', currency: 'USD', sourceText: 'Set JEANS-BLACK-S to $12 each' });
  assert.equal(prices.currentForSku(env.db, env.workspace.workspaceId, env.item.skuId).isSet, false);
  changes.approve(env.db, env.ctx, proposal.id, proposal.integrity_hash);
  assert.equal(prices.currentForSku(env.db, env.workspace.workspaceId, env.item.skuId).amount_minor, 1200);
});

test('Tell Foundry understands an ordinary selling-price sentence without hard-coded products or amounts', async () => {
  const env = setup();
  const proposal = await changes.interpret(env.db, env.ctx,
    'Can you add price for JEANS-BLACK-S in inventory, price is $27.45 each',
    { provider: { complete: async () => { throw new Error('offline'); } } });
  assert.equal(proposal.amount_minor, 2745);
  assert.equal(proposal.sku_id, env.item.skuId);
});

test('Tell Foundry recognises direct monetary assignments without requiring the word price', async () => {
  const examples = [
    ['Can you set JEANS-BLACK-S to $12 each', 1200],
    ['Update JEANS-BLACK-S to $19.95 per unit', 1995],
    ['Make JEANS-BLACK-S USD 8.50 each', 850],
  ];

  for (const [instruction, expectedMinor] of examples) {
    const env = setup();
    assert.equal(changes.matchesInstruction(instruction), true, instruction);
    const proposal = await changes.interpret(env.db, env.ctx, instruction,
      { provider: { complete: async () => { throw new Error('offline'); } } });
    assert.equal(proposal.amount_minor, expectedMinor, instruction);
    assert.equal(proposal.sku_id, env.item.skuId, instruction);
  }
});

test('a supplier-cost instruction is not mistaken for a customer selling price', () => {
  assert.equal(changes.matchesInstruction('Set the supplier cost for JEANS-BLACK-S to $12 each'), false);
  assert.equal(changes.matchesInstruction('Update the purchase price to $9.50'), false);
});

test('one instruction can preview and atomically approve different prices for multiple SKUs', async () => {
  const env = setup();
  const navy = makeQuantityItem(env.db, env.ctx, { name: 'Navy Jeans', baseCode: 'JEANS-NAVY-M' });
  const instruction = `Set these selling prices:
JEANS-BLACK-S: $12.00 each
JEANS-NAVY-M: $18.75 each`;

  assert.equal(changes.matchesBulkInstruction(instruction), true);
  const batch = await changes.interpretMany(env.db, env.ctx, instruction,
    { provider: { complete: async () => { throw new Error('offline'); } } });
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((proposal) => proposal.amount_minor).sort((a, b) => a - b), [1200, 1875]);
  assert.equal(prices.currentForSku(env.db, env.workspace.workspaceId, env.item.skuId).isSet, false);
  assert.equal(prices.currentForSku(env.db, env.workspace.workspaceId, navy.skuId).isSet, false);

  changes.approveBatch(env.db, env.ctx, batch.map((proposal) => ({
    id: proposal.id, integrityHash: proposal.integrity_hash,
  })));
  assert.equal(prices.currentForSku(env.db, env.workspace.workspaceId, env.item.skuId).amount_minor, 1200);
  assert.equal(prices.currentForSku(env.db, env.workspace.workspaceId, navy.skuId).amount_minor, 1875);
});
