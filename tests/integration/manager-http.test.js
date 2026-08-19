'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { fakeProvider } = require('../helpers/fake-provider');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, csrfFrom, plain } = require('../helpers');
const { makeQuantityItem } = require('../helpers');
const authService = require('../../src/domain/auth-service');
const supplierService = require('../../src/purchasing/supplier-service');
const purchasingPolicyService = require('../../src/purchasing/policy-service');
const poService = require('../../src/purchasing/po-service');
const repo = require('../../src/domain/repository');
const inventory = require('../../src/domain/inventory-engine');
const physicalEvents = require('../../src/manager/physical-events');

test.after(cleanupAll);

async function setup(response) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Manager HTTP Co' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'manager-http', aiProvider: fakeProvider(response) });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  return { ...store, workspace, agent };
}

test('Needs you is one consolidated, authenticated exception queue', async () => {
  const env = await setup({});
  const page = await env.agent.get('/needs-you');
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, /Exceptions only/);
  assert.match(text, /Operating inputs/);
  assert.match(text, /Investigations/);
  assert.match(text, /Physical events to match/);
  assert.match(text, /Decisions/);
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
  assert.match(detailText, /does not change recorded stock from 20 to 17/);
  const response = await env.agent.post(`/investigations/${event.investigationId}/resolve`).type('form').send({
    _csrf: csrfFrom(detail.text), note: 'A second count confirmed 17.',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/needs-you');

  const needsYou = plain((await env.agent.get('/needs-you')).text);
  assert.match(needsYou, /No investigations need you/);
  assert.doesNotMatch(needsYou, /I counted 17 Filter Cartridge/);
  assert.equal(env.db.prepare('SELECT status FROM physical_events WHERE id = ?').get(event.id).status, 'COMPLETED');
  env.db.close();
});

test('the universal input routes a policy request without changing policy on a guess', async () => {
  const env = await setup([
    { intentClass: 'POLICY_CHANGE', confidence: 'high', reason: 'Changes autonomy.',
      resolvedReference: '', clarifyingQuestion: '' },
    { understood: true, actionType: 'approve_purchase_order', name: 'Routine replenishment',
      maximumQuantity: 0, maximumValue: 500, maxUnitPriceChangePercent: 5,
      locationNames: [], supplierNames: [], dailyLimit: 0, unsupportedReason: '' },
  ]);
  const home = await env.agent.get('/');
  const response = await env.agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Never approve an order over $500',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, '/autopilot');
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
  const order = env.db.prepare("SELECT * FROM purchase_orders WHERE workspace_id = ? AND source = 'foundry_recommendation'")
    .get(env.workspace.workspaceId);
  assert.ok(order, 'the request must produce a concrete supported draft, not disappear into chat');
  assert.equal(order.status, 'DRAFT');
  const next = await env.agent.get('/');
  assert.match(plain(next.text), new RegExp(`${order.po_number} for Packaging Supply is ready to send`));
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

test('manager pages cannot be read without signing in', async () => {
  const store = makeDatabase();
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'manager-anon' });
  assert.equal((await request(app).get('/needs-you')).status, 302);
  assert.equal((await request(app).get('/investigations/not-real')).status, 302);
  store.db.close();
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
