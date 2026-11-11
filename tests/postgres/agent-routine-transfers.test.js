'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const autopilot = require('../../src/autopilot/postgres-service');
const native = require('../../src/transfers/postgres-transfer-service');
const queue = require('../../src/operations/postgres-job-queue');
const jobs = require('../../src/operations/postgres-runtime-handlers');
const catalog = require('../../src/domain/postgres-catalog-service');
const locations = require('../../src/domain/postgres-location-service');
const receipt = require('../../src/accounting/postgres-stock-receipt');
const member = { role: 'owner' };

async function fixture(t, plan) {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 1 });
  const { db, ctx } = f;
  await f.subscribe(plan);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);
  const destination = await locations.createLocation(db, ctx, { name: 'Routine receiving warehouse', kind: 'warehouse' });
  const other = await locations.createLocation(db, ctx, { name: 'Different authorized warehouse', kind: 'warehouse' });
  const today = await require('../../src/lib/business-time').today(db, ctx.workspaceId);
  const sku = async (code, profile = {}) => (await catalog.createItem(db, ctx, { name: code, baseCode: code, trackingMode: 'quantity', ...profile })).skuIds[0];
  const receive = (skuId, quantity, details = {}) => receipt.receive(db, ctx, {
    skuId, quantity, locationId: f.location.id, unitCost: '2.00', idempotencyKey: randomUUID(), ...details,
  });
  const target = (skuId, place, value) => db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$5,0,'manual',now()::text,now()::text)`, [randomUUID(), ctx.workspaceId, skuId, place.id, value]);
  const policy = (maximumQuantity, locationIds = [f.location.id, destination.id]) => autopilot.configureRoutine(db, ctx, member, {
    transferEnabled: true, maximumQuantity, locationIds,
  });
  const enqueue = () => queue.enqueue(db, { workspaceId: ctx.workspaceId, kind: 'autopilot.evaluate',
    idempotencyKey: randomUUID(), payload: { actorId: ctx.actorId, requestedByUser: true } });
  const work = () => queue.processOne(db, jobs.create(), { owner: 'native-transfer-test', kinds: ['autopilot.evaluate'], leaseMs: 120000 });
  const transfers = async () => (await db.query(`SELECT id,status,source_location_id,destination_location_id,decision_detail::jsonb detail
    FROM inventory_transfers WHERE workspace_id=$1 AND decision_detail::jsonb->>'kind'='agent_routine_transfer' ORDER BY created_at,id`, [ctx.workspaceId])).rows;
  const inventory = async () => (await db.query(`SELECT
      (SELECT sum(on_hand)::text FROM balances WHERE workspace_id=$1) stock,
      (SELECT sum(total_cost_minor)::text FROM accounting_inventory_cost_balances WHERE workspace_id=$1) value,
      (SELECT count(*)::int FROM movements WHERE workspace_id=$1) movements,
      (SELECT count(*)::int FROM accounting_journal_entries WHERE workspace_id=$1) journals`, [ctx.workspaceId])).rows[0];
  return { ...f, destination, other, today, sku, receive, target, policy, enqueue, work, transfers, inventory };
}

test('Pro owner configures a fractional stocking limit on a phone and queued work reserves two exact batches before staff records split receipt', { timeout: 300000 }, async t => {
  const f = await fixture(t, 'pro'), { db, ctx, location, destination } = f;
  const metres = await f.sku('TRANSFER-METRES', { trackingMode: 'lot', unitLabel: 'm', quantityPrecision: 3, quantityIncrement: '0.001' });
  const addDays = require('../../src/accounting/customer-money').addDays;
  await f.receive(metres, '0.1', { lotCode: 'ROUTINE-FIRST', expiresAt: addDays(f.today, 5) });
  await f.receive(metres, '0.2', { lotCode: 'ROUTINE-SECOND', expiresAt: addDays(f.today, 7) });
  await f.receive(metres, '0.4', { lotCode: 'KEEP-LOCAL', expiresAt: addDays(f.today, 20) });
  await f.receive(metres, '0.7', { lotCode: 'EXPIRED', expiresAt: addDays(f.today, -2), lotReceivedAt: addDays(f.today, -20) });
  await f.target(metres, location, '0.4');
  await f.target(metres, destination, '0.3');

  const app = require('../../src/postgres-app').createPostgresApp({ database: db, env: 'test', sessionSecret: randomUUID() });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const chrome = await require('playwright').chromium.launch();
  f.cleanup(async () => { await chrome.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await app.locals.sessionStore.close(); });
  const phone = await chrome.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const base = 'http://127.0.0.1:' + server.address().port;
  await phone.goto(base + '/login');
  await phone.locator('[name=email]').fill(f.email);
  await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(), phone.getByRole('button', { name: 'Sign in', exact: true }).click()]);
  await phone.goto(base + '/autopilot');
  const form = phone.locator('form[action="/autopilot/routine-authority"]');
  await form.locator('[name=transferEnabled]').check();
  await form.locator('[name=maximumQuantity]').fill('0.3');
  await form.locator('[name=locationIds][value="' + f.other.id + '"]').uncheck();
  await Promise.all([phone.waitForNavigation(), form.getByRole('button', { name: 'Confirm these limits' }).click()]);
  assert.match(await phone.textContent('body'), /Saved versioned routine-work authority/);
  assert.equal((await autopilot.dashboard(db, ctx.workspaceId)).transferPolicy.maximumQuantity, 0.3);
  const before = await f.inventory();
  await f.enqueue();
  await f.enqueue();
  const outcomes = await Promise.all([f.work(), f.work()]);
  assert(outcomes.some(job => job?.status === 'COMPLETED'), JSON.stringify(outcomes.map(j => j?.lastError)));
  const [row] = await f.transfers();
  assert(row, JSON.stringify(outcomes.map(j => j?.result || j?.lastError)));
  assert.equal(row.status, 'APPROVED');
  assert.equal((await f.transfers()).length, 1);
  assert.equal(row.detail.quantity, '0.3');
  assert.equal(row.detail.unit, 'm');
  const beforeDispatch = await native.get(db, ctx.workspaceId, row.id);
  assert.equal(beforeDispatch.totals.approved, 0.3);
  assert.deepEqual(Object.fromEntries(beforeDispatch.lines.map(l => [l.lot_code, Number(l.approved_quantity)])),
    { 'ROUTINE-FIRST': 0.1, 'ROUTINE-SECOND': 0.2 });
  assert.deepEqual(await f.inventory(), before);
  await phone.goto(base + '/autopilot/work/' + row.detail.workItemId);
  assert.match(await phone.textContent('body'), /ROUTINE-SECOND/);
  assert.equal(await phone.locator('body').evaluate(b => b.scrollWidth <= innerWidth + 2), true);

  const operatorAccount = await require('../../src/domain/postgres-auth-service').createBusiness(db, {
    email: randomUUID() + '@example.test', password: f.password, name: 'Transfer operator', businessName: 'Operator business',
  });
  const staff = { workspaceId: ctx.workspaceId, actorId: randomUUID() };
  await db.query(`INSERT INTO users(id,name,workspace_id,account_id,role,permissions,warehouse_location_ids,created_at)
    VALUES($1,'Transfer operator',$2,$3,'staff',$4,$5::jsonb,now()::text)`,
  [staff.actorId, ctx.workspaceId, operatorAccount.accountId,
    JSON.stringify(['VIEW', 'OPERATE', 'PICK_TRANSFER', 'DISPATCH_TRANSFER', 'RECEIVE_TRANSFER']),
    JSON.stringify([location.id, destination.id])]);
  await assert.rejects(native.receive(db, staff, row.id, { idempotencyKey: randomUUID(),
    lines: [{ lineId: beforeDispatch.lines[0].id, received: '0.1' }] }), /waiting to be received/);
  await native.pick(db, staff, row.id, { idempotencyKey: randomUUID() });
  assert.deepEqual(await f.inventory(), before);
  await native.dispatch(db, staff, row.id, { idempotencyKey: randomUUID() });
  await native.markInTransit(db, staff, row.id, { idempotencyKey: randomUUID() });
  const line = beforeDispatch.lines.find(l => l.lot_code === 'ROUTINE-FIRST');
  const firstReceipt = { idempotencyKey: randomUUID(), lines: [{ lineId: line.id, received: '0.1' }] };
  await native.receive(db, staff, row.id, firstReceipt);
  assert.equal((await native.get(db, ctx.workspaceId, row.id)).status, 'PARTIALLY_RECEIVED');
  await native.receive(db, staff, row.id, firstReceipt);
  await native.receive(db, staff, row.id, { idempotencyKey: randomUUID(),
    lines: [{ lineId: beforeDispatch.lines.find(l => l.id !== line.id).id, received: '0.2' }] });
  const complete = await native.get(db, ctx.workspaceId, row.id), after = await f.inventory();
  assert.equal(complete.status, 'RECEIVED');
  assert.equal(complete.totals.received, 0.3);
  assert.equal(after.stock, before.stock);
  assert.equal(after.value, before.value);
  assert.equal(after.movements, before.movements + 4);
  assert.equal((await native.verify(db, ctx.workspaceId, row.id)).ok, true);
  await require('../../src/operations/postgres-workflow-ownership').refresh(db, ctx.workspaceId, row.detail.workItemId);
  assert.equal((await autopilot.getWork(db, ctx.workspaceId, row.detail.workItemId)).execution_status, 'COMPLETED');
});

test('Custom transfers a kit’s actual weighted serial and stocked component while owner limits, holds and lower plans govern the queue', { timeout: 300000 }, async t => {
  const f = await fixture(t, 'enterprise'), { db, ctx, location, destination, other } = f;
  const serial = await f.sku('KIT-SERIAL-PART', { trackingMode: 'serial', secondaryUnitLabel: 'kg', secondaryPrecision: 3 });
  const shell = await f.sku('KIT-STOCKED-SHELL');
  const kit = await f.sku('ROUTINE-VIRTUAL-KIT');
  await require('../../src/domain/postgres-kit-service').define(db, ctx, { kitSkuId: kit, stockBasis: 'components',
    components: [{ skuId: serial, quantity: 1 }, { skuId: shell, quantity: 1 }] });
  const held = await f.receive(serial, 1, { serials: ['HELD'], secondaryQuantity: '2.125', serialWeights: { HELD: '2.125' } });
  const chosen = await f.receive(serial, 1, { serials: ['ACTUAL'], secondaryQuantity: '3.125', serialWeights: { ACTUAL: '3.125' } });
  await native.request(db, ctx, { fromLocationId: location.id, toLocationId: other.id, idempotencyKey: randomUUID(),
    lines: [{ skuId: serial, quantity: 1, secondaryQuantity: '2.125', serialUnitIds: held.serialUnitIds }] });
  await f.receive(shell, 2);
  await f.target(kit, destination, 1);
  await f.policy('1');
  const excess = await f.sku('ABOVE-TRANSFER-CAP');
  await f.receive(excess, 8);
  await f.target(excess, destination, 2);
  await f.enqueue();
  await autopilot.pause(db, ctx, member, 'Hold new transfers');
  const paused = await f.work();
  assert.equal(paused?.status, 'COMPLETED');
  assert.equal((await f.transfers()).length, 0);
  await autopilot.resume(db, ctx, member);
  const before = await f.inventory();
  for (let i = 0; i < 3; i++) {
    await f.enqueue();
    const next = await f.work();
    assert.equal(next?.status, 'COMPLETED', JSON.stringify(next?.lastError));
  }
  const transfers = await f.transfers();
  assert.equal(transfers.length, 2);
  assert(transfers.every(t => t.status === 'APPROVED' && t.detail.kitSkuId === kit));
  const lines = (await Promise.all(transfers.map(t => native.get(db, ctx.workspaceId, t.id)))).flatMap(t => t.lines);
  assert.deepEqual(new Set(lines.map(l => l.sku_id)), new Set([serial, shell]));
  const weighted = lines.find(l => l.sku_id === serial);
  assert.deepEqual(weighted.serials.map(s => s.serial_unit_id), chosen.serialUnitIds);
  assert.equal(Number(weighted.approved_secondary_quantity), 3.125);
  assert.deepEqual(await f.inventory(), before);
  const overLimit = (await db.query(`SELECT execution_status,policy_evaluation FROM work_items
    WHERE workspace_id=$1 AND recommended_action::jsonb->>'skuId'=$2 ORDER BY created_at DESC LIMIT 1`, [ctx.workspaceId, excess])).rows[0];
  assert.equal(overLimit.execution_status, 'WAITING_FOR_APPROVAL');
  assert.match(JSON.stringify(overLimit.policy_evaluation), /approved limit is 1/);

  const pendingSku = await f.sku('QUEUED-BEFORE-DOWNGRADE');
  await f.receive(pendingSku, 2);
  await f.target(pendingSku, destination, 1);
  const pending = (await autopilot.plan(db, ctx.workspaceId, { onlySkuIds: [pendingSku] })).created[0];
  assert.equal(pending.approval_requirement, 'NONE');
  await f.enqueue();
  await f.subscribe('growth');
  assert.equal((await f.work()).status, 'COMPLETED');
  const gated = await autopilot.execute(db, ctx, pending.id);
  assert.equal(gated.execution_status, 'WAITING_FOR_APPROVAL');
  const reviewed = await autopilot.approve(db, ctx, member, gated.id);
  assert.equal((await native.get(db, ctx.workspaceId, reviewed.outcome.transferId)).status, 'REQUESTED');
  await f.subscribe('starter');
  await f.enqueue();
  assert.equal((await f.work()).status, 'COMPLETED');
  assert.equal((await f.transfers()).length, 2);
});
