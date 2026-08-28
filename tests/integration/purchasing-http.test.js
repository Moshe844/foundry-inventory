'use strict';

/**
 * Purchasing over HTTP, as a browser actually drives it.
 *
 * These are the cases a browser causes by itself — a double-submitted approve,
 * a refreshed receiving form, someone opening a URL they have no permission
 * for — plus the one that matters most for money: asking Foundry what to order,
 * acting on it, and asking again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const engine = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const replenishment = require('../../src/purchasing/replenishment');
const policyService = require('../../src/purchasing/policy-service');
const position = require('../../src/purchasing/position');
const repo = require('../../src/domain/repository');
const { localDateKey, addLocalDays } = require('../../src/lib/calendar');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, makeVariantItem, csrfFrom, plain, signIn } = require('../helpers');

test.after(cleanupAll);

const DAY = 24 * 60 * 60 * 1000;

/** A wholesaler with one product, one supplier and a month of trading. */
function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Harbour Clothing' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Navy Oxford' });

  const supplier = suppliers.createSupplier(store.db, workspace.ctx, membership, {
    name: 'ABC Footwear',
    contactName: 'Dana Ruiz',
    email: 'orders@abcfootwear.test',
    defaultLeadTimeDays: 21,
  });
  suppliers.linkItem(store.db, workspace.ctx, membership, {
    supplierId: supplier.id,
    skuId: item.skuId,
    supplierSku: 'OX-NV-08',
    purchaseUnit: 'case',
    unitsPerPurchaseUnit: 12,
    minimumOrderQuantity: 2,
    lastUnitCost: 8.2,
    leadTimeDays: 21,
  });

  engine.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 40 });
  store.db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  const stmt = store.db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
  for (let i = 0; i < 6; i += 1) {
    const result = engine.issue(store.db, workspace.ctx, {
      skuId: item.skuId, locationId: workspace.main.id, quantity: 5, reasonCode: 'sold',
    });
    for (const id of result.movementIds) stmt.run(new Date(Date.now() - (28 - i * 4) * DAY).toISOString(), id);
  }
  store.db.exec(
    `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
     BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
  );

  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'purchasing-http-test' });
  return { ...store, workspace, membership, item, supplier, app };
}

async function owner(env) {
  const agent = request.agent(env.app);
  const session = await signIn(agent, env.workspace.account.email);
  return { agent, session };
}

test('the plan page shows what to order, with the reasoning a click away', async () => {
  const env = setup();
  const { agent } = await owner(env);

  const page = await agent.get('/purchasing');
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, /Foundry prepared today's replenishment/);
  assert.match(text, /ABC Footwear/);
  assert.match(text, /Navy Oxford/);
  assert.match(text, /reorder point/);

  const why = await agent.get(`/purchasing/why/${env.item.skuId}`);
  assert.equal(why.status, 200);
  const evidence = plain(why.text);
  for (const label of ['On hand', 'On order', 'Inventory position', 'Lead time', 'Reorder point', 'Order up to', 'Recommended']) {
    assert.match(evidence, new RegExp(label));
  }
  assert.match(evidence, /The calculation, step by step/);
});

test('the supplier page separates the vendor code from our code and applies only an approved mapping', async () => {
  const env = setup();
  const { agent } = await owner(env);
  const page = await agent.get(`/suppliers/${env.supplier.id}`);
  assert.equal(page.status, 200);
  const text = plain(page.text);
  assert.match(text, /Supplier code \(vendor\)/);
  assert.match(text, /Your code/);
  assert.match(text, /Vendor codes → your codes/);
  assert.match(text, /OX-NV-08/);

  const beforeCode = repo.requireSku(env.db, env.workspace.workspaceId, env.item.skuId).code;
  const proposed = await agent.post(`/suppliers/${env.supplier.id}/code-mappings`).type('form').send({
    _csrf: csrfFrom(page.text), vendorCode: 'OX-NV-08', internalBaseCode: 'OUR-OXFORD',
  });
  assert.equal(proposed.status, 303);
  assert.match(proposed.headers.location, /^\/supplier-code-mappings\/scmp_/);
  assert.equal(repo.requireSku(env.db, env.workspace.workspaceId, env.item.skuId).code, beforeCode);

  const review = await agent.get(proposed.headers.location);
  assert.match(plain(review.text), /Future documents will still match OX-NV-08/);
  const approved = await agent.post(`${proposed.headers.location}/apply`).type('form').send({
    _csrf: csrfFrom(review.text),
  });
  assert.equal(approved.status, 303);
  assert.equal(repo.requireSku(env.db, env.workspace.workspaceId, env.item.skuId).code, 'OUR-OXFORD');
  assert.equal(suppliers.itemsForSupplier(env.db, env.workspace.workspaceId, env.supplier.id)[0].supplierSku, 'OX-NV-08');

  const after = plain((await agent.get(`/suppliers/${env.supplier.id}`)).text);
  assert.match(after, /Remembered for future invoices/);
  env.db.close();
});

test('preparing, approving and receiving an order, end to end', async () => {
  const env = setup();
  const { agent } = await owner(env);

  // Foundry prepares the order from its own recommendation.
  const plan = await agent.get('/purchasing');
  const prepared = await agent
    .post(`/purchasing/prepare/${env.supplier.id}`)
    .type('form')
    .send({ _csrf: csrfFrom(plan.text) });
  assert.equal(prepared.status, 302);
  const orderPath = prepared.headers.location;
  assert.match(orderPath, /^\/purchasing\/orders\/po_/);

  const draft = await agent.get(orderPath);
  assert.match(plain(draft.text), /prepared by Foundry/);
  assert.match(plain(draft.text), /Nothing has been sent to ABC Footwear/);
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, env.item.skuId).onOrder, 0);

  // Approve.
  const hash = /name="integrityHash" value="([^"]+)"/.exec(draft.text)[1];
  const approved = await agent
    .post(`${orderPath}/approve`)
    .type('form')
    .send({ _csrf: csrfFrom(draft.text), integrityHash: hash });
  assert.equal(approved.status, 302);

  const afterApproval = poService.list(env.db, env.workspace.workspaceId)[0];
  assert.equal(afterApproval.status, 'ORDERED');
  const onOrder = position.positionForSku(env.db, env.workspace.workspaceId, env.item.skuId).onOrder;
  assert.ok(onOrder > 0);

  // Asking again now recommends nothing for this line.
  const again = plain((await agent.get('/purchasing')).text);
  assert.match(again, /Nothing needs ordering/);

  // Receive part of it.
  const receivePage = await agent.get(`${orderPath}/receive`);
  assert.equal(receivePage.status, 200);
  const lineId = afterApproval.lines[0].id;
  const partial = await agent
    .post(`${orderPath}/receive`)
    .type('form')
    .send({ _csrf: csrfFrom(receivePage.text), [`qty_${lineId}`]: 24, reference: 'DN-5567' });
  assert.equal(partial.status, 302);

  const partly = poService.get(env.db, env.workspace.workspaceId, afterApproval.id);
  assert.equal(partly.status, 'PARTIALLY_RECEIVED');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 34);
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, env.item.skuId).onOrder, onOrder - 24);

  // And the rest.
  const rest = await agent.get(`${orderPath}/receive`);
  const finished = await agent
    .post(`${orderPath}/receive`)
    .type('form')
    .send({ _csrf: csrfFrom(rest.text), [`qty_${lineId}`]: onOrder - 24 });
  assert.equal(finished.status, 302);

  const done = poService.get(env.db, env.workspace.workspaceId, afterApproval.id);
  assert.equal(done.status, 'RECEIVED');
  assert.equal(done.outstandingUnits, 0);
  assert.equal(position.positionForSku(env.db, env.workspace.workspaceId, env.item.skuId).onOrder, 0);

  // The movements reference the order.
  const receipts = env.db
    .prepare("SELECT * FROM movements WHERE workspace_id = ? AND operation = 'receive' AND reference = ?")
    .all(env.workspace.workspaceId, done.poNumber);
  assert.equal(receipts.length, 2);
});

test('a resubmitted receiving form does not receive the delivery twice', async () => {
  const env = setup();
  const { agent } = await owner(env);

  const order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    destinationLocationId: env.workspace.main.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 4 }],
  });
  poService.approve(env.db, env.workspace.ctx, env.membership, order.id);

  const page = await agent.get(`/purchasing/orders/${order.id}/receive`);
  const token = csrfFrom(page.text);
  const body = { _csrf: token, [`qty_${order.lines[0].id}`]: 48 };

  const first = await agent.post(`/purchasing/orders/${order.id}/receive`).type('form').send(body);
  const second = await agent.post(`/purchasing/orders/${order.id}/receive`).type('form').send(body);

  assert.equal(first.status, 302);
  assert.equal(second.status, 302);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 10 + 48);
  assert.equal(
    env.db.prepare("SELECT COUNT(*) AS n FROM purchase_order_receipts WHERE purchase_order_id = ?").get(order.id).n,
    1
  );
  assert.match(plain((await agent.get(`/purchasing/orders/${order.id}`)).text), /already booked in|48 unit/);
});

test('an over-receipt comes back as a question, not a silent acceptance', async () => {
  const env = setup();
  const { agent } = await owner(env);

  const order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    destinationLocationId: env.workspace.main.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 4 }],       // 48
  });
  poService.approve(env.db, env.workspace.ctx, env.membership, order.id);

  const page = await agent.get(`/purchasing/orders/${order.id}/receive`);
  const tooMany = await agent
    .post(`/purchasing/orders/${order.id}/receive`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), [`qty_${order.lines[0].id}`]: 60 });

  assert.equal(tooMany.status, 200, 'it re-renders the form rather than redirecting');
  assert.match(plain(tooMany.text), /12 unit\(s\) above the purchase order/);
  assert.match(plain(tooMany.text), /accept more than was ordered/);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 10);

  // Confirmed, it goes through and the difference is recorded.
  const accepted = await agent
    .post(`/purchasing/orders/${order.id}/receive`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), [`qty_${order.lines[0].id}`]: 60, approveOverReceipt: '1' });
  assert.equal(accepted.status, 302);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 70);
  assert.match(plain((await agent.get(`/purchasing/orders/${order.id}`)).text), /over-receipt accepted/);
});

test('the printable order carries the supplier SKU and is not claimed to be sent', async () => {
  const env = setup();
  const { agent } = await owner(env);

  const order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 4 }],
  });

  const document = await agent.get(`/purchasing/orders/${order.id}/document`);
  assert.equal(document.status, 200);
  const text = plain(document.text);
  assert.match(text, /Purchase order/);
  assert.match(text, new RegExp(order.poNumber));
  assert.match(text, /ABC Footwear/);
  assert.match(text, /OX-NV-08/);
  assert.match(text, /Harbour Clothing/);
  assert.match(text, /has not been sent to the supplier/);
  // It is the document alone, without the application chrome around it.
  assert.ok(!text.includes('Needs attention'), 'the printable order should not carry the app navigation');
});

test('staff can receive but cannot commit to a purchase', async () => {
  const env = setup();
  const staff = authService.createTeamMember(
    env.db,
    env.workspace.ctx,
    { role: 'owner' },
    { name: 'Sid Staff', email: 'sid-purchasing@example.test', password: 'password123', role: 'staff' }
  );

  const order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    destinationLocationId: env.workspace.main.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 2 }],
  });
  poService.approve(env.db, env.workspace.ctx, env.membership, order.id);

  const agent = request.agent(env.app);
  const session = await signIn(agent, 'sid-purchasing@example.test');

  // Can see purchasing, and can book in the van.
  assert.equal((await agent.get('/purchasing')).status, 200);
  const receivePage = await agent.get(`/purchasing/orders/${order.id}/receive`);
  assert.equal(receivePage.status, 200);
  const received = await agent
    .post(`/purchasing/orders/${order.id}/receive`)
    .type('form')
    .send({ _csrf: csrfFrom(receivePage.text), [`qty_${order.lines[0].id}`]: 24 });
  assert.equal(received.status, 302);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 34);

  // …but cannot approve an order, prepare one, or add a supplier.
  const another = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 2 }],
  });
  const token = await session.token('/purchasing');
  const approve = await agent.post(`/purchasing/orders/${another.id}/approve`).type('form').send({ _csrf: token });
  assert.equal(approve.status, 303);
  assert.equal(poService.get(env.db, env.workspace.workspaceId, another.id).status, 'DRAFT');

  const prepare = await agent.post(`/purchasing/prepare/${env.supplier.id}`).type('form').send({ _csrf: token });
  assert.equal(prepare.status, 303);

  const addSupplier = await agent.post('/suppliers').type('form').send({ _csrf: token, name: 'Sneaky Supply' });
  assert.equal(addSupplier.status, 303);
  assert.equal(suppliers.listSuppliers(env.db, env.workspace.workspaceId).length, 1);
});

test('a purchase order from one inventory is invisible from another', async () => {
  const env = setup();
  const order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 2 }],
  });

  authService.registerAccount(env.db, {
    workspaceName: 'Someone Else',
    name: 'Ida Outsider',
    email: 'outsider-purchasing@example.test',
    password: 'password123',
  });
  const outsider = request.agent(env.app);
  await signIn(outsider, 'outsider-purchasing@example.test');

  assert.equal((await outsider.get(`/purchasing/orders/${order.id}`)).status, 404);
  assert.equal((await outsider.get(`/suppliers/${env.supplier.id}`)).status, 404);
  assert.match(plain((await outsider.get('/suppliers')).text), /No suppliers yet|0 suppliers/);
});

test('the overview brief mentions purchasing when there is purchasing to mention', async () => {
  const env = setup();
  const { agent } = await owner(env);

  const overview = plain((await agent.get('/')).text);
  assert.match(overview, /needs? replenishment/);

  // An overdue order is mentioned too.
  const order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    expectedDate: addLocalDays(Date.now(), -3),
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 2 }],
  });
  poService.approve(env.db, env.workspace.ctx, env.membership, order.id);

  const after = plain((await agent.get('/')).text);
  assert.match(after, new RegExp(`${order.poNumber} is 3 days past its expected arrival`));
});

test('a delivery that matches the order is booked in with one click', async () => {
  // "Receiving against a PO should be automatic." The labour is: Foundry knows
  // the products, the quantities and where they go, so retyping them is work it
  // should do. The assertion is not: nobody has told it the boxes arrived.
  const env = setup();
  const { agent } = await owner(env);

  const order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id,
    destinationLocationId: env.workspace.main.id,
    expectedDate: localDateKey(),
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 5 }],
  });
  poService.approve(env.db, env.workspace.ctx, env.membership, order.id);
  const ordered = poService.get(env.db, env.workspace.workspaceId, order.id).outstandingUnits;

  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id);
  const page = await agent.get(`/purchasing/orders/${order.id}`);
  assert.match(plain(page.text), /It all arrived/, 'the common case is the obvious button');

  const res = await agent
    .post(`/purchasing/orders/${order.id}/receive-all`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text) });
  assert.equal(res.status, 303);

  assert.equal(poService.get(env.db, env.workspace.workspaceId, order.id).status, 'RECEIVED');
  assert.equal(
    repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id),
    before + ordered,
    'the stock is really in, through the ordinary engine'
  );

  // And an impatient second click is the same delivery, not another one.
  await agent
    .post(`/purchasing/orders/${order.id}/receive-all`)
    .type('form')
    .send({ _csrf: csrfFrom(page.text) });
  assert.equal(
    repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id),
    before + ordered,
    'booked in once'
  );
});

// --- being told what is missing, and being able to fix it --------------------

/**
 * A line can be short and unorderable at the same time, and Foundry says so.
 * The only link on it went to the reorder arithmetic — the one thing that was
 * not missing — so somebody new was told exactly what was wrong and left to
 * find suppliers on a screen they had no reason to know about.
 */
function shortWithNoSupplier() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Tee Business' });
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Black T-shirt' });

  engine.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 40 });
  store.db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  const stmt = store.db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
  for (let i = 0; i < 6; i += 1) {
    const result = engine.issue(store.db, workspace.ctx, {
      skuId: item.skuId, locationId: workspace.main.id, quantity: 6, reasonCode: 'sold',
    });
    for (const id of result.movementIds) stmt.run(new Date(Date.now() - (28 - i * 4) * DAY).toISOString(), id);
  }
  store.db.exec(
    `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
     BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
  );

  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'supplier-gap-test' });
  return { ...store, workspace, item, app };
}

test('a line blocked for want of a supplier leads to setting one up, and then becomes orderable', async () => {
  const env = shortWithNoSupplier();
  const { agent } = await owner(env);

  // 1. Foundry sees the shortfall and says what is missing.
  const plan = await agent.get('/purchasing');
  const planText = plain(plan.text);
  assert.match(planText, /no supplier on file/i);
  assert.match(planText, /Add the supplier for Black T-shirt/i,
    'the thing that is missing has to be the thing you can click');

  // 2. The primary action goes to supplier setup for this product — not back to
  //    the arithmetic, which is where it used to go.
  assert.match(plan.text, new RegExp(`/purchasing/supplier-for/${env.item.skuId}`));
  const form = await agent.get(`/purchasing/supplier-for/${env.item.skuId}`);
  assert.equal(form.status, 200);
  const formText = plain(form.text);
  assert.match(formText, /Who do you buy Black T-shirt from/i);
  assert.match(formText, /short/i, 'it carries the shortfall it is unblocking');

  // Reaching it from the numbers page works too.
  const why = plain((await agent.get(`/purchasing/why/${env.item.skuId}`)).text);
  assert.match(why, /Foundry cannot order this yet/i);
  assert.match(why, /Add the supplier for Black T-shirt/i);

  // 3. Creating and linking the supplier, in one step, from here.
  const saved = await agent.post(`/purchasing/supplier-for/${env.item.skuId}`).type('form').send({
    _csrf: csrfFrom(form.text),
    newSupplierName: 'Cotton Mills',
    purchaseUnit: 'case',
    unitsPerPurchaseUnit: 12,
    leadTimeDays: 7,
    lastUnitCost: 4.5,
  });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.location, '/purchasing', 'it returns to the order flow');

  // The link is real, and preferred, so replenishment can use it.
  const linked = suppliers.suppliersForSku(env.db, env.workspace.workspaceId, env.item.skuId);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].supplierName, 'Cotton Mills');

  // 4. Back on What to order, the same line is now actionable and costed with
  //    the supplier's pack size and lead time.
  const after = await agent.get('/purchasing');
  const afterText = plain(after.text);
  assert.doesNotMatch(afterText, /no supplier on file/i, 'the blocker is gone');
  assert.match(afterText, /Cotton Mills/);
  assert.match(afterText, /case/i, "the supplier's pack size is in the recommendation");
  assert.match(after.text, /\/purchasing\/prepare\//,
    'and the order can now actually be prepared');
  env.db.close();
});

// --- settings somebody typed in outrank what Foundry can infer ---------------

/**
 * Reported as: reorder point 60 / up to 80 / safety 10 set by hand on one
 * variant, supplier attached to all six afterwards, and the whole range came
 * back as "not enough history". The engine turned out to be right; the settings
 * had been deleted by a button labelled "Go back to working it out", which
 * reads like a way back to the calculation rather than a deletion.
 *
 * These lock the two properties the report asked for, whatever the wording of
 * any button: explicit levels beat missing history, and they survive supplier
 * attachment.
 */
function sixVariantsNoHistory() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Tee Business' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const item = makeVariantItem(store.db, workspace.ctx, {
    name: 'Black T-shirt',
    baseCode: 'BT-1',
    options: [
      { name: 'Colour', values: 'Black, White' },
      { name: 'Size', values: 'Small, Medium, Large' },
    ],
  });
  // Stock, and deliberately no sales at all: nothing here can be inferred.
  for (const sku of item.skus) {
    engine.receive(store.db, workspace.ctx, {
      skuId: sku.id, locationId: workspace.main.id, quantity: 56,
    });
  }
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'reorder-precedence-test' });
  return { ...store, workspace, membership, item, small: item.byLabel('Black / Small'), app };
}

test('reorder levels set by hand survive attaching a supplier and drive the recommendation', async () => {
  const env = sixVariantsNoHistory();
  const { agent } = await owner(env);

  // 1. The levels are typed in on the line itself.
  const whyPage = await agent.get(`/purchasing/why/${env.small.id}`);
  const saved = await agent.post(`/purchasing/policies/${env.small.id}`).type('form').send({
    _csrf: csrfFrom(whyPage.text), reorderPoint: 60, targetStock: 80, safetyStock: 10,
  });
  assert.ok(saved.status === 303 || saved.status === 302);

  // 2. With no sales history whatsoever, the line is still assessed — because
  //    the levels came from a person, not from inference.
  const beforeSupplier = replenishment.evaluateOne(env.db, env.workspace.workspaceId, env.small.id);
  assert.equal(beforeSupplier.reason, 'no_supplier',
    'explicit levels must outrank "not enough history"');
  assert.equal(beforeSupplier.shortfall, 24, '80 target − 56 on hand');

  // 3. A supplier is attached to all six variants, as a range.
  const supplierPage = await agent.get('/purchasing/setup');
  const linked = await agent.post('/purchasing/setup/supplier').type('form').send({
    _csrf: csrfFrom(supplierPage.text),
    newSupplierName: 'ABC Apparel',
    purchaseUnit: 'case',
    unitsPerPurchaseUnit: 12,
    minimumOrderQuantity: 2,
    leadTimeDays: 15,
    skuIds: env.item.skus.map((sku) => sku.id),
  });
  assert.ok(linked.status === 303 || linked.status === 302);

  // 4. The settings are still there afterwards, still the person's own.
  const policy = policyService.effectivePolicy(env.db, env.workspace.workspaceId, env.small.id);
  assert.equal(policy.isSet, true, 'attaching a supplier must not disturb saved levels');
  assert.equal(policy.reorderPoint, 60);
  assert.equal(policy.targetStock, 80);
  assert.equal(policy.safetyStock, 10);
  assert.equal(policy.source, 'manual');

  // 5. And the line is now actionable on exactly those numbers plus the
  //    supplier's terms: 24 short, rounded to whole cases, minimum 2.
  const line = replenishment.evaluateOne(env.db, env.workspace.workspaceId, env.small.id);
  assert.equal(line.recommend, true);
  assert.equal(line.reason, 'below_reorder_point');
  assert.equal(line.reorderPoint, 60);
  assert.equal(line.target, 80);
  assert.equal(line.shortfall, 24);
  assert.equal(line.quantityUnits, 24);
  assert.equal(line.quantityPurchaseUnits, 2, '24 units is exactly two cases of twelve');
  assert.equal(line.leadTimeDays, 15);

  // 6. On the page itself: this one is orderable, the other five honestly are not.
  const plan = plain((await agent.get('/purchasing')).text);
  assert.match(plan, /Black \/ Small/);
  assert.doesNotMatch(plan, /You have not set your own reorder levels/,
    'a line configured by hand must not be reported as unconfigured');
  const workspacePlan = replenishment.evaluateWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(workspacePlan.recommendations.length, 1);
  assert.equal(workspacePlan.recommendations[0].skuId, env.small.id);
  assert.equal(workspacePlan.blocked.length, 5, 'the other five stay honest about having no history');
  env.db.close();
});

test('discarding reorder levels is a deliberate, separate act', async () => {
  const env = sixVariantsNoHistory();
  const { agent } = await owner(env);
  const whyPage = await agent.get(`/purchasing/why/${env.small.id}`);
  await agent.post(`/purchasing/policies/${env.small.id}`).type('form').send({
    _csrf: csrfFrom(whyPage.text), reorderPoint: 60, targetStock: 80, safetyStock: 10,
  });

  // Saving again must never be a way of losing them.
  const withPolicy = await agent.get(`/purchasing/why/${env.small.id}`);
  await agent.post(`/purchasing/policies/${env.small.id}`).type('form').send({
    _csrf: csrfFrom(withPolicy.text), reorderPoint: 60, targetStock: 80, safetyStock: 10,
  });
  assert.equal(
    policyService.effectivePolicy(env.db, env.workspace.workspaceId, env.small.id).isSet,
    true
  );

  // The discard control is its own form, asks first, and says what it removed.
  const page = (await agent.get(`/purchasing/why/${env.small.id}`)).text;
  assert.match(page, /data-confirm="Discard your reorder settings/,
    'deleting somebody\'s settings has to ask');
  assert.doesNotMatch(page, /Go back to working it out/,
    'and must not be worded as though it were navigation');

  await agent.post(`/purchasing/policies/${env.small.id}`).type('form').send({
    _csrf: csrfFrom(page), clear: '1',
  });
  assert.equal(
    policyService.effectivePolicy(env.db, env.workspace.workspaceId, env.small.id).isSet,
    false,
    'and when it is asked for, it works'
  );
  env.db.close();
});

test('reorder settings persist through supplier attachment and later supplier edits', async () => {
  const env = sixVariantsNoHistory();
  const { agent } = await owner(env);
  const readRow = () => env.db
    .prepare('SELECT reorder_point, target_stock, safety_stock, source FROM reorder_policies WHERE workspace_id = ? AND sku_id = ?')
    .get(env.workspace.workspaceId, env.small.id);

  // Saved, and actually on the row rather than only in a page.
  const whyPage = await agent.get(`/purchasing/why/${env.small.id}`);
  await agent.post(`/purchasing/policies/${env.small.id}`).type('form').send({
    _csrf: csrfFrom(whyPage.text), reorderPoint: 60, targetStock: 80, safetyStock: 10,
  });
  assert.deepEqual(readRow(), { reorder_point: 60, target_stock: 80, safety_stock: 10, source: 'manual' });

  // Attaching the supplier to the whole range leaves the row untouched.
  const setupPage = await agent.get('/purchasing/setup');
  await agent.post('/purchasing/setup/supplier').type('form').send({
    _csrf: csrfFrom(setupPage.text),
    newSupplierName: 'ABC Apparel',
    purchaseUnit: 'case', unitsPerPurchaseUnit: 12, minimumOrderQuantity: 2, leadTimeDays: 15,
    skuIds: env.item.skus.map((sku) => sku.id),
  });
  assert.deepEqual(readRow(), { reorder_point: 60, target_stock: 80, safety_stock: 10, source: 'manual' },
    'attaching a supplier must not write to the reorder policy at all');

  // Nor does attaching one to this variant on its own, through the other route.
  const single = await agent.get(`/purchasing/supplier-for/${env.small.id}`);
  if (single.status === 200) {
    await agent.post(`/purchasing/supplier-for/${env.small.id}`).type('form').send({
      _csrf: csrfFrom(single.text),
      newSupplierName: 'Second Source',
      purchaseUnit: 'box', unitsPerPurchaseUnit: 6, leadTimeDays: 4,
    });
    assert.deepEqual(readRow(), { reorder_point: 60, target_stock: 80, safety_stock: 10, source: 'manual' },
      'linking a second supplier must not disturb the levels either');
  }

  // Editing supplier terms afterwards leaves them alone as well.
  const supplier = suppliers.listSuppliers(env.db, env.workspace.workspaceId)
    .find((entry) => entry.name === 'ABC Apparel');
  suppliers.linkItem(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, skuId: env.small.id,
    purchaseUnit: 'case', unitsPerPurchaseUnit: 24, minimumOrderQuantity: 1, leadTimeDays: 9,
    isPreferred: true,
  });
  assert.deepEqual(readRow(), { reorder_point: 60, target_stock: 80, safety_stock: 10, source: 'manual' },
    'changing pack size or lead time is not a change to the reorder levels');

  // A partial write cannot take unrelated configuration with it.
  policyService.setPolicy(env.db, env.workspace.ctx, env.membership, env.small.id, {
    preferredSupplierId: supplier.id,
  });
  const merged = policyService.effectivePolicy(env.db, env.workspace.workspaceId, env.small.id);
  assert.equal(merged.reorderPoint, 60, 'setting one field must not erase the others');
  assert.equal(merged.targetStock, 80);
  assert.equal(merged.safetyStock, 10);
  assert.equal(merged.preferredSupplierId, supplier.id);

  // Blanking a box on the form is still a deliberate clear of that one field.
  policyService.setPolicy(env.db, env.workspace.ctx, env.membership, env.small.id, {
    reorderPoint: 60, targetStock: 80, safetyStock: '',
  });
  assert.equal(policyService.effectivePolicy(env.db, env.workspace.workspaceId, env.small.id).safetyStock, null);
  env.db.close();
});

test('the product page shows the levels that are saved, not "no reorder level set"', async () => {
  const env = sixVariantsNoHistory();
  const { agent } = await owner(env);
  const whyPage = await agent.get(`/purchasing/why/${env.small.id}`);
  await agent.post(`/purchasing/policies/${env.small.id}`).type('form').send({
    _csrf: csrfFrom(whyPage.text), reorderPoint: 60, targetStock: 80, safetyStock: 10,
  });

  const setupPage = await agent.get('/purchasing/setup');
  await agent.post('/purchasing/setup/supplier').type('form').send({
    _csrf: csrfFrom(setupPage.text),
    newSupplierName: 'ABC Apparel',
    purchaseUnit: 'case', unitsPerPurchaseUnit: 12, minimumOrderQuantity: 2, leadTimeDays: 15,
    skuIds: env.item.skus.map((sku) => sku.id),
  });

  // The reported symptom was on this screen, so it is asserted on this screen.
  const itemPage = plain((await agent.get(`/inventory/${env.item.itemId}`)).text);
  assert.match(itemPage, /Reorder at 60/i, 'the saved level has to be visible on the product');
  const smallRow = itemPage.slice(itemPage.indexOf('Black / Small'));
  assert.doesNotMatch(smallRow.slice(0, 200), /No reorder level set/i);
  env.db.close();
});

test('booking a delivery in clears the reminder to book it in', async () => {
  // Found in the browser: the stock arrived, was counted and was live, and
  // "PO-1001 from Nordic Filters is late" was still sitting in Needs you —
  // the queue asking for a job that had just been done.
  const runner = require('../../src/autopilot/runner');
  const workItems = require('../../src/autopilot/work-items');
  const receiving = require('../../src/purchasing/receiving-service');

  const env = sixVariantsNoHistory();
  const { agent } = await owner(env);
  const supplier = suppliers.createSupplier(env.db, env.workspace.ctx, env.membership, { name: 'Nordic Filters' });
  suppliers.linkItem(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, skuId: env.small.id, purchaseUnit: 'box',
    unitsPerPurchaseUnit: 10, lastUnitCost: 4, leadTimeDays: 7, isPreferred: true,
  });
  const yesterday = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, expectedDate: yesterday,
    lines: [{ skuId: env.small.id, quantityPurchaseUnits: 4, unitCost: 4,
      destinationLocationId: env.workspace.main.id }],
  });
  order = poService.approve(env.db, env.workspace.ctx, env.membership, order.id, {
    expectedHash: order.integrityHash, markOrdered: true,
  });

  runner.run(env.db, env.workspace.ctx, env.membership, { trigger: 'test' });
  const reminder = workItems.list(env.db, env.workspace.workspaceId, { category: 'receiving_followup' })[0];
  assert.ok(reminder, 'an overdue delivery is worth a reminder');
  assert.equal(reminder.isTerminal, false);

  receiving.receive(env.db, env.workspace.ctx, env.membership, order.id, {
    idempotencyKey: 'booked-in',
    lines: order.lines.map((line) => ({
      lineId: line.id, quantityUnits: line.quantity_units || line.quantityUnits,
      locationId: env.workspace.main.id,
    })),
  });

  const after = workItems.get(env.db, env.workspace.workspaceId, reminder.id);
  assert.equal(after.isTerminal, true, 'the reminder is finished once the delivery is booked in');
  const inbox = plain((await agent.get('/needs-you')).text);
  assert.doesNotMatch(inbox, /is late/, 'and it leaves Needs you');
  env.db.close();
});
