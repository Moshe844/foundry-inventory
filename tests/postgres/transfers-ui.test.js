'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const { createPostgresApp } = require('../../src/postgres-app');
const locations = require('../../src/domain/postgres-location-service');
const catalog = require('../../src/domain/postgres-catalog-service');
const inventory = require('../../src/domain/postgres-inventory-engine');
const transfers = require('../../src/transfers/postgres-transfer-service');
const ledger = require('../../src/accounting/postgres-ledger');
const costing = require('../../src/accounting/postgres-costing');
const projections = require('../../src/projections/postgres-service');

async function costReceipt(database, ctx, receipt, totalCostMinor, sourceKey) {
  return database.transaction(async (client) => {
    const posted = await ledger.postInTransaction(client, ctx, {
      postingDate: '2026-09-23', sourceKey, description: 'Opening transfer-test inventory',
      sourceType: 'opening_inventory', sourceRecordType: 'movement', sourceRecordId: receipt.movementId,
      lines: [
        { accountKey: 'INVENTORY_ASSET', debitMinor: totalCostMinor },
        { accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: totalCostMinor },
      ],
    });
    return costing.receiveInTransaction(client, ctx, { movementId: receipt.movementId, totalCostMinor,
      journalEntryId: posted.entry.id, sourceType: 'opening_inventory', sourceRecordId: receipt.movementId });
  }, { isolation: 'SERIALIZABLE', retrySafe: true });
}

async function accountBalance(database, workspaceId, key) {
  const result = await database.query(`SELECT COALESCE(SUM(l.debit_minor-l.credit_minor),0) AS balance
    FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id=l.account_id
    WHERE l.workspace_id=$1 AND a.system_key=$2`, [workspaceId, key]);
  return Number(result.rows[0].balance);
}

test('real Chromium proves PostgreSQL transfer custody, partial outcomes, accounting, lots and serials',
  { timeout: 240000 }, async (context) => {
    const cluster = await startCluster();
    const database = openPostgres(cluster.connectionString, { applicationName: 'stockchief-postgres-transfers-ui' });
    await migratePostgres(database);
    const app = createPostgresApp({ database, env: 'test', sessionSecret: 'postgres-transfers-secret' });
    const server = await new Promise((resolve) => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
    const browser = await chromium.launch();
    context.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve));
      await app.locals.sessionStore.close(); await database.close(); cluster.stop(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(15000);
    const base = `http://127.0.0.1:${server.address().port}`;

    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Transfer Custody Business');
    await page.getByLabel('Your name').fill('Transfer Owner');
    await page.getByLabel('Work email').fill('transfers-ui@example.test');
    await page.getByLabel('Password').fill('transfer-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`), page.getByRole('button', { name: 'Create account' }).click()]);
    const identity = (await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id
      WHERE a.email='transfers-ui@example.test'`)).rows[0];
    const ctx = { workspaceId: identity.workspace_id, actorId: identity.actor_id };
    const source = await locations.createLocation(database, ctx, { name: 'North Warehouse', kind: 'warehouse' });
    const destination = await locations.createLocation(database, ctx, { name: 'South Store', kind: 'store' });
    const item = await catalog.createItem(database, ctx, { name: 'Transfer Widget', baseCode: 'TW',
      trackingMode: 'quantity', unitLabel: 'unit' });
    await ledger.configure(database, ctx, { startDate: '2026-01-01', currency: 'USD' });
    const opening = await inventory.receive(database, ctx, { skuId: item.skuIds[0], locationId: source.id,
      quantity: 20, reference: 'OPENING', idempotencyKey: 'transfer-opening-quantity' });
    await costReceipt(database, ctx, opening, 2000, 'opening-transfer-quantity');

    await page.goto(`${base}/inventory/${item.itemId}`);
    await page.getByRole('button', { name: 'Request a move' }).click();
    const modal = page.locator('#modal-transfer');
    await modal.locator('select[name="skuId"]').selectOption(item.skuIds[0]);
    await modal.locator('select[name="fromLocationId"]').selectOption(source.id);
    await modal.locator('input[name="quantity"]').fill('8');
    await modal.locator('select[name="toLocationId"]').selectOption(destination.id);
    await Promise.all([page.waitForURL(/\/transfers\/tr_/), modal.getByRole('button', { name: 'Create transfer request' }).click()]);
    const transferId = page.url().split('/').pop();
    assert.match(await page.locator('main').innerText(), /Nothing has physically moved/);
    let balances = (await database.query(`SELECT location_id,on_hand FROM balances
      WHERE workspace_id=$1 AND sku_id=$2`, [ctx.workspaceId, item.skuIds[0]])).rows;
    assert.deepEqual(Object.fromEntries(balances.map((row) => [row.location_id, Number(row.on_hand)])), { [source.id]: 20 });

    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Approve this move' }).click()]);
    assert.match(await page.locator('main').innerText(), /8 units are held at North Warehouse/);
    assert.equal((await catalog.getItem(database, ctx.workspaceId, item.itemId)).onOrder, 8);
    assert.equal((await projections.brief(database, ctx.workspaceId)).stats.incoming, 8);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: /Confirm 8 units left/ }).click()]);
    assert.match(await page.locator('main').innerText(), /8 units in transit to South Store/);
    balances = (await database.query(`SELECT location_id,on_hand FROM balances
      WHERE workspace_id=$1 AND sku_id=$2`, [ctx.workspaceId, item.skuIds[0]])).rows;
    assert.deepEqual(Object.fromEntries(balances.map((row) => [row.location_id, Number(row.on_hand)])), { [source.id]: 12 });
    assert.equal(await accountBalance(database, ctx.workspaceId, 'INVENTORY_IN_TRANSIT'), 800);

    await page.getByText('Something arrived short, lost, or damaged').click();
    const difference = page.locator('details.rm-more[open]');
    await difference.getByLabel('Arrived usable').fill('6');
    await difference.getByLabel('Lost').fill('1');
    await difference.getByLabel('Damaged / written off').fill('1');
    const receiptKey = await difference.locator('input[name="idempotencyKey"]').inputValue();
    await Promise.all([page.waitForNavigation(), difference.getByRole('button', { name: 'Record this difference' }).click()]);
    assert.match(await page.locator('main').innerText(), /This transfer is complete/);
    balances = (await database.query(`SELECT location_id,on_hand FROM balances
      WHERE workspace_id=$1 AND sku_id=$2`, [ctx.workspaceId, item.skuIds[0]])).rows;
    assert.deepEqual(Object.fromEntries(balances.map((row) => [row.location_id, Number(row.on_hand)])),
      { [source.id]: 12, [destination.id]: 6 });
    assert.equal(await accountBalance(database, ctx.workspaceId, 'INVENTORY_ASSET'), 1800);
    assert.equal(await accountBalance(database, ctx.workspaceId, 'INVENTORY_IN_TRANSIT'), 0);
    assert.equal(await accountBalance(database, ctx.workspaceId, 'INVENTORY_ADJUSTMENTS'), 200);
    assert.equal((await catalog.getItem(database, ctx.workspaceId, item.itemId)).onOrder, 0);
    assert.equal((await projections.brief(database, ctx.workspaceId)).stats.incoming, 0);
    const verified = await transfers.verify(database, ctx.workspaceId, transferId);
    assert.equal(verified.ok, true, verified.problems.join('; '));
    const replay = await transfers.receive(database, ctx, transferId, { idempotencyKey: receiptKey,
      lines: [{ lineId: verified.transfer.lines[0].id, received: 6, lost: 1, damaged: 1 }] });
    assert.equal(replay.replayed, true);

    const lotItem = await catalog.createItem(database, ctx, { name: 'Lot Ingredient', baseCode: 'LOT',
      trackingMode: 'lot', unitLabel: 'bag' });
    const lotOpening = await inventory.receive(database, ctx, { skuId: lotItem.skuIds[0], locationId: source.id,
      quantity: 5, lotCode: 'BATCH-7', reference: 'LOT-OPENING', idempotencyKey: 'transfer-opening-lot' });
    const lotTransfer = await transfers.request(database, ctx, { fromLocationId: source.id, toLocationId: destination.id,
      idempotencyKey: 'lot-transfer-request', lines: [{ skuId: lotItem.skuIds[0], quantity: 3, lotId: lotOpening.lotId }] });
    await transfers.approve(database, ctx, lotTransfer.id, { idempotencyKey: 'lot-transfer-approve' });
    await transfers.pick(database, ctx, lotTransfer.id, { idempotencyKey: 'lot-transfer-pick' });
    await transfers.dispatch(database, ctx, lotTransfer.id, { idempotencyKey: 'lot-transfer-dispatch' });
    await transfers.markInTransit(database, ctx, lotTransfer.id, { idempotencyKey: 'lot-transfer-transit' });
    const lotLine = (await transfers.get(database, ctx.workspaceId, lotTransfer.id)).lines[0];
    await transfers.receive(database, ctx, lotTransfer.id, { idempotencyKey: 'lot-transfer-receive',
      lines: [{ lineId: lotLine.id, received: 3, lost: 0, damaged: 0 }] });
    const lotBalances = (await database.query(`SELECT location_id,quantity FROM lot_balances
      WHERE workspace_id=$1 AND lot_id=$2`, [ctx.workspaceId, lotOpening.lotId])).rows;
    assert.deepEqual(Object.fromEntries(lotBalances.map((row) => [row.location_id, Number(row.quantity)])),
      { [source.id]: 2, [destination.id]: 3 });

    const serialItem = await catalog.createItem(database, ctx, { name: 'Serial Scanner', baseCode: 'SCAN',
      trackingMode: 'serial', unitLabel: 'unit' });
    await inventory.receive(database, ctx, { skuId: serialItem.skuIds[0], locationId: source.id,
      quantity: 2, serials: ['SCAN-A', 'SCAN-B'], reference: 'SERIAL-OPENING',
      idempotencyKey: 'transfer-opening-serial' });
    const serialRows = (await database.query(`SELECT id,serial FROM serial_units
      WHERE workspace_id=$1 AND sku_id=$2 ORDER BY serial`, [ctx.workspaceId, serialItem.skuIds[0]])).rows;
    const serialTransfer = await transfers.request(database, ctx, { fromLocationId: source.id, toLocationId: destination.id,
      idempotencyKey: 'serial-transfer-request', lines: [{ skuId: serialItem.skuIds[0], quantity: 2,
        serialUnitIds: serialRows.map((row) => row.id) }] });
    await transfers.approve(database, ctx, serialTransfer.id, { idempotencyKey: 'serial-transfer-approve' });
    await transfers.pick(database, ctx, serialTransfer.id, { idempotencyKey: 'serial-transfer-pick' });
    await transfers.dispatch(database, ctx, serialTransfer.id, { idempotencyKey: 'serial-transfer-dispatch' });
    await transfers.markInTransit(database, ctx, serialTransfer.id, { idempotencyKey: 'serial-transfer-transit' });
    const serialLine = (await transfers.get(database, ctx.workspaceId, serialTransfer.id)).lines[0];
    await transfers.receive(database, ctx, serialTransfer.id, { idempotencyKey: 'serial-transfer-receive',
      lines: [{ lineId: serialLine.id, received: 1, lost: 0, damaged: 1,
        receivedSerialUnitIds: [serialRows[0].id], damagedSerialUnitIds: [serialRows[1].id] }] });
    const serialState = (await database.query(`SELECT id,status,location_id,condition FROM serial_units
      WHERE workspace_id=$1 AND sku_id=$2 ORDER BY serial`, [ctx.workspaceId, serialItem.skuIds[0]])).rows;
    assert.deepEqual(serialState.map((row) => ({ status: row.status, location: row.location_id, condition: row.condition })), [
      { status: 'in_stock', location: destination.id, condition: 'good' },
      { status: 'issued', location: null, condition: 'damaged' },
    ]);
    assert.equal((await transfers.verify(database, ctx.workspaceId, serialTransfer.id)).ok, true);
    assert.deepEqual(errors, []);
  });

test('concurrent PostgreSQL transfer approvals cannot reserve the same source stock twice',
  { timeout: 120000 }, async (context) => {
    const cluster = await startCluster();
    const database = openPostgres(cluster.connectionString, { applicationName: 'stockchief-postgres-transfer-contention' });
    context.after(async () => { await database.close(); cluster.stop(); });
    await migratePostgres(database);
    const at = '2026-09-23T00:00:00.000Z';
    await database.query(`INSERT INTO accounts(id,email,name,password_hash,created_at)
      VALUES('account','transfer-contention@example.test','Owner','test',$1)`, [at]);
    await database.query(`INSERT INTO workspaces(id,name,owner_account_id,created_at)
      VALUES('workspace','Transfer contention','account',$1)`, [at]);
    await database.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at)
      VALUES('owner','workspace','account','Owner','owner',$1)`, [at]);
    const ctx = { workspaceId: 'workspace', actorId: 'owner' };
    const source = await locations.createLocation(database, ctx, { name: 'Source', kind: 'warehouse' });
    const destination = await locations.createLocation(database, ctx, { name: 'Destination', kind: 'store' });
    const item = await catalog.createItem(database, ctx, { name: 'Contended unit', baseCode: 'CONTEND',
      trackingMode: 'quantity', unitLabel: 'unit' });
    await inventory.receive(database, ctx, { skuId: item.skuIds[0], locationId: source.id, quantity: 10,
      reference: 'OPENING', idempotencyKey: 'contention-opening' });
    const first = await transfers.request(database, ctx, { fromLocationId: source.id, toLocationId: destination.id,
      idempotencyKey: 'contention-request-a', lines: [{ skuId: item.skuIds[0], quantity: 7 }] });
    const second = await transfers.request(database, ctx, { fromLocationId: source.id, toLocationId: destination.id,
      idempotencyKey: 'contention-request-b', lines: [{ skuId: item.skuIds[0], quantity: 7 }] });
    const approvals = await Promise.allSettled([
      transfers.approve(database, ctx, first.id, { idempotencyKey: 'contention-approve-a' }),
      transfers.approve(database, ctx, second.id, { idempotencyKey: 'contention-approve-b' }),
    ]);
    assert.equal(approvals.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(approvals.filter((entry) => entry.status === 'rejected').length, 1);
    assert.match(approvals.find((entry) => entry.status === 'rejected').reason.message, /only has 3 available/i);
    const state = await database.query(`SELECT status,COUNT(*) AS count FROM inventory_transfers
      WHERE workspace_id=$1 GROUP BY status ORDER BY status`, [ctx.workspaceId]);
    assert.deepEqual(state.rows.map((row) => ({ status: row.status, count: Number(row.count) })), [
      { status: 'APPROVED', count: 1 }, { status: 'REQUESTED', count: 1 },
    ]);
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances
      WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
    [ctx.workspaceId, item.skuIds[0], source.id])).rows[0].on_hand), 10);
  });
