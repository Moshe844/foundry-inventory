'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const refresh = require('../../src/forecasting/agent-reorder-refresh');
const catalog = require('../../src/domain/postgres-catalog-service');
const inv = require('../../src/domain/postgres-inventory-engine');
const auto = require('../../src/autopilot/postgres-service');
const modes = require('../../src/autopilot/job-modes');
const notices = require('../../src/autopilot/operational-notices');
const queue = require('../../src/operations/postgres-job-queue');
const handlers = require('../../src/operations/postgres-runtime-handlers').create();

test('one daily routine keeps reorder points and targets current from sales on every plan, inside owner limits, with undo', { timeout: 600000 }, async t => {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 1 }), { db, ctx, browser, subscribe, csrf } = f;
  const dispatch = f.location;
  const north = await require('../../src/domain/postgres-location-service').createLocation(db, ctx, { name: 'North site', kind: 'warehouse' });
  const ago = days => new Date(Date.now() - days * 86400000).toISOString();
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);
  async function product(code, created = 200) {
    const sku = (await catalog.createItem(db, ctx, { name: 'Product ' + code, baseCode: code, trackingMode: 'quantity' })).skuIds[0];
    await db.query('UPDATE skus SET created_at=$2 WHERE id=$1', [sku, ago(created)]);
    return sku;
  }
  const receive = (sku, site, quantity, days) => inv.receive(db, ctx, { skuId: sku, locationId: site.id, quantity, occurredAt: ago(days), idempotencyKey: randomUUID() });
  const sell = (sku, site, quantity, days) => inv.issue(db, ctx, { skuId: sku, locationId: site.id, quantity, reasonCode: 'sold', occurredAt: ago(days), idempotencyKey: randomUUID() });
  const setting = (sku, site, point, target, lead = 14) => db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,lead_time_days,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'manual',now()::text,now()::text)`, [randomUUID(), ctx.workspaceId, sku, site?.id || null, point, target, lead]);
  const lead = (sku, site, days) => db.query('UPDATE reorder_policies SET lead_time_days=$4 WHERE workspace_id=$1 AND sku_id=$2 AND location_id IS NOT DISTINCT FROM $3',
    [ctx.workspaceId, sku, site?.id || null, days]);
  const values = async (sku, site) => {
    const row = (await db.query('SELECT reorder_point,target_stock,source FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id IS NOT DISTINCT FROM $3',
      [ctx.workspaceId, sku, site?.id || null])).rows[0];
    return row && [row.reorder_point == null ? null : Number(row.reorder_point), row.target_stock == null ? null : Number(row.target_stock)];
  };
  const audits = async action => (await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2', [ctx.workspaceId, action])).rows[0].n;
  const work = kind => queue.processOne(db, handlers, { owner: 'reorder-refresh-test', kinds: [kind], leaseMs: 120000 });
  let runs = 0;
  async function run(runKey = 'check-' + (++runs)) {
    await queue.enqueue(db, { workspaceId: ctx.workspaceId, kind: refresh.KIND, idempotencyKey: randomUUID(), payload: { runKey } });
    const done = await work(refresh.KIND);
    assert.equal(done?.status, 'COMPLETED', JSON.stringify(done?.lastError));
    return done.result;
  }
  async function latest() {
    const rows = (await db.query(`SELECT c.id,c.status,c.reason,c.evidence->>'code' code,c.location_id,c.authority,c.after_minimum::float8 min,c.after_maximum::float8 max
      FROM stockchief_runtime.agent_reorder_refresh_changes c WHERE c.workspace_id=$1
      AND (c.run_id=(SELECT id FROM stockchief_runtime.agent_reorder_refresh_runs WHERE workspace_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1) OR c.status='DRAFT')`,
    [ctx.workspaceId])).rows;
    return code => rows.filter(r => r.code === code);
  }

  // Established products have 120 days of stock history and 90 days of sales.
  const steady = await product('STEADY'), ruled = await product('RULED'), jump = await product('JUMP'), shared = await product('SHARED');
  const locked = await product('LOCKED'), thin = await product('THIN'), opened = await product('OPENED'), nolead = await product('NOLEAD'), quiet = await product('QUIET');
  for (const [sku, site] of [[steady, dispatch], [locked, dispatch], [thin, dispatch], [nolead, dispatch], [quiet, dispatch], [ruled, north], [jump, north], [shared, dispatch], [shared, north]])
    await receive(sku, site, 500, 120);
  for (const sku of [steady, locked]) for (const day of [80, 50, 20]) await sell(sku, dispatch, 30, day);
  for (const sku of [ruled, jump]) for (const day of [80, 50, 20]) await sell(sku, north, 30, day);
  for (const site of [dispatch, north]) for (const day of [70, 30]) await sell(shared, site, 22 + (site === north ? 1 : 0), day);
  await sell(thin, dispatch, 5, 40);
  for (const day of [60, 10]) await sell(nolead, dispatch, 4, day);
  await receive(opened, north, 50, 10);
  for (const day of [8, 3]) await sell(opened, north, 5, day);
  await sell(f.item.skuIds[0], dispatch, 1, 0);
  await setting(steady, dispatch, 16, 24); await setting(locked, dispatch, 16, 24); await setting(thin, dispatch, 3, 6); await setting(quiet, dispatch, 3, 6);
  await setting(ruled, north, 20, 28); await setting(jump, north, 5, 10); await setting(opened, north, 2, 4);
  await setting(shared, null, 22, 31);
  await refresh.setLock(db, ctx, { skuId: locked, locationId: dispatch.id, locked: 'yes' });
  assert.equal(await audits('Locked reorder settings'), 1);
  const untouched = async () => [await values(steady, dispatch), await values(ruled, north), await values(jump, north), await values(shared, null), await values(locked, dispatch)];
  const original = [[16, 24], [20, 28], [5, 10], [22, 31], [16, 24]];

  // Starter: the scheduled check runs through the worker and only suggests.
  await subscribe('starter');
  await queue.enqueue(db, { workspaceId: ctx.workspaceId, kind: 'autopilot.evaluate', idempotencyKey: randomUUID(), payload: { actorId: ctx.actorId, requestedByUser: true } });
  assert.equal((await work('autopilot.evaluate'))?.status, 'COMPLETED');
  const today = await require('../../src/lib/business-time').today(db, ctx.workspaceId);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3',
    [ctx.workspaceId, refresh.KIND, 'reorder-refresh:' + today])).rows[0].n, 1);
  let result = (await work(refresh.KIND)).result;
  assert.equal(result.level, 'suggest');
  let row = await latest();
  assert.deepEqual(row('STEADY').map(r => [r.status, r.min, r.max]), [['SUGGESTED', 21, 30]]);
  assert.deepEqual(row('SHARED').map(r => [r.status, r.location_id, r.min, r.max]), [['SUGGESTED', null, 21, 30]]);
  assert.match(row('LOCKED')[0].reason, /You locked these settings/);
  assert.match(row('THIN')[0].reason, /at least two separate sales/);
  assert.match(row('OPENED')[0].reason, /First stocked here 10 days ago\. It needs 90 days of sales history/);
  assert.match(row('NOLEAD')[0].reason, /Record a lead time/);
  assert.match(row('QUIET')[0].reason, /No sales here in the last 90 days/);
  const fixtureCode = (await db.query('SELECT code FROM skus WHERE id=$1', [f.item.skuIds[0]])).rows[0].code;
  assert.match(row(fixtureCode)[0].reason, /Added 0 days ago/);
  assert.deepEqual(await untouched(), original);
  const starterPage = await browser.get(refresh.href).expect(200);
  assert.match(starterPage.text, /Suggested values/);
  assert.match(starterPage.text, /On Starter it only suggests/);
  assert.doesNotMatch(starterPage.text, /Approve all/);
  await assert.rejects(refresh.approve(db, ctx, row('STEADY')[0].id), e => e.code === 'entitlement_required');
  await assert.rejects(refresh.configure(db, ctx, { maxChangePercent: 10, confirmed: 'yes', revision: 0 }), e => e.code === 'entitlement_required');
  assert.equal((await run(today)).replayed, true, 'A finished daily run is not repeated.');

  // Growth before teaching: every change is a draft for a person.
  await subscribe('growth');
  await auto.setMode(db, ctx, { role: 'owner' }, 'POLICY_AUTOMATED');
  result = await run();
  assert.equal(result.level, 'draft');
  assert.equal(result.applied, 0);
  row = await latest();
  for (const code of ['STEADY', 'RULED', 'JUMP', 'SHARED']) {
    assert.deepEqual(row(code).map(r => r.status), ['DRAFT'], code);
    assert.match(row(code)[0].reason, /Approve a change here or save a rule to teach it/);
  }
  assert.deepEqual(await untouched(), original);
  await notices.refresh(db, ctx.workspaceId);
  const notice = (await notices.inbox(db, ctx.workspaceId, ctx.actorId)).find(n => n.sourceId === 'agent-notice-21');
  assert.match(notice.happened, /^4 reorder point and target changes are ready/);

  // A person approves one change on a 390 px phone; it teaches that position.
  const app = require('../../src/postgres-app').createPostgresApp({ database: db, env: 'test', sessionSecret: randomUUID() });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const chrome = await require('playwright').chromium.launch();
  f.cleanup(async () => { await chrome.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await app.locals.sessionStore.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function signedIn(viewport) {
    const page = await chrome.newPage({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
    await page.goto(base + '/login');
    await page.locator('[name=email]').fill(f.email);
    await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Sign in', exact: true }).click()]);
    return page;
  }
  const phone = await signedIn({ width: 390, height: 844 });
  await phone.goto(base + '/planning');
  await Promise.all([phone.waitForNavigation(), phone.getByRole('link', { name: 'Keep reorder points up to date' }).click()]);
  assert.match(await phone.textContent('body'), /Waiting for you/);
  assert.equal(await phone.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true);
  const steadyDraft = phone.locator('#waiting li').filter({ hasText: 'STEADY' });
  assert.match(await steadyDraft.textContent(), /16 units → 21 units/);
  await Promise.all([phone.waitForNavigation(), steadyDraft.getByRole('button', { name: 'Approve' }).click()]);
  assert.match(await phone.textContent('body'), /Change approved and saved/);
  assert.deepEqual(await values(steady, dispatch), [21, 30]);
  assert.equal(await audits('Updated reorder point and target from sales'), 1);
  const approvedId = row('STEADY')[0].id;
  assert.equal((await refresh.approve(db, ctx, approvedId)).replayed, true);
  assert.equal(await audits('Updated reorder point and target from sales'), 1);
  const declinedId = row('JUMP')[0].id;
  await refresh.decline(db, ctx, declinedId);

  // Growth taught by a saved rule as well: changes inside 10% apply alone.
  const page = await browser.get(refresh.href).expect(200);
  assert.match(page.text, /Teach it in either way/);
  await browser.post(refresh.href + '/rule').type('form').send({ _csrf: csrf(page.text), revision: 0, maxChangePercent: 10, confirmed: 'yes' }).expect(303);
  assert.equal(await audits('Authorized routine reorder point updates'), 1);
  await sell(steady, dispatch, 9, 1);
  result = await run();
  row = await latest();
  assert.deepEqual(row('STEADY').map(r => [r.status, r.authority, r.min, r.max]), [['APPLIED', 'LEARNED', 24, 33]]);
  assert.deepEqual(row('RULED').map(r => [r.status, r.authority, r.min, r.max]), [['APPLIED', 'RULE', 21, 30]]);
  assert.deepEqual(row('SHARED').map(r => [r.status, r.authority]), [['APPLIED', 'RULE']]);
  assert.match(row('JUMP')[0].reason, /You declined this change/);
  assert.equal(result.applied, 3);
  assert.deepEqual(await untouched(), [[24, 33], [21, 30], [5, 10], [21, 30], [16, 24]]);
  assert.equal(await audits('Updated reorder point and target from sales'), 4);
  const again = await run((await db.query('SELECT run_key FROM stockchief_runtime.agent_reorder_refresh_runs WHERE workspace_id=$1 ORDER BY started_at DESC LIMIT 1', [ctx.workspaceId])).rows[0].run_key);
  assert.equal(again.replayed, true);
  assert.equal(await audits('Updated reorder point and target from sales'), 4, 'Replaying a run applies nothing twice.');

  // Undo restores the exact earlier values and the routine does not re-apply them.
  const ruledChange = row('RULED')[0].id;
  const undoPage = await browser.get(refresh.href).expect(200);
  await browser.post(refresh.href + '/' + ruledChange + '/undo').type('form').send({ _csrf: csrf(undoPage.text) }).expect(303);
  assert.deepEqual(await values(ruled, north), [20, 28]);
  assert.equal((await db.query('SELECT source FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2', [ctx.workspaceId, ruled])).rows[0].source, 'manual');
  assert.equal((await refresh.undo(db, ctx, ruledChange)).replayed, true);
  assert.equal(await audits('Undid reorder point change'), 1);
  await db.query("UPDATE reorder_policies SET reorder_point=25 WHERE workspace_id=$1 AND sku_id=$2", [ctx.workspaceId, steady]);
  await assert.rejects(refresh.undo(db, ctx, row('STEADY')[0].id), /changed after this update/);
  await db.query("UPDATE reorder_policies SET reorder_point=24 WHERE workspace_id=$1 AND sku_id=$2", [ctx.workspaceId, steady]);
  await run();
  row = await latest();
  assert.match(row('RULED')[0].reason, /You undid this change/);
  assert.deepEqual(await values(ruled, north), [20, 28]);

  // Pro: alone inside the limit, but Ask me first, pause, Watch, shadow and a
  // location maximum each stop automatic changes.
  await subscribe('pro');
  await modes.save(db, ctx, 21, { mode: 'ask', revision: 0 });
  await lead(shared, null, 13);
  await run();
  row = await latest();
  assert.deepEqual(row('SHARED').map(r => r.status), ['DRAFT']);
  assert.match(row('SHARED')[0].reason, /Ask me first/);
  assert.deepEqual(await values(shared, null), [21, 30]);
  await modes.save(db, ctx, 21, { mode: 'routine', revision: 1 });
  await auto.pause(db, ctx, { role: 'owner' }, 'Reorder check test');
  await run();
  assert.match((await latest())('SHARED')[0].reason, /paused/);
  assert.deepEqual(await values(shared, null), [21, 30]);
  await auto.resume(db, ctx, { role: 'owner' });
  await run();
  row = await latest();
  assert.deepEqual(row('SHARED').map(r => [r.status, r.authority, r.min, r.max]), [['APPLIED', 'RULE', 20, 30]]);
  assert.deepEqual(await values(shared, null), [20, 30]);

  await modes.save(db, ctx, 21, { mode: 'watch', revision: 2 });
  await lead(shared, null, 14);
  result = await run();
  assert.equal(result.level, 'suggest');
  row = await latest();
  assert.deepEqual(row('SHARED').map(r => r.status), ['SUGGESTED']);
  assert.match(row('SHARED')[0].reason, /Watch only/);
  assert.deepEqual(await values(shared, null), [20, 30]);
  await modes.save(db, ctx, 21, { mode: 'inherit', revision: 3 });

  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1", [f.owner.accountId]);
  result = await run();
  assert.equal(result.level, 'watch');
  row = await latest();
  assert.deepEqual(row('SHARED').map(r => [r.status, r.min, r.max]), [['WATCHED', 21, 30]]);
  const shadowPage = await browser.get(refresh.href).expect(200);
  assert.match(shadowPage.text, /What it would change/);
  assert.deepEqual(await values(shared, null), [20, 30]);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);

  // Custom: a saved location maximum and the change limit still hold work.
  await subscribe('enterprise');
  await require('../../src/forecasting/location-reorder-rules').configure(db, ctx, { skuId: steady, locationId: dispatch.id, ceiling: '29', confirmed: 'yes' });
  await lead(steady, dispatch, 13);
  result = await run();
  row = await latest();
  assert.deepEqual(row('SHARED').map(r => [r.status, r.authority, r.min, r.max]), [['APPLIED', 'RULE', 21, 30]]);
  assert.deepEqual(row('STEADY').map(r => r.status), ['DRAFT']);
  assert.match(row('STEADY')[0].reason, /above your saved maximum of 29 units here/);
  assert.deepEqual(await values(steady, dispatch), [24, 33]);
  const sharedChange = row('SHARED')[0].id;
  await lead(jump, north, 10);
  await run();
  row = await latest();
  assert.match(row('JUMP')[0].reason, /more than your 10% limit/);
  assert.deepEqual(await values(jump, north), [5, 10]);

  // The phone and desktop pages fit, and approve all works for the owner.
  const desktop = await signedIn({ width: 1440, height: 1000 });
  await desktop.goto(base + refresh.href);
  assert.equal(await desktop.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true);
  await Promise.all([desktop.waitForNavigation(), desktop.getByRole('button', { name: 'Approve all' }).click()]);
  assert.match(await desktop.textContent('body'), /Approved 2 changes/);
  assert.deepEqual(await values(jump, north), [17, 30]);
  assert.deepEqual(await values(steady, dispatch), [23, 33]);
  await phone.goto(base + refresh.href);
  assert.equal(await phone.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true);
  assert.match(await phone.textContent('body'), /learned from your approvals/);

  // A downgrade to Starter keeps only suggestions; open drafts are replaced.
  await lead(jump, north, 20);
  await run();
  assert.deepEqual((await latest())('JUMP').map(r => [r.status, r.authority, r.min, r.max]), [['APPLIED', 'LEARNED', 27, 34]], 'Approve all taught this position.');
  await modes.save(db, ctx, 21, { mode: 'ask', revision: 4 });
  await lead(jump, north, 14);
  await run();
  assert.deepEqual((await latest())('JUMP').map(r => [r.status, r.min, r.max]), [['DRAFT', 21, 30]]);
  await lead(ruled, north, 12);
  await subscribe('starter');
  result = await run();
  assert.equal(result.applied, 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_reorder_refresh_changes WHERE workspace_id=$1 AND status='DRAFT'", [ctx.workspaceId])).rows[0].n, 0);
  assert.deepEqual((await latest())('RULED').map(r => [r.status, r.min, r.max]), [['SUGGESTED', 19, 30]]);
  assert.deepEqual((await latest())('JUMP').map(r => r.status), ['SUGGESTED']);
  assert.deepEqual(await values(ruled, north), [20, 28]);
  await refresh.undo(db, ctx, sharedChange);
  assert.deepEqual(await values(shared, null), [20, 30], 'A person can still undo after a downgrade.');
  assert.equal((await refresh.undo(db, ctx, declinedId).catch(e => e)).message, 'Only an applied change can be undone.');
  assert.equal(await audits('Undid reorder point change'), 2);
});
