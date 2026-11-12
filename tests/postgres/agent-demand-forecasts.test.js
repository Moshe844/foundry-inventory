'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const forecast = require('../../src/forecasting/agent-demand-forecast');
const refresh = require('../../src/forecasting/agent-reorder-refresh');
const planning = require('../../src/forecasting/postgres-planning-service');
const catalog = require('../../src/domain/postgres-catalog-service');
const inv = require('../../src/domain/postgres-inventory-engine');
const auto = require('../../src/autopilot/postgres-service');
const modes = require('../../src/autopilot/job-modes');
const reviews = require('../../src/autopilot/job-reviews');
const queue = require('../../src/operations/postgres-job-queue');
const time = require('../../src/lib/business-time');
const handlers = require('../../src/operations/postgres-runtime-handlers').create();
const { addDays } = require('../../src/accounting/customer-money');

test('job 144: every product is forecast with its seasons, and on Growth and up the forecast drives planning inside the owner modes', { timeout: 900000 }, async t => {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 1 }), { db, ctx, browser, subscribe, csrf } = f;
  const site = f.location, ws = ctx.workspaceId;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);
  const clock = await time.forWorkspace(db, ws), today = clock.calendarDate;
  const at = day => new Date(Date.parse(time.dayBoundary(day, clock.timeZone)) + 12 * 3600000).toISOString();
  // A product that sells 6 a day in its busy months and 2 otherwise. The busy
  // months are this month and the one five days ago, last year and this year.
  const month = day => day.slice(5, 7), busy = new Set([month(addDays(today, -5)), month(today)]);
  const level = day => busy.has(month(day)) ? 6 : 2;
  const expected = (days, from = today) => { let n = 0; for (let i = 0; i < days; i++) n += level(addDays(from, i)); return n; };
  async function product(code) {
    const sku = (await catalog.createItem(db, ctx, { name: 'Product ' + code, baseCode: code, trackingMode: 'quantity' })).skuIds[0];
    await db.query('UPDATE skus SET created_at=$2 WHERE id=$1', [sku, at(addDays(today, -500))]);
    await inv.receive(db, ctx, { skuId: sku, locationId: site.id, quantity: 5000, occurredAt: at(addDays(today, -470)), idempotencyKey: randomUUID() });
    return sku;
  }
  const sell = (sku, day, quantity, reference) => inv.issue(db, ctx, { skuId: sku, locationId: site.id, quantity, reasonCode: 'sold', reference, occurredAt: at(day), idempotencyKey: randomUUID() });
  const season = await product('SEASON'), short = await product('SHORT'), ordered = await product('ORDERED');
  for (let k = 455; k >= 1; k--) { const day = addDays(today, -k); await sell(season, day, level(day)); }
  for (const k of [3, 2, 1]) await sell(short, addDays(today, -k), 1);

  // A shipped order is counted once, on its order date.
  const order = await f.workflows.createSalesOrder(db, ctx, { customerId: 'fixture-customer', deliveryMethod: 'PICKUP', fulfillmentLocationId: site.id,
    orderDate: addDays(today, -3), idempotencyKey: randomUUID(), lines: [{ skuId: ordered, quantity: 4, unitPriceMinor: 900 }] });
  await f.workflows.confirmSalesOrder(db, ctx, order.salesOrderId, { idempotencyKey: randomUUID() });
  await inv.issue(db, ctx, { skuId: ordered, locationId: site.id, quantity: 4, reasonCode: 'sale', reference: order.orderNumber, occurredAt: at(addDays(today, -2)), idempotencyKey: randomUUID() });
  const counted = (await forecast.demand(db, ws, [ordered, season], { from: addDays(today, -30), today }));
  assert.deepEqual([...counted.get(ordered)], [[addDays(today, -3), 4]]);
  assert.equal(counted.get(season).get(addDays(today, -1)), level(addDays(today, -1)));

  const work = kind => queue.processOne(db, handlers, { owner: 'demand-forecast-test', kinds: [kind], leaseMs: 120000 });
  let runs = 0;
  async function run(runKey = 'check-' + (++runs)) {
    await queue.enqueue(db, { workspaceId: ws, kind: forecast.KIND, idempotencyKey: randomUUID(), payload: { runKey } });
    const done = await work(forecast.KIND);
    assert.equal(done?.status, 'COMPLETED', JSON.stringify(done?.lastError));
    return done.result;
  }
  const saved = async sku => (await db.query(`SELECT status,reason,method,next_7::float8 n7,next_30::float8 n30 FROM stockchief_runtime.agent_demand_forecasts
    WHERE workspace_id=$1 AND sku_id=$2`, [ws, sku])).rows[0];
  const audits = async action => (await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2', [ws, action])).rows[0].n;
  const planned = async sku => (await planning.position(db, ws, { onlySkuIds: [sku] })).find(p => p.location_id === site.id);
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,lead_time_days,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,40,80,14,'manual',now()::text,now()::text)`, [randomUUID(), ws, season, site.id]);

  // Starter: one suggestion, no daily routine.
  await subscribe('starter');
  assert.deepEqual(await forecast.schedule(db, ws), { queued: false });
  assert.deepEqual(await run(), { skipped: 'plan' });
  const starter = await reviews.run(db, ctx, 'seasonal-demand', { filter: 'SEASON' });
  assert.equal(starter.rows.length, 1);
  assert.match(starter.rows[0].Suggestion, /^Plan for about [\d.]+ units of SEASON over the next week\.$/);
  assert.match((await browser.get(forecast.href).expect(200)).text, /Plan for about <strong>[\d.]+ units<\/strong> of <strong>SEASON<\/strong>/);
  await assert.rejects(forecast.requestCheck(db, ctx), e => e.code === 'entitlement_required');
  await assert.rejects(reviews.run(db, ctx, 'seasonal-demand', { scheduled: true }), e => e.code === 'entitlement_required');
  assert.equal((await planned(season)).forecast, undefined);

  // Growth: the scheduled autopilot check queues one forecast run a day.
  await subscribe('growth');
  await queue.enqueue(db, { workspaceId: ws, kind: 'autopilot.evaluate', idempotencyKey: randomUUID(), payload: { actorId: ctx.actorId, requestedByUser: true } });
  assert.equal((await work('autopilot.evaluate'))?.status, 'COMPLETED');
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3',
    [ws, forecast.KIND, 'demand-forecast:' + today])).rows[0].n, 1);

  // Growth with routine work off: every forecast waits for the owner.
  let result = (await work(forecast.KIND)).result;
  assert.equal(result.level, 'draft');
  assert.deepEqual([result.proposed, result.held, result.used], [1, 2, 0]);
  let row = await saved(season);
  assert.deepEqual([row.status, row.method, row.n7, row.n30], ['PROPOSED', 'yearly_seasonal', expected(7), expected(30)]);
  assert.match(row.reason, /Routine work is off/);
  assert.equal((await saved(short)).status, 'HELD');
  assert.match((await saved(short)).reason, /Record more sales/);
  assert.equal((await planned(season)).forecast, undefined, 'A waiting forecast does not drive planning.');
  const growthReview = (await reviews.run(db, ctx, 'seasonal-demand', { filter: 'SEASON' })).rows[0];
  assert.deepEqual([growthReview['Forecast method'], growthReview['Next 30 days'], growthReview.Planning], ['Yearly and weekday pattern', expected(30), 'Waiting for your approval']);
  const own = async () => (await forecast.inbox(db, ws)).filter(n => n.sourceId === 'demand-forecasts');
  const [notice] = await own();
  assert.equal(notice.title, 'Forecasts wait for your approval');
  assert.match(notice.happened, /^1 product forecast is ready/);
  assert.ok((await require('../../src/projections/postgres-service').needs(db, ws, ctx.actorId)).some(n => n.sourceId === 'demand-forecasts'));
  assert.equal((await run(today)).replayed, true, 'A finished daily run is not repeated.');

  // The owner lets it drive planning; the reorder list then follows the seasons.
  const page = await browser.get(forecast.href).expect(200);
  assert.match(page.text, /Waiting for you/);
  await browser.post(forecast.href + '/approve').type('form').send({ _csrf: csrf(page.text), skuId: season }).expect(303);
  assert.equal((await saved(season)).status, 'USED');
  assert.equal(await audits('Approved demand forecast for planning'), 1);
  assert.equal((await forecast.approve(db, ctx, season)).replayed, true);
  assert.equal(await audits('Approved demand forecast for planning'), 1);
  assert.deepEqual(await own(), []);
  let position = await planned(season);
  assert.equal(position.forecast.method, 'yearly_seasonal');
  assert.equal(Math.round(position.dailyRate * 30 * 1000) / 1000, expected(30));
  // Job 21's daily check uses the same forecast for lead-time and cover demand.
  let estimate = (await refresh.positions(db, ws, [season])).find(p => p.locationId === site.id).estimate;
  assert.equal(estimate.forecast.method, 'yearly_seasonal');
  assert.equal(Number(estimate.minimum), expected(14) + expected(7));
  assert.equal(Number(estimate.maximum), Math.max(expected(30), expected(14) + 2 * expected(7)));
  result = await run();
  assert.equal((await saved(season)).status, 'USED', 'An approved forecast stays in use while it keeps its method and size.');

  // Growth with routine work on: forecasts drive planning on their own.
  await auto.setMode(db, ctx, { role: 'owner' }, 'POLICY_AUTOMATED');
  for (let k = 9; k >= 4; k--) await sell(short, addDays(today, -k), 1);
  result = await run();
  assert.equal(result.level, 'alone');
  assert.deepEqual([(await saved(season)).status, (await saved(short)).status], ['USED', 'USED']);
  assert.equal((await require('../../src/forecasting/agent-demand-trends').scan(db, ws, [season], today)).size, 0,
    'A busy month the yearly pattern expects is not a sudden trend (job 148).');
  assert.equal(await audits('Updated demand forecasts used for planning'), 1);
  const changed = (await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Updated demand forecasts used for planning'", [ws])).rows[0].after_state;
  assert.deepEqual(changed.products.map(p => p.skuId), [short]);
  const again = await run((await db.query('SELECT run_key FROM stockchief_runtime.agent_demand_forecast_runs WHERE workspace_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1', [ws])).rows[0].run_key);
  assert.equal(again.replayed, true);
  assert.equal(await audits('Updated demand forecasts used for planning'), 1, 'Replaying a run changes nothing twice.');

  // Forecast against actual: last week's stored forecast is scored once its
  // week is over, and job 163's accuracy report counts it.
  await db.query(`UPDATE demand_forecasts SET as_of=$3,horizon_end=$4 WHERE workspace_id=$1 AND sku_id=$2 AND model_version='agent-144-v1'`,
    [ws, season, addDays(today, -7), addDays(today, -1)]);
  const predicted = Number((await db.query("SELECT horizon_units FROM demand_forecasts WHERE workspace_id=$1 AND sku_id=$2 AND model_version='agent-144-v1'", [ws, season])).rows[0].horizon_units);
  await run();
  const scored = (await db.query(`SELECT o.predicted_units,o.actual_units FROM forecast_outcomes o JOIN demand_forecasts d ON d.id=o.forecast_id
    WHERE o.workspace_id=$1 AND o.sku_id=$2`, [ws, season])).rows;
  assert.deepEqual(scored.map(r => [Number(r.predicted_units), Number(r.actual_units)]), [[predicted, expected(7, addDays(today, -7))]]);
  assert.equal((await db.query("SELECT count(*)::int n FROM demand_forecasts WHERE workspace_id=$1 AND sku_id=$2 AND model_version='agent-144-v1'", [ws, season])).rows[0].n, 2);
  const weekReview = (await reviews.run(db, ctx, 'seasonal-demand', { filter: 'SEASON' })).rows[0];
  assert.deepEqual([weekReview['Last full week forecast'], weekReview['Last full week actual'], weekReview.Planning], [predicted, expected(7, addDays(today, -7)), 'Used for planning']);
  await db.query('UPDATE forecast_outcomes SET scored_at=$2 WHERE workspace_id=$1', [ws, at(addDays(today, -1))]);
  assert.match((await reviews.run(db, ctx, 'service-levels')).summary, /Across 1 comparable SKU forecast/);
  await run();
  assert.equal((await db.query('SELECT count(*)::int n FROM forecast_outcomes WHERE workspace_id=$1', [ws])).rows[0].n, 1, 'Each week is scored once.');

  // Pro: Ask me first, a pause, Watch only and shadow mode hold the forecast.
  await subscribe('pro');
  const setJobMode = async mode => { const current = (await modes.page(db, ctx)).find(r => r.id === 144); await modes.save(db, ctx, 144, { mode, revision: current.revision }); };
  await db.query('UPDATE stockchief_runtime.agent_demand_forecasts SET approved_method=NULL,approved_next_30=NULL WHERE workspace_id=$1', [ws]);
  await setJobMode('ask');
  result = await run();
  assert.equal(result.level, 'draft');
  assert.match((await saved(season)).reason, /Ask me first/);
  assert.equal((await saved(season)).status, 'PROPOSED');
  assert.equal((await planned(season)).forecast, undefined);
  await setJobMode('watch');
  result = await run();
  assert.equal(result.level, 'watch');
  assert.equal((await saved(season)).status, 'WATCHED');
  await assert.rejects(forecast.approve(db, ctx, season), /Watch only/);
  await setJobMode('inherit');
  await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1', [ws]);
  result = await run();
  assert.equal(result.level, 'draft');
  assert.match((await saved(season)).reason, /paused/);
  await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1', [ws]);
  await db.query("UPDATE accounts SET created_at=(now()-interval '2 days')::text WHERE id=$1", [f.owner.accountId]);
  result = await run();
  assert.equal(result.level, 'watch');
  assert.match((await saved(season)).reason, /first 14 days/);
  assert.equal((await planned(season)).forecast, undefined);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);
  await auto.setMode(db, ctx, { role: 'owner' }, 'POLICY_AUTOMATED');
  result = await run();
  assert.equal(result.level, 'alone');
  assert.equal((await saved(season)).status, 'USED');

  // Pro applies job 21's reorder point change from the forecast on its own.
  await refresh.configure(db, ctx, { maxChangePercent: 500, fillMissing: 'yes', confirmed: 'yes', revision: 0 });
  await queue.enqueue(db, { workspaceId: ws, kind: refresh.KIND, idempotencyKey: randomUUID(), payload: { runKey: 'forecast-reorder' } });
  assert.equal((await work(refresh.KIND))?.status, 'COMPLETED');
  const applied = (await db.query(`SELECT status,after_minimum::float8 min,evidence FROM stockchief_runtime.agent_reorder_refresh_changes
    WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`, [ws, season, site.id])).rows[0];
  assert.deepEqual([applied.status, applied.min, applied.evidence.forecast.method], ['APPLIED', expected(14) + expected(7), 'yearly_seasonal']);
  assert.equal((await db.query('SELECT notes FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3', [ws, season, site.id])).rows[0].notes,
    'Kept up to date from the demand forecast');

  // Custom: the owner keeps a product on plain sales history, and back again.
  await subscribe('enterprise');
  const forecasts = await browser.get(forecast.href).expect(200);
  assert.match(forecasts.text, /Forecasts drive the reorder list and reorder points on their own/);
  assert.match(forecasts.text, /Yearly and weekday pattern/);
  assert.match(forecasts.text, /Week from /);
  await browser.post(forecast.href + '/use').type('form').send({ _csrf: csrf(forecasts.text), skuId: season, excluded: 'yes' }).expect(303);
  assert.equal((await saved(season)).status, 'EXCLUDED');
  assert.equal((await planned(season)).forecast, undefined);
  assert.equal(await audits('Kept a product on plain sales history'), 1);
  await run();
  assert.equal((await saved(season)).status, 'EXCLUDED', 'The daily run keeps the owner\'s choice.');
  await forecast.setExcluded(db, ctx, { skuId: season, excluded: 'no' });
  assert.equal((await saved(season)).status, 'USED');
  assert.equal((await planned(season)).forecast.method, 'yearly_seasonal');
  assert.equal(await audits('Let the forecast plan a product again'), 1);
  await assert.rejects(forecast.setExcluded(db, ctx, { skuId: f.item.skuIds[0], excluded: 'yes' }), /no forecast/);

  // A downgrade to Starter stops the forecast driving planning at once.
  await subscribe('starter');
  assert.equal((await planned(season)).forecast, undefined);
  await subscribe('enterprise');

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
    await tab.goto(base + '/planning');
    await Promise.all([tab.waitForNavigation(), tab.getByRole('link', { name: 'Demand forecasts' }).click()]);
    assert.match(await tab.textContent('body'), /SEASON/);
    assert.equal(await tab.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true, 'No sideways scrolling at ' + viewport.width + ' px');
    await tab.close();
  }
});

test('job 144 on a database migrated only up to 444: planning, reorder checks and Needs you keep working', { timeout: 300000 }, async t => {
  const cluster = await require('../helpers/postgres-cluster').startCluster(), db = require('../../src/db/postgres').openPostgres(cluster.connectionString);
  t.after(async () => { await db.close(); await cluster.stop(); });
  await require('../../src/db/migrate-postgres').migratePostgres(db, { through: '444-agent-repeat-orders.sql' });
  const owner = await require('../../src/domain/postgres-auth-service').createBusiness(db, { name: 'Older forecast owner', businessName: 'Older forecasts',
    email: randomUUID() + '@example.test', password: 'Upgrade!' + randomUUID() });
  const ctx = { workspaceId: owner.workspaceId, actorId: owner.userId, accountId: owner.accountId };
  const sku = (await catalog.createItem(db, ctx, { name: 'Older product', baseCode: 'OLDER', trackingMode: 'quantity' })).skuIds[0];
  const site = await require('../../src/domain/postgres-location-service').createLocation(db, ctx, { name: 'Older site', kind: 'warehouse' });
  await inv.receive(db, ctx, { skuId: sku, locationId: site.id, quantity: 50, idempotencyKey: randomUUID() });
  for (const days of [20, 10]) await inv.issue(db, ctx, { skuId: sku, locationId: site.id, quantity: 5, reasonCode: 'sold', occurredAt: new Date(Date.now() - days * 86400000).toISOString(), idempotencyKey: randomUUID() });
  const position = (await planning.position(db, ctx.workspaceId, { onlySkuIds: [sku] })).find(p => p.location_id === site.id);
  assert.equal(position.issued, 10);
  assert.equal(position.forecast, undefined);
  assert.ok(Array.isArray(await refresh.positions(db, ctx.workspaceId, [sku])));
  assert.deepEqual(await forecast.inbox(db, ctx.workspaceId), []);
  assert.ok(Array.isArray(await require('../../src/projections/postgres-service').needs(db, ctx.workspaceId, ctx.actorId)));
});
