'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const forecast = require('../../src/forecasting/agent-demand-forecast');
const launch = require('../../src/forecasting/agent-launch-forecast');
const refresh = require('../../src/forecasting/agent-reorder-refresh');
const planning = require('../../src/forecasting/postgres-planning-service');
const catalog = require('../../src/domain/postgres-catalog-service');
const inv = require('../../src/domain/postgres-inventory-engine');
const pricing = require('../../src/pricing/postgres-service');
const auto = require('../../src/autopilot/postgres-service');
const modes = require('../../src/autopilot/job-modes');
const reviews = require('../../src/autopilot/job-reviews');
const queue = require('../../src/operations/postgres-job-queue');
const time = require('../../src/lib/business-time');
const handlers = require('../../src/operations/postgres-runtime-handlers').create();
const { addDays } = require('../../src/accounting/customer-money');

test('job 146: new products are forecast from similar items, ask when unclear, and drive planning on Pro and Custom', { timeout: 900000 }, async t => {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 1 }), { db, ctx, browser, subscribe, csrf } = f;
  const site = f.location, ws = ctx.workspaceId;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);
  const clock = await time.forWorkspace(db, ws), today = clock.calendarDate;
  const at = day => new Date(Date.parse(time.dayBoundary(day, clock.timeZone)) + 12 * 3600000).toISOString();
  async function product(code, { category, brand, price, unit, age }) {
    const item = await catalog.createItem(db, ctx, { name: 'Product ' + code, baseCode: code, trackingMode: 'quantity', ...(unit ? { unitLabel: unit } : {}) });
    const sku = item.skuIds[0];
    await db.query('UPDATE skus SET created_at=$2 WHERE id=$1', [sku, at(addDays(today, -age))]);
    if (unit) await db.query('UPDATE items SET unit_label=$2 WHERE id=$1', [item.itemId, unit]);
    if (category || brand) await db.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at) VALUES($1,$2,$3,$4,now()::text,now()::text)`,
      [ws, item.itemId, category || null, JSON.stringify(brand ? { brand } : {})]);
    if (price) await pricing.setPrice(db, ctx, { skuId: sku, amountMinor: price, currency: 'USD' });
    await inv.receive(db, ctx, { skuId: sku, locationId: site.id, quantity: 5000, occurredAt: at(addDays(today, -Math.min(age, 130))), idempotencyKey: randomUUID() });
    return sku;
  }
  await db.query('UPDATE skus SET created_at=$2 WHERE id=$1', [f.item.skuIds[0], at(addDays(today, -300))]);
  const sell = (sku, day, quantity) => inv.issue(db, ctx, { skuId: sku, locationId: site.id, quantity, reasonCode: 'sold', occurredAt: at(day), idempotencyKey: randomUUID() });
  // Established items: 100 days of steady sales.
  const red = await product('TEE-RED', { category: 'Shirts', brand: 'Acme', price: 2000, age: 300 });
  const old = await product('TEE-OLD', { category: 'Shirts', brand: 'Other', price: 5000, age: 300 });
  await product('MUG', { category: 'Kitchen', brand: 'Acme', price: 2000, age: 300 });
  for (let k = 100; k >= 1; k--) { await sell(red, addDays(today, -k), 2); await sell(old, addDays(today, -k), 6); }
  // New products.
  const blue = await product('TEE-BLUE', { category: 'Shirts', brand: 'Acme', price: 2100, age: 10 });
  const green = await product('TEE-GREEN', { category: 'Shirts', brand: 'Acme', price: 1900, age: 20 });
  for (let k = 14; k >= 1; k--) await sell(green, addDays(today, -k), 4);
  const plain = await product('SHIRT-X', { category: 'Shirts', age: 5 });
  const gadget = await product('GADGET', { category: 'Gadgets', age: 5 });
  const weighed = await product('TEE-KG', { category: 'Shirts', brand: 'Acme', price: 2000, unit: 'kg', age: 5 });
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,lead_time_days,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,20,40,14,'manual',now()::text,now()::text)`, [randomUUID(), ws, blue, site.id]);

  const work = kind => queue.processOne(db, handlers, { owner: 'launch-forecast-test', kinds: [kind], leaseMs: 120000 });
  let runs = 0;
  async function run(runKey = 'check-' + (++runs)) {
    await queue.enqueue(db, { workspaceId: ws, kind: forecast.KIND, idempotencyKey: randomUUID(), payload: { runKey } });
    const done = await work(forecast.KIND);
    assert.equal(done?.status, 'COMPLETED', JSON.stringify(done?.lastError));
    return done.result;
  }
  const saved = async sku => (await db.query(`SELECT status,reason,rule,comparisons,next_30::float8 n30,own_days,weight::float8 weight
    FROM stockchief_runtime.agent_launch_forecasts WHERE workspace_id=$1 AND sku_id=$2`, [ws, sku])).rows[0];
  const audits = async action => (await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2', [ws, action])).rows[0].n;
  const planned = async sku => (await planning.position(db, ws, { onlySkuIds: [sku] })).find(p => p.location_id === site.id);

  // Explicit rules: same units, then same category, brand and price band.
  const rules = await launch.estimate(db, ws, await launch.launches(db, ws, { today }), { today });
  assert.deepEqual([...rules.keys()].sort(), [blue, gadget, green, plain, weighed].sort());
  assert.deepEqual(rules.get(blue).comparisons.map(c => [c.code, c.units30, c.matched.join(', ')]), [['TEE-RED', 60, 'same category, same brand, price within 25%']]);
  assert.equal(rules.get(blue).next30, 60);
  // Its own early sales count too: 14 days at 4 a day, weighted 14/(14+28).
  assert.equal(rules.get(green).ownDays, 14);
  assert.equal(rules.get(green).next30, 80);
  assert.match(rules.get(plain).reason, /sell very differently: 60 to 180 units/);
  assert.match(rules.get(gadget).reason, /No similar item/);
  assert.match(rules.get(weighed).reason, /No similar item with the same units/);

  // Starter: the job is not included.
  await subscribe('starter');
  await assert.rejects(reviews.run(db, ctx, 'new-product-forecast'), e => e.code === 'entitlement_required');
  await assert.rejects(launch.choose(db, ctx, { skuId: plain, code: 'TEE-OLD' }), e => e.code === 'entitlement_required');

  // Growth: suggestions only; missing comparisons ask.
  await subscribe('growth');
  await auto.setMode(db, ctx, { role: 'owner' }, 'POLICY_AUTOMATED');
  let result = await run();
  assert.equal(result.level, 'alone');
  assert.deepEqual([result.new_shown, result.new_asked, result.new_used], [2, 3, 0]);
  assert.equal((await saved(blue)).status, 'SUGGESTED');
  assert.equal((await saved(gadget)).status, 'ASK');
  assert.equal((await planned(blue)).forecast, undefined, 'Growth only suggests.');
  assert.deepEqual((await reviews.run(db, ctx, 'new-product-forecast')).rows, [{ Suggestion: 'Choose a similar item for GADGET so StockChief can forecast it.' }]);
  assert.deepEqual((await reviews.run(db, ctx, 'new-product-forecast', { filter: 'TEE-BLUE' })).rows, [{ Suggestion: 'Consider about 60 units for TEE-BLUE over its first 30 days.' }]);
  const asks = (await forecast.inbox(db, ws)).find(n => n.sourceId === 'launch-forecast-choices');
  assert.match(asks.happened, /^3 new products have no clear similar item/);
  assert.ok((await require('../../src/projections/postgres-service').needs(db, ws, ctx.actorId)).some(n => n.sourceId === 'launch-forecast-choices'));

  // Pro: on its own, the new product's forecast drives planning and job 21.
  await subscribe('pro');
  result = await run();
  assert.deepEqual([result.new_used, result.new_asked], [2, 3]);
  let row = await saved(blue);
  assert.deepEqual([row.status, row.rule, row.n30], ['USED', 'RULES', 60]);
  let position = await planned(blue);
  assert.deepEqual([position.forecast.basis, Math.round(position.dailyRate * 30)], ['SIMILAR', 60]);
  const estimate = (await refresh.positions(db, ws, [blue])).find(p => p.locationId === site.id);
  assert.equal(estimate.skip, undefined, 'A new product with a forecast from similar items is not skipped for its short history.');
  assert.deepEqual([estimate.estimate.forecast.basis, Number(estimate.estimate.minimum)], ['SIMILAR', 28 + 14]);
  assert.deepEqual([(await planned(green)).forecast.basis, Math.round((await planned(green)).dailyRate * 30)], ['SIMILAR', 80]);
  assert.equal(await audits('Updated new product forecasts used for planning'), 1);
  const again = await run((await db.query('SELECT run_key FROM stockchief_runtime.agent_demand_forecast_runs WHERE workspace_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1', [ws])).rows[0].run_key);
  assert.equal(again.replayed, true);
  assert.equal(await audits('Updated new product forecasts used for planning'), 1, 'Replaying a run changes nothing twice.');

  // Unclear comparisons stop; a person chooses, on the page.
  const page = await browser.get(forecast.href).expect(200);
  assert.match(page.text, /New products/);
  assert.match(page.text, /sell very differently/);
  await browser.post(forecast.href + '/similar').type('form').send({ _csrf: csrf(page.text), skuId: plain, code: 'tee-old' }).expect(303);
  row = await saved(plain);
  assert.deepEqual([row.status, row.rule, row.n30, row.comparisons.map(c => c.code)], ['USED', 'OWNER', 180, ['TEE-OLD']]);
  assert.equal(await audits('Chose a similar item for a new product'), 1);
  assert.equal((await launch.choose(db, ctx, { skuId: plain, code: 'TEE-OLD' })).replayed, true);
  await run();
  assert.deepEqual([(await saved(plain)).status, (await saved(plain)).n30], ['USED', 180], 'The daily run keeps the person\'s choice.');
  await assert.rejects(launch.choose(db, ctx, { skuId: weighed, code: 'TEE-RED' }), /same units/);
  await assert.rejects(launch.choose(db, ctx, { skuId: plain, code: 'SHIRT-X' }), /different product/);
  await assert.rejects(launch.choose(db, ctx, { skuId: plain, code: 'NOPE' }), /active product/);
  await assert.rejects(launch.choose(db, ctx, { skuId: plain, code: 'TEE-BLUE' }), /eight weeks of sales/);
  await launch.choose(db, ctx, { skuId: plain, code: '' });
  assert.equal((await saved(plain)).status, 'ASK');
  assert.equal(await audits('Cleared the similar item for a new product'), 1);

  // Ask me first, Watch only and shadow mode hold the forecast.
  const setJobMode = async mode => { const current = (await modes.page(db, ctx)).find(r => r.id === 146); await modes.save(db, ctx, 146, { mode, revision: current.revision }); };
  await setJobMode('ask');
  result = await run();
  assert.equal((await saved(blue)).status, 'PROPOSED');
  assert.match((await saved(blue)).reason, /Ask me first/);
  assert.equal((await planned(blue)).forecast, undefined);
  assert.ok((await forecast.inbox(db, ws)).some(n => n.sourceId === 'launch-forecast-approvals'));
  const waiting = await browser.get(forecast.href).expect(200);
  await browser.post(forecast.href + '/new/approve').type('form').send({ _csrf: csrf(waiting.text), skuId: blue }).expect(303);
  assert.equal((await saved(blue)).status, 'USED');
  assert.equal((await launch.approve(db, ctx, blue)).replayed, true);
  assert.equal(await audits('Approved new product forecast for planning'), 1);
  await run();
  assert.equal((await saved(blue)).status, 'USED', 'An approved forecast stays in use while it keeps its comparison and size.');
  await setJobMode('watch');
  await run();
  assert.equal((await saved(blue)).status, 'WATCHED');
  await assert.rejects(launch.approve(db, ctx, green), /Watch only/);
  await setJobMode('inherit');
  await db.query("UPDATE accounts SET created_at=(now()-interval '2 days')::text WHERE id=$1", [f.owner.accountId]);
  await run();
  assert.equal((await saved(blue)).status, 'WATCHED');
  assert.match((await saved(blue)).reason, /first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);

  // Custom: on its own again; a downgrade to Growth stops it driving planning.
  await subscribe('enterprise');
  await run();
  assert.equal((await saved(blue)).status, 'USED');
  assert.equal((await planned(blue)).forecast.basis, 'SIMILAR');
  await subscribe('growth');
  assert.equal((await planned(blue)).forecast, undefined);
  await subscribe('enterprise');

  // A product stops being new once it has sales older than 90 days.
  await db.query('UPDATE skus SET created_at=$2 WHERE id=$1', [green, at(addDays(today, -200))]);
  await sell(green, addDays(today, -95), 1);
  await run();
  assert.equal(await saved(green), undefined);
  assert.equal((await planned(green)).forecast.basis, 'HISTORY');

  // The page reads on a 390 px phone and on a desktop.
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
    await tab.goto(base + forecast.href);
    assert.match(await tab.locator('#new-products').textContent(), /TEE-BLUE/);
    assert.equal(await tab.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true, 'No sideways scrolling at ' + viewport.width + ' px');
    await tab.close();
  }
});
