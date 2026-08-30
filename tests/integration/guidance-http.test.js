'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const repo = require('../../src/domain/repository');
const engine = require('../../src/domain/inventory-engine');
const reorderPolicies = require('../../src/purchasing/policy-service');
const suppliers = require('../../src/purchasing/supplier-service');
const modes = require('../../src/autopilot/modes');
const guidance = require('../../src/manager/guidance');
const physicalEvents = require('../../src/manager/physical-events');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, plain, signIn } = require('../helpers');
const { configure } = require('../helpers/scenarios');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Guided Inventory' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'guidance-http' });
  return { db: store.db, workspace, membership, ctx: workspace.ctx, app };
}

async function ownerAgent(env) {
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  return agent;
}

test('a fresh inventory explains the first real step and deep-links to it', async () => {
  const env = setup();
  const agent = await ownerAgent(env);
  const response = await agent.get('/');
  const page = plain(response.text);

  assert.match(page, /Getting started/);
  assert.match(page, /The shortest path to a working inventory/);
  assert.match(page, /Set up products and locations/);
  assert.match(response.text, /href="\/onboarding"/);
  assert.match(page, /Foundry checks these off from your real records/);
  assert.doesNotMatch(page, /Learn more/);
});

test('the operating checklist completes from real records and becomes a next-best action', async () => {
  const env = setup();
  configure(env.db, env.workspace.workspaceId);
  const item = itemService.createItem(env.db, env.ctx, {
    name: 'Black T-shirt', baseCode: 'TEE', trackingMode: 'quantity',
  });
  const sku = repo.listSkusForItem(env.db, env.workspace.workspaceId, item.itemId)[0];

  let state = guidance.build(env.db, env.workspace.workspaceId);
  assert.equal(state.steps.find((step) => step.id === 'structure').complete, true);
  assert.equal(state.steps.find((step) => step.id === 'opening').complete, false);
  assert.match(state.examples[0], /opening inventory for Black T-shirt/);

  engine.adjust(env.db, env.ctx, {
    skuId: sku.id, locationId: env.workspace.main.id, countedQty: 20,
    reasonCode: 'physical_count', notes: 'starting inventory',
  });
  state = guidance.build(env.db, env.workspace.workspaceId);
  assert.equal(state.steps.find((step) => step.id === 'opening').complete, true);
  assert.equal(state.steps.find((step) => step.id === 'activity').complete, false,
    'opening stock itself is not treated as normal demand activity');
  assert.match(state.examples[0], /We sold 1 Black T-shirt/);

  engine.issue(env.db, env.ctx, {
    skuId: sku.id, locationId: env.workspace.main.id, quantity: 1, reasonCode: 'sold',
  });
  state = guidance.build(env.db, env.workspace.workspaceId);
  assert.equal(state.checklistActive, false);
  assert.match(state.next.title, /Set low-stock and replenishment rules for Black T-shirt/);
  assert.equal(state.next.href, `/purchasing/why/${sku.id}?guide=1#reorder-settings`);

  reorderPolicies.setPolicy(env.db, env.ctx, env.membership, sku.id, {
    reorderPoint: 5, targetStock: 20, safetyStock: 2,
  });
  state = guidance.build(env.db, env.workspace.workspaceId);
  assert.match(state.next.title, /Add a supplier for Black T-shirt/);
  assert.equal(state.next.href, `/purchasing/supplier-for/${sku.id}`);

  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Apparel Supply', defaultLeadTimeDays: 7,
  });
  suppliers.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: sku.id, purchaseUnit: 'unit',
    unitsPerPurchaseUnit: 1, lastUnitCost: 4, isPreferred: true,
  });
  state = guidance.build(env.db, env.workspace.workspaceId);
  assert.match(state.next.title, /Choose how Foundry should handle routine work/);
  assert.equal(state.next.href, '/autopilot');

  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  state = guidance.build(env.db, env.workspace.workspaceId);
  assert.equal(state.next.kind, 'clear');
  assert.match(state.next.title, /Everything is in order/);

  const agent = await ownerAgent(env);
  const home = plain((await agent.get('/')).text);
  assert.match(home, /What should I do next\?/);
  assert.match(home, /Everything is in order\. Nothing needs you right now\./);
});

test('the permanent task guide uses this inventory in examples and points to real task screens', async () => {
  const env = setup();
  configure(env.db, env.workspace.workspaceId);
  itemService.createItem(env.db, env.ctx, {
    name: 'Canvas Tote', baseCode: 'TOTE', trackingMode: 'quantity',
  });
  const agent = await ownerAgent(env);
  const response = await agent.get('/guide');
  const page = plain(response.text);

  for (const topic of [
    'Set up inventory', 'Record a sale', 'Receive stock', 'Move stock', 'Fix a count',
    'Set low-stock/reorder rules', 'Set up suppliers and purchase orders',
    'Receive a purchase order', 'Control what Foundry may do automatically',
    'Find what needs my attention',
  ]) assert.match(page, new RegExp(topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.match(page, /We sold 1 Canvas Tote/);
  assert.match(response.text, /href="\/autopilot"/);
  assert.match(response.text, /href="\/needs-you"/);
  assert.match(page, /How do I use Foundry\?/);
});

test('Tell Foundry examples change with the actual operating state', async () => {
  const env = setup();
  configure(env.db, env.workspace.workspaceId);
  itemService.createItem(env.db, env.ctx, {
    name: 'Canvas Tote', baseCode: 'TOTE', trackingMode: 'quantity',
  });
  const agent = await ownerAgent(env);

  const emptyLedger = plain((await agent.get('/')).text);
  assert.match(emptyLedger, /I want to enter opening inventory for Canvas Tote/);
  const actions = plain((await agent.get('/actions')).text);
  assert.match(actions, /I want to enter opening inventory for Canvas Tote/);
});

test('the next action reuses the real Needs you decision and links to the exact count', async () => {
  const env = setup();
  configure(env.db, env.workspace.workspaceId);
  const item = itemService.createItem(env.db, env.ctx, {
    name: 'Canvas Tote', baseCode: 'TOTE', trackingMode: 'quantity',
  });
  const sku = repo.listSkusForItem(env.db, env.workspace.workspaceId, item.itemId)[0];
  engine.receive(env.db, env.ctx, {
    skuId: sku.id, locationId: env.workspace.main.id, quantity: 20,
    reasonCode: 'opening_inventory', notes: 'Opening inventory',
  });
  engine.issue(env.db, env.ctx, {
    skuId: sku.id, locationId: env.workspace.main.id, quantity: 1, reasonCode: 'sold',
  });

  const event = await physicalEvents.recordNatural(
    env.db, env.ctx, 'I counted 17 Canvas Tote at Main Warehouse'
  );
  const state = guidance.build(env.db, env.workspace.workspaceId);

  assert.equal(state.checklistActive, false);
  assert.equal(state.next.kind, 'needs-you');
  assert.match(state.next.title, /Canvas Tote/);
  assert.match(state.next.why, /cannot tell which figure is right/i);
  assert.equal(state.next.href, `/investigations/${event.investigationId}`);

  const agent = await ownerAgent(env);
  const home = plain((await agent.get('/')).text);

  // Home shows that decision once. Because guidance builds its next-best action
  // by reusing the top Needs you item, rendering both put the same title, the
  // same paragraph and the same button on the page twice, centimetres apart.
  assert.match(home, /Canvas Tote/);
  assert.equal(
    (home.match(/Canvas Tote does not match the records/g) || []).length, 1,
    'the same decision is not stated twice on one page'
  );
  assert.doesNotMatch(home, /Do this now/,
    'the four-question treatment belongs on Needs you, not doubled onto Home');

  // And it still goes to the exact count, not to a list to search through.
  assert.match((await agent.get('/')).text, new RegExp(`/investigations/${event.investigationId}`));

  // The full contract is on Needs you, where the decision is actually made.
  const needsYou = plain((await agent.get('/needs-you')).text);
  assert.match(needsYou, /What happened\?/);
  assert.match(needsYou, /Canvas Tote/);
});
