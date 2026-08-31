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
  guardAction: '', guardMode: '', guardMetric: '', guardComparator: '', guardThreshold: -1,
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
      guardAction: 'issue', guardMode: 'block', guardMetric: 'network_on_hand', guardComparator: 'below', guardThreshold: 10,
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
      guardAction: 'issue', guardMode: 'block', guardMetric: 'network_on_hand', guardComparator: 'below', guardThreshold: 10 }],
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

test('a broad restriction question is answered with choices in the conversation, never a toast', async () => {
  const env = setup({
    understood: false,
    summary: '',
    changes: [],
    clarifyingQuestion: '',
    unsupportedReason: 'The request does not specify which type of restriction, item, location, supplier, or threshold.',
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const routed = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'Can you set up restrictions?',
  });

  assert.equal(routed.status, 303);
  assert.equal(routed.headers.location, '/actions');
  const answer = await agent.get('/actions');
  const text = plain(answer.text);
  assert.match(text, /Yes\. Foundry can protect low stock/i);
  assert.match(text, /Which restriction do you want to set first/i);
  assert.match(text, /Protect low stock/);
  assert.match(text, /Limit purchasing/);
  assert.match(text, /Limit transfers/);
  assert.match(text, /Control supplier changes/);
  assert.match(text, /Control supplier emails/);
  assert.doesNotMatch(answer.text, /flash--(?:warn|error)[^>]*>[^<]*The request does not specify/i);
  assert.doesNotMatch(text, /item, location, supplier, or threshold/i);

  const continued = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(answer.text),
    original: 'Can you set up restrictions?',
    answer: 'Set up stock protection. Ask me for the product, location if relevant, limit, and what should be blocked.',
  });
  assert.equal(continued.status, 303);
  assert.equal(continued.headers.location, '/actions');
  const next = await agent.get('/actions');
  const nextText = plain(next.text);
  assert.match(nextText, /Which product should Foundry protect/i);
  assert.match(nextText, /at what quantity/i);
  assert.doesNotMatch(nextText, /Which restriction do you want to set first/i,
    'choosing a restriction must advance instead of reopening the first menu');
  env.db.close();
});

test('Can you set restrictions uses the same guided choices as set up restrictions', async () => {
  const env = setup({
    understood: false, summary: '', changes: [], clarifyingQuestion: '',
    unsupportedReason: 'The restriction is incomplete.',
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const routed = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Can you set restrictions?',
  });

  assert.equal(routed.status, 303);
  assert.equal(routed.headers.location, '/actions');
  const answer = await agent.get('/actions');
  const text = plain(answer.text);
  assert.match(text, /Which restriction do you want to set first/i);
  assert.match(text, /Protect low stock/);
  assert.match(text, /Limit purchasing/);
  assert.match(text, /Limit transfers/);
  assert.doesNotMatch(text, /What should Foundry restrict:/i);
  assert.match(answer.text, /name="workflow" value="restriction_setup"/);
  assert.match(answer.text, /name="workflowKind" value="stock_protection"/);
  env.db.close();
});

test('an already-open stock-protection form checks any product answer even if temporary session state is gone', async () => {
  const env = setup({
    understood: false, summary: '', changes: [], clarifyingQuestion: '',
    unsupportedReason: 'The request is incomplete.',
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const routed = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    original: 'Can you set restrictions? — Clarification: Set up stock protection. Ask me for the product, location if relevant, limit, and what should be blocked.',
    answer: 'candy',
  });

  assert.match(routed.headers.location, /^\/operating-instructions\/oin_/);
  const review = await agent.get(routed.headers.location);
  const text = plain(review.text);
  assert.match(text, /I can’t find “candy” in this inventory/i);
  assert.match(text, /No restriction has been created/i);
  assert.match(text, /Create “candy”/i);
  assert.doesNotMatch(text, /Which product should Foundry protect/i);
  env.db.close();
});

test('an already-open stock-protection form accepts product, quantity and warning mode in one answer', async () => {
  const env = setup({
    understood: false, summary: '', changes: [], clarifyingQuestion: '',
    unsupportedReason: 'The request is incomplete.',
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const original = 'Can you set restrictions? — Clarification: Set up stock protection. Ask me for the product, location if relevant, limit, and what should be blocked.';

  const unknown = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), original,
    answer: 'Water at quantity of 10 only warn me',
  });
  assert.match(unknown.headers.location, /^\/operating-instructions\/oin_/);
  const unknownText = plain((await agent.get(unknown.headers.location)).text);
  assert.match(unknownText, /I can’t find “Water” in this inventory/i);
  assert.match(unknownText, /No restriction has been created/i);
  assert.doesNotMatch(unknownText, /Which product should Foundry protect/i);

  const known = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom((await agent.get('/')).text), original,
    answer: 'Canvas Apron Charcoal Short at quantity of 10 only warn me',
  });
  assert.match(known.headers.location, /^\/operating-instructions\/oin_/);
  const review = await agent.get(known.headers.location);
  const reviewText = plain(review.text);
  assert.match(reviewText, /warn when on-hand stock is at or below 10/i);
  assert.match(reviewText, /Outgoing stock remains allowed/i);
  assert.doesNotMatch(reviewText, /What should release the block/i);

  const approved = await agent.post(`${known.headers.location}/approve`).type('form').send({
    _csrf: csrfFrom(review.text),
    integrityHash: review.text.match(/name="integrityHash" value="([^"]+)"/)[1],
  });
  assert.equal(approved.status, 303);
  const guard = operatingGuards.list(env.db, env.workspace.workspaceId, { activeOnly: true })[0];
  assert.equal(guard.enforcementMode, 'warn');
  assert.equal(guard.threshold, 10);
  assert.equal(operatingGuards.evaluateIssue(env.db, env.workspace.workspaceId, {
    skuId: guard.skuId, locationId: env.workspace.main.id, quantity: 1,
  }), null, 'warning-only rules must never reject the outgoing movement');
  env.db.close();
});

test('an incomplete restriction becomes one answerable human question instead of a top toast', async () => {
  const env = setup({
    understood: false,
    summary: '',
    changes: [],
    clarifyingQuestion: '',
    unsupportedReason: 'The request is missing the supplier scope and threshold values needed to create a setting.',
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const routed = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'Set a supplier price tolerance for me',
  });

  assert.equal(routed.status, 303);
  assert.equal(routed.headers.location, '/actions');
  const answer = await agent.get('/actions');
  const text = plain(answer.text);
  assert.match(text, /Which supplier should this apply to/i);
  assert.match(text, /what percentage change may Foundry accept/i);
  assert.match(answer.text, /name="answer"/);
  assert.match(answer.text, /action="\/foundry\/tell"/);
  assert.doesNotMatch(answer.text, /flash--(?:warn|error)[^>]*>/i);
  assert.doesNotMatch(text, /missing the supplier scope and threshold values/i);
  env.db.close();
});

test('a restriction clarification stays in setup and explains an unknown product with real next choices', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Unknown Product Rules Co' });
  let operatingCalls = 0;
  const provider = {
    complete: async (request) => {
      if (request.schemaName === 'manager_intent') {
        return { data: {
          intentClass: 'QUESTION', confidence: 'high', reason: 'A short answer.',
          resolvedReference: '', clarifyingQuestion: '',
        } };
      }
      operatingCalls += 1;
      if (operatingCalls === 1) {
        return { data: {
          understood: false, summary: '', changes: [], clarifyingQuestion: '',
          unsupportedReason: 'The product and threshold are still missing.',
        } };
      }
      return { data: {
        understood: true, summary: 'Protect Snacks from low stock', clarifyingQuestion: '', unsupportedReason: '',
        changes: [{ ...blank(), domain: 'stock_protection', itemText: 'Snacks',
          guardMetric: 'network_on_hand', guardComparator: 'below' }],
      } };
    },
  };
  const app = createApp({ db, env: 'test', sessionSecret: 'unknown-product-rule', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const home = await agent.get('/');
  const opened = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Can you set up restrictions?',
  });
  const menu = await agent.get(opened.headers.location);
  const category = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(menu.text), original: 'Can you set up restrictions?',
    answer: 'Set up stock protection. Ask me for the product, location if relevant, limit, and what should be blocked.',
  });
  assert.equal(category.headers.location, '/actions');
  const productQuestion = await agent.get('/actions');
  const unknown = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(productQuestion.text),
    original: 'Can you set up restrictions? — Clarification: Set up stock protection. Ask me for the product, location if relevant, limit, and what should be blocked.',
    answer: 'snacks',
  });

  assert.match(unknown.headers.location, /^\/operating-instructions\/oin_/,
    'the short product answer must remain in restriction setup, never escape to Ask Foundry');
  const review = await agent.get(unknown.headers.location);
  const reviewText = plain(review.text);
  assert.match(reviewText, /I can’t find “Snacks” in this inventory/i);
  assert.match(reviewText, /No restriction has been created/i);
  assert.match(reviewText, /Create “Snacks”/i);
  assert.match(reviewText, /Try another product name/i);
  assert.doesNotMatch(reviewText, /Foundry cannot set up stock protection/i);
  assert.doesNotMatch(reviewText, /Exactly what Foundry understood/i);
  assert.doesNotMatch(reviewText, /this inventory: block outgoing/i);

  const createHref = review.text.match(/href="([^"]*\/inventory\/new\?name=Snacks[^\"]*)"/i)[1].replaceAll('&amp;', '&');
  const createPage = await agent.get(createHref);
  assert.match(createPage.text, /name="name" value="snacks"/i);
  const resumeInstructionId = createPage.text.match(/name="resumeInstructionId" value="([^"]+)"/)[1];
  const created = await agent.post('/inventory').type('form').send({
    _csrf: csrfFrom(createPage.text), resumeInstructionId,
    name: 'Snacks', baseCode: 'SNACKS', unitLabel: 'unit', trackingMode: 'quantity',
  });
  assert.match(created.headers.location, /^\/operating-instructions\/oin_/);
  const continued = await agent.get(created.headers.location);
  const continuedText = plain(continued.text);
  assert.match(continuedText, /Should Foundry block outgoing stock at the limit, or only warn you/i);
  assert.doesNotMatch(continuedText, /I can’t find “Snacks”/i);
  assert.ok(db.prepare("SELECT id FROM items WHERE workspace_id = ? AND name = 'Snacks'").get(workspace.workspaceId));
  assert.equal(operatingGuards.list(db, workspace.workspaceId, { activeOnly: true }).length, 0,
    'creating the missing product must not silently activate the restriction');
  db.close();
});
