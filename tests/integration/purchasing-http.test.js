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
const position = require('../../src/purchasing/position');
const repo = require('../../src/domain/repository');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, csrfFrom, plain, signIn } = require('../helpers');

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
    expectedDate: new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10),
    lines: [{ skuId: env.item.skuId, quantityPurchaseUnits: 2 }],
  });
  poService.approve(env.db, env.workspace.ctx, env.membership, order.id);

  const after = plain((await agent.get('/')).text);
  assert.match(after, new RegExp(`${order.poNumber} is 3 days past its expected arrival`));
});
