'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { fakeProvider } = require('../helpers/fake-provider');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, csrfFrom, plain } = require('../helpers');
const { makeQuantityItem, makeVariantItem } = require('../helpers');
const authService = require('../../src/domain/auth-service');
const supplierService = require('../../src/purchasing/supplier-service');
const purchasingPolicyService = require('../../src/purchasing/policy-service');
const poService = require('../../src/purchasing/po-service');
const repo = require('../../src/domain/repository');
const inventory = require('../../src/domain/inventory-engine');
const physicalEvents = require('../../src/manager/physical-events');
const documentRemovals = require('../../src/manager/document-removals');
const catalogCodeChanges = require('../../src/manager/catalog-code-changes');
const operatingGuards = require('../../src/domain/operating-guards');
const attention = require('../../src/attention/attention-engine');
const planService = require('../../src/imports/plan-service');
const importRemovals = require('../../src/manager/import-removals');

test.after(cleanupAll);

async function setup(response) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Manager HTTP Co' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'manager-http', aiProvider: fakeProvider(response) });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  return { ...store, workspace, agent };
}

function operatingChange(overrides = {}) {
  return {
    operation: 'set', domain: 'replenishment', itemText: '', variantText: '', locationText: '', sourceLocationText: '', supplierText: '',
    reorderPoint: -1, targetStock: -1, safetyStock: -1, locationMinimum: -1, locationTarget: -1,
    leadTimeDays: -1, unitsPerPurchaseUnit: -1, minimumOrderQuantity: -1, orderMultiple: -1,
    maximumQuantity: -1, maximumValue: -1, cooldownHours: -1, daysOfStock: -1,
    purchaseUnit: '', contactName: '', email: '', orderingMethod: '',
    preferTransferBeforePurchasing: false, approvalRequired: true,
    guardAction: '', guardMetric: '', guardComparator: '', guardThreshold: -1,
    guardReleaseCondition: '', guardReleaseThreshold: -1, ...overrides,
  };
}

function operatingResult(changes, summary = 'Operating rule') {
  return { understood: true, summary, changes, clarifyingQuestion: '', unsupportedReason: '' };
}

test('Needs you is one consolidated, authenticated exception queue', async () => {
  const env = await setup({});
  const page = await env.agent.get('/needs-you');
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, /things Foundry cannot settle itself/i);
  // The queue is one list now rather than a section per internal mechanism, so
  // the contract is what is asserted: an empty inbox says so once, plainly, and
  // does not name physical events, investigations or work items at a customer.
  assert.match(text, /Nothing is waiting/);
  for (const internal of [/physical event/i, /work item/i, /attention item/i, /proposal/i]) {
    assert.doesNotMatch(text, internal, 'internal vocabulary must not reach the page');
  }
  env.db.close();
});

test('Tell Foundry turns a missing transfer destination into a visible setup preview', async () => {
  const env = await setup({
      lines: [{
        actionType: 'transfer', item: 'Filter Cartridge', variant: '', lotCode: '', serials: [],
        sourceLocation: 'Main Warehouse', destinationLocation: 'Overflow Warehouse',
        quantity: 2, adjustmentTarget: -1, reasonCode: '',
        terminologyKey: '', terminologyValue: '', productName: '', productCode: '',
        variantAxes: '', unitLabel: '', supplier: '', purchaseUnit: '',
      }],
      clarifyingQuestion: '', unsupportedReason: '',
  });
  const item = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Filter Cartridge' });
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: item.skuId, locationId: env.workspace.main.id, quantity: 10,
  });

  const home = await env.agent.get('/');
  const response = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'Move 2 Filter Cartridge from Main Warehouse to Overflow Warehouse',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/actions/location-required');

  const preview = plain((await env.agent.get('/actions/location-required')).text);
  assert.match(preview, /Overflow Warehouse does not exist yet/);
  assert.match(preview, /Create location and continue/);
  assert.match(preview, /The transfer remains a separate preview/);
  assert.equal(env.db.prepare(
    'SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ? AND name = ?'
  ).get(env.workspace.workspaceId, 'Overflow Warehouse').n, 0);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id), 10);
  env.db.close();
});

test('resolving an investigation clears the linked physical event from Needs you', async () => {
  const env = await setup({});
  const item = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Filter Cartridge' });
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: item.skuId, locationId: env.workspace.main.id, quantity: 20,
  });
  const event = await physicalEvents.recordNatural(env.db, env.workspace.ctx,
    'I counted 17 Filter Cartridge at Main Warehouse');

  const pending = plain((await env.agent.get('/needs-you')).text);
  assert.match(pending, /Recount Filter Cartridge/);
  assert.doesNotMatch(pending, /I counted 17 Filter Cartridge/,
    'a matched event is represented by its investigation, not duplicated as unmatched');

  const detail = await env.agent.get(`/investigations/${event.investigationId}`);
  const detailText = plain(detail.text);
  assert.match(detailText, /The physical count does not match the inventory record/);
  assert.match(detailText, /Recorded\s+20\s+in Foundry/);
  assert.match(detailText, /Counted\s+17\s+reported physically/);
  assert.match(detailText, /Difference\s+3\s+3 fewer than recorded/);
  assert.match(detailText, /Neither button changes stock/);

  // This is the "the records were right" half: it closes the investigation and
  // deliberately leaves the ledger alone.
  const response = await env.agent.post(`/investigations/${event.investigationId}/resolve`).type('form').send({
    _csrf: csrfFrom(detail.text), note: 'The miscount was mine; the shelf really holds 20.',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/needs-you');
  assert.equal(
    repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id),
    20,
    'closing without correcting must not move the balance'
  );

  const needsYou = plain((await env.agent.get('/needs-you')).text);
  // Resolved means gone from the inbox, not moved to a quieter section of it.
  assert.doesNotMatch(needsYou, /does not match the records/,
    'the investigation must leave Needs you the moment it is settled');
  assert.doesNotMatch(needsYou, /I counted 17 Filter Cartridge/);
  assert.equal(env.db.prepare('SELECT status FROM physical_events WHERE id = ?').get(event.id).status, 'COMPLETED');
  env.db.close();
});

test('the universal input routes a policy request without changing policy on a guess', async () => {
  const env = await setup(operatingResult([
    operatingChange({ domain: 'purchase_authority', supplierText: '', maximumValue: 500 }),
  ], 'Purchasing limit'));
  const home = await env.agent.get('/');
  const response = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Never approve an order over $500',
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/operating-instructions\//);
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM automation_policies WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 0);
  assert.equal(env.db.prepare('SELECT intent_class FROM manager_intents').get().intent_class, 'POLICY_CHANGE');
  env.db.close();
});

test('"order what we need" runs the manager loop and prepares supported purchasing work', async () => {
  const env = await setup({ intentClass: 'PURCHASING_REQUEST', confidence: 'high',
    reason: 'The operator asked Foundry to assess replenishment.', resolvedReference: '', clarifyingQuestion: '' });
  const membership = authService.getMembership(env.db, env.workspace.workspaceId, env.workspace.accountId);
  const item = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Packing Tape' });
  const supplier = supplierService.createSupplier(env.db, env.workspace.ctx, membership, { name: 'Packaging Supply' });
  supplierService.linkItem(env.db, env.workspace.ctx, membership, { supplierId: supplier.id, skuId: item.skuId,
    supplierSku: 'TAPE-01', purchaseUnit: 'case', unitsPerPurchaseUnit: 6, lastUnitCost: 2, isPreferred: true });
  purchasingPolicyService.setPolicy(env.db, env.workspace.ctx, membership, item.skuId,
    { reorderPoint: 1, targetStock: 12 });
  env.db.prepare(
    `INSERT INTO workspace_configuration
       (workspace_id, configured_at, configuration_version, terminology, operational_defaults, inventory_model, updated_at)
     VALUES (?, datetime('now'), 1, '{}', '{}', '{"primaryArchetype":"quantity"}', datetime('now'))`
  ).run(env.workspace.workspaceId);

  const home = await env.agent.get('/');
  const response = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Order what we need',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/');
  // A general "order what we need" is a replenishment question, so the answer
  // is the replenishment decision — which explains the level, the position and
  // the quantity — rather than a bare draft order the customer is asked to
  // approve without ever seeing why. Asking for a specific product by name
  // still drafts that order directly; that path is unchanged.
  //
  // What this test protects is the same: the request produces something
  // concrete and named, not a summary that disappears into chat.
  const workItems = require('../../src/autopilot/work-items');
  const plan = workItems.list(env.db, env.workspace.workspaceId, { category: 'replenishment_plan' })[0];
  assert.ok(plan, 'the request must produce concrete work, not disappear into chat');
  assert.equal(plan.executionStatus, 'WAITING_FOR_APPROVAL');
  assert.equal((plan.affectedEntities || {}).displayName, 'Packing Tape', 'and it names the product');

  const next = plain((await env.agent.get('/')).text);
  assert.match(next, /Packing Tape needs replenishing/, 'named on the home page too');
  assert.doesNotMatch(next, /No purchase is currently supported/,
    'a plan was prepared, so saying nothing is supported is false');
  env.db.close();
});

test('"handle everything" opens bounded authority review and never grants unlimited authority', async () => {
  const env = await setup({ intentClass: 'POLICY_CHANGE', confidence: 'high', reason: 'Changes autonomy.',
    resolvedReference: '', clarifyingQuestion: '' });
  const home = await env.agent.get('/');
  const response = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Handle everything you safely can',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/autopilot');
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM automation_policies WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 0);
  const review = await env.agent.get('/autopilot');
  assert.match(plain(review.text), /policy review, never unlimited permission/);
  assert.match(plain(review.text), /bounded transfer and purchasing policies/);
  env.db.close();
});

test('Tell Foundry prepares a remembered vendor-code mapping without changing codes before approval', async () => {
  const env = await setup({});
  const membership = authService.getMembership(env.db, env.workspace.workspaceId, env.workspace.accountId);
  const item = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Boys Dress Oxford', baseCode: 'SH-204-BRN' });
  const supplier = supplierService.createSupplier(env.db, env.workspace.ctx, membership, {
    name: 'Step & Style Wholesale', itemCodeLabel: 'Style Number',
  });
  supplierService.linkItem(env.db, env.workspace.ctx, membership, {
    supplierId: supplier.id, skuId: item.skuId, supplierSku: 'SH-204-BRN',
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
  });

  const home = await env.agent.get('/');
  const routed = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Change vendor code SH-204-BRN to my code OXFORD-BROWN',
  });
  assert.equal(routed.status, 303);
  assert.match(routed.headers.location, /^\/supplier-code-mappings\/scmp_/);
  assert.equal(repo.requireSku(env.db, env.workspace.workspaceId, item.skuId).code, 'SH-204-BRN');

  const preview = await env.agent.get(routed.headers.location);
  assert.equal(preview.status, 200);
  assert.match(plain(preview.text), /Vendor code SH-204-BRN/);
  assert.match(plain(preview.text), /Your code OXFORD-BROWN/);
  assert.match(plain(preview.text), /Future documents will still match SH-204-BRN/);
  assert.match(plain(preview.text), /No quantities, receipts, supplier codes, costs, or movement history will change/);
  env.db.close();
});

test('universal Tell Foundry keeps the all-locations continuation through its redirect', async () => {
  const env = await setup({
    lines: [{
      actionType: 'receive', item: 'Display Hook', variant: '', sourceText: 'received 1 Display Hook',
      lotCode: '', serials: [], sourceLocation: '', destinationLocation: '', quantity: 1,
      adjustmentTarget: -1, reasonCode: '', terminologyKey: '', terminologyValue: '',
      productName: '', productCode: '', variantAxes: '', unitLabel: '', supplier: '', purchaseUnit: '',
    }],
    clarifyingQuestion: '', unsupportedReason: '',
  });
  makeQuantityItem(env.db, env.workspace.ctx, { name: 'Display Hook', baseCode: 'HOOK-1' });
  const home = await env.agent.get('/');
  const asked = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'We received 1 Display Hook.',
  });
  assert.equal(asked.status, 303);
  assert.equal(asked.headers.location, '/actions');
  const question = await env.agent.get('/actions');
  assert.match(plain(question.text), /Both locations/);
  const continuationId = /name="continuationId" value="([^"]+)"/.exec(question.text)?.[1];
  assert.ok(continuationId);
  const answered = await env.agent.post('/actions/ask').type('form').send({
    _csrf: csrfFrom(question.text), original: 'We received 1 Display Hook.',
    answer: '__all_locations__', continuationId,
  });
  assert.equal(answered.status, 303, plain(answered.text));
  assert.match(answered.headers.location, /^\/actions\/plan\/apl_/);
  const plan = plain((await env.agent.get(answered.headers.location)).text);
  assert.match(plan, /Downtown Store/);
  assert.match(plan, /Main Warehouse/);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM action_proposals WHERE plan_id IS NOT NULL').get().n, 2);
  env.db.close();
});

test('Tell Foundry prepares and atomically applies a catalogue-wide code prefix change', async () => {
  const env = await setup({});
  const first = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Classic T-Shirt', baseCode: 'TS-BLK' });
  const second = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Straight Jeans', baseCode: 'TS-JEAN' });
  const untouched = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Zip Hoodie', baseCode: 'HD-NVY' });

  const home = await env.agent.get('/');
  const routed = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'Can you replace the first two letters of the code for each item from TS to ME',
  });
  assert.equal(routed.status, 303);
  assert.match(routed.headers.location, /^\/catalog-code-changes\/ccp_/);
  const preview = await env.agent.get(routed.headers.location);
  const text = plain(preview.text);
  assert.match(text, /TS-BLK → ME-BLK/);
  assert.match(text, /TS-JEAN → ME-JEAN/);
  assert.doesNotMatch(text, /HD-NVY →/);
  assert.equal(repo.requireItem(env.db, env.workspace.workspaceId, first.itemId).base_code, 'TS-BLK',
    'previewing changes nothing');

  const id = routed.headers.location.split('/').pop();
  const proposal = catalogCodeChanges.get(env.db, env.workspace.workspaceId, id);
  const approved = await env.agent.post(`${routed.headers.location}/approve`).type('form').send({
    _csrf: csrfFrom(preview.text), integrityHash: proposal.integrityHash,
  });
  assert.equal(approved.status, 303);
  assert.equal(repo.requireItem(env.db, env.workspace.workspaceId, first.itemId).base_code, 'ME-BLK');
  assert.equal(repo.requireSku(env.db, env.workspace.workspaceId, first.skuId).code, 'ME-BLK');
  assert.equal(repo.requireItem(env.db, env.workspace.workspaceId, second.itemId).base_code, 'ME-JEAN');
  assert.equal(repo.requireSku(env.db, env.workspace.workspaceId, second.skuId).code, 'ME-JEAN');
  assert.equal(repo.requireItem(env.db, env.workspace.workspaceId, untouched.itemId).base_code, 'HD-NVY');
  env.db.close();
});

test('manager pages cannot be read without signing in', async () => {
  const store = makeDatabase();
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'manager-anon' });
  assert.equal((await request(app).get('/needs-you')).status, 302);
  assert.equal((await request(app).get('/investigations/not-real')).status, 302);
  store.db.close();
});

test('Home confirms a selected attachment and a file-only Tell Foundry request reaches its preview', async () => {
  const env = await setup({});
  env.db.prepare(
    `INSERT INTO workspace_configuration
       (workspace_id, configured_at, configuration_version, terminology, operational_defaults, inventory_model, updated_at)
     VALUES (?, datetime('now'), 1, '{}', '{}', '{"primaryArchetype":"quantity"}', datetime('now'))`
  ).run(env.workspace.workspaceId);
  const home = await env.agent.get('/');
  assert.match(home.text, /data-operator-attachment/);
  assert.match(home.text, /data-operator-attachment-status/);
  assert.match(plain(home.text), /Attach file/);

  const csv = [
    'Item Name,SKU,Warehouse,Qty On Hand',
    'Copper Elbow,CE-050,Main Warehouse,140',
  ].join('\n');
  const response = await env.agent.post('/foundry/tell')
    .field('_csrf', csrfFrom(home.text))
    .attach('file', Buffer.from(csv, 'utf8'), { filename: 'opening-stock.csv', contentType: 'text/csv' });

  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/imports\/imp_/);
  const preview = plain((await env.agent.get(response.headers.location)).text);
  assert.match(preview, /Copper Elbow/);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0,
    'reading the attachment must still wait for review before creating inventory');
  env.db.close();
});

test('Tell Foundry treats an attached pricing sheet as updates to exact SKU codes and never creates products', async () => {
  const env = await setup({});
  const existing = makeQuantityItem(env.db, env.workspace.ctx, {
    name: 'Black Jeans / Small', baseCode: 'JEANS-BLACK-S',
  });
  const home = await env.agent.get('/');
  const csv = [
    'SKU,Selling Price',
    'JEANS-BLACK-S,12.00',
    'NOT-IN-INVENTORY,99.00',
  ].join('\n');
  const response = await env.agent.post('/foundry/tell')
    .field('_csrf', csrfFrom(home.text))
    .field('message', 'Take a look at this sheet and update the pricing accordingly')
    .attach('file', Buffer.from(csv, 'utf8'), { filename: 'prices.csv', contentType: 'text/csv' });

  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/imports\/imp_/);
  const importId = response.headers.location.split('/').pop();
  const plan = planService.get(env.db, env.workspace.workspaceId, importId);
  assert.equal(plan.transformations.operationScope, 'selling_price_update');
  assert.equal(plan.recordsValid, 1);
  assert.equal(plan.recordsInvalid, 1, 'an unknown SKU is blocked rather than created');

  const preview = await env.agent.get(response.headers.location);
  const previewText = plain(preview.text);
  assert.match(previewText, /selling-price update/i);
  assert.match(previewText, /create no products and change no stock quantities/i);
  assert.match(previewText, /USD 12\.00/);
  assert.match(previewText, /NOT-IN-INVENTORY does not match exactly one active SKU code/i);
  assert.doesNotMatch(previewText, /just create the products/i);

  const token = csrfFrom(preview.text);
  const hash = /name="integrityHash" value="([^"]+)"/.exec(preview.text)[1];
  await env.agent.post(`${response.headers.location}/approve`).type('form').send({ _csrf: token, integrityHash: hash });
  await env.agent.post(`${response.headers.location}/run`).type('form').send({ _csrf: token });

  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ? AND base_code = ?')
    .get(env.workspace.workspaceId, 'NOT-IN-INVENTORY').n, 0);
  const price = env.db.prepare(`SELECT amount_minor FROM sku_prices
    WHERE workspace_id = ? AND sku_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(env.workspace.workspaceId, existing.skuId);
  assert.equal(price.amount_minor, 1200);
  env.db.close();
});

test('newly added products resolve to the latest import and allow subset or select-all removal', async () => {
  const env = await setup({});
  const home = await env.agent.get('/');
  const csv = [
    'Item Name,SKU',
    'Imported One,NEW-ONE',
    'Imported Two,NEW-TWO',
    'Imported Three,NEW-THREE',
  ].join('\n');
  const uploaded = await env.agent.post('/foundry/tell')
    .field('_csrf', csrfFrom(home.text))
    .attach('file', Buffer.from(csv, 'utf8'), { filename: 'new-products.csv', contentType: 'text/csv' });
  const preview = await env.agent.get(uploaded.headers.location);
  const hash = /name="integrityHash" value="([^"]+)"/.exec(preview.text)[1];
  const token = csrfFrom(preview.text);
  await env.agent.post(`${uploaded.headers.location}/approve`).type('form').send({ _csrf: token, integrityHash: hash });
  await env.agent.post(`${uploaded.headers.location}/run`).type('form').send({ _csrf: token });
  const unrelated = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Unrelated Existing Product', baseCode: 'OLD-ONE' });

  const after = await env.agent.get('/');
  const asked = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(after.text), message: 'Remove the newly added inventory products',
  });
  assert.equal(asked.status, 303);
  assert.match(asked.headers.location, /^\/import-removals\/irp_/);
  const page = await env.agent.get(asked.headers.location);
  const text = plain(page.text);
  assert.match(text, /new-products\.csv/i);
  assert.match(text, /Imported One/);
  assert.match(text, /Imported Two/);
  assert.match(text, /Imported Three/);
  assert.doesNotMatch(text, /Unrelated Existing Product/);
  assert.match(text, /Select all/);
  assert.match(text, /Remove all 3/);

  const proposalId = asked.headers.location.split('/').pop();
  const proposal = importRemovals.get(env.db, env.workspace.workspaceId, proposalId);
  const one = proposal.snapshot.items.find((item) => item.name === 'Imported One');
  await env.agent.post(`${asked.headers.location}/approve`).type('form').send({
    _csrf: csrfFrom(page.text), integrityHash: proposal.integrityHash,
    selectionMode: 'selected', itemIds: one.id,
  });
  assert.equal(env.db.prepare('SELECT is_active FROM items WHERE id = ?').get(one.id).is_active, 0);
  assert.equal(env.db.prepare('SELECT is_active FROM items WHERE id = ?').get(unrelated.itemId).is_active, 1);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM items
    WHERE workspace_id = ? AND is_active = 1 AND base_code LIKE 'NEW-%'`).get(env.workspace.workspaceId).n, 2);

  const againHome = await env.agent.get('/');
  const again = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(againHome.text), message: 'Remove the newly added inventory products',
  });
  const allPage = await env.agent.get(again.headers.location);
  const allProposal = importRemovals.get(env.db, env.workspace.workspaceId, again.headers.location.split('/').pop());
  await env.agent.post(`${again.headers.location}/approve`).type('form').send({
    _csrf: csrfFrom(allPage.text), integrityHash: allProposal.integrityHash, selectionMode: 'all',
  });
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM items
    WHERE workspace_id = ? AND is_active = 1 AND base_code LIKE 'NEW-%'`).get(env.workspace.workspaceId).n, 0);
  assert.equal(env.db.prepare('SELECT is_active FROM items WHERE id = ?').get(unrelated.itemId).is_active, 1);
  env.db.close();
});

test('an unmatched supplier invoice becomes an exact inventory review instead of a generic exception', async () => {
  const interpretation = {
    documentType: 'invoice', businessDescription: 'New shoe inventory from Step & Style Wholesale.', unitLabel: 'pair',
    supplierName: 'Step & Style Wholesale', supplierCodeLabel: 'Style #', supplierEmail: '',
    documentNumber: 'INV-NEW-1', documentDate: '2026-08-26', paymentTerms: '', currency: 'USD',
    destinationName: 'Main Warehouse', destinationAddress: '',
    lines: [{ styleName: 'Kids Loafer', color: 'Black', variantDimension: 'Size', size: '23',
      supplierSku: 'SH-101-BLK', description: 'Kids Loafer Black size 23', quantity: 12, unitCost: 11.5 }],
    warnings: [],
  };
  const env = await setup(interpretation);
  env.db.prepare(
    `INSERT INTO workspace_configuration
       (workspace_id, configured_at, configuration_version, terminology, operational_defaults, inventory_model, updated_at)
     VALUES (?, datetime('now'), 1, '{}', '{}', '{"primaryArchetype":"quantity"}', datetime('now'))`
  ).run(env.workspace.workspaceId);
  makeQuantityItem(env.db, env.workspace.ctx, { name: 'Classic Cotton T-Shirt', baseCode: 'TS-BLK' });

  const home = await env.agent.get('/');
  const routed = await env.agent.post('/foundry/tell')
    .field('_csrf', csrfFrom(home.text))
    .field('message', 'This is a supplier invoice')
    .attach('file', Buffer.from('Step & Style Wholesale\nINV-NEW-1\nSH-101-BLK Kids Loafer Black 23 Qty 12'),
      { filename: 'new-shoes.txt', contentType: 'text/plain' });

  assert.equal(routed.status, 303);
  assert.match(routed.headers.location, /^\/foundry\/proposal\/und_/);
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM physical_events WHERE workspace_id = ? AND status = ?')
    .get(env.workspace.workspaceId, 'NEEDS_HUMAN').n, 0);
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 1,
    'reading the invoice must not create inventory before approval');

  const review = await env.agent.get(routed.headers.location);
  const reviewText = plain(review.text);
  assert.match(reviewText, /what Foundry read from your file/i);
  assert.match(reviewText, /Kids Loafer/);
  assert.match(reviewText, /Black/);
  assert.match(reviewText, /23/);
  assert.match(reviewText, /12 pairs/);
  assert.match(reviewText, /This file looks different from Manager HTTP Co/i);
  assert.match(reviewText, /Already here Classic Cotton T-Shirt/i);

  const blocked = await env.agent.post(`${routed.headers.location}/configure`).type('form').send({
    _csrf: csrfFrom(review.text), supplierCodeLabel: 'Style #',
  });
  assert.equal(blocked.status, 303);
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 1);

  const confirmed = await env.agent.post(`${routed.headers.location}/configure`).type('form').send({
    _csrf: csrfFrom(review.text), scopeDecision: 'confirm',
  });
  assert.equal(confirmed.status, 303);
  const resumed = await env.agent.get(confirmed.headers.location);
  assert.match(plain(resumed.text), /Nothing changes until you approve the exact records below/i);
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 1,
    'confirming the destination inventory must not apply the document');

  const approved = await env.agent.post(`${routed.headers.location}/configure`).type('form').send({
    _csrf: csrfFrom(resumed.text), supplierCodeLabel: 'Style #',
  });
  assert.equal(approved.status, 303);
  assert.match(plain((await env.agent.get(approved.headers.location)).text), /existing inventory setup was not changed/i);
  assert.equal(env.db.prepare('SELECT configuration_version FROM workspace_configuration WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).configuration_version, 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 2);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId,
    env.db.prepare("SELECT sku_id AS id FROM supplier_items WHERE workspace_id = ? AND supplier_sku = 'SH-101-BLK'")
      .get(env.workspace.workspaceId).id,
    env.workspace.main.id), 12);

  const afterImport = await env.agent.get('/');
  const removalRequest = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(afterImport.text),
    message: 'Can you delete the newly added items from the document provided earlier?',
  });
  assert.equal(removalRequest.status, 303);
  assert.match(removalRequest.headers.location, /^\/document-removals\/drp_/);
  const removalPage = await env.agent.get(removalRequest.headers.location);
  const removalText = plain(removalPage.text);
  assert.match(removalText, /Foundry traced these products to new-shoes\.txt/i);
  assert.match(removalText, /Kids Loafer - Black/i);
  assert.match(removalText, /Current stock 12/i);
  assert.doesNotMatch(removalText, /Attach the spreadsheet, PDF or document/i);
  assert.equal(env.db.prepare("SELECT is_active FROM items WHERE workspace_id = ? AND name LIKE 'Kids Loafer%'")
    .get(env.workspace.workspaceId).is_active, 1, 'the review must not remove the product');

  const proposalId = removalRequest.headers.location.split('/').pop();
  const removal = documentRemovals.get(env.db, env.workspace.workspaceId, proposalId);
  const removed = await env.agent.post(`${removalRequest.headers.location}/approve`).type('form').send({
    _csrf: csrfFrom(removalPage.text), integrityHash: removal.integrityHash,
  });
  assert.equal(removed.status, 303);
  assert.equal(env.db.prepare("SELECT is_active FROM items WHERE workspace_id = ? AND name LIKE 'Kids Loafer%'")
    .get(env.workspace.workspaceId).is_active, 0);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId,
    env.db.prepare("SELECT sku_id AS id FROM supplier_items WHERE workspace_id = ? AND supplier_sku = 'SH-101-BLK'")
      .get(env.workspace.workspaceId).id, env.workspace.main.id), 0);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM items WHERE workspace_id = ? AND is_active = 1")
    .get(env.workspace.workspaceId).n, 1, 'the earlier T-shirt remains active');
  env.db.close();
});

test('a photo is kept as physical evidence instead of being forced through spreadsheet import', async () => {
  const env = await setup({});
  const home = await env.agent.get('/');
  const response = await env.agent.post('/foundry/tell')
    .field('_csrf', csrfFrom(home.text))
    .field('message', 'This delivery arrived damaged')
    .attach('file', Buffer.from([137, 80, 78, 71]), { filename: 'damage.png', contentType: 'image/png' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/needs-you');
  const event = env.db.prepare('SELECT * FROM physical_events').get();
  assert.equal(event.event_type, 'damage');
  assert.equal(event.attachment_name, 'damage.png');
  assert.equal(event.attachment_mime, 'image/png');
  assert.deepEqual([...event.attachment_content], [137, 80, 78, 71]);
  env.db.close();
});

test('an operational document is read, matched to one PO, and becomes a verified receipt preview', async () => {
  const interpretation = {
    documentType: 'invoice', businessDescription: 'ABC Supply delivered Filter Cartridge inventory.', unitLabel: 'unit',
    supplierName: 'ABC Supply', supplierCodeLabel: 'Vendor Item No.', supplierEmail: '', documentNumber: 'DEL-900', documentDate: '2026-08-17',
    paymentTerms: '', currency: 'USD', destinationName: 'Main Warehouse', destinationAddress: '',
    lines: [{ styleName: 'Filter Cartridge', color: '', variantDimension: '', size: '', supplierSku: 'FC-100',
      description: 'Filter Cartridge', quantity: 12, unitCost: 4.5 }], warnings: [],
  };
  const env = await setup(interpretation);
  const membership = authService.getMembership(env.db, env.workspace.workspaceId, env.workspace.accountId);
  const item = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Filter Cartridge' });
  const supplier = supplierService.createSupplier(env.db, env.workspace.ctx, membership, { name: 'ABC Supply' });
  supplierService.linkItem(env.db, env.workspace.ctx, membership, { supplierId: supplier.id, skuId: item.skuId,
    supplierSku: 'FC-100', purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 4.5, isPreferred: true });
  let order = poService.createOrder(env.db, env.workspace.ctx, membership, { supplierId: supplier.id,
    destinationLocationId: env.workspace.main.id, lines: [{ skuId: item.skuId, quantityUnits: 12 }] });
  order = poService.approve(env.db, env.workspace.ctx, membership, order.id, { expectedHash: order.integrityHash, markOrdered: true });
  const before = repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id);
  const home = await env.agent.get('/');
  const routed = await env.agent.post('/foundry/tell')
    .field('_csrf', csrfFrom(home.text)).field('message', 'This supplier shipment arrived')
    .attach('file', Buffer.from('DEL-900\nABC Supply\nFC-100 Filter Cartridge quantity 12\nShip to Main Warehouse'),
      { filename: 'delivery-note.txt', contentType: 'text/plain' });
  assert.equal(routed.status, 303);
  assert.match(routed.headers.location, new RegExp(`/purchasing/orders/${order.id}/receive\\?event=`));
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id), before,
    'reading and matching the document changes no stock');

  const preview = await env.agent.get(routed.headers.location);
  assert.equal(preview.status, 200);
  assert.match(plain(preview.text), /Foundry prepared this from delivery-note.txt/);
  assert.match(preview.text, new RegExp(`name="qty_${order.lines[0].id}"[^>]*value="12"`));
  const event = env.db.prepare('SELECT * FROM physical_events WHERE workspace_id = ?').get(env.workspace.workspaceId);
  const received = await env.agent.post(`/purchasing/orders/${order.id}/receive`).type('form').send({
    _csrf: csrfFrom(preview.text), [`qty_${order.lines[0].id}`]: '12',
    [`location_${order.lines[0].id}`]: env.workspace.main.id,
    reference: 'DEL-900', note: 'Prepared from document', physicalEventId: event.id,
  });
  assert.equal(received.status, 302);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.main.id), before + 12);
  assert.equal(env.db.prepare('SELECT status FROM physical_events WHERE id = ?').get(event.id).status, 'COMPLETED');
  const learnedSupplier = supplierService.getSupplier(env.db, env.workspace.workspaceId, supplier.id);
  assert.equal(learnedSupplier.itemCodeLabel, 'Supplier code');
  assert.ok(learnedSupplier.itemCodeAliases.includes('Vendor Item No.'));
  env.db.close();
});

/**
 * Recorded 8, counted 5, confirmed — and then the ledger still said 8 while
 * Needs you said nothing was waiting. Closing the investigation was never meant
 * to write a balance, and still does not; it prepares the ordinary correction
 * and that correction waits for approval like any other.
 */
test('confirming a count prepares the correction, and Needs you stays actionable until it is approved', async () => {
  const env = await setup({});
  const item = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Black T-shirt' });
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: item.skuId, locationId: env.workspace.store.id, quantity: 8,
  });
  const event = await physicalEvents.recordNatural(env.db, env.workspace.ctx,
    'I counted 5 Black T-shirt at Downtown Store');
  assert.equal(event.status, 'NEEDS_HUMAN');

  const detail = await env.agent.get(`/investigations/${event.investigationId}`);
  const confirm = await env.agent.post(`/investigations/${event.investigationId}/resolve`).type('form').send({
    _csrf: csrfFrom(detail.text),
    correct: '1',
    note: 'I counted the shelf again and confirmed there are 5.',
  });

  // It goes to the prepared correction, not to an empty exceptions list.
  assert.equal(confirm.status, 303);
  assert.match(confirm.headers.location, /^\/actions\/act_/);
  const proposalId = confirm.headers.location.split('/').pop();

  // Nothing has moved yet.
  assert.equal(
    repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.store.id),
    8,
    'confirming must not write the balance by itself'
  );

  // The correction carries the count and the words it was confirmed with.
  const preview = plain((await env.agent.get(`/actions/${proposalId}`)).text);
  assert.match(preview, /8/);
  assert.match(preview, /5/);
  assert.match(preview, /counted the shelf again/i);

  // And Needs you still has something to do, because the ledger is still wrong.
  const midway = plain((await env.agent.get('/needs-you')).text);
  assert.match(midway, /A change is prepared and waiting for you/,
    'the prepared correction is still an item, with what it is and what it needs');
  assert.match(midway, /Review and approve/, 'and one obvious action');
  assert.doesNotMatch(midway, /Nothing is waiting/,
    'the ledger is known to be wrong, so Needs you must not report all clear');

  // Approving it runs the correction through the normal engine path.
  const approvePage = await env.agent.get(`/actions/${proposalId}`);
  const approved = await env.agent.post(`/actions/${proposalId}/approve`).type('form').send({
    _csrf: csrfFrom(approvePage.text), confirm: 'on',
  });
  assert.equal(approved.status, 303);
  // Execution is its own GET-after-POST landing, so follow it.
  await env.agent.get(approved.headers.location);

  assert.equal(
    repo.getBalance(env.db, env.workspace.workspaceId, item.skuId, env.workspace.store.id),
    5,
    'the ledger now agrees with the confirmed count'
  );
  assert.equal(inventory.verifyIntegrity(env.db, env.workspace.workspaceId).ok, true);

  // What the person actually looks at. The reported symptom was the Inventory
  // screen still showing the old figure, so the screen is asserted, not just
  // the row underneath it.
  const itemPage = plain((await env.agent.get(`/inventory/${item.itemId}`)).text);
  assert.match(itemPage, /Downtown Store\s*5/,
    'the item page must show the corrected quantity at that location');
  assert.match(itemPage, /Corrected|Adjusted/i, 'and the correction appears in its recent activity');

  const activity = plain((await env.agent.get('/activity')).text);
  assert.match(activity, /Black T-shirt/);
  assert.match(activity, /8 to 5|Adjusted/i, 'the ledger entry is visible in Activity');

  // Only now is the correction gone from Needs you. (This fixture has never
  // sold anything, so the "tell Foundry when you sell something" input is still
  // legitimately waiting — asserting a globally empty queue would be asserting
  // an unrelated fact about the fixture.)
  const settled = plain((await env.agent.get('/needs-you')).text);
  assert.doesNotMatch(settled, /A change is prepared and waiting for you/,
    'once approved it leaves the inbox immediately');
  assert.doesNotMatch(settled, /does not match the records/, 'and so does the investigation');
  assert.doesNotMatch(settled, /Black T-shirt.*8.*5/);
  env.db.close();
});

/**
 * A sale bigger than the stock is understood, refused, and explained.
 *
 * The four endings a sale can have are asserted together because the bug was
 * that two of them were the same ending: a refusal by an inventory rule was
 * filed as a report Foundry could not place, which is what "missing
 * information" means everywhere else in the product.
 */
const locationService = require('../../src/domain/location-service');

function saleProvider({ quantity, intentClass = 'PHYSICAL_EVENT', variant = 'Black / Large', item = 'Black T-shirt' }) {
  return fakeProvider((req) => {
    if (req.schemaName === 'manager_intent') {
      return { intentClass, confidence: 'high', reason: 'A sale is something that happened.',
        resolvedReference: '', clarifyingQuestion: '' };
    }
    if (req.schemaName === 'physical_inventory_event') {
      return { eventType: 'reported_event', skuId: '', locationId: '', countedQuantity: -1,
        reason: 'A sale is not a count.' };
    }
    if (req.schemaName === 'inventory_action_intent') {
      return { lines: [{ actionType: 'issue', item, variant, lotCode: '', serials: [],
        sourceLocation: 'Downtown Store', destinationLocation: '', quantity,
        adjustmentTarget: -1, reasonCode: 'sold', terminologyKey: '', terminologyValue: '',
        productName: '', productCode: '', variantAxes: '', unitLabel: '', supplier: '', purchaseUnit: '' }],
        clarifyingQuestion: '', unsupportedReason: '' };
    }
    return {};
  });
}

async function shopWithFourLarge(provider) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Downtown Co' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'sale-block', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const downtown = store.db
    .prepare("SELECT id, name FROM locations WHERE workspace_id = ? AND name = 'Downtown Store'")
    .get(workspace.workspaceId)
    || locationService.createLocation(store.db, workspace.ctx, { name: 'Downtown Store', kind: 'store' });
  const item = makeVariantItem(store.db, workspace.ctx, {
    name: 'Black T-shirt',
    options: [{ name: 'Colour', values: 'Black, White' }, { name: 'Size', values: 'Large, Small' }],
  });
  const large = item.byLabel('Black / Large');
  inventory.receive(store.db, workspace.ctx, { skuId: large.id, locationId: downtown.id, quantity: 4 });
  const tell = async (message) => {
    const home = await agent.get('/');
    const res = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message });
    return { res, landed: await agent.get(res.headers.location.split('#')[0]) };
  };
  const balance = () => (store.db
    .prepare('SELECT on_hand FROM balances WHERE sku_id = ? AND location_id = ?')
    .get(large.id, downtown.id) || { on_hand: 0 }).on_hand;
  return { ...store, workspace, agent, downtown, item, large, tell, balance };
}

test('a sale within stock goes to the ordinary approval, and nothing moves until it is approved', async () => {
  const env = await shopWithFourLarge(saleProvider({ quantity: 3 }));
  const { res, landed } = await env.tell('We sold 3 Black Large at Downtown Store');
  assert.match(res.headers.location, /^\/actions\//, 'a sale it can do becomes a proposal to approve');
  const text = plain(landed.text);
  assert.match(text, /Downtown Store/);
  assert.equal(env.balance(), 4, 'a proposal on its own does not move stock');
  assert.equal(env.db.prepare("SELECT COUNT(*) c FROM physical_events WHERE status = 'NEEDS_HUMAN'").get().c, 0);
  env.db.close();
});

test('an unclear Tell Foundry request becomes an orange answerable continuation, never a blue top message', async () => {
  let classifications = 0;
  const env = await setup((req) => {
    if (req.schemaName !== 'manager_intent') return {};
    classifications += 1;
    return classifications === 1
      ? { intentClass: 'UNKNOWN', confidence: 'low', reason: 'The requested outcome is unclear.',
          resolvedReference: '', clarifyingQuestion: 'Which inventory outcome do you want?' }
      : { intentClass: 'QUESTION', confidence: 'high', reason: 'The clarification says this is a question.',
          resolvedReference: '', clarifyingQuestion: '' };
  });
  const home = await env.agent.get('/');
  const first = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Do something with the blue line',
  });
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, '/actions');

  const continuation = await env.agent.get('/actions');
  const text = plain(continuation.text);
  assert.match(text, /Which inventory outcome do you want/i);
  assert.match(continuation.text, /value="Do something with the blue line"/i);
  assert.match(continuation.text, /act-question--warning/);
  assert.match(continuation.text, /action="\/foundry\/tell"/);
  assert.doesNotMatch(continuation.text, /flash--info[^>]*>[^<]*Which inventory outcome/i);

  const answered = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(continuation.text),
    original: 'Do something with the blue line',
    answer: 'This is a question about my current inventory.',
  });
  assert.equal(answered.status, 303);
  assert.match(answered.headers.location, /^\/ask\?q=/);
  assert.match(decodeURIComponent(answered.headers.location), /Do something with the blue line.*Clarification:.*question about my current inventory/i);
  env.db.close();
});

test('Tell Foundry treats an exact SKU code as the variant even when the reader calls it a lot', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'SKU identity QA' });
  const item = makeVariantItem(store.db, workspace.ctx, {
    name: 'Straight Jeans - Blue', baseCode: 'JN-BLU-28',
    options: [{ name: 'Size', values: '28' }],
  });
  const size28 = item.byLabel('28');
  inventory.receive(store.db, workspace.ctx, {
    skuId: size28.id, locationId: workspace.main.id, quantity: 16,
  });
  const provider = fakeProvider((req) => {
    if (req.schemaName === 'manager_intent') {
      return { intentClass: 'PHYSICAL_EVENT', confidence: 'high', reason: 'A sale happened.',
        resolvedReference: '', clarifyingQuestion: '' };
    }
    if (req.schemaName === 'physical_inventory_event') {
      return { eventType: 'reported_event', skuId: '', locationId: '', countedQuantity: -1,
        reason: 'A sale is not a count.' };
    }
    if (req.schemaName === 'inventory_action_intent') {
      return { lines: [{
        actionType: 'issue', item: 'Straight Jeans - Blue Quantity Variants', variant: '',
        lotCode: 'JN-BLU-28', serials: [], sourceLocation: 'Main Warehouse', destinationLocation: '',
        quantity: 1, adjustmentTarget: -1, reasonCode: 'sold', terminologyKey: '', terminologyValue: '',
        productName: '', productCode: '', variantAxes: '', unitLabel: '', supplier: '', purchaseUnit: '',
      }], clarifyingQuestion: '', unsupportedReason: '' };
    }
    return {};
  });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'sku-identity', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const home = await agent.get('/');
  const response = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'I sold 1 Straight Jeans - Blue Quantity Variants JN-BLU-28',
  });

  assert.match(response.headers.location, /^\/actions\/act_/);
  const preview = plain((await agent.get(response.headers.location)).text).replace(/\s+/g, ' ');
  assert.match(preview, /Straight Jeans - Blue \/ 28/);
  assert.match(preview, /Main Warehouse/);
  assert.doesNotMatch(preview, /There is no lot/);
  assert.equal(repo.getBalance(store.db, workspace.workspaceId, size28.id, workspace.main.id), 16,
    'the sale is still only a preview');
  store.db.close();
});

test('a complete past-tense sale bypasses an UNKNOWN manager answer and reaches the grounded preview', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Natural sale routing QA' });
  const item = makeVariantItem(store.db, workspace.ctx, {
    name: 'Straight Jeans - Blue', baseCode: 'JN-BLU',
    options: [{ name: 'Size', values: '28, 30' }],
  });
  const size28 = item.byLabel('28');
  inventory.receive(store.db, workspace.ctx, {
    skuId: size28.id, locationId: workspace.main.id, quantity: 10,
  });
  let managerClassifierCalls = 0;
  const provider = fakeProvider((req) => {
    if (req.schemaName === 'manager_intent') {
      managerClassifierCalls += 1;
      return { intentClass: 'UNKNOWN', confidence: 'low', reason: 'Incorrect generic fallback.',
        resolvedReference: '', clarifyingQuestion: 'What would you like Foundry to do with the inventory?' };
    }
    if (req.schemaName === 'inventory_action_intent') {
      return { lines: [{
        actionType: 'issue', item: 'Straight Jeans - Blue', variant: '28', sourceText: '1 Straight Jeans - Blue size 28',
        lotCode: '', serials: [], sourceLocation: 'Main Warehouse', destinationLocation: '', quantity: 1,
        adjustmentTarget: -1, reasonCode: 'sold', terminologyKey: '', terminologyValue: '',
        productName: '', productCode: '', variantAxes: '', unitLabel: '', supplier: '', purchaseUnit: '',
      }], clarifyingQuestion: '', unsupportedReason: '' };
    }
    return {};
  });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'natural-sale-routing', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const home = await agent.get('/');
  const response = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'I sold 1 Straight Jeans - Blue size 28 at Main Warehouse.',
  });

  assert.equal(managerClassifierCalls, 0, 'clear transaction grammar must not be demoted by a model answer');
  assert.match(response.headers.location, /^\/actions\/act_/);
  const preview = plain((await agent.get(response.headers.location)).text).replace(/\s+/g, ' ');
  assert.match(preview, /Straight Jeans - Blue \/ 28/);
  assert.match(preview, /Main Warehouse/);
  assert.doesNotMatch(preview, /What would you like Foundry to do/i);
  assert.equal(repo.getBalance(store.db, workspace.workspaceId, size28.id, workspace.main.id), 10,
    'the sale remains a preview until approval');
  store.db.close();
});

test('Tell Foundry preserves a supplied split-catalogue attribute and asks only for the missing axis', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Split catalogue Tell Foundry QA' });
  for (const colour of ['Black', 'White']) {
    for (const size of ['Small', 'Medium', 'Large']) {
      makeVariantItem(store.db, workspace.ctx, {
        name: `Classic Cotton T-Shirt - ${colour}`,
        options: [{ name: 'Size', values: size }],
      });
    }
  }
  const provider = fakeProvider((req) => {
    if (req.schemaName === 'inventory_action_intent') {
      return { lines: [{
        actionType: 'issue', item: 'Classic Cotton T-Shirt', variant: 'White',
        sourceText: '15 Classic Cotton T-Shirt - White', lotCode: '', serials: [],
        sourceLocation: '', destinationLocation: '', quantity: 15, adjustmentTarget: -1,
        reasonCode: 'sold', terminologyKey: '', terminologyValue: '', productName: '', productCode: '',
        variantAxes: '', unitLabel: '', supplier: '', purchaseUnit: '',
      }], clarifyingQuestion: '', unsupportedReason: '' };
    }
    return {};
  });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'split-catalogue-home', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const home = await agent.get('/');
  const response = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'I sold 15 Classic Cotton T-Shirt - White',
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/actions');
  const asked = await agent.get('/actions');
  const page = plain(asked.text);
  assert.match(page, /Which size of Classic Cotton T-Shirt - White do you mean\?/);
  assert.doesNotMatch(page, /Classic Cotton T-Shirt - Black/);
  for (const size of ['Small', 'Medium', 'Large']) {
    assert.match(asked.text, new RegExp(`name="answer" value="${size}"`));
  }
  store.db.close();
});

test('Tell Foundry previews reorder language in the same settings the UI saves', async () => {
  const env = await setup(operatingResult([
    operatingChange({ domain: 'replenishment', itemText: 'T-shirt', variantText: 'Black Small', reorderPoint: 60, targetStock: 80 }),
  ], 'Black Small replenishment'));
  const item = makeVariantItem(env.db, env.workspace.ctx, {
    name: 'T-shirt',
    options: [
      { name: 'Colour', values: 'Black, White' },
      { name: 'Size', values: 'Small, Large' },
    ],
  });
  const blackSmall = item.byLabel('Black / Small');
  const home = await env.agent.get('/');
  const routed = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'Reorder Black Small at 60 and bring it back to 80.',
  });
  assert.equal(routed.status, 303);
  assert.match(routed.headers.location, /^\/operating-instructions\//);
  assert.equal(purchasingPolicyService.effectivePolicy(env.db, env.workspace.workspaceId, blackSmall.id).isSet, false,
    'reading the sentence must not save the rule');

  const preview = await env.agent.get(routed.headers.location);
  const text = plain(preview.text);
  assert.match(text, /reorder at 60/i);
  assert.match(text, /bring the network position to 80/i);

  const saved = await env.agent.post(`${routed.headers.location}/approve`).type('form').send({
    _csrf: csrfFrom(preview.text), integrityHash: preview.text.match(/name="integrityHash" value="([^"]+)"/)[1],
  });
  assert.equal(saved.status, 303);
  const policy = purchasingPolicyService.effectivePolicy(env.db, env.workspace.workspaceId, blackSmall.id);
  assert.equal(policy.reorderPoint, 60);
  assert.equal(policy.targetStock, 80);
  env.db.close();
});

test('Tell Foundry previews a variant-and-location minimum and the shared control enforces it', async () => {
  const env = await setup(operatingResult([
    operatingChange({ domain: 'location_stock', itemText: 'T-shirt', variantText: 'Black Small', locationText: 'Downtown Store', locationMinimum: 20 }),
  ], 'Downtown keep-back'));
  const item = makeVariantItem(env.db, env.workspace.ctx, {
    name: 'T-shirt',
    options: [
      { name: 'Colour', values: 'Black, White' },
      { name: 'Size', values: 'Small, Large' },
    ],
  });
  const blackSmall = item.byLabel('Black / Small');
  const home = await env.agent.get('/');
  const routed = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'Never let Black Small fall below 20 at Downtown Store.',
  });
  assert.equal(routed.status, 303);
  assert.match(routed.headers.location, /^\/operating-instructions\//);
  const preview = await env.agent.get(routed.headers.location);
  assert.match(plain(preview.text), /keep at least 20/i);
  assert.equal(purchasingPolicyService.locationPolicies(env.db, env.workspace.workspaceId, blackSmall.id).length, 0);

  const saved = await env.agent.post(`${routed.headers.location}/approve`).type('form').send({
    _csrf: csrfFrom(preview.text), integrityHash: preview.text.match(/name="integrityHash" value="([^"]+)"/)[1],
  });
  assert.equal(saved.status, 303);
  assert.deepEqual(
    purchasingPolicyService.locationPolicies(env.db, env.workspace.workspaceId, blackSmall.id)
      .map((row) => ({ locationId: row.locationId, minimum: row.minimum })),
    [{ locationId: env.workspace.store.id, minimum: 20 }]
  );

  // The saved UI rule must be the rule used by the ordinary workspace scan,
  // not merely something that reappears in the form.
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: blackSmall.id, locationId: env.workspace.main.id, quantity: 30,
  });
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: blackSmall.id, locationId: env.workspace.store.id, quantity: 1,
  });
  const signalEngine = require('../../src/signals/signal-engine');
  const replenishmentPlan = require('../../src/purchasing/replenishment-plan');
  const scan = replenishmentPlan.planWorkspace(
    env.db,
    env.workspace.workspaceId,
    { skus: signalEngine.skuSignals(env.db, env.workspace.workspaceId) }
  );
  const planned = scan.plans.find((entry) => entry.skuId === blackSmall.id);
  const downtown = planned.byLocation.find((entry) => entry.locationId === env.workspace.store.id);
  assert.equal(downtown.reserveFloor, 20, 'Check now uses this exact variant/location minimum');
  assert.equal(downtown.need, 20);
  env.db.close();
});

test('Tell Foundry routes a direct currency assignment to a selling-price preview', async () => {
  const env = await setup({});
  makeQuantityItem(env.db, env.workspace.ctx, { name: 'Black Jeans', baseCode: 'JEANS-BLACK-S' });

  const home = await env.agent.get('/');
  const response = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'Can you set JEANS-BLACK-S to $12 each',
  });

  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/pricing\/proposals\//);
  const preview = plain((await env.agent.get(response.headers.location)).text);
  assert.match(preview, /Review the selling price/i);
  assert.match(preview, /\$12\.00/);
  assert.match(preview, /Nothing changes until you approve/i);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM sku_prices WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 0);
  env.db.close();
});

test('Tell Foundry previews and approves one list of different selling prices', async () => {
  const env = await setup({});
  const black = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Black Jeans', baseCode: 'JEANS-BLACK-S' });
  const navy = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Navy Jeans', baseCode: 'JEANS-NAVY-M' });
  const home = await env.agent.get('/');
  const response = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'Set these selling prices:\nJEANS-BLACK-S: $12.00 each\nJEANS-NAVY-M: $18.75 each',
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/pricing/proposals/batch');
  const batchPage = await env.agent.get('/pricing/proposals/batch');
  const preview = plain(batchPage.text);
  assert.match(preview, /Review 2 selling prices/i);
  assert.match(preview, /JEANS-BLACK-S/);
  assert.match(preview, /\$12\.00/);
  assert.match(preview, /JEANS-NAVY-M/);
  assert.match(preview, /\$18\.75/);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM sku_prices WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 0);

  const pending = env.db.prepare(`SELECT id, integrity_hash FROM price_change_proposals
    WHERE workspace_id = ? AND status = 'PENDING' ORDER BY created_at, rowid`).all(env.workspace.workspaceId);
  const body = { _csrf: csrfFrom(batchPage.text) };
  pending.forEach((proposal) => { body[`approval[${proposal.id}]`] = proposal.integrity_hash; });
  const approved = await env.agent.post('/pricing/proposals/batch/approve').type('form').send(body);
  assert.equal(approved.status, 303);
  assert.equal(env.db.prepare('SELECT amount_minor FROM sku_prices WHERE sku_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(black.skuId).amount_minor, 1200);
  assert.equal(env.db.prepare('SELECT amount_minor FROM sku_prices WHERE sku_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(navy.skuId).amount_minor, 1875);
  env.db.close();
});

test('Tell Foundry carries each multi-sale clause into one correctly grouped preview', async () => {
  const provider = fakeProvider((req) => {
    if (req.schemaName === 'manager_intent') {
      return { intentClass: 'PHYSICAL_EVENT', confidence: 'high', reason: 'A sale happened.',
        resolvedReference: '', clarifyingQuestion: '' };
    }
    if (req.schemaName === 'physical_inventory_event') {
      return { eventType: 'reported_event', skuId: '', locationId: '', countedQuantity: -1,
        reason: 'This sale contains several stock lines.' };
    }
    if (req.schemaName === 'inventory_action_intent') {
      const line = (variant) => ({
        actionType: 'issue', item: 'Black T-shirt', variant, lotCode: '', serials: [],
        sourceLocation: 'Downtown Store', destinationLocation: '', quantity: 2,
        adjustmentTarget: -1, reasonCode: 'sold', terminologyKey: '', terminologyValue: '',
        productName: '', productCode: '', variantAxes: '', unitLabel: '', supplier: '', purchaseUnit: '',
      });
      // Deliberately omit each colour and sourceText, reproducing the live
      // parser shape. Clause provenance must recover Black and White from the
      // person's exact request, independently.
      return { lines: [line('Large'), line('Small')], clarifyingQuestion: '', unsupportedReason: '' };
    }
    return {};
  });

  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Multi-sale QA' });
  const item = makeVariantItem(store.db, workspace.ctx, {
    name: 'Black T-shirt',
    options: [{ name: 'Colour', values: 'Black, White' }, { name: 'Size', values: 'Small, Large' }],
  });
  for (const sku of item.skus) {
    inventory.receive(store.db, workspace.ctx, {
      skuId: sku.id, locationId: workspace.store.id, quantity: 10,
    });
  }
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'multi-sale', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const home = await agent.get('/');
  const response = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'We sold 2 Black Large and 2 White Small at Downtown Store.',
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/actions\/plan\//,
    'the universal Tell Foundry input must end on one grouped action preview');

  const preview = plain((await agent.get(response.headers.location)).text).replace(/\s+/g, ' ');
  assert.match(preview, /several changes/i);
  assert.match(preview, /Black T-shirt \/ Black \/ Large/);
  assert.match(preview, /Black T-shirt \/ White \/ Small/);
  assert.doesNotMatch(preview, /Which .*T-shirt do you mean/i);
  for (const sku of item.skus) {
    assert.equal(repo.getBalance(store.db, workspace.workspaceId, sku.id, workspace.store.id), 10,
      'the grouped preview must not change any stock before approval');
  }
  store.db.close();
});

test('a sale larger than stock is refused by name, not filed as missing information', async () => {
  const env = await shopWithFourLarge(saleProvider({ quantity: 10 }));
  const { res, landed } = await env.tell('We sold 10 Black Large at Downtown Store');
  assert.equal(res.headers.location, '/actions', 'the refusal goes back to the person who asked');
  const text = plain(landed.text).replace(/\s+/g, ' ');

  // The actual constraint, with both numbers, in the words of the rule.
  assert.match(text, /cannot record it/i);
  assert.match(text, /take 10 .*Black \/ Large.* out of Downtown Store, where 4 are recorded/i);
  assert.match(text, /does not allow stock to go below zero/i);
  assert.match(text, /Nothing has been changed/i);

  // And the three ways out, each naming what it would do.
  assert.match(text, /recorded number is wrong/i);
  assert.match(text, /Record 4 instead/i);

  // None of the things that made this confusing.
  assert.doesNotMatch(text, /Add details/i);
  assert.doesNotMatch(text, /could not place it/i);

  assert.equal(env.balance(), 4, 'a refused sale changes nothing');
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM movements').get().c, 1, 'only the original receipt');
  env.db.close();
});

test('a refusal by a rule is never left waiting in Needs you', async () => {
  const env = await shopWithFourLarge(saleProvider({ quantity: 10 }));
  await env.tell('We sold 10 Black Large at Downtown Store');

  const stuck = env.db
    .prepare("SELECT event_type, status FROM physical_events WHERE status = 'NEEDS_HUMAN'").all();
  assert.deepEqual(stuck, [], 'validation failure must not leave a generic event behind');

  const routed = env.db.prepare('SELECT status, routed_to FROM manager_intents ORDER BY created_at DESC').get();
  assert.equal(routed.status, 'REFUSED', 'declined by a rule is its own outcome, not clarification');

  const needsYou = plain((await env.agent.get('/needs-you')).text).replace(/\s+/g, ' ');
  assert.doesNotMatch(needsYou, /Black \/ Large/, 'nothing about this sale is waiting for a person');
  env.db.close();
});

test('a protected stock boundary appears as one orange Needs You warning and its refusal is orange too', async () => {
  const env = await shopWithFourLarge(saleProvider({ quantity: 1 }));
  const membership = authService.getMembership(env.db, env.workspace.workspaceId, env.workspace.accountId);
  operatingGuards.set(env.db, env.workspace.ctx, membership, {
    skuId: env.large.id, actionType: 'issue', metric: 'location_on_hand', locationId: env.downtown.id,
    comparator: 'below', threshold: 4, releaseCondition: 'stock_recovered', releaseThreshold: 4,
    source: 'tell_foundry', statedAs: 'Do not let this location fall below four.',
  });
  attention.evaluate(env.db, env.workspace.workspaceId, { trigger: 'rule-approved' });

  const needsPage = await env.agent.get('/needs-you');
  const needsText = plain(needsPage.text);
  assert.match(needsText, /Black T-shirt.*Black \/ Large is at its protected stock limit/i);
  assert.match(needsText, /4 on hand at Downtown Store.*protected limit 4/i);
  assert.match(needsPage.text, /badge--warn/);

  const warning = attention.listAttention(env.db, env.workspace.workspaceId, {
    category: 'stock_protection_boundary',
  })[0];
  const detail = await env.agent.get(`/attention/${warning.attentionId}`);
  assert.match(plain(detail.text), /Review stock and ordering/i);
  assert.match(detail.text, new RegExp(`/inventory/${env.item.itemId}`));

  const { landed } = await env.tell('We sold 1 Black Large at Downtown Store');
  assert.match(plain(landed.text), /Stock protection stopped this outgoing stock/i);
  assert.match(landed.text, /act-question--warning/);
  assert.doesNotMatch(landed.text, /act-question--muted/);
  assert.equal(env.balance(), 4, 'the warning never weakens the enforcement rule');
  env.db.close();
});

test('a sale Foundry genuinely cannot resolve still asks, and still records nothing', async () => {
  const env = await shopWithFourLarge(saleProvider({ quantity: 2, variant: '' }));
  const { res, landed } = await env.tell('We sold 2 Black T-shirt at Downtown Store');
  assert.equal(res.headers.location, '/actions');
  const text = plain(landed.text).replace(/\s+/g, ' ');
  assert.match(text, /Black T-shirt/);
  // Ambiguity is a question. It must not borrow the refusal's wording.
  assert.doesNotMatch(text, /does not allow stock to go below zero/i);
  assert.equal(env.balance(), 4);
  env.db.close();
});

test('an item allowed to go negative is not refused by a rule it does not have', async () => {
  const env = await shopWithFourLarge(saleProvider({ quantity: 10 }));
  env.db.prepare('UPDATE items SET allow_negative = 1 WHERE name = ?').run('Black T-shirt');
  const { res } = await env.tell('We sold 10 Black Large at Downtown Store');
  assert.match(res.headers.location, /^\/actions\//,
    'the engine would accept this, so Foundry must not refuse it first');
  env.db.close();
});
