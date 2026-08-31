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
const connectionService = require('../../src/connections/service');
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

test('a fresh inventory asks for the real source instead of assuming manual entry', async () => {
  const env = setup();
  const agent = await ownerAgent(env);
  const response = await agent.get('/');
  const page = plain(response.text);

  assert.match(page, /Do this next/);
  assert.match(page, /Do this next/);
  assert.match(page, /Choose where Foundry should get your inventory/);
  assert.match(page, /manual entry, file upload, approved email attachments, a connected POS\/ERP, or several sources/);
  assert.match(response.text, /href="\/onboarding"/);
  assert.match(page, /Setup progress/);
  assert.doesNotMatch(page, /Learn more/);
});

test('a completed source review outranks generic manual setup on Home', () => {
  const env = setup();
  const connection = connectionService.create(env.db, env.ctx, env.membership, {
    providerType: 'supplier_email', displayName: 'Inventory mailbox',
  }).connection;
  const now = new Date().toISOString();
  env.db.prepare(`INSERT INTO foundry_understandings
    (id, workspace_id, source_description, provider, model, payload, confidence, actor_user_id, created_at)
    VALUES ('under_source', ?, 'email attachment', 'test', 'test', '{}', 'high', ?, ?)`)
    .run(env.workspace.workspaceId, env.ctx.actorId, now);
  env.db.prepare(`INSERT INTO setup_documents
    (id, workspace_id, uploaded_by_user_id, understanding_id, source_name, source_mime,
     source_content, content_hash, extracted_text, interpretation, status, created_at)
    VALUES ('doc_source', ?, ?, 'under_source', 'inventory.pdf', 'application/pdf', X'01',
      'source-hash', 'inventory rows', '{}', 'PREPARED', ?)`)
    .run(env.workspace.workspaceId, env.ctx.actorId, now);
  env.db.prepare(`INSERT INTO connection_email_messages
    (id, workspace_id, connector_id, external_message_id, sender, recipients, received_at,
     trust_status, classification, processing_status, created_at)
    VALUES ('msg_source', ?, ?, 'external-source', 'records@example.test', '[]', ?,
      'TRUSTED', 'inventory_document', 'AWAITING_INVENTORY_REVIEW', ?)`)
    .run(env.workspace.workspaceId, connection.id, now, now);
  env.db.prepare(`INSERT INTO connection_email_attachments
    (id, workspace_id, message_id, filename, content_hash, content, setup_document_id, created_at)
    VALUES ('att_source', ?, 'msg_source', 'inventory.pdf', 'attachment-hash', X'01', 'doc_source', ?)`)
    .run(env.workspace.workspaceId, now);

  const state = guidance.build(env.db, env.workspace.workspaceId);
  assert.equal(state.next.kind, 'import');
  assert.match(state.next.title, /inventory\.pdf is ready for inventory review/);
  assert.equal(state.next.href, '/foundry/proposal/under_source');
  assert.doesNotMatch(state.next.title, /Add your first product|Choose where Foundry/);
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
  assert.equal(state.next.href, `/foundry/quantities/${item.itemId}`);

  engine.adjust(env.db, env.ctx, {
    skuId: sku.id, locationId: env.workspace.main.id, countedQty: 20,
    reasonCode: 'physical_count', notes: 'starting inventory',
  });
  state = guidance.build(env.db, env.workspace.workspaceId);
  assert.equal(state.steps.find((step) => step.id === 'opening').complete, true);
  assert.equal(state.steps.find((step) => step.id === 'supplier').complete, false);
  // "ABC Apparel supplies Black T-shirt in cases of 12" was suggested here, and
  // Foundry answers that sentence with "Foundry cannot store supplier catalogue
  // details like pricing, pack size or lead time". Suggesting a sentence the
  // product refuses teaches somebody that Tell Foundry does not work.
  assert.match(state.examples[0], /Help me add a supplier for Black T-shirt/);
  for (const example of state.examples) {
    assert.doesNotMatch(example, /supplies .* in cases of/,
      'no example promises something this box will refuse');
  }

  engine.issue(env.db, env.ctx, {
    skuId: sku.id, locationId: env.workspace.main.id, quantity: 1, reasonCode: 'sold',
  });
  state = guidance.build(env.db, env.workspace.workspaceId);
  assert.equal(state.checklistActive, true);
  assert.match(state.next.title, /Add who supplies Black T-shirt/);
  assert.equal(state.next.href, `/purchasing/supplier-for/${sku.id}`);

  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Apparel Supply', defaultLeadTimeDays: 7,
  });
  suppliers.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: sku.id, purchaseUnit: 'unit',
    unitsPerPurchaseUnit: 1, lastUnitCost: 4, isPreferred: true,
  });
  state = guidance.build(env.db, env.workspace.workspaceId);
  assert.match(state.next.title, /Decide when to reorder Black T-shirt/);
  assert.equal(state.next.href, `/purchasing/why/${sku.id}?guide=1#reorder-settings`);

  reorderPolicies.setPolicy(env.db, env.ctx, env.membership, sku.id, {
    reorderPoint: 5, targetStock: 20, safetyStock: 2,
  });
  state = guidance.build(env.db, env.workspace.workspaceId);
  assert.match(state.next.title, /Choose what Foundry may handle without asking you/);
  assert.equal(state.next.href, '/autopilot');

  // Background checks update the autopilot timestamp. That is not a human
  // authority decision and must not silently complete this setup step.
  env.db.prepare(
    'UPDATE workspace_autopilot SET updated_at = ?, last_evaluated_at = ? WHERE workspace_id = ?'
  ).run(new Date().toISOString(), new Date().toISOString(), env.workspace.workspaceId);
  state = guidance.build(env.db, env.workspace.workspaceId);
  assert.match(state.next.title, /Choose what Foundry may handle without asking you/);

  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');
  state = guidance.build(env.db, env.workspace.workspaceId);
  assert.equal(state.next.kind, 'clear');
  assert.match(state.next.title, /Foundry is managing inventory/);

  const agent = await ownerAgent(env);
  const home = plain((await agent.get('/')).text);
  assert.match(home, /Do this next/);
  assert.match(home, /Foundry is managing inventory/);
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
  const supplier = suppliers.createSupplier(env.db, env.ctx, env.membership, {
    name: 'Tote Supply', defaultLeadTimeDays: 5,
  });
  suppliers.linkItem(env.db, env.ctx, env.membership, {
    supplierId: supplier.id, skuId: sku.id, purchaseUnit: 'unit',
    unitsPerPurchaseUnit: 1, lastUnitCost: 4, isPreferred: true,
  });
  reorderPolicies.setPolicy(env.db, env.ctx, env.membership, sku.id, {
    reorderPoint: 5, targetStock: 20, safetyStock: 2,
  });
  modes.setMode(env.db, env.ctx, env.membership, 'POLICY_AUTOMATED');

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

  // The full contract is on Needs you, where the decision is actually made:
  // what happened, why Foundry stopped, what it suggests, and what is being
  // asked of the reader — each answered once, beside one specific action.
  const needsYou = plain((await agent.get('/needs-you')).text);
  assert.match(needsYou, /Canvas Tote/);
  assert.match(needsYou, /Why Foundry stopped/i);
  assert.match(needsYou, /Your decision/i);
  assert.match(needsYou, /Resolve the difference/, 'the action names the decision, not "Review"');
});

test('Needs you guidance names the real waiting decision even while setup is incomplete', async () => {
  const env = setup();
  configure(env.db, env.workspace.workspaceId);
  const item = itemService.createItem(env.db, env.ctx, {
    name: 'Canvas Tote', baseCode: 'TOTE-ACTIVE-SETUP', trackingMode: 'quantity',
  });
  const sku = repo.listSkusForItem(env.db, env.workspace.workspaceId, item.itemId)[0];
  engine.receive(env.db, env.ctx, {
    skuId: sku.id, locationId: env.workspace.main.id, quantity: 20,
    reasonCode: 'opening_inventory', notes: 'Opening inventory',
  });
  const event = await physicalEvents.recordNatural(
    env.db, env.ctx, 'I counted 17 Canvas Tote at Main Warehouse'
  );
  const state = guidance.build(env.db, env.workspace.workspaceId);
  assert.equal(state.checklistActive, true, 'supplier and replenishment setup are still incomplete');
  assert.notEqual(state.next.kind, 'needs-you', 'Home may still lead the setup sequence');

  const agent = await ownerAgent(env);
  const page = plain((await agent.get('/needs-you')).text);
  assert.match(page, /Do now:.*Canvas Tote does not match the records/i);
  assert.doesNotMatch(page, /Do now:\s*Nothing needs a decision from you/i);
  assert.match((await agent.get('/needs-you')).text, new RegExp(`/investigations/${event.investigationId}`));
  env.db.close();
});

/**
 * Setup must not send somebody back through the door they just came out of.
 *
 * Found by walking the new-owner scenario. Foundry read the business, agreed
 * the tracking model, created both locations and said "Your inventory is ready
 * — everything below is live now". Home then said "Do this next: choose where
 * Foundry should get your inventory", pointing at the screen just left, over a
 * progress bar reading 0 of 5.
 *
 * The step was genuinely incomplete — there were no products yet — but the one
 * thing missing was the one thing it did not say.
 */
test('a configured inventory is asked for its first product, not for a source again', async () => {
  const env = setup();
  configure(env.db, env.workspace.workspaceId);
  const agent = await ownerAgent(env);
  const page = plain((await agent.get('/')).text);

  assert.match(page, /Add the first thing you sell/,
    'the missing thing is a product, and it says so');
  assert.doesNotMatch(page, /Choose where Foundry should get your inventory/,
    'that question was answered by configuring the inventory');
  assert.match((await agent.get('/')).text, /href="\/inventory\/new"/,
    'and it goes where products are added');

  // The checklist says which half of the step is done rather than reading as
  // if nothing had happened.
  assert.match(page, /location(s)? ready\. No products yet\./);
});
