'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');
const rollup = require('../../src/reports/agent-inventory-rollup');
const catalog = require('../../src/domain/postgres-catalog-service');
const inv = require('../../src/domain/postgres-inventory-engine');
const locations = require('../../src/domain/postgres-location-service');
const auth = require('../../src/domain/postgres-auth-service');
const auto = require('../../src/autopilot/postgres-service');
const modes = require('../../src/autopilot/job-modes');
const queue = require('../../src/operations/postgres-job-queue');
const handlers = require('../../src/operations/postgres-runtime-handlers').create();

// Three inventories of one Custom account: the fixture's US business, a
// Canadian company and a third inventory the second person never joins.
async function setup(t) {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 4 }), { db, ctx } = f;
  await f.subscribe('enterprise');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);
  const made = await auth.createWorkspace(db, f.owner.accountId, { name: 'Northern company' });
  const north = { workspaceId: made.workspaceId, actorId: made.userId, accountId: f.owner.accountId };
  await db.transaction(c => require('../../src/accounting/postgres-ledger').configureInTransaction(c, north, { startDate: '2026-01-01', currency: 'CAD' }));
  await db.query("INSERT INTO workspace_company_profiles(workspace_id,legal_name) VALUES($1,'Northern Supply Ltd')", [north.workspaceId]);
  const third = await auth.createWorkspace(db, f.owner.accountId, { name: 'Zeta warehouse' });
  await db.query('UPDATE accounts SET last_workspace_id=$2 WHERE id=$1', [f.owner.accountId, ctx.workspaceId]);
  const owner = { ...ctx, accountId: f.owner.accountId };
  const toronto = await locations.createLocation(db, north, { name: 'Toronto', kind: 'warehouse' });
  const site = c => c.workspaceId === north.workspaceId ? toronto : f.location;
  const parcel = (await db.query('SELECT code FROM skus WHERE id=$1', [f.item.skuIds[0]])).rows[0].code;
  async function product(c, code, name, { quantity = 0, cost = '1.00', unit, barcode } = {}) {
    const sku = (await catalog.createItem(db, c, { name, baseCode: code, trackingMode: 'quantity', ...(unit ? { unitLabel: unit } : {}),
      ...(quantity ? { startingLocationId: site(c).id, startingQuantity: quantity, startingCost: cost } : {}) })).skuIds[0];
    if (barcode) await db.query('UPDATE skus SET barcode=$2 WHERE id=$1', [sku, barcode]);
    return sku;
  }
  const policy = (c, sku, point) => db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$5,0,'manual',now()::text,now()::text)`, [randomUUID(), c.workspaceId, sku, site(c).id, point]);
  const skus = {
    parcelA: f.item.skuIds[0],
    parcelB: await product(north, parcel, 'Parcel item', { quantity: 6, cost: '2.50' }),
    widgetA: await product(ctx, 'WID-A', 'Widget', { quantity: 2, barcode: '012345678905' }),
    widgetB: await product(north, 'WID-B', 'Widget', { quantity: 3, cost: '4.00', barcode: '12345678905' }),
    ropeA: await product(ctx, 'ROPE', 'Rope', { quantity: 10, unit: 'm' }),
    ropeB: await product(north, 'ROPE', 'Rope', { quantity: 2, unit: 'each', cost: '3.00' }),
    dupA: await product(ctx, 'DUP', 'Hook', { quantity: 1, barcode: '111111111111' }),
    dupB: await product(north, 'DUP', 'Hook', { quantity: 1, cost: '1.00', barcode: '222222222222' }),
    glueA: await product(ctx, 'GLUE', 'Glue'),
  };
  await policy(north, skus.parcelB, 10);
  await policy(ctx, skus.glueA, 2);
  // An order placed with the Canadian supplier, not yet received.
  await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('north-supplier',$1,'Maple parts','active','CAD',now()::text,now()::text)", [north.workspaceId]);
  const po = await f.workflows.createPurchaseOrder(db, north, { supplierId: 'north-supplier', destinationLocationId: toronto.id, idempotencyKey: 'north-po', lines: [{ skuId: skus.parcelB, quantityUnits: 5, unitCost: 3 }] });
  await f.workflows.approvePurchaseOrder(db, north, po.purchaseOrderId, { idempotencyKey: 'north-approve' });
  await f.workflows.placePurchaseOrder(db, north, po.purchaseOrderId, { idempotencyKey: 'north-place' });
  // A posted sale of one parcel in the US business.
  const order = await f.workflows.createSalesOrder(db, ctx, { customerId: 'fixture-customer', deliveryMethod: 'PICKUP', fulfillmentLocationId: f.location.id, idempotencyKey: 'us-sale', lines: [{ skuId: skus.parcelA, quantity: 1, unitPriceMinor: 1200 }] });
  await f.workflows.confirmSalesOrder(db, ctx, order.salesOrderId, { idempotencyKey: 'us-sale-confirm' });
  await f.workflows.fulfillSalesOrder(db, ctx, order.salesOrderId, { idempotencyKey: 'us-sale-fulfil', lines: [{ lineId: order.lineIds[0], locationId: f.location.id, quantity: 1 }] });
  const work = async () => {
    const done = []; for (let job; (job = await queue.processOne(db, handlers, { owner: 'rollup-test', kinds: [rollup.KIND], leaseMs: 120000 }));) {
      assert.equal(job.status, 'COMPLETED', JSON.stringify(job.lastError)); done.push(job);
    } return done;
  };
  let clock = Date.now();
  const tick = async (minutes = 16) => { clock += minutes * 60000; await rollup.schedule(db, { now: clock }); return work(); };
  const run = (workspaceId, requestKey = randomUUID()) => db.transaction(c => rollup.process(c, workspaceId, { requestKey }), { isolation: 'READ COMMITTED' });
  const audits = action => db.query('SELECT count(*)::int n FROM security_event_history WHERE action=$1', [action]).then(r => r.rows[0].n);
  const row = (view, code) => view.rows.find(r => r.codes.includes(code));
  return { ...f, north, third, toronto, owner, skus, parcel, work, tick, run, audits, row };
}

test('Custom combines stock, value per currency, low and out, buying and sales across inventories; lower plans see the lock', { timeout: 600000 }, async t => {
  const f = await setup(t), { db, owner, north, skus, parcel } = f;
  for (const plan of ['starter', 'growth', 'pro']) {
    await f.subscribe(plan);
    await assert.rejects(rollup.model(db, owner), e => e.code === 'entitlement_required' && /Custom/.test(e.message), plan);
    assert.equal((await f.tick(0)).length, 0, plan + ' schedules nothing');
    assert.deepEqual(await f.run(owner.workspaceId), { skipped: 'plan' }, plan + ' worker refuses');
    const page = await f.browser.get(rollup.href).expect(402);
    assert.match(page.text, /data-agent-plan-locked/);
    assert.match(page.text, /requires the Custom plan/);
    await f.browser.get(rollup.href + '/export.xlsx').expect(402);
  }
  assert.equal(await f.audits('Updated combined inventory figures'), 0);
  await f.subscribe('enterprise');

  // The worker updates every inventory of the account on its own schedule.
  const first = await f.tick(0);
  assert.equal(first.length, 3);
  assert.equal(await f.audits('Updated combined inventory figures'), 3);
  const view = await rollup.model(db, owner);
  assert.deepEqual(view.inventories.map(i => [i.name, i.company]), [['Northern company', 'Northern Supply Ltd'], ['Shipping operation fixture', null], ['Zeta warehouse', null]]);
  assert(view.inventories.every(i => i.refreshedAt && !i.heldReason));

  // Matched by code: added up, with low stock and buying where it happens.
  const parcelRow = f.row(view, parcel);
  assert.equal(parcelRow.total, 9);
  assert.deepEqual(parcelRow.parts.map(p => [p.inventory, p.onHand, p.low, p.incoming, p.sold]), [['Northern company', 6, true, 5, 0], ['Shipping operation fixture', 3, false, 0, 1]]);
  assert.equal(parcelRow.incoming, 5);
  assert.equal(parcelRow.sold, 1);
  // Matched by barcode under different codes.
  const widget = f.row(view, 'WID-A');
  assert.deepEqual(widget.codes, ['WID-A', 'WID-B']);
  assert.equal(widget.matchedByBarcode, true);
  assert.equal(widget.total, 5);
  // Codes or units that do not agree are shown apart, never added up.
  const rope = f.row(view, 'ROPE'), hook = f.row(view, 'DUP');
  assert.deepEqual([rope.problem, rope.total, rope.parts.map(p => p.unit).sort()], ['units', null, ['each', 'm']]);
  assert.deepEqual([hook.problem, hook.total, hook.parts.length], ['barcodes', null, 2]);
  assert.match(hook.problemText, /Not added up/);
  // A product with a reorder point and none in stock is out everywhere it is kept.
  const glue = f.row(view, 'GLUE');
  assert.deepEqual([glue.outIn, glue.outEverywhere, glue.total], [1, true, 0]);
  assert.deepEqual(view.counts, { products: 5, low: 1, out: 1, out_everywhere: 1, to_check: 2, matched: 2 });

  // Each currency stays on its own line.
  assert.deepEqual(view.totals.value.map(v => [v.currency, v.minor]), [['CAD', String(1500 + 1200 + 600 + 100)], ['USD', String(300 + 200 + 1000 + 100)]]);
  assert.deepEqual(view.totals.incoming.map(v => [v.currency, v.minor]), [['CAD', '1500']]);
  assert.deepEqual(view.totals.sales.filter(v => v.minor !== '0').map(v => [v.currency, v.minor]), [['USD', '1200']]);

  // Filters and search.
  assert.deepEqual((await rollup.model(db, owner, { filter: 'check' })).rows.map(r => r.codes[0]).sort(), ['DUP', 'ROPE']);
  assert.deepEqual((await rollup.model(db, owner, { filter: 'low' })).rows.map(r => r.codes[0]).sort(), ['GLUE', parcel].sort());
  assert.deepEqual((await rollup.model(db, owner, { q: '12345678905' })).rows.map(r => r.product), ['Widget']);
  assert.deepEqual((await rollup.model(db, owner, { q: '%' })).rows, []);

  // Drill into each inventory: the product page opens the product where it is kept.
  const drill = await f.browser.get(rollup.href + '/product?key=' + encodeURIComponent(parcelRow.key)).expect(200);
  assert.match(drill.text, /Open in Northern company/);
  const northItem = parcelRow.parts.find(p => p.workspaceId === north.workspaceId).itemId;
  await f.browser.post('/inventories/switch').type('form').send({ _csrf: f.csrf(drill.text), workspaceId: north.workspaceId, next: '/inventory/' + northItem }).expect(303).expect('Location', '/inventory/' + northItem);
  assert.match((await f.browser.get('/inventory/' + northItem).expect(200)).text, /Parcel item/);
  const fromNorth = await f.browser.get(rollup.href).expect(200);
  assert.match(fromNorth.text, /data-rollup-inventory="[^"]+"/);
  const back = await f.browser.post('/inventories/switch').type('form').send({ _csrf: f.csrf(fromNorth.text), workspaceId: owner.workspaceId, next: rollup.href }).expect(303);
  assert.equal(back.headers.location, rollup.href);

  // Excel holds inventories, currency totals and products; PDF prints all three.
  const xlsx = await f.browser.get(rollup.href + '/export.xlsx').buffer(true).parse((res, done) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
  assert.match(xlsx.headers['content-type'], /spreadsheetml/);
  const entries = unzip(xlsx.body);
  assert.match(entries['xl/workbook.xml'], /name="Inventories".*name="Totals by currency".*name="Products"/s);
  assert.match(entries['xl/worksheets/sheet2.xml'], /CAD.*USD/s);
  assert.match(entries['xl/worksheets/sheet3.xml'], /Units differ\. Not added up\./);
  const pdf = await f.browser.get(rollup.href + '/export.pdf?filter=check').buffer(true).parse((res, done) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
  assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  assert.equal(await f.audits('Exported combined inventory figures'), 2);

  // A deleted inventory leaves the combined view and the schedule.
  await db.query('UPDATE workspaces SET deletion_requested_at=now()::text WHERE id=$1', [f.third.workspaceId]);
  assert.deepEqual((await rollup.model(db, owner)).inventories.map(i => i.name), ['Northern company', 'Shipping operation fixture']);
  assert.deepEqual((await f.tick()).map(j => j.workspaceId).sort(), [north.workspaceId, owner.workspaceId].sort());

  // An owner playbook step reads the same figures.
  const books = require('../../src/autopilot/playbooks');
  const id = await books.create(db, owner, { name: 'Morning stock', steps: ['value', 'combined-stock'], cadence: 'manual' });
  const result = await books.run(db, owner, id, 'combined-run');
  assert.deepEqual(result[1].rows.map(r => [r.inventory, r.products_in_stock]), [['Northern company', 4], ['Shipping operation fixture', 4]]);
});

test('each person sees only the inventories and figures their access allows', { timeout: 600000 }, async t => {
  const f = await setup(t), { db, owner, north, parcel } = f;
  await f.tick(0);
  const person = await auth.createBusiness(db, { name: 'Viewer', businessName: 'Viewer own business', email: randomUUID() + '@example.test', password: 'Viewer!' + randomUUID() });
  const inUs = 'viewer-us-' + randomUUID(), inNorth = 'viewer-north-' + randomUUID();
  await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES($1,$2,$3,'Viewer','staff',now()::text),($4,$5,$3,'Viewer','accountant',now()::text)",
    [inUs, owner.workspaceId, person.accountId, inNorth, north.workspaceId]);
  const viewer = { workspaceId: owner.workspaceId, actorId: inUs, accountId: person.accountId };
  const view = await rollup.model(db, viewer);
  // The third inventory is not shared with this person, and their own business is another account.
  assert.deepEqual(view.inventories.map(i => i.name), ['Northern company', 'Shipping operation fixture']);
  const us = view.inventories.find(i => i.id === owner.workspaceId), can = view.inventories.find(i => i.id === north.workspaceId);
  assert.equal(us.figures.value, undefined, 'staff cannot see money in the US business');
  assert.equal(us.figures.sales, undefined);
  assert.equal(can.figures.value.currency, 'CAD');
  assert.deepEqual(view.totals.value.map(v => v.currency), ['CAD']);
  const parcelRow = f.row(view, parcel);
  assert.deepEqual(parcelRow.parts.map(p => [p.inventory, p.sold]), [['Northern company', 0], ['Shipping operation fixture', null]]);
  assert.equal(parcelRow.sold, 0, 'sold units only from inventories where this person sees sales');
  const page = await rollup.model(db, { workspaceId: north.workspaceId, actorId: inNorth, accountId: person.accountId });
  assert.deepEqual(page.inventories.map(i => i.name), ['Northern company', 'Shipping operation fixture']);
  assert.equal(page.inventories.every(i => !i.mayApprove), true);
  await assert.rejects(rollup.requestUpdate(db, viewer, north.workspaceId), /owner/);

  // Limited to assigned warehouses: that inventory is named but not included.
  await db.query('UPDATE users SET warehouse_location_ids=$2 WHERE id=$1', [inUs, JSON.stringify([f.location.id])]);
  const limited = await rollup.model(db, viewer);
  assert.deepEqual(limited.inventories.map(i => i.name), ['Northern company']);
  assert.deepEqual(limited.limited.map(i => i.name), ['Shipping operation fixture']);
  assert(f.row(limited, parcel).parts.every(p => p.workspaceId === north.workspaceId));
  assert.equal(f.row(limited, parcel).total, 6);
  // Someone without view access cannot open it at all.
  await db.query('UPDATE users SET permissions=$2 WHERE id=$1', [inUs, JSON.stringify([])]);
  await assert.rejects(rollup.model(db, viewer), e => e.status === 403);
});

test('the routine replays safely, writes only on change, holds for a pause or Ask me first, and keeps looking in Watch only and the first 14 days', { timeout: 600000 }, async t => {
  const f = await setup(t), { db, owner, north, skus, parcel } = f;
  await f.tick(0);
  const updates = () => f.audits('Updated combined inventory figures');
  const state = id => db.query('SELECT revision,held_reason,request_key FROM stockchief_runtime.agent_inventory_rollups WHERE workspace_id=$1', [id]).then(r => r.rows[0]);
  // Replays and unchanged figures write nothing new.
  const key = (await state(north.workspaceId)).request_key, before = await state(north.workspaceId);
  assert.deepEqual(await f.run(north.workspaceId, key), { replayed: true, revision: before.revision });
  assert.deepEqual(await f.run(north.workspaceId), { refreshed: true, changed: false, revision: before.revision });
  assert.equal(await updates(), 3);
  // A real change is picked up by the next scheduled update and audited.
  await inv.receive(db, north, { skuId: skus.parcelB, locationId: f.toronto.id, quantity: 1, idempotencyKey: randomUUID() });
  assert.equal((await f.tick()).length, 3);
  assert.equal(await updates(), 4);
  assert.equal((await state(north.workspaceId)).revision, before.revision + 1);
  assert.equal(f.row(await rollup.model(db, owner), parcel).total, 10);
  // Stock without a recorded cost is named, not valued as zero silently.
  const view = await rollup.model(db, owner);
  assert.match(view.totals.missingCost.map(m => m.inventory + ': ' + m.text).join(), /Northern company: 1 unit/);

  // A pause holds the scheduled update; the last figures stay with the reason.
  await auto.pause(db, north, { role: 'owner' }, 'Stocktake');
  await inv.receive(db, north, { skuId: skus.parcelB, locationId: f.toronto.id, quantity: 1, idempotencyKey: randomUUID() });
  await f.tick();
  assert.match((await state(north.workspaceId)).held_reason, /paused/);
  assert.equal(await f.audits('Held the combined inventory update'), 1);
  await f.tick();
  assert.equal(await f.audits('Held the combined inventory update'), 1, 'one entry per reason');
  let held = await rollup.model(db, owner);
  assert.equal(f.row(held, parcel).total, 10);
  const northRow = held.inventories.find(i => i.id === north.workspaceId);
  assert.equal(northRow.mayApprove, true);
  const page = await f.browser.get(rollup.href).expect(200);
  assert.match(page.text, /Automatic work is paused in this inventory/);
  // The owner approves one update; the worker runs it.
  await f.browser.post(rollup.href + '/update').type('form').send({ _csrf: f.csrf(page.text), inventoryId: north.workspaceId }).expect(303);
  assert.equal(await f.audits('Approved a combined inventory update'), 1);
  assert.match((await f.browser.get(rollup.href).expect(200)).text, /Update approved/);
  await f.work();
  assert.equal(f.row(await rollup.model(db, owner), parcel).total, 11);
  assert.equal(await f.audits('Updated combined inventory figures after owner approval'), 1);
  await auto.resume(db, north, { role: 'owner' });

  // This job's own Ask me first waits for approval in the same way.
  await modes.save(db, north, rollup.JOB, { mode: 'ask', revision: 0 });
  await inv.receive(db, north, { skuId: skus.parcelB, locationId: f.toronto.id, quantity: 1, idempotencyKey: randomUUID() });
  await f.tick();
  assert.match((await state(north.workspaceId)).held_reason, /Ask me first/);
  assert.equal(f.row(await rollup.model(db, owner), parcel).total, 11);
  assert.deepEqual(await rollup.requestUpdate(db, owner, f.owner.workspaceId), { queued: false, current: true });
  assert.equal((await rollup.requestUpdate(db, owner, north.workspaceId)).queued, true);
  await f.work();
  assert.equal(f.row(await rollup.model(db, owner), parcel).total, 12);

  // Watch only, inventory-wide watch mode and the first 14 days only look,
  // so the figures keep updating; nothing else in the business changes.
  await modes.save(db, north, rollup.JOB, { mode: 'watch', revision: 1 });
  await auto.setMode(db, north, { role: 'owner' }, 'OBSERVE');
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1", [f.owner.accountId]);
  const movements = await db.query('SELECT count(*)::int n FROM movements').then(r => r.rows[0].n);
  await inv.receive(db, north, { skuId: skus.parcelB, locationId: f.toronto.id, quantity: 1, idempotencyKey: randomUUID() });
  await f.tick();
  assert.equal((await state(north.workspaceId)).held_reason, null);
  assert.equal(f.row(await rollup.model(db, owner), parcel).total, 13);
  assert.equal(await db.query('SELECT count(*)::int n FROM movements').then(r => r.rows[0].n), movements + 1, 'only the receipt moved stock');

  // A broken request key is refused without retry.
  await assert.rejects(f.run(north.workspaceId, 'bad key!'), e => e.retryable === false);
});

test('the combined page and its drill-down render at desktop width and on a 390 px phone', { timeout: 600000 }, async t => {
  const f = await setup(t), { db } = f;
  await f.tick(0);
  const app = require('../../src/postgres-app').createPostgresApp({ database: db, env: 'test', sessionSecret: randomUUID() });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const chrome = await require('playwright').chromium.launch();
  f.cleanup(async () => { await chrome.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await app.locals.sessionStore.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await chrome.newPage({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
    await page.goto(base + '/login');
    await page.locator('[name=email]').fill(f.email);
    await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Sign in', exact: true }).click()]);
    await page.goto(base + '/inventories');
    await Promise.all([page.waitForNavigation(), page.getByRole('link', { name: 'See all inventories together' }).click()]);
    assert.equal(new URL(page.url()).pathname, rollup.href);
    const text = await page.locator('main').innerText();
    assert.match(text, /All inventories together/);
    assert.match(text, /Money by currency/);
    assert.match(text, /Rope\s+ROPE\s+Units differ/);
    assert.match(text, /Not added up/);
    assert.match(text, /Northern Supply Ltd/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, viewport.width + ' px has no sideways page scroll');
    await Promise.all([page.waitForNavigation(), page.getByRole('link', { name: 'Widget' }).click()]);
    assert.match(await page.locator('main').innerText(), /share a barcode but use different codes/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Open in Northern company' }).click()]);
    assert.match(new URL(page.url()).pathname, /^\/inventory\/.+/);
    assert.match(await page.locator('main').innerText(), /WID-B/);
    await page.goto(base + '/inventories');
    await Promise.all([page.waitForNavigation(), page.locator('form[action="/inventories/switch"]').filter({ has: page.locator('input[value="' + f.ctx.workspaceId + '"]') }).getByRole('button').click()]);
    await page.close();
  }
  await f.subscribe('growth');
  const page = await chrome.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(base + '/login');
  await page.locator('[name=email]').fill(f.email);
  await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Sign in', exact: true }).click()]);
  const response = await page.goto(base + rollup.href);
  assert.equal(response.status(), 402);
  assert.match(await page.locator('main').innerText(), /requires the Custom plan/);
});

function unzip(buffer) {
  const files = {};
  for (let at = 0; buffer.readUInt32LE(at) === 0x04034b50;) {
    const size = buffer.readUInt32LE(at + 18), nameLength = buffer.readUInt16LE(at + 26), extra = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 30, at + 30 + nameLength).toString();
    const start = at + 30 + nameLength + extra;
    files[name] = zlib.inflateRawSync(buffer.subarray(start, start + size)).toString();
    at = start + size;
  }
  return files;
}
