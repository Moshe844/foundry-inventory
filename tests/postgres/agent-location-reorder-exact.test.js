'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const rules = require('../../src/forecasting/location-reorder-rules');
const catalog = require('../../src/domain/postgres-catalog-service');
const auto = require('../../src/autopilot/postgres-service');
const receipts = require('../../src/accounting/postgres-stock-receipt');
const queue = require('../../src/operations/postgres-job-queue');
const handlers = require('../../src/operations/postgres-runtime-handlers').create();

test('native measured and serialized sales drive exact local thresholds, with stale queued writes and old authority held', { timeout: 300000 }, async t => {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 1 }), { db, ctx, location, workflows } = f;
  const annex = await require('../../src/domain/postgres-location-service').createLocation(db, ctx, { name: 'North dispatch', kind: 'warehouse' });
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);
  await auto.setMode(db, ctx, { role: 'owner' }, 'POLICY_AUTOMATED');
  const measured = (await catalog.createItem(db, ctx, { name: 'Measured reorder roll', baseCode: 'REORDER-M',
    trackingMode: 'lot', unitLabel: 'm', quantityPrecision: 3, quantityIncrement: '0.125' })).skuIds[0];
  const weighted = (await catalog.createItem(db, ctx, { name: 'Weighted reorder piece', baseCode: 'REORDER-W',
    trackingMode: 'serial', unitLabel: 'piece', secondaryUnitLabel: 'kg', secondaryPrecision: 3, secondaryIncrement: '0.001' })).skuIds[0];
  async function receive(skuId, site, quantity, evidence) {
    return receipts.receive(db, ctx, { skuId, locationId: site.id, quantity, unitCost: '2.00', idempotencyKey: randomUUID(), ...evidence });
  }
  async function sale(skuId, site, quantity, evidence) {
    const draft = await workflows.createSalesOrder(db, ctx, { customerId: 'fixture-customer', deliveryMethod: 'PICKUP',
      fulfillmentLocationId: site.id, idempotencyKey: randomUUID(),
      lines: [{ skuId, quantity, unitPriceMinor: 1000, secondaryQuantity: evidence.secondaryQuantity }] });
    await workflows.confirmSalesOrder(db, ctx, draft.salesOrderId, { idempotencyKey: randomUUID(), requireFullAllocation: true });
    await workflows.fulfillSalesOrder(db, ctx, draft.salesOrderId, { idempotencyKey: randomUUID(),
      lines: [{ lineId: draft.lineIds[0], locationId: site.id, quantity, ...evidence }] });
  }
  async function planningRow(sku, site, lead, safety) {
    return db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,lead_time_days,safety_stock,source,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'manual',now()::text,now()::text)`, [randomUUID(), ctx.workspaceId, sku, site.id, lead, safety]);
  }
  async function values(sku, site) {
    const row = (await db.query(`SELECT reorder_point,target_stock,lead_time_days,safety_stock FROM reorder_policies
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`, [ctx.workspaceId, sku, site.id])).rows[0];
    return row && [row.reorder_point, row.target_stock, row.lead_time_days, row.safety_stock].map(v => v == null ? null : Number(v));
  }
  const work = (kind = rules.jobKind) => queue.processOne(db, handlers, { owner: 'location-reorder-worker', kinds: [kind], leaseMs: 120000 });
  async function evaluate() {
    await queue.enqueue(db, { workspaceId: ctx.workspaceId, kind: 'autopilot.evaluate', idempotencyKey: randomUUID(),
      payload: { actorId: ctx.actorId, requestedByUser: true } });
    const result = await work('autopilot.evaluate');
    assert.equal(result?.status, 'COMPLETED', JSON.stringify(result?.lastError));
  }
  async function physical() {
    return (await db.query(`SELECT (SELECT count(*) FROM movements WHERE workspace_id=$1)::int movements,
      (SELECT count(*) FROM purchase_orders WHERE workspace_id=$1)::int purchases,
      (SELECT count(*) FROM inventory_transfers WHERE workspace_id=$1)::int transfers,
      (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1)::int journals,
      (SELECT sum(total_cost_minor)::text FROM accounting_inventory_cost_balances WHERE workspace_id=$1) stock_value`, [ctx.workspaceId])).rows[0];
  }
  const first = await receive(measured, location, '8', { lotCode: 'MEASURE-A' });
  const second = await receive(measured, location, '5', { lotCode: 'MEASURE-B' });
  await planningRow(measured, location, 10, '0.125');
  await planningRow(measured, annex, 7, '0.125');
  await sale(measured, location, '2.125', { lotId: first.lotId });
  await sale(measured, location, '2.375', { lotId: second.lotId });

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
  await phone.goto(base + '/autopilot/reviews/location-reorder?filter=REORDER-M');
  assert.match(await phone.textContent('body'), /4.5 m/);
  await phone.locator('a[href^="/planning/location-reorder?"]').first().click();
  assert.match(await phone.textContent('body'), /0.625 m/);
  assert.match(await phone.textContent('body'), /1.5 m/);
  assert.equal(await phone.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true);
  await phone.locator('[name=ceiling]').fill('2.5');
  await phone.locator('[name=confirmed]').check();
  await Promise.all([phone.waitForNavigation(), phone.getByRole('button', { name: 'Save reorder rule' }).click()]);
  assert.match(await phone.textContent('body'), /Automatic reorder limits saved/);
  await evaluate();
  await sale(measured, location, '0.375', { lotId: first.lotId });
  const afterSale = await physical();
  const stale = await work();
  assert.equal(stale?.status, 'COMPLETED', JSON.stringify(stale?.lastError));
  assert.equal(stale.result.updated, 0);
  assert.match(stale.result.held[0].reason, /changed/);
  assert.deepEqual(await values(measured, location), [null, null, 10, 0.125]);
  assert.deepEqual(await physical(), afterSale);
  await evaluate();
  assert.equal((await work()).result.updated, 1);
  assert.deepEqual(await values(measured, location), [0.75, 1.625, 10, 0.125]);
  assert.deepEqual(await values(measured, annex), [null, null, 7, 0.125]);
  assert.deepEqual(await physical(), afterSale);
  assert.equal(await work(), null);

  await f.subscribe('growth');
  const metresScope = { skuId: measured, locationId: location.id };
  const lead = days => db.query('UPDATE reorder_policies SET lead_time_days=$4 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
    [ctx.workspaceId, measured, location.id, days]);
  await lead(9);
  await evaluate();
  assert.equal(await work(), null, 'A prior untaught Pro rule cannot authorize Growth.');
  const example = (await rules.page(db, ctx, metresScope)).estimate;
  const approved = await rules.approve(db, ctx, { ...metresScope, digest: example.digest });
  await rules.configure(db, ctx, { ...metresScope, revision: 1, ceiling: '1.625', confirmed: 'yes', exampleId: approved.id });
  await lead(12);
  await evaluate();
  assert.equal((await work()).result.updated, 1);
  assert.deepEqual(await values(measured, location), [0.875, 1.625, 12, 0.125]);

  await f.subscribe('enterprise');
  const serial = await receive(weighted, annex, 4, { serials: ['MEASURE-W1', 'MEASURE-W2', 'MEASURE-W3', 'MEASURE-W4'],
    serialWeights: { 'MEASURE-W1': '2.125', 'MEASURE-W2': '3.375', 'MEASURE-W3': '2.625', 'MEASURE-W4': '1.875' },
    secondaryQuantity: '10' });
  await sale(weighted, annex, 1, { serialUnitIds: [serial.serialUnitIds[0]], secondaryQuantity: '2.125' });
  await sale(weighted, annex, 1, { serialUnitIds: [serial.serialUnitIds[1]], secondaryQuantity: '3.375' });
  const scoped = { skuId: weighted, locationId: annex.id };
  assert.match((await rules.page(db, ctx, scoped)).problem, /Record a lead time/);
  await planningRow(weighted, annex, 14, 0);
  const proof = (await rules.page(db, ctx, scoped)).estimate;
  assert.equal(proof.issued, '2');
  assert.equal(proof.soldWeight, '5.5');
  assert.equal(proof.maximum, '1');
  await rules.configure(db, ctx, { ...scoped, ceiling: '2', confirmed: 'yes' });
  await evaluate();
  assert.equal((await work()).result.updated, 1);
  assert.deepEqual(await values(weighted, annex), [1, 1, 14, 0]);
  await sale(weighted, annex, 1, { serialUnitIds: [serial.serialUnitIds[2]], secondaryQuantity: '2.625' });
  await sale(weighted, annex, 1, { serialUnitIds: [serial.serialUnitIds[3]], secondaryQuantity: '1.875' });
  await evaluate();
  await rules.configure(db, ctx, { ...scoped, revision: 1, ceiling: '1', confirmed: 'yes' });
  assert.match((await work()).result.held[0].reason, /rule.*changed/);
  await evaluate();
  assert.match((await work()).result.held[0].reason, /saved maximum/);
  assert.deepEqual(await values(weighted, annex), [1, 1, 14, 0]);
  await rules.configure(db, ctx, { ...scoped, revision: 2, ceiling: '2', confirmed: 'yes' });
  await evaluate();
  const beforeDowngrade = await physical();
  await f.subscribe('growth');
  assert.equal((await work()).result.updated, 0);
  assert.deepEqual(await values(weighted, annex), [1, 1, 14, 0]);
  assert.deepEqual(await physical(), beforeDowngrade);
});
