'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const daily = require('../../src/operations/agent-daily-cycle-counts');
const reviews = require('../../src/autopilot/job-reviews');
const autopilot = require('../../src/autopilot/postgres-service');
const queue = require('../../src/operations/postgres-job-queue');
const handlers = require('../../src/operations/postgres-runtime-handlers').create();
const receipts = require('../../src/accounting/postgres-stock-receipt');
const removal = require('../../src/accounting/postgres-stock-removal');
const count = require('../../src/accounting/postgres-physical-count');
const campaigns = require('../../src/operations/postgres-count-campaigns');
const time = require('../../src/lib/business-time');
const { addDays } = require('../../src/accounting/customer-money');

test('all four plans use real shelf risks, exact stock valuation, current owner authority and daily native replay', { timeout: 300000 }, async t => {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 1 }), { db, ctx, location } = f;
  const member = { role: 'owner' };
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);
  await db.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1", [ctx.workspaceId]);
  const day = await time.today(db, ctx.workspaceId), month = day.slice(0,7) + '-01';
  const received = addDays(month, -4) + 'T17:00:00Z', sold = addDays(month, -3) + 'T17:00:00Z';
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1', [ctx.workspaceId, received.slice(0,10)]);
  const locations = require('../../src/domain/postgres-location-service');
  const place = (name, kind = 'warehouse', parent = null) => locations.createLocation(db, ctx, { name, kind, parentLocationId: parent?.id });
  const annex = await place('Annex cycle counts'), reserve = await place('Reserve cycle counts');
  const variance = await place('Variance shelf','shelf',location), varianceBin = await place('Variance bin','bin',variance);
  const shelfA = await place('Class A shelf','shelf',location), binA = await place('Class A bin','bin',shelfA), binB = await place('Extra A bin','bin',shelfA);
  const shelfB = await place('Class B shelf','shelf',location), shelfC = await place('Higher value C shelf','shelf',location);
  const catalog = require('../../src/domain/postgres-catalog-service');
  const item = async (code, options = {}) => (await catalog.createItem(db, ctx, { name: code, baseCode: code, trackingMode: 'quantity', ...options })).skuIds[0];
  const receive = (skuId, loc, quantity, unitCost, extra = {}) => receipts.receive(db, ctx, {
    skuId, locationId: loc.id, quantity, unitCost, idempotencyKey: randomUUID(), ...extra,
  });
  async function history(code, loc, quantity, unitCost) {
    const skuId = await item(code);
    await receive(skuId, loc, quantity, unitCost, { occurredAt: received });
    await removal.issue(db, ctx, { skuId, locationId: loc.id, quantity: 1, reasonCode: 'sold', occurredAt: sold, idempotencyKey: randomUUID() });
    return skuId;
  }
  await history('COUNT-A', binA, 2, '80');
  await history('COUNT-B', shelfB, 2, '15');
  await history('COUNT-C', shelfC, 101, '5');
  const special = await item('COUNT-SERIAL-WEIGHT', { trackingMode: 'serial', secondaryUnitLabel: 'kg', secondaryPrecision: 3 });
  await receive(special, binB, 2, '2', { serials: ['WEIGHT-A', 'WEIGHT-B'], secondaryQuantity: '5.125',
    serialWeights: { 'WEIGHT-A': '2.125', 'WEIGHT-B': '3' } });
  const unknown = await item('COUNT-NO-COST');
  await require('../../src/domain/postgres-inventory-engine').receive(db, ctx, {
    skuId: unknown, locationId: binB.id, quantity: 8, idempotencyKey: randomUUID(),
  });
  const discrepancy = await item('COUNT-VARIANCE');
  await receive(discrepancy, varianceBin, 8, '3');
  for (const countedQuantity of [7, 6]) await count.apply(db, ctx, {
    skuId: discrepancy, locationId: varianceBin.id, countedQuantity, reasonCode: 'cycle_count', idempotencyKey: randomUUID(),
  });
  const physicalDraft = await campaigns.create(db, ctx, { locationId: varianceBin.id, title: 'Prior physical worksheet' }, { exactLocation: true });
  await campaigns.save(db, ctx, physicalDraft.id, { revision: 1, lines: [{ skuId: discrepancy, locationId: varianceBin.id, quantity: 5 }] });
  await receive(discrepancy, annex, 3, '3');
  await receive(discrepancy, reserve, 4, '3');
  await db.transaction(c => require('../../src/forecasting/monthly-product-classes').calculate(c, ctx.workspaceId));

  const plans = async () => (await db.query(`SELECT *,business_day::text FROM stockchief_runtime.daily_cycle_count_plans
    WHERE workspace_id=$1 ORDER BY created_at,id`, [ctx.workspaceId])).rows;
  async function effects() {
    return (await db.query(`SELECT
      (SELECT count(*) FROM warehouse_count_campaigns WHERE workspace_id=$1)::int campaigns,
      (SELECT count(*) FROM stockchief_runtime.agent_count_tasks WHERE workspace_id=$1)::int assignments,
      (SELECT count(*) FROM movements WHERE workspace_id=$1)::int movements,
      (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1)::int journals,
      (SELECT count(*) FROM locations WHERE workspace_id=$1 AND annual_count_freeze_id IS NOT NULL)::int freezes`, [ctx.workspaceId])).rows[0];
  }
  const work = (kind = daily.jobKind) => queue.processOne(db, handlers, { owner: 'cycle-count-worker', kinds: [kind], leaseMs: 120000 });
  async function evaluate() {
    await queue.enqueue(db, { workspaceId: ctx.workspaceId, kind: 'autopilot.evaluate', idempotencyKey: randomUUID(),
      payload: { actorId: ctx.actorId, requestedByUser: true } });
    const result = await work('autopilot.evaluate');
    assert.equal(result?.status, 'COMPLETED', JSON.stringify(result?.lastError));
  }
  const saveRule = (warehouse, maximumShelves, revision = 0) => daily.configure(db, ctx, {
    warehouseId: warehouse.id, maximumShelves, revision, confirmed: 'yes',
  });

  await f.subscribe('starter');
  const suggestion = await reviews.run(db, ctx, 'count-priorities');
  assert.equal(suggestion.rows.length, 1);
  assert.match(suggestion.rows[0].Suggestion, /Variance shelf/);
  assert(!suggestion.cyclePlan);
  await f.browser.get('/autopilot/daily-cycle-counts').expect(200).expect(/available on Growth/);
  await f.browser.get('/autopilot/daily-cycle-counts').set('Accept','application/json').expect(402);
  await assert.rejects(daily.prepare(db, ctx, { warehouseId: location.id, maximumShelves: 4, revision: 0 }), e => e.code === 'entitlement_required');
  assert.deepEqual(await plans(), []);

  await f.subscribe('growth');
  await assert.rejects(saveRule(location, 4), e => e.code === 'entitlement_required');
  const app = require('../../src/postgres-app').createPostgresApp({ database: db, env: 'test', sessionSecret: randomUUID() });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const chrome = await require('playwright').chromium.launch();
  f.cleanup(async () => { await chrome.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await app.locals.sessionStore.close(); });
  const phone = await chrome.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const base = 'http://127.0.0.1:' + server.address().port;
  await phone.goto(base + '/login');
  await phone.locator('[name=email]').fill(f.email);
  await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(), phone.getByRole('button', { name: 'Sign in', exact: true }).click()]);
  await phone.goto(base + '/autopilot/reviews/count-priorities');
  await phone.getByRole('link', { name: 'Open daily cycle-count plans' }).click();
  await phone.locator('select[name=warehouseId]').selectOption(location.id);
  await Promise.all([phone.waitForNavigation(), phone.getByRole('button', { name: 'Open today’s plan' }).click()]);
  await phone.locator('input[name=maximumShelves]').fill('4');
  await Promise.all([phone.waitForNavigation(), phone.getByRole('button', { name: 'Prepare a draft' }).click()]);
  let [draft] = await plans();
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.business_day, day);
  assert.deepEqual(draft.snapshot.shelves.map(s => s.shelf), ['Variance shelf', 'Class A shelf', 'Class B shelf', 'Higher value C shelf']);
  assert.equal(draft.snapshot.shelves[0].unresolvedDifferences, 1);
  assert.equal(draft.snapshot.shelves[0].recentAdjustments, 2);
  assert.equal(draft.snapshot.shelves[1].positions, 3);
  assert.equal(draft.snapshot.shelves[1].valueMinor, '9025');
  assert.equal(draft.snapshot.shelves[1].unknownValues, 1);
  assert.equal(draft.snapshot.shelves[2].classB, 1);
  assert.equal(await phone.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true);
  await receive(discrepancy, varianceBin, 1, '3');
  await assert.rejects(daily.confirm(db, ctx, draft.id, {
    revision: draft.revision, fingerprint: draft.source_fingerprint, confirmed: 'yes',
  }), /changed/);
  const beforePlanning = await effects();
  await Promise.all([phone.waitForNavigation(), phone.getByRole('button', { name: 'Refresh the draft' }).click()]);
  [draft] = await plans();
  await phone.locator('input[name=confirmed]').check();
  await Promise.all([phone.waitForNavigation(), phone.getByRole('button', { name: 'Confirm today’s draft' }).click()]);
  assert.match(await phone.textContent('body'), /Ready · owner confirmed/);
  assert.equal((await daily.confirm(db, ctx, draft.id, { revision: draft.revision, fingerprint: draft.source_fingerprint, confirmed: 'yes' })).replayed, true);
  assert.deepEqual(await effects(), beforePlanning);

  await f.subscribe('pro');
  await autopilot.setMode(db, ctx, member, 'POLICY_AUTOMATED');
  await saveRule(annex, 1);
  await evaluate();
  const pro = await work();
  assert.equal(pro?.status, 'COMPLETED', JSON.stringify(pro?.lastError));
  assert(pro.result.id);
  assert.deepEqual(await effects(), beforePlanning);
  await saveRule(reserve, 1);
  await evaluate();
  await f.subscribe('growth');
  const downgrade = await work();
  assert.match(downgrade.result.held, /plan|control/i);
  assert.equal((await plans()).length, 2);

  await f.subscribe('enterprise');
  await evaluate();
  const modes = require('../../src/autopilot/job-modes');
  await modes.save(db, ctx, 4, { mode: 'watch', revision: 0 });
  assert.match((await work()).result.held, /Watch only/);
  await modes.save(db, ctx, 4, { mode: 'routine', revision: 1 });
  await evaluate();
  await db.query("UPDATE users SET role='staff' WHERE workspace_id=$1 AND id=$2", [ctx.workspaceId, ctx.actorId]);
  const former = await work();
  assert.match(former.result.held, /current inventory owner/);
  await db.query("UPDATE users SET role='owner' WHERE workspace_id=$1 AND id=$2", [ctx.workspaceId, ctx.actorId]);
  await evaluate();
  await daily.enqueue(db, ctx.workspaceId, randomUUID());
  const competing = await Promise.all([work(), work()]);
  assert(competing.some(j => j?.result?.id));
  const final = await plans();
  assert.equal(final.length, 3);
  assert.deepEqual(final.map(row => [row.status, row.automatic]), [['READY',false],['READY',true],['READY',true]]);
  assert(final.every(row => row.business_day === day && row.snapshot.shelves.length <= row.snapshot.maximumShelves));
  assert.deepEqual(await effects(), beforePlanning);
  assert.equal(await daily.enqueue(db, ctx.workspaceId, randomUUID()), 0);
  await f.subscribe('starter');
  await f.browser.get('/autopilot/daily-cycle-counts/' + final.at(-1).id).expect(200).expect(/available on Growth/);
  assert.equal((await reviews.run(db,ctx,'count-priorities')).rows.length,1);
});
