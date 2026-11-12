'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const runout = require('../../src/forecasting/agent-runout');
const catalog = require('../../src/domain/postgres-catalog-service');
const inv = require('../../src/domain/postgres-inventory-engine');
const pricing = require('../../src/pricing/postgres-service');
const auto = require('../../src/autopilot/postgres-service');
const reviews = require('../../src/autopilot/job-reviews');
const queue = require('../../src/operations/postgres-job-queue');
const time = require('../../src/lib/business-time');
const handlers = require('../../src/operations/postgres-runtime-handlers').create();
const { addDays } = require('../../src/accounting/customer-money');

test('job 151: the worker keeps every item\'s run-out date and its cost current on every plan, and Needs you ranks items that run out before their next delivery', { timeout: 900000 }, async t => {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 1 }), { db, ctx, browser, subscribe } = f;
  const site = f.location, ws = ctx.workspaceId;
  await db.query("UPDATE accounts SET created_at=(now()-interval '200 days')::text WHERE id=$1", [f.owner.accountId]);
  const clock = await time.forWorkspace(db, ws), today = clock.calendarDate;
  const at = day => new Date(Date.parse(time.dayBoundary(day, clock.timeZone)) + 12 * 3600000).toISOString();
  async function product(code, { stock, daily = 0, price = null, cost = null, lead = null }) {
    const sku = (await catalog.createItem(db, ctx, { name: 'Product ' + code, baseCode: code, trackingMode: 'quantity' })).skuIds[0];
    await inv.receive(db, ctx, { skuId: sku, locationId: site.id, quantity: stock + daily * 60, occurredAt: at(addDays(today, -70)), idempotencyKey: randomUUID() });
    if (daily) for (let k = 60; k >= 1; k--) await inv.issue(db, ctx, { skuId: sku, locationId: site.id, quantity: daily, reasonCode: 'sold', occurredAt: at(addDays(today, -k)), idempotencyKey: randomUUID() });
    if (price !== null) await pricing.setPrice(db, ctx, { skuId: sku, amountMinor: price, currency: 'USD' });
    if (cost !== null) await pricing.setPurchaseCost(db, ctx, { skuId: sku, amountMinor: cost, currency: 'USD' });
    if (lead !== null) await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,lead_time_days,source,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'manual',now()::text,now()::text)`, [randomUUID(), ws, sku, site.id, lead]);
    return sku;
  }
  async function purchase(sku, units, expected) {
    const po = await f.workflows.createPurchaseOrder(db, ctx, { supplierId: 'fixture-supplier', destinationLocationId: site.id, expectedDate: expected,
      idempotencyKey: randomUUID(), lines: [{ skuId: sku, quantityUnits: units, unitCost: 1 }] });
    await f.workflows.approvePurchaseOrder(db, ctx, po.purchaseOrderId, { idempotencyKey: randomUUID() });
    await f.workflows.placePurchaseOrder(db, ctx, po.purchaseOrderId, { idempotencyKey: randomUUID() });
    return po;
  }
  // STEADY sells 5 a day with 40 free: it runs out in 8 days, 12 days before a
  // purchase order dated in 20 days. Another order is overdue and not counted.
  const steady = await product('STEADY', { stock: 40, daily: 5, price: 2000, cost: 800 });
  const dated = await purchase(steady, 100, addDays(today, 20));
  await purchase(steady, 50, addDays(today, -3));
  // WAIT has 10 in stock and a customer order for 25: 15 wait, so it is out now
  // until an order placed today arrives after its 7-day lead time.
  const wait = await product('WAIT', { stock: 10, daily: 1, price: 1000, cost: 400, lead: 7 });
  const order = await f.workflows.createSalesOrder(db, ctx, { customerId: 'fixture-customer', deliveryMethod: 'PICKUP', fulfillmentLocationId: site.id,
    idempotencyKey: randomUUID(), lines: [{ skuId: wait, quantity: 25, unitPriceMinor: 1000 }] });
  await f.workflows.confirmSalesOrder(db, ctx, order.salesOrderId, { idempotencyKey: randomUUID() });
  // NOPRICE runs out in 6 days with no delivery due and no price recorded.
  const noPrice = await product('NOPRICE', { stock: 12, daily: 2 });
  // LATER runs out only after a delivery dated in 10 days.
  const later = await product('LATER', { stock: 50, daily: 1, price: 500, cost: 200 });
  await purchase(later, 100, addDays(today, 10));
  const quiet = await product('QUIET', { stock: 5 });
  const saved = async sku => (await db.query(`SELECT *,runout_date::text AS runout,next_delivery_date::text AS delivery,available::float8 AS free,
    waiting::float8 AS owed,units_short::float8 AS short,lost_margin_minor::int AS lost,daily_margin_minor::int AS per_day FROM stockchief_runtime.agent_runout_estimates
    WHERE workspace_id=$1 AND sku_id=$2`, [ws, sku])).rows[0];
  const effects = async () => (await db.query(`SELECT (SELECT count(*) FROM movements WHERE workspace_id=$1)::int AS movements,
    (SELECT count(*) FROM reorder_policies WHERE workspace_id=$1)::int AS policies,(SELECT count(*) FROM sales_order_allocations WHERE workspace_id=$1)::int AS allocations,
    (SELECT string_agg(status,',' ORDER BY id) FROM purchase_orders WHERE workspace_id=$1) AS purchases,
    (SELECT count(*) FROM security_event_history WHERE workspace_id=$1)::int AS audits`, [ws])).rows[0];
  const work = kind => queue.processOne(db, handlers, { owner: 'runout-test', kinds: [kind], leaseMs: 120000 });
  let runs = 0;
  async function run(runKey = 'runout-' + (++runs)) {
    await queue.enqueue(db, { workspaceId: ws, kind: runout.KIND, idempotencyKey: randomUUID(), payload: { runKey } });
    const done = await work(runout.KIND);
    assert.equal(done?.status, 'COMPLETED', JSON.stringify(done?.lastError));
    return done.result;
  }
  const inbox = async () => (await require('../../src/projections/postgres-service').needs(db, ws, ctx.actorId)).filter(n => String(n.sourceId).startsWith('runout'));
  for (const tier of ['starter', 'growth', 'pro', 'enterprise']) {
    await subscribe(tier);
    // The scheduled autopilot check queues one run a business day.
    await queue.enqueue(db, { workspaceId: ws, kind: 'autopilot.evaluate', idempotencyKey: randomUUID(), payload: { actorId: ctx.actorId, requestedByUser: true } });
    assert.equal((await work('autopilot.evaluate'))?.status, 'COMPLETED');
    assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3',
      [ws, runout.KIND, 'runout:' + today])).rows[0].n, 1);
    if (tier === 'starter') assert.equal((await work(runout.KIND)).result.before_delivery, 3, 'The scheduled run on Starter.');
    const before = await effects();
    const result = await run(tier);
    assert.equal(result.before_delivery, 3, tier);
    assert.equal((await run(tier)).replayed, true, 'A finished run is not repeated.');

    let row = await saved(steady);
    assert.deepEqual([row.free, row.owed, Number(row.daily_demand), row.demand_basis, row.runout, row.delivery, row.next_delivery, row.before_delivery],
      [40, 0, 5, 'FORECAST', addDays(today, 8), addDays(today, 20), (await db.query('SELECT po_number FROM purchase_orders WHERE id=$1', [dated.purchaseOrderId])).rows[0].po_number, true], tier);
    assert.deepEqual([row.days_short, row.short, Number(row.unit_margin_minor), row.per_day, row.lost, row.orders_affected], [12, 60, 1200, 6000, 72000, 0]);
    assert.deepEqual(row.evidence.notCounted.map(l => [l.date, l.units]), [[addDays(today, -3), 50]], 'The overdue order is listed, not counted.');
    assert.match(row.reason, /^Runs out in 8 days, before PO-.+ arrives on /);
    row = await saved(wait);
    assert.deepEqual([row.free, row.owed, row.runout, row.delivery, row.days_short, row.short, row.lost, row.per_day, row.orders_affected],
      [0, 15, today, addDays(today, 7), 7, 7, 4200, 600, 1]);
    assert.match(row.reason, /^Out of stock now\. No delivery is due, and an order placed today would arrive in about 7 days\.$/);
    row = await saved(noPrice);
    assert.deepEqual([row.runout, row.delivery, row.before_delivery, row.lost, row.currency], [addDays(today, 6), addDays(today, 14), true, null, null]);
    assert.match(row.reason, /No delivery is due and no lead time is recorded\. Record a selling price and cost to see what it costs\./);
    row = await saved(later);
    assert.deepEqual([row.before_delivery, row.runout, row.reason, row.per_day], [false, addDays(today, 150), 'Runs out after its next delivery.', 300]);
    row = await saved(quiet);
    assert.deepEqual([row.demand_basis, row.runout, row.reason], ['NONE', null, 'No recorded sales or open orders.']);

    // Needs you ranks them by the gross margin lost before the delivery.
    const items = await inbox();
    assert.deepEqual(items.map(n => n.title), ['STEADY runs out before its next delivery', 'WAIT runs out before its next delivery', 'NOPRICE runs out before its next delivery']);
    assert.match(items[0].why, /^About \$720\.00 of gross margin is lost before the delivery \(\$60\.00 a day for 12 days\)\.$/);
    assert.match(items[1].why, /1 open customer order waits for it\./);
    assert.match(items[2].why, /selling price or cost is not recorded/);
    const page = await browser.get(runout.href).expect(200);
    assert.match(page.text, /Runs out before its next delivery/);
    assert.match(page.text, /\$720\.00/);
    assert.match(page.text, /Runs out later/);
    const review = (await reviews.run(db, ctx, 'stockout-cost', { filter: 'STEADY' })).rows[0];
    assert.deepEqual([review['Runs out'], review['Gross margin lost before the delivery'], review['Customer orders affected']], [addDays(today, 8), '$720.00', 0]);
    assert.deepEqual(await effects(), before, 'Run-out checks change no stock, order, setting or audit record.');
  }

  // It only shows, so a pause and the first 14 days do not stop it.
  await auto.pause(db, ctx, { role: 'owner' }, 'Run-out test');
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1', [f.owner.accountId]);
  assert.equal((await run()).before_delivery, 3);
  await auto.resume(db, ctx, { role: 'owner' });
  await db.query("UPDATE accounts SET created_at=(now()-interval '200 days')::text WHERE id=$1", [f.owner.accountId]);

  // Kept current: the dated order arrives early, and the next run clears it.
  await f.workflows.receivePurchaseOrder(db, ctx, dated.purchaseOrderId, { idempotencyKey: randomUUID(), lines: [{ lineId: dated.lineIds[0], quantity: 100, locationId: site.id }] });
  assert.equal((await run()).before_delivery, 2);
  assert.equal((await saved(steady)).before_delivery, false);
  assert.equal((await saved(steady)).free, 140);
  assert.deepEqual((await inbox()).map(n => n.title), ['WAIT runs out before its next delivery', 'NOPRICE runs out before its next delivery']);
  // A product that is no longer sold leaves the list.
  await db.query('UPDATE skus SET is_active=0 WHERE id=$1', [quiet]);
  await run();
  assert.equal(await saved(quiet), undefined);

  // Owners can check now; the page reads on a 390 px phone and on a desktop.
  assert.equal((await runout.requestCheck(db, ctx)).queued, true);
  const app = require('../../src/postgres-app').createPostgresApp({ database: db, env: 'test', sessionSecret: randomUUID() });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const chrome = await require('playwright').chromium.launch();
  f.cleanup(async () => { await chrome.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await app.locals.sessionStore.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const tab = await chrome.newPage({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
    await tab.goto(base + '/login');
    await tab.locator('[name=email]').fill(f.email);
    await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(), tab.getByRole('button', { name: 'Sign in', exact: true }).click()]);
    await tab.goto(base + '/planning');
    await Promise.all([tab.waitForNavigation(), tab.getByRole('link', { name: 'When stock runs out' }).click()]);
    const text = await tab.textContent('body');
    assert.match(text, /WAIT/);
    assert.match(text, /1 open order waiting/);
    assert.equal(await tab.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true, 'No sideways scrolling at ' + viewport.width + ' px');
    await tab.close();
  }
});

test('job 151 on a database migrated only up to 467: Needs you, planning and the review keep working', { timeout: 300000 }, async t => {
  const cluster = await require('../helpers/postgres-cluster').startCluster(), db = require('../../src/db/postgres').openPostgres(cluster.connectionString);
  t.after(async () => { await db.close(); await cluster.stop(); });
  await require('../../src/db/migrate-postgres').migratePostgres(db, { through: '467-agent-safety-stock-targets.sql' });
  const owner = await require('../../src/domain/postgres-auth-service').createBusiness(db, { name: 'Older run-out owner', businessName: 'Older run-out',
    email: randomUUID() + '@example.test', password: 'Upgrade!' + randomUUID() });
  const ctx = { workspaceId: owner.workspaceId, actorId: owner.userId, accountId: owner.accountId };
  const sku = (await catalog.createItem(db, ctx, { name: 'Older product', baseCode: 'OLDER', trackingMode: 'quantity' })).skuIds[0];
  const site = await require('../../src/domain/postgres-location-service').createLocation(db, ctx, { name: 'Older site', kind: 'warehouse' });
  await inv.receive(db, ctx, { skuId: sku, locationId: site.id, quantity: 10, idempotencyKey: randomUUID() });
  for (const days of [20, 10]) await inv.issue(db, ctx, { skuId: sku, locationId: site.id, quantity: 3, reasonCode: 'sold', occurredAt: new Date(Date.now() - days * 86400000).toISOString(), idempotencyKey: randomUUID() });
  assert.deepEqual(await runout.inbox(db, ctx.workspaceId), []);
  assert.ok(Array.isArray(await require('../../src/projections/postgres-service').needs(db, ctx.workspaceId, ctx.actorId)));
  const [estimate] = await runout.estimate(db, ctx.workspaceId, [sku]);
  assert.equal(estimate.available, 4);
});
