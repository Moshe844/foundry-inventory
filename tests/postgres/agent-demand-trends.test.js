'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const forecast = require('../../src/forecasting/agent-demand-forecast');
const trends = require('../../src/forecasting/agent-demand-trends');
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

test('job 148: sudden changes in pace are found against each product\'s own forecast, one-off orders are left out, and planning follows', { timeout: 900000 }, async t => {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 1 }), { db, ctx, browser, subscribe, csrf } = f;
  const site = f.location, ws = ctx.workspaceId;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);
  await db.query('UPDATE skus SET created_at=$2 WHERE id=$1', [f.item.skuIds[0], new Date(Date.now() - 300 * 86400000).toISOString()]);
  const clock = await time.forWorkspace(db, ws), today = clock.calendarDate;
  const at = day => new Date(Date.parse(time.dayBoundary(day, clock.timeZone)) + 12 * 3600000).toISOString();
  async function product(code) {
    const sku = (await catalog.createItem(db, ctx, { name: 'Product ' + code, baseCode: code, trackingMode: 'quantity' })).skuIds[0];
    await db.query('UPDATE skus SET created_at=$2 WHERE id=$1', [sku, at(addDays(today, -300))]);
    await inv.receive(db, ctx, { skuId: sku, locationId: site.id, quantity: 9000, occurredAt: at(addDays(today, -120)), idempotencyKey: randomUUID() });
    return sku;
  }
  const sell = (sku, day, quantity, reference) => inv.issue(db, ctx, { skuId: sku, locationId: site.id, quantity, reasonCode: 'sold', reference,
    occurredAt: at(day), idempotencyKey: randomUUID() });
  // Ten weeks of steady sales, then the last 14 days.
  const fast = await product('FAST'), slow = await product('SLOW'), spike = await product('SPIKE'), twobig = await product('TWOBIG'), noisy = await product('NOISY');
  for (let k = 84; k >= 1; k--) {
    const day = addDays(today, -k), recent = k <= 14;
    await sell(fast, day, recent ? 6 : 2);
    await sell(slow, day, recent ? 1 : 6);
    await sell(spike, day, 2);
    await sell(twobig, day, 2);
    if (k % 2 === 0) await sell(noisy, day, recent ? 12 : 8);
  }
  await sell(fast, addDays(today, -2), 200, 'BIG-1');
  await sell(spike, addDays(today, -5), 100, 'BIG-2');
  for (const k of [6, 3]) await sell(twobig, addDays(today, -k), 40, 'REPEAT-' + k);
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,lead_time_days,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,40,80,14,'manual',now()::text,now()::text)`, [randomUUID(), ws, fast, site.id]);

  // The test itself, before any plan applies.
  const found = await trends.scan(db, ws, [fast, slow, spike, twobig, noisy], today);
  assert.deepEqual([...found.keys()].sort(), [fast, slow, twobig].sort());
  const rising = found.get(fast);
  assert.deepEqual([rising.direction, rising.observed, rising.expected, rising.factor, rising.next30], ['FASTER', 84, 28, 3, 180]);
  assert.deepEqual(rising.ignored, [{ day: addDays(today, -2), units: 200, label: 'BIG-1' }], 'One large order is a one-off.');
  assert.deepEqual([found.get(twobig).direction, found.get(twobig).observed, found.get(twobig).ignored], ['FASTER', 108, []], 'Two large orders are a pattern.');
  assert.deepEqual([found.get(slow).direction, found.get(slow).observed, found.get(slow).expected, found.get(slow).factor], ['SLOWER', 14, 84, 0.25]);

  const work = kind => queue.processOne(db, handlers, { owner: 'demand-trend-test', kinds: [kind], leaseMs: 120000 });
  let runs = 0;
  async function run(runKey = 'check-' + (++runs)) {
    await queue.enqueue(db, { workspaceId: ws, kind: forecast.KIND, idempotencyKey: randomUUID(), payload: { runKey } });
    const done = await work(forecast.KIND);
    assert.equal(done?.status, 'COMPLETED', JSON.stringify(done?.lastError));
    return done.result;
  }
  const trend = async sku => (await db.query(`SELECT id,status,authority_verdict,evidence::jsonb AS evidence FROM planning_recommendations
    WHERE workspace_id=$1 AND kind='demand_trend' AND sku_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [ws, sku])).rows[0];
  const audits = async action => (await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2', [ws, action])).rows[0].n;
  const planned = async sku => (await planning.position(db, ws, { onlySkuIds: [sku] })).find(p => p.location_id === site.id);
  const notice = async id => (await forecast.inbox(db, ws)).find(n => n.sourceId === id);

  // Starter: one suggestion, no routine.
  await subscribe('starter');
  assert.deepEqual(await run(), { skipped: 'plan' });
  assert.deepEqual((await reviews.run(db, ctx, 'rising-demand')).rows,
    [{ Suggestion: 'FAST is selling faster: 84 units in the last 14 days against about 28 expected. Review its reorder point.' }]);
  await assert.rejects(reviews.run(db, ctx, 'rising-demand', { scheduled: true }), e => e.code === 'entitlement_required');
  assert.equal(await notice('demand-trends'), undefined);

  // Growth with routine work on: found on schedule, alerted, followed by planning.
  await subscribe('growth');
  await auto.setMode(db, ctx, { role: 'owner' }, 'POLICY_AUTOMATED');
  let result = await run();
  assert.deepEqual([result.trends_used, result.trends_waiting, result.trends_shown], [3, 0, 0]);
  assert.deepEqual([(await trend(fast)).status, (await trend(fast)).authority_verdict], ['APPLIED', 'authorized']);
  assert.equal(await trend(spike), undefined);
  assert.equal(await trend(noisy), undefined, 'A rise inside the product\'s usual swings is not a trend.');
  let position = await planned(fast);
  assert.deepEqual([position.forecast.basis, Math.round(position.dailyRate * 30)], ['TREND', 180]);
  assert.equal(Math.round((await planned(slow)).dailyRate * 30), 45, 'Slower trends follow down to a quarter of the forecast.');
  const estimate = (await refresh.positions(db, ws, [fast])).find(p => p.locationId === site.id).estimate;
  assert.deepEqual([estimate.forecast.basis, Number(estimate.minimum)], ['TREND', 84 + 42]);
  const alert = await notice('demand-trends');
  assert.equal(alert.title, 'Products selling faster or slower');
  assert.match(alert.happened, /^3 products changed pace/);
  assert.ok((await require('../../src/projections/postgres-service').needs(db, ws, ctx.actorId)).some(n => n.sourceId === 'demand-trends'));
  assert.equal(await audits('Updated demand trends used for planning'), 1);
  const full = (await reviews.run(db, ctx, 'rising-demand', { filter: 'FAST' })).rows[0];
  assert.deepEqual([full.Direction, full['Last 14 days'], full.Expected, full['One-off orders left out'], full.Planning], ['Faster', 84, 28, 'BIG-1 (200)', 'Used for planning']);
  const lastKey = (await db.query('SELECT run_key FROM stockchief_runtime.agent_demand_forecast_runs WHERE workspace_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1', [ws])).rows[0].run_key;
  assert.equal((await run(lastKey)).replayed, true);
  await run();
  assert.equal((await db.query("SELECT count(*)::int n FROM planning_recommendations WHERE workspace_id=$1 AND kind='demand_trend'", [ws])).rows[0].n, 3,
    'A later run keeps one trend per product.');
  assert.equal(await audits('Updated demand trends used for planning'), 1, 'An unchanged trend is not recorded twice.');
  assert.equal((await planning.openRecommendations(db, ws)).length, 0, 'Trends stay off the reorder recommendation list.');

  // Dismissing is the undo: planning goes back to the forecast, and the same
  // trend is not raised again for four weeks.
  const page = await browser.get(forecast.href).expect(200);
  assert.match(page.text, /Selling faster or slower/);
  assert.match(page.text, /Left out as a one-off: BIG-1 \(200\)/);
  await browser.post(forecast.href + '/trends/' + (await trend(fast)).id + '/dismiss').type('form').send({ _csrf: csrf(page.text) }).expect(303);
  assert.equal((await trend(fast)).status, 'DECLINED');
  assert.equal((await planned(fast)).forecast.basis, 'HISTORY');
  assert.equal(await audits('Dismissed a demand trend'), 1);
  assert.equal((await trends.dismiss(db, ctx, (await trend(fast)).id)).replayed, true);
  await run();
  assert.equal((await trend(fast)).status, 'DECLINED');

  // Pro: Ask me first, Watch only, a pause and shadow mode keep planning on the forecast.
  await subscribe('pro');
  const setJobMode = async mode => { const current = (await modes.page(db, ctx)).find(r => r.id === 148); await modes.save(db, ctx, 148, { mode, revision: current.revision }); };
  await setJobMode('ask');
  result = await run();
  assert.equal(result.trends_waiting, 2);
  assert.deepEqual([(await trend(twobig)).status, (await trend(twobig)).authority_verdict], ['OPEN', 'needs_approval']);
  assert.equal((await planned(twobig)).forecast.basis, 'HISTORY');
  assert.match((await notice('demand-trend-approvals')).happened, /^2 products are selling/);
  const waiting = await browser.get(forecast.href).expect(200);
  await browser.post(forecast.href + '/trends/' + (await trend(twobig)).id + '/approve').type('form').send({ _csrf: csrf(waiting.text) }).expect(303);
  assert.equal((await trend(twobig)).status, 'APPLIED');
  assert.equal((await planned(twobig)).forecast.basis, 'TREND');
  assert.equal((await trends.approve(db, ctx, (await trend(twobig)).id)).replayed, true);
  assert.equal(await audits('Approved a demand trend for planning'), 1);
  await run();
  assert.equal((await trend(twobig)).status, 'APPLIED', 'An approved trend stays in use while it lasts.');
  await setJobMode('watch');
  await run();
  assert.deepEqual([(await trend(slow)).status, (await trend(slow)).authority_verdict], ['OPEN', 'refused']);
  await assert.rejects(trends.approve(db, ctx, (await trend(slow)).id), /Watch only/);
  await setJobMode('inherit');
  await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1', [ws]);
  await run();
  assert.equal((await trend(slow)).authority_verdict, 'needs_approval');
  await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1', [ws]);
  await db.query("UPDATE accounts SET created_at=(now()-interval '2 days')::text WHERE id=$1", [f.owner.accountId]);
  await run();
  assert.deepEqual([(await trend(slow)).status, (await trend(slow)).authority_verdict], ['OPEN', 'refused']);
  assert.equal((await planned(slow)).forecast, undefined, 'In shadow mode planning stays on plain sales history.');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);

  // Custom: on its own again; a trend that eases ends, and planning follows.
  await subscribe('enterprise');
  await run();
  assert.equal((await trend(slow)).status, 'APPLIED');
  for (let k = 14; k >= 1; k--) await sell(slow, addDays(today, -k), 5);
  result = await run();
  assert.equal(result.trends_ended, 1);
  const ended = (await db.query("SELECT status,resulting_detail FROM planning_recommendations WHERE workspace_id=$1 AND kind='demand_trend' AND sku_id=$2", [ws, slow])).rows[0];
  assert.equal(ended.status, 'SUPERSEDED');
  assert.match(ended.resulting_detail, /back in line/);
  assert.equal((await planned(slow)).forecast.basis, 'HISTORY');
  await subscribe('starter');
  assert.equal((await planned(twobig)).forecast, undefined, 'A downgrade stops planning following the trend at once.');
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
    await tab.goto(base + forecast.href);
    assert.match(await tab.locator('#trends').textContent(), /TWOBIG/);
    assert.equal(await tab.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true, 'No sideways scrolling at ' + viewport.width + ' px');
    await tab.close();
  }
});
