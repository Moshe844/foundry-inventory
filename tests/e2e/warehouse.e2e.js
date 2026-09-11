'use strict';

/** Mission 5 acceptance in a phone-sized real browser with a real restart. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const { openDatabase } = require('../../src/db');
const auth = require('../../src/domain/auth-service');
const locations = require('../../src/domain/location-service');
const items = require('../../src/domain/item-service');
const repo = require('../../src/domain/repository');
const engine = require('../../src/domain/inventory-engine');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.E2E_WAREHOUSE_PORT || 3991);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'artifacts', 'screenshots', 'warehouse');
const ACCOUNT = { workspaceName: 'Scan Company', name: 'Robin Warehouse',
  email: 'robin@warehouse.test', password: 'warehouse-2026' };

function startServer(databasePath) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATABASE_PATH: databasePath,
      SESSION_SECRET: 'warehouse-e2e-secret', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(`[warehouse server] ${chunk}`));
  return child;
}

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('Warehouse browser server did not start.');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve); child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 3000);
  });
}

async function signIn(page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${BASE}/`);
}

test('Mission 5 warehouse work is scan-first, restart-safe and duplicate-safe in a real mobile browser', async (t) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-warehouse-e2e-'));
  const databasePath = path.join(temp, 'warehouse.sqlite');
  let db = openDatabase(databasePath);
  const registered = auth.registerAccount(db, ACCOUNT);
  const ctx = { workspaceId: registered.workspaceId, actorId: registered.userId, accountId: registered.accountId };
  const root = locations.createLocation(db, ctx, { name: 'Main Warehouse', kind: 'warehouse', barcode: 'WH-MAIN' });
  const aisle = locations.createLocation(db, ctx, { name: 'Aisle A', kind: 'aisle', parentLocationId: root.id, barcode: 'AISLE-A' });
  const bin = locations.createLocation(db, ctx, { name: 'Bin A-01', kind: 'bin', parentLocationId: aisle.id, barcode: 'BIN-A-01' });
  const created = items.createItem(db, ctx, { name: 'Black Loafer', baseCode: 'LOAFER-35-BLK', trackingMode: 'quantity' });
  const sku = repo.listSkusForItem(db, ctx.workspaceId, created.itemId)[0];
  engine.receive(db, ctx, { skuId: sku.id, locationId: root.id, quantity: 3, reference: 'Opening proof' });
  db.close();

  let server = startServer(databasePath);
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('requestfailed', (request) => errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));

  try {
    await signIn(page);
    await page.goto(`${BASE}/warehouse`);
    await page.screenshot({ path: path.join(SHOTS, '01-queue-phone.png'), fullPage: true });
    assert.match(await page.locator('body').innerText(), /Work that starts with a scan/);
    const taskForm = page.locator('form[action="/warehouse/tasks"]');
    await taskForm.getByLabel('Task type').selectOption('TRANSFER');
    await taskForm.getByLabel('Product').selectOption(sku.id);
    await taskForm.getByLabel('Source').selectOption(root.id);
    await taskForm.getByLabel('Destination').selectOption(bin.id);
    await taskForm.getByLabel('Quantity').fill('3');
    await taskForm.getByRole('button', { name: 'Create scan task' }).click();
    await page.waitForURL(/\/warehouse\/tasks\/wht_/);

    await page.getByLabel('Location barcode').fill('BIN-A-01');
    await page.getByLabel('Product barcode').fill('LOAFER-35-BLK');
    await page.getByRole('button', { name: 'Accept scan' }).click();
    assert.match(await page.locator('body').innerText(), /belongs at Main Warehouse/);

    await page.getByLabel('Location barcode').fill('WH-MAIN');
    await page.getByLabel('Product barcode').fill('LOAFER-35-BLK');
    await page.getByLabel('Quantity').fill('1');
    await page.locator('[data-scan-id]').evaluate((node) => { node.value = 'offline-fixed-1'; });
    await page.getByRole('button', { name: 'Accept scan' }).click();
    assert.match(await page.locator('body').innerText(), /Moved 1 from Main Warehouse to Bin A-01/);

    await page.getByLabel('Location barcode').fill('WH-MAIN');
    await page.getByLabel('Product barcode').fill('LOAFER-35-BLK');
    await page.getByLabel('Quantity').fill('1');
    await page.locator('[data-scan-id]').evaluate((node) => { node.value = 'offline-fixed-1'; });
    await page.getByRole('button', { name: 'Accept scan' }).click();
    assert.match(await page.locator('body').innerText(), /Already received that offline scan/);

    await page.getByRole('button', { name: 'Pause task' }).click();
    assert.match(await page.locator('body').innerText(), /PAUSED/);
    await page.screenshot({ path: path.join(SHOTS, '02-paused-after-replay.png'), fullPage: true });

    const taskUrl = page.url();
    await stopServer(server);
    server = startServer(databasePath);
    await waitForServer();
    await page.goto(taskUrl);
    if (page.url().includes('/login')) { await signIn(page); await page.goto(taskUrl); }
    assert.match(await page.locator('body').innerText(), /1 \/ 3/);
    await page.getByRole('button', { name: 'Resume task' }).click();
    await page.getByLabel('Location barcode').fill('WH-MAIN');
    await page.getByLabel('Product barcode').fill('LOAFER-35-BLK');
    await page.getByLabel('Quantity').fill('2');
    await page.getByRole('button', { name: 'Accept scan' }).click();
    assert.match(await page.locator('body').innerText(), /COMPLETED/);
    await page.screenshot({ path: path.join(SHOTS, '03-completed-after-restart.png'), fullPage: true });

    await page.goto(`${BASE}/warehouse/labels/sku/${sku.id}`);
    assert.match(await page.locator('body').innerText(), /Encoding verified for scan round-trip/);
    assert.equal(await page.locator('svg[data-barcode="LOAFER-35-BLK"]').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await stopServer(server);
  }

  db = openDatabase(databasePath);
  assert.equal(repo.getBalance(db, ctx.workspaceId, sku.id, root.id), 0);
  assert.equal(repo.getBalance(db, ctx.workspaceId, sku.id, bin.id), 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warehouse_scan_events WHERE workspace_id = ? AND status = 'ACCEPTED'").get(ctx.workspaceId).n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM warehouse_scan_events WHERE workspace_id = ? AND status = 'REJECTED'").get(ctx.workspaceId).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'transfer'").get(ctx.workspaceId).n, 4);
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
