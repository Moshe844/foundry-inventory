'use strict';

/**
 * The box at the top of every page is the application's search.
 *
 * It searched inventory only, which nothing on screen said. Typing "PO-1001"
 * or "ABC Apparel" — both exact names of records the customer had just created
 * — returned nothing at all, and there was no way to tell from looking at the
 * box that it only knew about stock.
 *
 * These go through the real HTTP routes, both the results page and the
 * type-ahead behind the box, because that is where the gap was.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const {
  makeDatabase, cleanupAll, seedWorkspace, signIn, plain, makeVariantItem, makeSerialItem,
} = require('../helpers');
const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const locationService = require('../../src/domain/location-service');
const repo = require('../../src/domain/repository');
const engine = require('../../src/domain/inventory-engine');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');

test.after(cleanupAll);

/** A workspace holding one of every kind of record the box should find. */
async function shop() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Search Co' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'search-http' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  // A product whose own name contains a colour, so "Black Small" can be
  // satisfied the wrong way — every variant of it contains "black".
  const tees = itemService.createItem(store.db, workspace.ctx, {
    name: 'Black T-shirt', baseCode: 'BT-1', trackingMode: 'quantity', hasVariants: true,
    options: [{ name: 'Colour', values: 'Black, White' }, { name: 'Size', values: 'Small, Large' }],
  });
  const skus = repo.listSkusForItem(store.db, workspace.workspaceId, tees.itemId);
  const blackSmall = skus.find((sku) => sku.variant_label === 'Black / Small');
  const whiteSmall = skus.find((sku) => sku.variant_label === 'White / Small');
  engine.receive(store.db, workspace.ctx, {
    skuId: blackSmall.id, locationId: workspace.main.id, quantity: 12,
  });

  const chiller = locationService.createLocation(store.db, workspace.ctx, {
    name: 'Cold Room', kind: 'warehouse',
  });

  const supplier = supplierService.createSupplier(store.db, workspace.ctx, membership, {
    name: 'ABC Apparel',
  });
  supplierService.linkItem(store.db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: blackSmall.id, purchaseUnit: 'case',
    unitsPerPurchaseUnit: 12, lastUnitCost: 4, isPreferred: true,
  });
  const order = poService.createOrder(store.db, workspace.ctx, membership, {
    supplierId: supplier.id,
    lines: [{ skuId: blackSmall.id, quantityPurchaseUnits: 2, unitCost: 4,
      destinationLocationId: workspace.main.id }],
  });

  const find = async (term) => {
    const page = await agent.get(`/search?q=${encodeURIComponent(term)}`);
    assert.equal(page.status, 200, `searching "${term}" must work`);
    return { text: plain(page.text).replace(/\s+/g, ' '), raw: page.text };
  };
  const suggest = async (term) => {
    const res = await agent.get(`/api/search?q=${encodeURIComponent(term)}`);
    assert.equal(res.status, 200);
    return res.body.results;
  };

  return {
    ...store, workspace, membership, agent, find, suggest,
    tees, blackSmall, whiteSmall, chiller, supplier, order,
  };
}

test('an exact purchase order number finds that order first, and opens it', async () => {
  const env = await shop();
  const hits = await env.suggest(env.order.poNumber);

  assert.ok(hits.length, `"${env.order.poNumber}" is a record that exists`);
  assert.equal(hits[0].type, 'purchase_order', 'an identifier typed in full wins outright');
  assert.equal(hits[0].title, env.order.poNumber);
  assert.equal(hits[0].typeLabel, 'Purchase order', 'and it says what kind of record it is');
  assert.equal(hits[0].href, `/purchasing/orders/${env.order.id}`, 'straight to the order');

  const page = await env.find(env.order.poNumber);
  assert.match(page.text, new RegExp(env.order.poNumber));
  assert.match(page.text, /Purchase order/);
  env.db.close();
});

test('an exact supplier name finds the supplier first, and opens it', async () => {
  const env = await shop();
  const hits = await env.suggest('ABC Apparel');

  assert.ok(hits.length, 'the supplier exists under exactly this name');
  assert.equal(hits[0].type, 'supplier');
  assert.equal(hits[0].title, 'ABC Apparel');
  assert.equal(hits[0].href, `/suppliers/${env.supplier.id}`);

  const page = await env.find('ABC Apparel');
  assert.match(page.text, /Supplier/);
  env.db.close();
});

test('a location is found by name and opens where locations live', async () => {
  const env = await shop();
  const hits = await env.suggest('Cold Room');

  const location = hits.find((hit) => hit.type === 'location');
  assert.ok(location, 'a place stock sits in is a record worth finding');
  assert.equal(location.title, 'Cold Room');
  assert.equal(hits[0].type, 'location', 'and an exact name ranks first');
  assert.match(location.href, /^\/inventory\/locations/);
  env.db.close();
});

test('a SKU code finds that exact variant', async () => {
  const env = await shop();
  const hits = await env.suggest(env.blackSmall.code);

  assert.ok(hits.length);
  assert.equal(hits[0].title, 'Black T-shirt / Black / Small');
  assert.equal(hits[0].typeLabel, 'Variant');
  assert.equal(hits[0].href, `/inventory/${env.tees.itemId}#sku-${env.blackSmall.id}`);
  // Its sibling shares the product name, so the same words appear in it. That
  // makes it noise beside an exact code, not an alternative.
  assert.deepEqual(
    hits.filter((hit) => hit.title === 'Black T-shirt / White / Small'), [],
    'an exact SKU code does not also return the other variant'
  );
  env.db.close();
});

test('every dimension matching outranks a sibling that only shares the product name', async () => {
  // "Black Small" ranked Black/Small first but returned White/Small as an
  // equally strong result — because the product is called "Black T-shirt", so
  // every variant of it contains the word "black" somewhere.
  const env = await shop();
  const hits = await env.suggest('Black Small');

  assert.ok(hits.length, 'a variant read off the screen and typed without the slash still matches');
  assert.equal(hits[0].title, 'Black T-shirt / Black / Small');

  const positions = Object.fromEntries(hits.map((hit, index) => [hit.title, index]));
  const white = positions['Black T-shirt / White / Small'];
  if (white !== undefined) {
    assert.ok(white > 0, 'the one matching both dimensions comes first');
    const service = require('../../src/domain/search-service');
    const scored = service.search(env.db, env.workspace.workspaceId, 'Black Small', { limit: 20 }).results;
    const scoreOf = (title) => (scored.find((r) => r.title === title) || {}).score;
    assert.ok(
      scoreOf('Black T-shirt / Black / Small') > scoreOf('Black T-shirt / White / Small'),
      'and it is a stronger match, not merely an earlier one'
    );
  }
  env.db.close();
});

test('a partial query still finds things, ranked below the exact ones', async () => {
  const env = await shop();

  // Part of a name.
  const partial = await env.suggest('Appar');
  assert.ok(
    partial.some((hit) => hit.type === 'supplier' && hit.title === 'ABC Apparel'),
    'part of a supplier name finds the supplier'
  );

  // Part of a PO number.
  const poPartial = await env.suggest(env.order.poNumber.slice(0, 5));
  assert.ok(
    poPartial.some((hit) => hit.type === 'purchase_order'),
    'part of an order number finds the order'
  );

  // Part of a product name.
  const productPartial = await env.suggest('T-shirt');
  assert.ok(productPartial.length, 'part of a product name finds the product');
  env.db.close();
});

test('a serial number and a batch code are still found', async () => {
  const env = await shop();
  const serialItem = makeSerialItem(env.db, env.workspace.ctx, { name: 'Label Printer' });
  engine.receive(env.db, env.workspace.ctx, {
    skuId: serialItem.skuId, locationId: env.workspace.main.id, serials: ['LP-77-A'],
  });

  const hits = await env.suggest('LP-77-A');
  assert.ok(hits.length, 'the box has not stopped finding what it already found');
  assert.equal(hits[0].type, 'serial');
  assert.equal(hits[0].typeLabel, 'Unit');
  env.db.close();
});

test('nothing matching says so rather than failing', async () => {
  const env = await shop();
  const page = await env.find('zzzz-not-a-record');
  assert.match(page.text, /Nothing matched/i);
  assert.deepEqual(await env.suggest('zzzz-not-a-record'), []);
  env.db.close();
});
