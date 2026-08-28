'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const authService = require('../../src/domain/auth-service');
const { createApp } = require('../../src/app');
const reorderPolicies = require('../../src/purchasing/policy-service');
const operatingGuards = require('../../src/domain/operating-guards');
const inventory = require('../../src/domain/inventory-engine');
const attention = require('../../src/attention/attention-engine');
const { makeDatabase, cleanupAll, seedWorkspace, makeVariantItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

const blank = () => ({
  operation: 'set', itemText: '', variantText: '', locationText: '', sourceLocationText: '', supplierText: '',
  reorderPoint: -1, targetStock: -1, safetyStock: -1, locationMinimum: -1, locationTarget: -1,
  leadTimeDays: -1, unitsPerPurchaseUnit: -1, minimumOrderQuantity: -1, orderMultiple: -1,
  maximumQuantity: -1, maximumValue: -1, cooldownHours: -1, daysOfStock: -1,
  purchaseUnit: '', contactName: '', email: '', orderingMethod: '',
  preferTransferBeforePurchasing: false, approvalRequired: true,
  guardAction: '', guardMetric: '', guardComparator: '', guardThreshold: -1,
  guardReleaseCondition: '', guardReleaseThreshold: -1,
});

function setup(result) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Conversation Rules Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeVariantItem(db, workspace.ctx, {
    name: 'Canvas Apron', baseCode: 'APRON',
    options: [{ name: 'Colour', values: 'Charcoal, Natural' }, { name: 'Length', values: 'Short, Long' }],
  });
  const provider = { complete: async (request) => ({ data: request.schemaName === 'manager_intent'
    ? { intentClass: 'OPERATING_INSTRUCTION', confidence: 'high', reason: 'A lasting restocking rule.', resolvedReference: '', clarifyingQuestion: '' }
    : result }) };
  const app = createApp({ db, env: 'test', sessionSecret: 'operating-http', aiProvider: provider });
  return { db, workspace, membership, item, app };
}

test('Tell Foundry → structured review → approve → same Settings record → remove', async () => {
  const result = {
    understood: true, summary: 'Charcoal Long replenishment', clarifyingQuestion: '', unsupportedReason: '',
    changes: [{ ...blank(), domain: 'replenishment', itemText: 'Canvas Apron', variantText: 'Charcoal Long', reorderPoint: 18, targetStock: 34 }],
  };
  const env = setup(result);
  const sku = env.item.skus.find((entry) => /Charcoal.*Long/.test(entry.variant_label));
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const routed = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    // Deliberately not one of the old parser's sentence templates.
    message: 'For charcoal long aprons, begin restocking once the network reaches eighteen; restore it to thirty-four.',
  });
  assert.equal(routed.status, 303);
  assert.match(routed.headers.location, /^\/operating-instructions\/oin_/);
  assert.equal(reorderPolicies.effectivePolicy(env.db, env.workspace.workspaceId, sku.id).isSet, false);

  const review = await agent.get(routed.headers.location);
  const reviewText = plain(review.text);
  assert.match(reviewText, /Review what Foundry should remember/);
  assert.match(reviewText, /reorder at 18/);
  assert.match(reviewText, /bring the network position to 34/);
  assert.match(reviewText, /Nothing changes until you approve/);

  const approved = await agent.post(`${routed.headers.location}/approve`).type('form').send({
    _csrf: csrfFrom(review.text),
    integrityHash: review.text.match(/name="integrityHash" value="([^"]+)"/)[1],
  });
  assert.equal(approved.status, 303);
  assert.equal(reorderPolicies.effectivePolicy(env.db, env.workspace.workspaceId, sku.id).reorderPoint, 18);

  const settings = await agent.get('/settings#learned-instructions');
  assert.match(plain(settings.text), /Rule history/);
  assert.match(plain(settings.text), /For charcoal long aprons/);
  assert.match(settings.text, /<details class="card advanced-settings" id="learned-instructions">/,
    'conversation history stays collapsed until somebody asks for audit detail');
  const remove = await agent.post(`${routed.headers.location}/remove`).type('form').send({ _csrf: csrfFrom(settings.text) });
  assert.equal(remove.status, 303);
  assert.equal(reorderPolicies.effectivePolicy(env.db, env.workspace.workspaceId, sku.id).isSet, false);
  env.db.close();
});

test('Tell Foundry accepts a general low-stock sales guard and shows the same rule in Settings', async () => {
  const result = {
    understood: true, summary: 'Protect Charcoal Short outgoing stock', clarifyingQuestion: '', unsupportedReason: '',
    changes: [{ ...blank(), domain: 'stock_protection', itemText: 'Canvas Apron', variantText: 'Charcoal Short',
      guardAction: 'issue', guardMetric: 'network_on_hand', guardComparator: 'below', guardThreshold: 10,
      guardReleaseCondition: 'on_order' }],
  };
  const env = setup(result);
  const sku = env.item.skus.find((entry) => /Charcoal.*Short/.test(entry.variant_label));
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const routed = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'When Charcoal Short gets under ten, block outgoing customer orders until replenishment has been ordered.',
  });
  assert.equal(routed.status, 303);
  assert.match(routed.headers.location, /^\/operating-instructions\/oin_/);
  const review = await agent.get(routed.headers.location);
  assert.match(plain(review.text), /block outgoing sales\/issues that would leave stock below 10/);
  assert.match(plain(review.text), /until a supplier order is placed/);
  const approved = await agent.post(`${routed.headers.location}/approve`).type('form').send({
    _csrf: csrfFrom(review.text),
    integrityHash: review.text.match(/name="integrityHash" value="([^"]+)"/)[1],
  });
  assert.equal(approved.status, 303);
  assert.equal(operatingGuards.list(env.db, env.workspace.workspaceId, { activeOnly: true, skuId: sku.id }).length, 1);
  const settings = await agent.get('/settings');
  const settingsText = plain(settings.text);
  assert.match(settingsText, /Stock protection/);
  assert.match(settingsText, /Resume after a supplier order is placed/);
  assert.match(settings.text, new RegExp(`href="/operating-instructions/${routed.headers.location.split('/').pop()}">Manage</a>`));
  env.db.close();
});

test('inclusive protection wording names the configured limit and lowest permitted balance consistently', async () => {
  const env = setup({});
  const sku = env.item.skus.find((entry) => /Charcoal.*Short/.test(entry.variant_label));
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: sku.id, locationId: env.workspace.main.id, quantity: 9, reasonCode: 'purchase',
  });
  operatingGuards.set(env.db, env.workspace.ctx, env.membership, {
    skuId: sku.id, actionType: 'issue', metric: 'network_on_hand', comparator: 'at_or_below', threshold: 8,
    releaseCondition: 'on_order', source: 'settings', statedAs: 'Block at or below eight.',
  });
  attention.evaluate(env.db, env.workspace.workspaceId, {
    trigger: 'operating_guard.updated', scope: { skuIds: [sku.id] },
  });

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const settingsText = plain((await agent.get('/settings')).text);
  assert.match(settingsText, /at or below 8\. The lowest permitted balance is 9/i);

  const needsText = plain((await agent.get('/needs-you')).text);
  assert.match(needsText, /9 on hand across this inventory.*next outgoing unit would reach the configured limit of 8/i);
  assert.match(needsText, /next outgoing unit would reach the blocked boundary you approved/i);
  assert.doesNotMatch(needsText, /protected limit 9/i);
  env.db.close();
});

test('a missing stock-protection release uses contextual buttons and the choice continues the same rule', async () => {
  const result = {
    understood: true, summary: 'Protect Charcoal Short outgoing stock', clarifyingQuestion: '', unsupportedReason: '',
    changes: [{ ...blank(), domain: 'stock_protection', itemText: 'Canvas Apron', variantText: 'Charcoal Short',
      guardAction: 'issue', guardMetric: 'network_on_hand', guardComparator: 'below', guardThreshold: 10 }],
  };
  const env = setup(result);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const routed = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Block outgoing Charcoal Short sales below 10.',
  });
  const review = await agent.get(routed.headers.location);
  const reviewText = plain(review.text);
  assert.match(reviewText, /What should release the block/);
  assert.match(review.text, /name="answer" value="on_order"[^>]*>Supplier order placed</);
  assert.match(review.text, /name="answer" value="stock_recovered"[^>]*>Stock is back to 10</);
  assert.match(review.text, /name="answer" value="manual"[^>]*>Owner releases it</);

  const continued = await agent.post(`${routed.headers.location}/answer`).type('form').send({
    _csrf: csrfFrom(review.text), answer: 'stock_recovered',
  });
  assert.equal(continued.status, 303);
  assert.notEqual(continued.headers.location, routed.headers.location);
  const ready = await agent.get(continued.headers.location);
  const readyText = plain(ready.text);
  assert.match(readyText, /until on-hand stock recovers to 10/);
  assert.match(readyText, /Approve and remember/);
  assert.doesNotMatch(readyText, /One detail is still missing/);
  env.db.close();
});

test('Tell Foundry overrides an incorrect model rejection for the supported outgoing-order guard', async () => {
  const env = setup({ understood: false, summary: '', changes: [], clarifyingQuestion: '', unsupportedReason: 'No matching setting.' });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const routed = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'Can you make when Canvas Apron - Charcoal / Short reaches less than 10 it should block you from doing more orders on it until you ordreded more',
  });
  assert.equal(routed.status, 303);
  assert.match(routed.headers.location, /^\/operating-instructions\/oin_/);
  const review = await agent.get(routed.headers.location);
  const text = plain(review.text);
  assert.match(text, /block outgoing sales\/issues that would leave stock below 10/);
  assert.match(text, /until a supplier order is placed/);
  env.db.close();
});
