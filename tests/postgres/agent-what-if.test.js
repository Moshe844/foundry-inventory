'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const catalog = require('../../src/domain/postgres-catalog-service');
const inv = require('../../src/domain/postgres-inventory-engine');
const pricing = require('../../src/pricing/postgres-service');
const reviews = require('../../src/autopilot/job-reviews');
const commerce = require('../../src/operations/postgres-commerce');
const time = require('../../src/lib/business-time');
const { addDays } = require('../../src/accounting/customer-money');

const KEYS = ['demand-scenario', 'price-scenario', 'cost-scenario', 'lead-time-scenario', 'supplier-loss-scenario'];

test('job 149: Growth, Pro and Custom answer what-if questions about sales, prices, costs, slower deliveries and a lost supplier; Starter is locked', { timeout: 900000 }, async t => {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 1 }), { db, ctx, browser, subscribe } = f;
  const site = f.location, ws = ctx.workspaceId;
  await db.query("UPDATE accounts SET created_at=(now()-interval '200 days')::text WHERE id=$1", [f.owner.accountId]);
  const clock = await time.forWorkspace(db, ws), today = clock.calendarDate;
  const at = day => new Date(Date.parse(time.dayBoundary(day, clock.timeZone)) + 12 * 3600000).toISOString();
  await db.query(`INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('backup-supplier',$1,'Backup parts','active','USD',now()::text,now()::text)`, [ws]);
  async function product(code, { stock, daily = 0, price = null, cost = null, suppliers = [] }) {
    const sku = (await catalog.createItem(db, ctx, { name: 'Product ' + code, baseCode: code, trackingMode: 'quantity' })).skuIds[0];
    await inv.receive(db, ctx, { skuId: sku, locationId: site.id, quantity: stock + daily * 60, occurredAt: at(addDays(today, -70)), idempotencyKey: randomUUID() });
    if (daily) for (let k = 60; k >= 1; k--) await inv.issue(db, ctx, { skuId: sku, locationId: site.id, quantity: daily, reasonCode: 'sold', occurredAt: at(addDays(today, -k)), idempotencyKey: randomUUID() });
    if (price !== null) await pricing.setPrice(db, ctx, { skuId: sku, amountMinor: price, currency: 'USD' });
    if (cost !== null) await pricing.setPurchaseCost(db, ctx, { skuId: sku, amountMinor: cost, currency: 'USD' });
    for (const [supplierId, lead, preferred] of suppliers) await commerce.linkSupplierItem(db, ctx, { supplierId, skuId: sku, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
      lastUnitCost: 1, minimumOrderQuantity: 1, orderMultiple: 1, leadTimeDays: lead, isPreferred: preferred });
    return sku;
  }
  async function purchase(sku, units, expected) {
    const po = await f.workflows.createPurchaseOrder(db, ctx, { supplierId: 'fixture-supplier', destinationLocationId: site.id, expectedDate: expected,
      idempotencyKey: randomUUID(), lines: [{ skuId: sku, quantityUnits: units, unitCost: 1 }] });
    await f.workflows.approvePurchaseOrder(db, ctx, po.purchaseOrderId, { idempotencyKey: randomUUID() });
    await f.workflows.placePurchaseOrder(db, ctx, po.purchaseOrderId, { idempotencyKey: randomUUID() });
    return po;
  }
  // STEADY sells 5 a day with 40 free: it runs out in 8 days, before its
  // delivery in 20. Only Fixture parts supplies it.
  const steady = await product('STEADY', { stock: 40, daily: 5, price: 2000, cost: 800, suppliers: [['fixture-supplier', 7, true]] });
  await purchase(steady, 100, addDays(today, 20));
  // ONLY sells 2 a day with 30 free; its delivery in 10 days comes in time.
  const only = await product('ONLY', { stock: 30, daily: 2, price: 1000, cost: 500, suppliers: [['fixture-supplier', 7, true]] });
  await purchase(only, 50, addDays(today, 10));
  // BOTH can also come from Backup parts in 5 days.
  await product('BOTH', { stock: 20, daily: 1, price: 600, cost: 300, suppliers: [['fixture-supplier', 7, true], ['backup-supplier', 5, false]] });
  // NOPRICE has no selling price or cost on record.
  await product('NOPRICE', { stock: 12, daily: 2 });
  const effects = async () => (await db.query(`SELECT (SELECT count(*) FROM movements WHERE workspace_id=$1)::int AS movements,
    (SELECT count(*) FROM reorder_policies WHERE workspace_id=$1)::int AS policies,(SELECT count(*) FROM sku_prices WHERE workspace_id=$1)::int AS prices,
    (SELECT count(*) FROM sku_purchase_costs WHERE workspace_id=$1)::int AS costs,(SELECT string_agg(status||':'||coalesce(expected_date,''),',' ORDER BY id) FROM purchase_orders WHERE workspace_id=$1) AS purchases,
    (SELECT count(*) FROM security_event_history WHERE workspace_id=$1)::int AS audits`, [ws])).rows[0];
  const before = await effects();
  const ask = (agentJob, search, demandChangePercent) => require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review')
    .prepare(null, db, ctx, 'What if?', { agentJob, search, demandChangePercent });
  const row = (result, sku) => result.rows.find(r => r.SKU === sku);

  // Starter: every what-if question shows the plan lock.
  await subscribe('starter');
  for (const key of KEYS) {
    await assert.rejects(reviews.run(db, ctx, key, { filter: '', change: 20 }), e => e.code === 'entitlement_required');
    await browser.get('/autopilot/reviews/' + key).query({ change: 20 }).expect(402);
  }
  assert.doesNotMatch((await browser.get('/autopilot/reviews').expect(200)).text, /href="\/autopilot\/reviews\/lead-time-scenario"/);

  for (const tier of ['growth', 'pro', 'enterprise']) {
    await subscribe(tier);
    assert.match((await browser.get('/autopilot/reviews').expect(200)).text, /href="\/autopilot\/reviews\/supplier-loss-scenario"/);

    // What if sales go up 20%? STEADY runs out 2 days sooner and loses more margin before its delivery.
    const sales = await reviews.run(db, ctx, 'demand-scenario', { filter: '', change: 20 });
    assert.equal(sales.mode, 'alone');
    const s = row(sales, 'STEADY');
    assert.deepEqual([s['Sales in 30 days'], s['Runs out'], s['Next delivery'], s['Short before it'], s['Margin lost before it']],
      ['150 → 180', addDays(today, 8) + ' → ' + addDays(today, 6), addDays(today, 20), '60 → 80', '$720.00 → $960.00']);
    assert.equal(row(sales, 'ONLY')['Runs out'], addDays(today, 40) + ' → ' + addDays(today, 33));
    assert.equal(row(sales, 'ONLY')['Margin lost before it'], 'None');
    assert.match(sales.summary, /If sales go up 20%, 2 of 5 products run out before their next delivery \(2 today\), 101\.6 units short in all\. Gross margin lost before those deliveries: \$960\.00 \(today \$720\.00\)\./);
    assert.match(sales.summary, /Nothing was changed/);
    const none = row(await reviews.run(db, ctx, 'demand-scenario', { filter: 'STEADY', change: -100 }), 'STEADY');
    assert.deepEqual([none['Sales in 30 days'], none['Runs out']], ['150 → 0', addDays(today, 8) + ' → Not within a year']);

    // What if prices go up 10%? Same sales, higher margin; sales could fall 14.3% and earn the same.
    const prices = await reviews.run(db, ctx, 'price-scenario', { filter: '', change: 10 });
    const p = row(prices, 'STEADY');
    assert.deepEqual([p.Price, p.Cost, p['Margin a unit'], p['Sales in 30 days'], p['Margin in 30 days'], p['Sales change that earns the same']],
      ['$20.00 → $22.00', '$8.00', '$12.00 → $14.00', 150, '$1,800.00 → $2,100.00', '-14.3%']);
    assert.deepEqual(Object.keys(row(prices, 'NOPRICE')), Object.keys(p), 'Every row has the same columns');
    assert.match(row(prices, 'NOPRICE').Reason, /Record a selling price and a purchase cost/);
    assert.match(prices.summary, /StockChief does not guess how customers react\. No price was changed; changing prices always needs a person\./);
    assert.match(prices.summary, /2 products need a selling price and cost first/);

    // What if Fixture parts raises costs 10%? Only its products, and the price that keeps today's margin.
    const costs = await reviews.run(db, ctx, 'cost-scenario', { filter: 'fixture parts', change: 10 });
    assert.deepEqual(costs.rows.map(r => r.SKU), ['BOTH', 'ONLY', 'STEADY']);
    const c = row(costs, 'STEADY');
    assert.deepEqual([c.Cost, c.Margin, c['Margin in 30 days'], c['Price that keeps the margin %']], ['$8.00 → $8.80', '60% → 56%', '$1,800.00 → $1,680.00', '$22.00']);
    assert.match(costs.summary, /^If costs from Fixture parts go up 10%, gross margin over the next 30 days at today’s prices goes from \$2,190\.00 to \$2,031\.00\./);

    // What if Fixture parts takes 14 more days? ONLY and BOTH now run out before their deliveries.
    const slow = await reviews.run(db, ctx, 'lead-time-scenario', { filter: 'Fixture parts', change: 14 });
    const l = row(slow, 'STEADY'), o = row(slow, 'ONLY');
    assert.deepEqual([l['Next delivery'], l['Margin lost before it'], l['Extra stock for the wait']], [addDays(today, 20) + ' → ' + addDays(today, 34), '$720.00 → $1,560.00', 70]);
    assert.deepEqual([o['Next delivery'], o['Short before it'], o['Margin lost before it']], [addDays(today, 10) + ' → ' + addDays(today, 24), '0 → 18', 'None → $90.00']);
    assert.equal(row(slow, 'BOTH')['Next delivery'], addDays(today, 7) + ' → ' + addDays(today, 21));
    assert.match(slow.summary, /If deliveries from Fixture parts take 14 days longer, 3 of 3 products run out before their next delivery \(1 today\)\. Keeping about 112 more units in stock covers the longer wait\./);
    const fast = row(await reviews.run(db, ctx, 'lead-time-scenario', { filter: 'Fixture parts', change: -15 }), 'STEADY');
    assert.deepEqual([fast['Next delivery'], fast['Margin lost before it'], fast['Extra stock for the wait']], [addDays(today, 20) + ' → ' + addDays(today, 5), '$720.00 → None', 0]);

    // What if you lost Fixture parts? STEADY and ONLY have no other supplier; BOTH can come from Backup parts.
    const loss = await reviews.run(db, ctx, 'supplier-loss-scenario', { filter: 'Fixture parts' });
    const g = row(loss, 'STEADY'), b = row(loss, 'BOTH');
    assert.deepEqual([g['Other suppliers'], g['Due from this supplier'], g['Next delivery if lost'], g['Margin lost before it'], g['Margin a month']],
      ['None on record', 100, 'None', '$4,920.00', '$1,800.00']);
    assert.match(g.Reason, /no other supplier is on record/);
    assert.deepEqual([b['Other suppliers'], b['Next delivery if lost'], b['Runs out'], b['Margin lost before it']], ['Backup parts', addDays(today, 5), addDays(today, 20), 'None']);
    assert.match(loss.summary, /If you lost Fixture parts, 2 of its 3 products would have no other supplier on record, and 2 would run out before another delivery could arrive\./);
    assert.match(loss.summary, /2 open purchase orders worth \$150\.00 from it would not arrive/);
    assert.match(loss.summary, /With no other supplier, losses are counted over 90 days/);

    // Ask reaches the same answers through the review capability.
    const asked = await ask('lead-time-scenario', 'Fixture parts', 14);
    assert.equal(row(asked, 'ONLY')['Short before it'], '0 → 18');
    assert.ok(asked.sources[0].href.includes('change=14') && asked.sources[0].href.includes('filter=Fixture+parts'));
    assert.equal(row(await ask('demand-scenario', 'STEADY', 20), 'STEADY')['Sales in 30 days'], '150 → 180');
  }

  // Missing or wrong facts: it asks instead of guessing.
  assert.match((await reviews.run(db, ctx, 'lead-time-scenario', { filter: '', change: '' })).summary, /Enter the supplier’s exact name/);
  assert.match((await reviews.run(db, ctx, 'supplier-loss-scenario', { filter: '' })).summary, /Enter the exact name of the supplier/);
  await assert.rejects(reviews.run(db, ctx, 'supplier-loss-scenario', { filter: 'Nobody Ltd' }), /No active supplier is called Nobody Ltd/);
  await assert.rejects(reviews.run(db, ctx, 'lead-time-scenario', { filter: 'Fixture parts', change: '2.5' }), /whole days/);
  await assert.rejects(reviews.run(db, ctx, 'demand-scenario', { filter: '', change: 'lots' }), /between -100% and 1,000%/);
  await assert.rejects(reviews.run(db, ctx, 'price-scenario', { filter: 'NO-SUCH-SKU', change: 5 }), /No active product has the SKU/);
  assert.equal((await reviews.run(db, ctx, 'price-scenario', { filter: '', change: '' })).rows.length, 0);

  // Answering changed nothing: no stock, policy, price, cost, order or audit record.
  assert.deepEqual(await effects(), before);

  // The pages read on a 390 px phone and on a desktop.
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
    await tab.goto(base + '/autopilot/reviews/lead-time-scenario');
    await tab.locator('[name=filter]').fill('Fixture parts');
    await tab.locator('[name=change]').fill('14');
    await Promise.all([tab.waitForNavigation(), tab.getByRole('button', { name: 'Look up', exact: true }).click()]);
    const text = await tab.textContent('main');
    assert.match(text, /If deliveries from Fixture parts take 14 days longer/);
    assert.match(text, /Extra stock for the wait/);
    assert.equal(await tab.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true, 'No sideways scrolling at ' + viewport.width + ' px: ' + JSON.stringify(await tab.evaluate(() => ({ sw: document.body.scrollWidth, iw: innerWidth, wide: [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > innerWidth + 2).slice(0, 6).map(e => e.tagName + '.' + e.className + ':' + Math.round(e.getBoundingClientRect().width)) }))));
    await tab.goto(base + '/autopilot/reviews/supplier-loss-scenario?filter=' + encodeURIComponent('Fixture parts'));
    assert.match(await tab.textContent('main'), /If you lost Fixture parts/);
    assert.equal(await tab.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true, 'No sideways scrolling at ' + viewport.width + ' px');
    await tab.close();
  }
});
