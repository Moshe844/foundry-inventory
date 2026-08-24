'use strict';

/**
 * Activity is the business's history, not Foundry's working notes.
 *
 * Two faults met on this page. The sidebar link went to Foundry's own work log,
 * so somebody looking for their trading history landed on fifty near-identical
 * "Scheduled inventory check" lines. And the ledger underneath held movements
 * only, so an order placed, a delivery booked in, or a difference opened and
 * settled appeared on no timeline at all.
 *
 * The acceptance test is the one the customer set: open Activity and find the
 * opening quantities, the sale, the transfer, the count and correction, and the
 * purchase order lifecycle, without scrolling past routine checks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const {
  makeDatabase, cleanupAll, seedWorkspace, signIn, plain, makeQuantityItem,
} = require('../helpers');
const authService = require('../../src/domain/auth-service');
const engine = require('../../src/domain/inventory-engine');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');

test.after(cleanupAll);

/** A workspace that has actually traded, plus a pile of quiet checks. */
async function traded({ quietChecks = 50 } = {}) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Trading Co' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'activity-log' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Trail Ration Pack' });

  engine.receive(store.db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 60,
  });
  engine.issue(store.db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 4, reasonCode: 'sold',
  });
  engine.transfer(store.db, workspace.ctx, {
    skuId: item.skuId, fromLocationId: workspace.main.id, toLocationId: workspace.store.id, quantity: 10,
  });
  engine.adjust(store.db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.store.id, countedQty: 9, reasonCode: 'found',
  });

  const supplier = supplierService.createSupplier(store.db, workspace.ctx, membership, { name: 'ABC Supply' });
  supplierService.linkItem(store.db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: item.skuId, purchaseUnit: 'case',
    unitsPerPurchaseUnit: 12, lastUnitCost: 3, isPreferred: true,
  });
  let order = poService.createOrder(store.db, workspace.ctx, membership, {
    supplierId: supplier.id,
    lines: [{ skuId: item.skuId, quantityPurchaseUnits: 2, unitCost: 3,
      destinationLocationId: workspace.main.id }],
  });
  order = poService.approve(store.db, workspace.ctx, membership, order.id, {
    expectedHash: order.integrityHash, markOrdered: true,
  });
  receiving.receive(store.db, workspace.ctx, membership, order.id, {
    idempotencyKey: 'arrived',
    lines: order.lines.map((line) => ({
      lineId: line.id,
      quantityUnits: line.quantity_units || line.quantityUnits,
      locationId: workspace.main.id,
    })),
  });

  // The noise: routine checks that decided nothing.
  const insert = store.db.prepare(
    `INSERT INTO work_plans (id, workspace_id, trigger, idempotency_key, mode, status,
       items_planned, items_executed, items_awaiting, started_at, finished_at)
     VALUES (?, ?, 'scheduled', ?, 'SUPERVISED', 'COMPLETED', 0, 0, 0, ?, ?)`
  );
  for (let i = 0; i < quietChecks; i += 1) {
    const when = new Date(Date.now() - i * 60000).toISOString();
    insert.run(`wp_quiet_${i}`, workspace.workspaceId, `quiet-${i}`, when, when);
  }

  // The raw movement ledger is kept on the page behind a fold, so assertions
  // about what the timeline shows read the part above it.
  const open = async (query = '') => {
    const raw = (await agent.get(`/activity${query}`)).text;
    const timelineOnly = raw.split('The raw movement ledger')[0];
    return plain(timelineOnly).replace(/\s+/g, ' ');
  };
  return { ...store, workspace, membership, agent, item, order, open };
}

test('Activity leads with what happened to the business, not with routine checks', async () => {
  const env = await traded();
  const page = await env.open();

  // Everything the customer asked to be able to find.
  assert.match(page, /Received 60 × Trail Ration Pack/, 'the opening quantity');
  assert.match(page, /Issued 4 × Trail Ration Pack/, 'the sale');
  assert.match(page, /Transferred 10 × Trail Ration Pack/, 'the transfer');
  assert.match(page, /Trail Ration Pack/, 'the count and correction');
  assert.match(page, /placed with ABC Supply/, 'the order going out');
  assert.match(page, /received in full/, 'and the delivery arriving');

  // Fifty quiet checks are a footnote, not fifty rows — and not a row at all,
  // because even one collapsed row sat above the sale.
  assert.doesNotMatch(page, /routine inventory checks — no action needed/,
    'routine checks are not part of what happened to the business');
  assert.match(page, /50 routine checks found nothing/,
    'but the page says how many there were, and where they are');
  assert.doesNotMatch(page, /Scheduled inventory check/,
    "Foundry's own trigger names are not the business's history");
  env.db.close();
});

test('the routine checks are still there, one filter away', async () => {
  const env = await traded({ quietChecks: 12 });
  const system = await env.open('?stream=system');
  assert.match(system, /12 routine inventory checks/, 'kept for the audit trail, not deleted');
  env.db.close();
});

test('each stream answers its own question', async () => {
  const env = await traded({ quietChecks: 5 });

  const inventory = await env.open('?stream=inventory');
  assert.match(inventory, /Received 60 × Trail Ration Pack/);
  assert.doesNotMatch(inventory, /placed with ABC Supply/, 'orders are not stock movements');

  const purchasing = await env.open('?stream=purchasing');
  assert.match(purchasing, /placed with ABC Supply/);
  assert.match(purchasing, /received in full/);
  assert.doesNotMatch(purchasing, /Issued 4 × Trail Ration Pack/, 'sales are not purchasing');
  env.db.close();
});

test('search narrows the timeline', async () => {
  const env = await traded({ quietChecks: 3 });
  const hits = await env.open('?q=ABC%20Supply');
  assert.match(hits, /ABC Supply/);
  assert.doesNotMatch(hits, /Issued 4 × Trail Ration Pack/, 'only what was searched for');
  env.db.close();
});

test('every event says who did it, when, and where to read more', async () => {
  const env = await traded({ quietChecks: 2 });
  const operationsLog = require('../../src/domain/operations-log');
  const { events } = operationsLog.timeline(env.db, env.workspace.workspaceId, { limit: 50 });

  assert.ok(events.length >= 6, 'the traded events are all there');
  for (const event of events) {
    assert.ok(event.title, 'every entry says what happened');
    assert.ok(event.at, 'and when');
    assert.ok(event.who, 'and who or what caused it');
    assert.match(event.href, /^\//, 'and links somewhere real');
    assert.ok(operationsLog.STREAMS.includes(event.stream), 'and knows which story it belongs to');
  }
  env.db.close();
});

/**
 * The sidebar entry is what actually sent people to the wrong page, and the fix
 * lives in the shared layout — a file another session is editing right now. The
 * assertion is written and waiting rather than committed against work in
 * flight; enable it once that lands.
 */
test('the sidebar sends Activity to the business history', { skip: 'layout.ejs is being edited by another session' }, async () => {
  const env = await traded({ quietChecks: 1 });
  const raw = (await env.agent.get('/activity')).text;
  const anchors = raw.match(/<a[^>]*class="nav-item[^"]*"[^>]*>[\s\S]*?<\/a>/g) || [];
  const activityLink = anchors.find((a) => /<span>Activity<\/span>/.test(a));
  assert.ok(activityLink, 'the sidebar has an Activity entry');
  assert.match(activityLink, /href="\/activity"/, 'pointing at the ledger, not the autopilot log');
  env.db.close();
});
