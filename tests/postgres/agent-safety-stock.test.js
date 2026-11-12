'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const forecast = require('../../src/forecasting/agent-demand-forecast');
const safety = require('../../src/forecasting/agent-safety-stock');
const refresh = require('../../src/forecasting/agent-reorder-refresh');
const catalog = require('../../src/domain/postgres-catalog-service');
const auto = require('../../src/autopilot/postgres-service');
const modes = require('../../src/autopilot/job-modes');
const queue = require('../../src/operations/postgres-job-queue');
const time = require('../../src/lib/business-time');
const handlers = require('../../src/operations/postgres-runtime-handlers').create();
const { addDays } = require('../../src/accounting/customer-money');

test('job 150: safety stock follows forecast error and late deliveries for the owner target, drafted on Growth and applied inside limits on Pro and Custom', { timeout: 900000 }, async t => {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 1 }), { db, ctx, browser, subscribe, csrf } = f;
  const site = f.location, ws = ctx.workspaceId;
  const clock = await time.forWorkspace(db, ws), today = clock.calendarDate;
  const at = day => new Date(Date.parse(time.dayBoundary(day, clock.timeZone)) + 12 * 3600000).toISOString();
  await db.query("UPDATE accounts SET created_at=(now()-interval '200 days')::text WHERE id=$1", [f.owner.accountId]);
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1', [ws, addDays(today, -190)]);
  const receipts = require('../../src/accounting/postgres-stock-receipt'), removals = require('../../src/accounting/postgres-stock-removal');
  async function product(code, days, { lead = null, reorder = null, target = null } = {}) {
    const sku = (await catalog.createItem(db, ctx, { name: 'Product ' + code, baseCode: code, trackingMode: 'quantity' })).skuIds[0];
    await receipts.receive(db, ctx, { skuId: sku, locationId: site.id, quantity: 5000, unitCost: 1, occurredAt: at(addDays(today, -150)), idempotencyKey: randomUUID() });
    for (let k = days; k >= 1; k--) await removals.issue(db, ctx, { skuId: sku, locationId: site.id, quantity: [2, 4, 6][k % 3], reasonCode: 'sold',
      occurredAt: at(addDays(today, -k)), idempotencyKey: randomUUID() });
    if (lead !== null) await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,lead_time_days,reorder_point,target_stock,source,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'manual',now()::text,now()::text)`, [randomUUID(), ws, sku, site.id, lead, reorder, target]);
    return sku;
  }
  // A delivery promised for one day and received on another.
  async function delivery(sku, ordered, promised, received) {
    const po = await f.workflows.createPurchaseOrder(db, ctx, { supplierId: 'fixture-supplier', destinationLocationId: site.id, expectedDate: addDays(today, -promised),
      idempotencyKey: randomUUID(), lines: [{ skuId: sku, quantityUnits: 10, unitCost: 1 }] });
    await f.workflows.approvePurchaseOrder(db, ctx, po.purchaseOrderId, { idempotencyKey: randomUUID() });
    await f.workflows.placePurchaseOrder(db, ctx, po.purchaseOrderId, { idempotencyKey: randomUUID() });
    await db.query('UPDATE purchase_orders SET ordered_at=$3,order_date=$4 WHERE workspace_id=$1 AND id=$2', [ws, po.purchaseOrderId, at(addDays(today, -ordered)), addDays(today, -ordered)]);
    await f.workflows.receivePurchaseOrder(db, ctx, po.purchaseOrderId, { idempotencyKey: randomUUID(), receivedAt: at(addDays(today, -received)),
      lines: [{ lineId: po.lineIds[0], quantity: 10, locationId: site.id }] });
  }
  // SAFE has everything: 100 days of uneven sales, a 10-day lead time, and
  // three deliveries that came 0, 2 and 4 days after their promised date.
  const safe = await product('SAFE', 100, { lead: 10, reorder: 60, target: 100 });
  for (const [ordered, late] of [[80, 0], [60, 2], [40, 4]]) await delivery(safe, ordered, ordered - 10, ordered - 10 - late);
  const noLead = await product('NOLEAD', 60);
  const few = await product('FEW', 60, { lead: 7 });
  for (const ordered of [50, 30]) await delivery(few, ordered, ordered - 7, ordered - 7);
  const young = await product('YOUNG', 10, { lead: 7 });

  const work = kind => queue.processOne(db, handlers, { owner: 'safety-stock-test', kinds: [kind], leaseMs: 120000 });
  let runs = 0;
  async function run(runKey = 'safety-' + (++runs)) {
    await queue.enqueue(db, { workspaceId: ws, kind: forecast.KIND, idempotencyKey: randomUUID(), payload: { runKey } });
    const done = await work(forecast.KIND);
    assert.equal(done?.status, 'COMPLETED', JSON.stringify(done?.lastError));
    return done.result;
  }
  const rows = async sku => (await db.query(`SELECT id,status,reason,before_safety::float8 AS before,after_safety::float8 AS after,authority,evidence
    FROM stockchief_runtime.agent_safety_stock_changes WHERE workspace_id=$1 AND sku_id=$2 ORDER BY created_at,id`, [ws, sku])).rows;
  const open = async sku => (await rows(sku)).filter(r => ['DRAFT', 'WATCHED', 'HELD'].includes(r.status));
  const saved = async sku => {
    const v = (await db.query('SELECT safety_stock FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3', [ws, sku, site.id])).rows[0]?.safety_stock;
    return v == null ? null : Number(v);
  };
  const audits = async action => (await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2', [ws, action])).rows[0].n;
  const target = async (input) => {
    const page = await browser.get(safety.href).expect(200);
    const { percent, runouts, ...rest } = input;
    return browser.post(safety.href + '/targets').type('form').send({ _csrf: csrf(page.text), locationId: '', ...rest, value: percent ?? runouts }).expect(303);
  };
  // The formula, worked from the recorded inputs.
  const expected = e => Math.ceil(Math.round(e.z * Math.sqrt(e.lead * e.spread ** 2 + e.demand ** 2 * e.leadSpread ** 2) * 1e6) / 1e6);
  const forecastError = async sku => Number((await db.query('SELECT holdout_error FROM stockchief_runtime.agent_demand_forecasts WHERE workspace_id=$1 AND sku_id=$2', [ws, sku])).rows[0].holdout_error);

  // Starter: excluded, with the plan lock shown.
  await subscribe('starter');
  // Monthly classes (job 15) say which target each product follows.
  assert.equal((await db.transaction(c => require('../../src/forecasting/monthly-product-classes').calculate(c, ws))).withSales, 3, 'YOUNG sold only this month, so it is class C.');
  const locked = await browser.get(safety.href).expect(402);
  assert.match(locked.text, /data-agent-plan-locked/);
  assert.match(locked.text, /requires the Growth plan/);
  await assert.rejects(safety.setTarget(db, ctx, { class: 'A', kind: 'percent', percent: '95' }), e => e.code === 'entitlement_required');
  await assert.rejects(safety.page(db, ctx), e => e.code === 'entitlement_required');
  assert.deepEqual(await run(), { skipped: 'plan' });
  assert.deepEqual(await rows(safe), []);

  // Growth: the owner sets a 95% target for every class; the daily run drafts
  // each new value for approval and holds the products missing facts.
  await subscribe('growth');
  for (const cls of ['A', 'B', 'C']) await target({ class: cls, kind: 'percent', percent: cls === 'A' ? '95' : '90' });
  assert.equal(await audits('Set safety stock target'), 3);
  let result = await run();
  assert.equal(result.safety_waiting, 1);
  let [draft] = await open(safe);
  assert.equal(draft.status, 'DRAFT');
  let e = draft.evidence;
  assert.deepEqual([e.class, e.lead, e.leadSpread, e.deliveries, e.z, e.service, e.target], ['A', 10, 2, 3, 1.6449, 95, '95% of reorders without running out'],
    'The monthly class of the product (job 15) picks its target.');
  assert.equal(e.spread, Math.round(1.25 * await forecastError(safe) * 1e4) / 1e4, 'Demand swings come from the forecast error on held-out days.');
  assert.ok(e.spread > 0);
  const position = (await require('../../src/forecasting/postgres-planning-service').position(db, ws, { onlySkuIds: [safe] })).find(p => p.location_id === site.id);
  assert.equal(e.demand, Math.round(position.issued / 90 * 1e4) / 1e4, 'Routine work is off, so the forecast is not in use and demand is recorded sales.');
  const first = expected(e);
  assert.equal(draft.after, first);
  assert.equal(await saved(safe), null, 'Nothing changes before a person approves.');
  const held = Object.fromEntries((await db.query(`SELECT evidence->>'code' AS code,reason FROM stockchief_runtime.agent_safety_stock_changes
    WHERE workspace_id=$1 AND status='HELD'`, [ws])).rows.map(r => [r.code, r.reason]));
  assert.match(held.NOLEAD, /Record a lead time/);
  assert.match(held.FEW, /Needs 3 deliveries received against a promised date.*There are 2 so far/);
  assert.match(held.YOUNG, /Needs a tested sales forecast/);
  const notice = (await require('../../src/projections/postgres-service').needs(db, ws, ctx.actorId)).find(n => n.sourceId === 'safety-stock');
  assert.equal(notice.title, 'Safety stock changes wait for you');
  let page = await browser.get(safety.href).expect(200);
  assert.match(page.text, /Waiting for you/);
  assert.match(page.text, /Held and why/);
  assert.match(page.text, /Class A · 95% of reorders without running out/);
  await browser.post(safety.href + '/' + draft.id + '/approve').type('form').send({ _csrf: csrf(page.text) }).expect(303);
  assert.equal(await saved(safe), first);
  assert.equal(await audits('Updated safety stock for your service target'), 1);
  assert.equal((await safety.approve(db, ctx, draft.id)).replayed, true);
  assert.equal(await audits('Updated safety stock for your service target'), 1);
  assert.equal((await require('../../src/projections/postgres-service').needs(db, ws, ctx.actorId)).some(n => n.sourceId === 'safety-stock'), false);
  // Job 21 builds the reorder point on the new safety stock.
  const reorder = (await refresh.positions(db, ws, [safe])).find(p => p.locationId === site.id).estimate;
  assert.equal(Number(reorder.safety), first);
  assert.equal(Number(reorder.minimum), Math.ceil(Number(reorder.issued) * 10 / 90) + first, 'Reorder point = lead-time demand + safety stock.');
  result = await run();
  assert.equal(result.safety_waiting, 0, 'An approved value is not drafted again.');

  // "I can run out once a year": about 36 reorders a year here, so 35 of 36
  // are covered. A person keeps the current value; it is not drafted again.
  await target({ class: 'A', kind: 'runouts', runouts: '1' });
  await run();
  [draft] = await open(safe);
  e = draft.evidence;
  assert.equal(e.target, 'run out at most once a year');
  // Reorders a year: daily demand over the 40 units between the reorder point and the target.
  assert.equal(e.reorders, Math.round(365 * e.demand / 40 * 10) / 10);
  assert.ok(e.reorders > 35 && e.reorders < 37);
  assert.equal(e.service, Math.round((1 - 40 / (365 * e.demand)) * 1000) / 10);
  assert.equal(draft.after, expected(e));
  assert.ok(draft.after > first);
  await safety.decline(db, ctx, draft.id);
  assert.equal(await saved(safe), first);
  await run();
  [draft] = await open(safe);
  assert.deepEqual([draft.status, draft.reason], ['HELD', 'You kept the current value instead of this change. It will look again when sales, deliveries or targets change.']);

  // Pro: alone inside the change limit from the reorder point check.
  await subscribe('pro');
  await auto.setMode(db, ctx, { role: 'owner' }, 'POLICY_AUTOMATED');
  await target({ class: 'A', kind: 'percent', percent: '99' });
  await run();
  [draft] = await open(safe);
  assert.deepEqual([draft.status, draft.reason], ['DRAFT', 'Save your change limit on Keep reorder points up to date to let it change safety stock on its own.']);
  assert.equal(draft.evidence.demand > 0, true);
  const high = draft.after;
  await refresh.configure(db, ctx, { maxChangePercent: '10', confirmed: 'yes', revision: 0 });
  await run();
  [draft] = await open(safe);
  assert.equal(draft.status, 'DRAFT');
  assert.match(draft.reason, /^This changes safety stock by [\d.]+%, more than your 10% limit\.$/);
  await refresh.configure(db, ctx, { maxChangePercent: '200', confirmed: 'yes', revision: 1 });
  const before = await audits('Updated safety stock for your service target');
  const key = 'pro-apply';
  result = await run(key);
  assert.equal(result.safety_applied, 1);
  assert.equal(await saved(safe), high);
  const applied = (await rows(safe)).find(r => r.status === 'APPLIED' && r.authority === 'RULE');
  assert.ok(applied);
  assert.equal(await audits('Updated safety stock for your service target'), before + 1);
  assert.equal((await run(key)).replayed, true);
  assert.equal(await audits('Updated safety stock for your service target'), before + 1, 'A replayed run changes nothing twice.');
  // The reorder check reads it the same day.
  assert.equal(Number((await refresh.positions(db, ws, [safe])).find(p => p.locationId === site.id).estimate.safety), high);

  // Undo restores the earlier value; the routine does not apply it again.
  page = await browser.get(safety.href).expect(200);
  assert.match(page.text, /Changed on its own/);
  await browser.post(safety.href + '/' + applied.id + '/undo').type('form').send({ _csrf: csrf(page.text) }).expect(303);
  assert.equal(await saved(safe), first);
  assert.equal((await safety.undo(db, ctx, applied.id)).replayed, true);
  assert.equal(await audits('Undid safety stock change'), 1);
  await run();
  [draft] = await open(safe);
  assert.deepEqual([draft.status, draft.reason], ['HELD', 'You undid this change. It will look again when sales, deliveries or targets change.']);
  assert.equal(await saved(safe), first);

  // Ask me first, a pause, Watch only, a lock and the first 14 days each stop
  // automatic changes.
  await target({ class: 'A', kind: 'percent', percent: '98' });
  await modes.save(db, ctx, 150, { mode: 'ask', revision: 0 });
  await run();
  [draft] = await open(safe);
  assert.equal(draft.status, 'DRAFT');
  assert.match(draft.reason, /Ask me first/);
  await modes.save(db, ctx, 150, { mode: 'routine', revision: 1 });
  await auto.pause(db, ctx, { role: 'owner' }, 'Safety stock test');
  await run();
  [draft] = await open(safe);
  assert.match(draft.reason, /paused/);
  await auto.resume(db, ctx, { role: 'owner' });
  await modes.save(db, ctx, 150, { mode: 'watch', revision: 2 });
  await run();
  [draft] = await open(safe);
  assert.equal(draft.status, 'WATCHED');
  assert.match(draft.reason, /Watch only/);
  await assert.rejects(safety.approveAll(db, ctx), /Watch only/);
  await modes.save(db, ctx, 150, { mode: 'inherit', revision: 3 });
  await refresh.setLock(db, ctx, { skuId: safe, locationId: site.id, locked: 'yes' });
  await run();
  [draft] = await open(safe);
  assert.deepEqual([draft.status, draft.reason], ['HELD', 'You locked these settings on Keep reorder points up to date.']);
  await refresh.setLock(db, ctx, { skuId: safe, locationId: site.id, locked: 'no' });
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1', [f.owner.accountId]);
  await run();
  [draft] = await open(safe);
  assert.equal(draft.status, 'WATCHED');
  assert.match(draft.reason, /first 14 days/);
  page = await browser.get(safety.href).expect(200);
  assert.match(page.text, /What it would set/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '200 days')::text WHERE id=$1", [f.owner.accountId]);
  assert.equal(await saved(safe), first, 'Nothing changed while it was held.');
  result = await run();
  assert.equal(result.safety_applied, 1);
  const ninetyEight = await saved(safe);
  assert.ok(ninetyEight > first && ninetyEight < high);

  // Custom: alone without training inside the same limit.
  await subscribe('enterprise');
  await target({ class: 'A', kind: 'percent', percent: '97' });
  result = await run();
  assert.equal(result.safety_applied, 1);
  assert.ok(await saved(safe) < ninetyEight);
  assert.equal((await open(safe)).length, 0);

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
    await Promise.all([tab.waitForNavigation(), tab.getByRole('link', { name: 'Safety stock', exact: true }).click()]);
    const text = await tab.textContent('body');
    assert.match(text, /Your targets/);
    assert.match(text, /Recent decisions/);
    assert.equal(await tab.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true, 'No sideways scrolling at ' + viewport.width + ' px');
    await tab.close();
  }

  // A Starter downgrade stops it at once.
  await target({ class: 'A', kind: 'percent', percent: '96' });
  await subscribe('starter');
  assert.deepEqual(await run(), { skipped: 'plan' });
  await assert.rejects(safety.approveAll(db, ctx), e => e.code === 'entitlement_required');
  assert.match((await browser.get(safety.href).expect(402)).text, /data-agent-plan-locked/);
});

test('job 150 on a database migrated only up to 456: the forecast run, Needs you and planning keep working', { timeout: 300000 }, async t => {
  const cluster = await require('../helpers/postgres-cluster').startCluster(), db = require('../../src/db/postgres').openPostgres(cluster.connectionString);
  t.after(async () => { await db.close(); await cluster.stop(); });
  await require('../../src/db/migrate-postgres').migratePostgres(db, { through: '456-agent-launch-forecasts.sql' });
  const owner = await require('../../src/domain/postgres-auth-service').createBusiness(db, { name: 'Older safety owner', businessName: 'Older safety',
    email: randomUUID() + '@example.test', password: 'Upgrade!' + randomUUID() });
  const ctx = { workspaceId: owner.workspaceId, actorId: owner.userId, accountId: owner.accountId };
  const sku = (await catalog.createItem(db, ctx, { name: 'Older product', baseCode: 'OLDER', trackingMode: 'quantity' })).skuIds[0];
  assert.deepEqual(await safety.evaluate(db, ctx.workspaceId, [sku]), []);
  assert.deepEqual(await safety.inbox(db, ctx.workspaceId), []);
  assert.deepEqual(await db.transaction(c => safety.step(c, ctx, { run: { id: null }, skuIds: [sku], today: '2026-01-01' })),
    { safety_applied: 0, safety_waiting: 0, safety_shown: 0, safety_held: 0 });
  assert.ok(Array.isArray(await require('../../src/projections/postgres-service').needs(db, ctx.workspaceId, ctx.actorId)));
  assert.ok(Array.isArray(await refresh.positions(db, ctx.workspaceId, [sku])));
});
