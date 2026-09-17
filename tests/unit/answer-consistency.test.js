'use strict';

/**
 * The sentence and the records under it must agree.
 *
 * "This inventory has 19 active products" with "12 records" underneath read
 * as a contradiction, and the answers had only ever been checked against
 * the records, never against their own disclosure. This seeds more of
 * everything than any list caps at, runs every lookup, and for each answer
 * that states a count of things it also lists, checks that the count shown
 * for the records is not smaller than the count in the sentence.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const authService = require('../../src/domain/auth-service');
const engine = require('../../src/domain/inventory-engine');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const salesOrders = require('../../src/sales/sales-order-service');
const queryService = require('../../src/attention/query-service');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll } = require('../helpers');

test.after(cleanupAll);

function bigWorkspace() {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const items = [];
  for (let i = 1; i <= 70; i += 1) {
    const item = makeQuantityItem(db, w.ctx, { name: `Product ${String(i).padStart(2, '0')}`, baseCode: `P${i}` });
    engine.receive(db, w.ctx, { skuId: item.skuId, locationId: i % 2 ? w.main.id : w.store.id, quantity: 10 + i });
    items.push(item);
  }
  const suppliers = ['Acme Trade Supply', 'Lakeside Textiles', 'Northern Packaging'].map((name) => supplierService.createSupplier(db, w.ctx, membership, { name, email: `${name.split(' ')[0].toLowerCase()}@example.test` }));
  items.forEach((item, i) => supplierService.linkItem(db, w.ctx, membership, { supplierId: suppliers[i % 3].id, skuId: item.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 1 + (i % 5) }));
  for (let i = 0; i < 40; i += 1) {
    const po = poService.createOrder(db, w.ctx, membership, { supplierId: suppliers[i % 3].id, expectedDate: `2026-0${1 + (i % 9)}-15`, lines: [{ skuId: items[i].skuId, quantityPurchaseUnits: 5, unitCost: 2 }], source: 'test' });
    poService.approve(db, w.ctx, membership, po.id);
  }
  const customers = ['Fresh Cafe', 'Harbour Plumbing', 'Marta Okonjo', 'ABC School'].map((name) => salesOrders.createCustomer(db, w.ctx, { name, email: `${name.split(' ')[0].toLowerCase()}@example.test` }));
  for (let i = 0; i < 30; i += 1) {
    try {
      salesOrders.createOrder(db, w.ctx, { customerId: customers[i % 4].id, lines: [{ skuId: items[i].skuId, quantityOrdered: 1 + (i % 3), unitPriceMinor: 500 }] });
    } catch { /* a fixture that cannot be ordered is still a fixture */ }
  }
  return { db, w, membership };
}

/** Counts a sentence states about things it lists: "19 active products", "40 purchase orders", "5 customers". */
function statedCounts(answer) {
  const out = [];
  const re = /\b(\d[\d,]*)\s+(?:active\s+|open\s+|matching\s+|tracked\s+|stock\s+)?(products?|variants?|records?|purchase orders?|orders?|lines?|customers?|suppliers?|bills?|invoices?|payments?|shipments?|positions?|lots?|batches|movements?|returns?)\b/gi;
  let m;
  while ((m = re.exec(String(answer || '')))) out.push({ n: Number(m[1].replace(/,/g, '')), noun: m[2].toLowerCase() });
  return out;
}

test('every lookup that states a count of the things it lists shows at least that many records, or says it is a page of them', () => {
  const { db, w, membership } = bigWorkspace();
  const problems = [];
  for (const intent of queryService.INTENTS) {
    let result;
    try {
      result = queryService.execute(db, w.workspaceId, queryService.normalisePlan({ intent, windowDays: 365, limit: 25 }), { question: intent.replace(/_/g, ' '), membership });
    } catch (err) {
      continue; // a lookup that needs a named thing or an accounting ledger is not under test here
    }
    if (!result || !Array.isArray(result.rows) || !result.rows.length) continue;
    // A briefing's rows are its lines, not the things it counts; the page labels them as lines.
    if (result.columns && result.columns[0] === 'measure' && result.columns[1] === 'value') continue;
    const shown = Number(result.rowCount || result.rows.length);
    for (const { n, noun } of statedCounts(result.answer)) {
      // Only counts of the very things the rows are: a sentence that says
      // "40 units" beside 3 rows is not a contradiction.
      const rowsAreThose = /products?|variants?|records?|orders?|lines?|customers?|suppliers?|bills?|invoices?|payments?|shipments?|positions?|lots?|batches|movements?|returns?/.test(noun);
      if (rowsAreThose && n > shown && n <= 1000) problems.push(`${intent}: says "${n} ${noun}" but shows ${shown} records (${result.rows.length} rows)`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('on the page, the count under an answer is a page count when it is a page: "first 25 of 70", never "25 records" under "70"', async () => {
  const request = require('supertest');
  const { createApp } = require('../../src/app');
  const { signIn } = require('../helpers');
  const { db, w } = bigWorkspace();
  const app = createApp({ db, env: 'test', sessionSecret: 'consistency' });
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const page = await agent.get('/ask?q=how%20many%20items%20in%20my%20inventory%20now');
  assert.match(page.text, /This inventory has 70 active products/);
  assert.match(page.text, /first 60 of 70/, 'the disclosure says it is a page of the 70, not a smaller number');
  assert.doesNotMatch(page.text, /\b12 records\b/);
});
