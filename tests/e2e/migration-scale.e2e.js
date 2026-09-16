'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const { openDatabase } = require('../../src/db');
const auth = require('../../src/domain/auth-service');
const migrations = require('../../src/onboarding/canonical-migration');
const mapping = require('../../src/onboarding/canonical-mapping');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.E2E_MIGRATION_PORT || 3998);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'artifacts', 'screenshots', 'migration-scale');

function startServer(databasePath) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT:String(PORT), DATABASE_PATH:databasePath,
      SESSION_SECRET:'migration-e2e-secret', NODE_ENV:'test' },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Migration browser server did not start.');
}

async function stopServer(child) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 3000);
  });
}

async function clickAndLoad(page, name) {
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.getByRole('button', { name }).click(),
  ]);
}

async function waitForText(page, pattern, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await page.locator('body').innerText();
    if (pattern.test(text)) return text;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for visible text ${pattern}.`);
}

test('a real browser proves a staged migration before activating cutover', { timeout:120_000 }, async (t) => {
  fs.mkdirSync(SHOTS, { recursive:true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-migration-e2e-'));
  const databasePath = path.join(dir, 'migration.db');
  const account = { workspaceName:'Migration Browser Proof', name:'Migration Owner',
    email:'migration-browser@example.test', password:'migration-browser-2026' };
  const db = openDatabase(databasePath);
  const registered = auth.registerAccount(db, account);
  const ctx = { workspaceId:registered.workspaceId, actorId:registered.userId,
    accountId:registered.accountId };
  const pkg = migrations.createPackage(db, ctx, { role:'owner' }, {
    sourceNamespace:'connector-neutral-fixture', sourceLabel:'Existing inventory system',
    sourceSnapshotHash:'snapshot-browser-1', manifest:{ reconciliation:{
      'sku.records':2, 'inventory.units':15,
    } },
  });
  migrations.stagePage(db, ctx, { role:'owner' }, pkg.id, [
    { entityType:'location', sourceKey:'main', payload:{ name:'Main warehouse', kind:'warehouse' } },
    { entityType:'product', sourceKey:'shoe', payload:{ name:'Migration shoe', trackingMode:'quantity',
      variants:[{ sourceKey:'shoe-blue', code:'MIG-BLUE', label:'Blue' },
        { sourceKey:'shoe-black', code:'MIG-BLACK', label:'Black' }] } },
    { entityType:'inventory_position', sourceKey:'blue-stock', payload:{
      skuKey:'shoe-blue', locationKey:'main', quantity:9 } },
    { entityType:'inventory_position', sourceKey:'black-stock', payload:{
      skuKey:'shoe-black', locationKey:'main', quantity:6 } },
  ]);
  db.close();

  const server = startServer(databasePath);
  await waitForServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport:{ width:1440, height:1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  t.after(async () => {
    await context.close();
    await browser.close();
    await stopServer(server);
    fs.rmSync(dir, { recursive:true, force:true });
  });

  await page.goto(`${BASE}/login`);
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await Promise.all([page.waitForURL(`${BASE}/`), page.getByRole('button', { name:'Sign in' }).click()]);
  await page.goto(`${BASE}/onboarding/migrations/${pkg.id}`);
  assert.match(await page.locator('body').innerText(), /StockChief records prepared\s+4/i);
  await page.screenshot({ path:path.join(SHOTS, '01-staged-not-cut-over.png'), fullPage:true });

  await page.getByRole('button',{ name:'Approve and go live' }).waitFor();
  await clickAndLoad(page, 'Approve and go live');
  const reconciled = await page.locator('body').innerText();
  assert.match(reconciled, /This inventory is live and verified/);
  assert.match(reconciled, /Open this inventory/);
  assert.match(reconciled, /SKU \/ variant records\s+2\s+2\s+matched/i);
  assert.match(reconciled, /Inventory units\s+15\s+15\s+matched/i);
  await page.screenshot({ path:path.join(SHOTS, '03-active-cutover.png'), fullPage:true });
  assert.deepEqual(pageErrors, []);

  const verified = openDatabase(databasePath);
  try {
    assert.equal(verified.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id=?')
      .get(ctx.workspaceId).n, 2);
    assert.equal(verified.prepare('SELECT SUM(on_hand) AS n FROM balances WHERE workspace_id=?')
      .get(ctx.workspaceId).n, 15);
    assert.equal(migrations.getPackage(verified, ctx.workspaceId, pkg.id).status, 'CUTOVER_ACTIVE');
  } finally { verified.close(); }
});

test('a real browser reviews an unfamiliar mapping and proves a frozen live-source cutover', { timeout:120_000 }, async (t) => {
  fs.mkdirSync(SHOTS,{ recursive:true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'foundry-live-cutover-e2e-'));
  const databasePath = path.join(dir,'migration.db');
  const account = { workspaceName:'Custom Source Proof',name:'Migration Owner',
    email:'custom-source@example.test',password:'custom-source-2026' };
  const db = openDatabase(databasePath); const registered = auth.registerAccount(db,account);
  const ctx = { workspaceId:registered.workspaceId,actorId:registered.userId,accountId:registered.accountId };
  const member = { role:'owner' };
  const pkg = migrations.createPackage(db,ctx,member,{ sourceNamespace:'customer-built-source',
    sourceSnapshotHash:'customer-snapshot-1',cutoverMode:'SNAPSHOT_DELTA',sourceCheckpoint:'event-400',
    sourceSnapshotAt:'2026-09-14T12:00:00.000Z' });
  const profile = mapping.createProfile(db,ctx,member,pkg.id,{ sourceDataset:'Custom product table',entityType:'product',
    columns:[{ name:'External ID',samples:['CUSTOM-1'] },{ name:'Name',samples:['Built-to-order assembly'] },
      { name:'Local Routing Hint',samples:['special-cell-7'] }] });
  db.close();

  const server = startServer(databasePath); await waitForServer();
  const browser = await chromium.launch(); const context = await browser.newContext({ viewport:{ width:1440,height:1000 } });
  const page = await context.newPage(); const pageErrors = [];
  page.on('pageerror',(error) => pageErrors.push(String(error)));
  t.after(async () => { await context.close(); await browser.close(); await stopServer(server);
    fs.rmSync(dir,{ recursive:true,force:true }); });

  await page.goto(`${BASE}/login`); await page.fill('#email',account.email); await page.fill('#password',account.password);
  await Promise.all([page.waitForURL(`${BASE}/`),page.getByRole('button',{ name:'Sign in' }).click()]);
  await page.goto(`${BASE}/onboarding/migrations/${pkg.id}`);
  await page.goto(`${BASE}/onboarding/migration-mappings/${profile.id}`);
  assert.match(await page.locator('body').innerText(),/0 business facts need a rule/);
  await clickAndLoad(page,'Keep as evidence and continue');
  assert.match(await page.locator('body').innerText(),/approved/i);

  let live = openDatabase(databasePath);
  mapping.stageRows(live,ctx,member,profile.id,[{ 'External ID':'CUSTOM-1',Name:'Built-to-order assembly',
    'Local Routing Hint':'special-cell-7' }]);
  migrations.beginDeltaCapture(live,ctx,member,pkg.id,{ sourceCursor:'event-400' });
  migrations.stageDeltaPage(live,ctx,member,pkg.id,'event-401',[{ operation:'UPSERT',record:{ entityType:'product',
    sourceKey:'CUSTOM-1',sourceVersion:'2',payload:{ name:'Built-to-order assembly v2' } } }]);
  migrations.freezeSource(live,ctx,member,pkg.id,{ finalCheckpoint:'event-401',evidence:'Browser fixture source frozen' });
  migrations.validate(live,ctx,member,pkg.id);
  live.close();
  await page.goto(`${BASE}/onboarding/migrations/${pkg.id}`);
  await clickAndLoad(page,'Approve and go live');
  assert.match(await page.locator('body').innerText(),/Frozen source checkpoint\s+event-401\s+event-401\s+matched/i);
  assert.match(await page.locator('body').innerText(),/This inventory is live and verified/);
  await page.screenshot({ path:path.join(SHOTS,'04-live-custom-source-active.png'),fullPage:true });
  assert.deepEqual(pageErrors,[]);
});

test('an owner starts and completes a migration entirely in the browser with their own export', { timeout:120_000 }, async (t) => {
  fs.mkdirSync(SHOTS,{ recursive:true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'foundry-owner-cutover-e2e-'));
  const databasePath = path.join(dir,'migration.db');
  const account = { workspaceName:'Owner Migration Proof',name:'Migration Owner',
    email:'owner-migration@example.test',password:'owner-migration-2026' };
  const db = openDatabase(databasePath); const registered = auth.registerAccount(db,account); db.close();
  const server = startServer(databasePath); await waitForServer();
  const browser = await chromium.launch(); const context = await browser.newContext({ viewport:{ width:1440,height:1000 } });
  const page = await context.newPage(); const pageErrors = [];
  page.on('pageerror',(error) => pageErrors.push(String(error)));
  t.after(async () => { await context.close(); await browser.close(); await stopServer(server);
    fs.rmSync(dir,{ recursive:true,force:true }); });

  await page.goto(`${BASE}/login`); await page.fill('#email',account.email); await page.fill('#password',account.password);
  await Promise.all([page.waitForURL(`${BASE}/`),page.getByRole('button',{ name:'Sign in' }).click()]);
  await page.goto(`${BASE}/onboarding/migrations/new`);
  await page.locator('input[type=file]').setInputFiles([
    { name:'inventory-export.csv',mimeType:'text/csv',buffer:Buffer.from([
      'SKU,Product,Location,Quantity,Selling Price,Unit Cost,Supplier',
      'LIVE-9,Live browser shoe,Live Depot,14,99.00,44.50,Live Supplier',
    ].join('\n')) },
    { name:'open-purchase-orders.csv',mimeType:'text/csv',buffer:Buffer.from([
      'PO Number,Supplier,Destination,Status,SKU,Quantity,Unit Cost',
      'PO-LIVE-9,Live Supplier,Live Depot,Open,LIVE-9,4,44.50',
    ].join('\n')) },
    { name:'open-sales-orders.csv',mimeType:'text/csv',buffer:Buffer.from([
      'Sales Order Number,Customer,Status,SKU,Quantity,Unit Price,Delivery Method',
      'SO-LIVE-9,Live Customer,Confirmed,LIVE-9,2,99.00,Pickup',
    ].join('\n')) },
  ]);
  const selected = page.locator('[data-migration-selection]');
  assert.match(await selected.innerText(),/3 files ready/);
  assert.match(await selected.innerText(),/inventory-export\.csv/);
  assert.match(await selected.innerText(),/open-purchase-orders\.csv/);
  assert.match(await selected.innerText(),/open-sales-orders\.csv/);
  await page.screenshot({ path:path.join(SHOTS,'04-owner-files-selected.png'),fullPage:true });
  const read = page.getByRole('button',{ name:'Read 3 files safely' });
  const destination = page.waitForURL(/\/onboarding\/migrations\/[^/]+(?:\/sources)?$/);
  await read.click({ noWaitAfter:true });
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-migration-submit]');
    return button && button.disabled && /Reading/.test(button.textContent || '');
  });
  const busyRead = page.locator('[data-migration-submit]');
  assert.equal(await busyRead.isDisabled(),true);
  assert.match(await busyRead.innerText(),/Reading/);
  await page.screenshot({ path:path.join(SHOTS,'05-owner-upload-working.png'),fullPage:true });
  await destination;
  assert.match(await page.locator('body').innerText(),/open-purchase-orders\.csv · inventory-export\.csv · open-sales-orders\.csv|StockChief is preparing this inventory/);
  await page.getByRole('button',{ name:'Approve and go live' }).waitFor({ timeout:30_000 });
  assert.match(await page.locator('body').innerText(),/Verification passed|source totals match/i);
  await page.screenshot({ path:path.join(SHOTS,'05-owner-upload-staged.png'),fullPage:true });
  await clickAndLoad(page,'Approve and go live');
  assert.match(await page.locator('body').innerText(),/Purchase-order units/);
  assert.match(await page.locator('body').innerText(),/Sales-order units/);
  assert.match(await page.locator('body').innerText(),/This inventory is live and verified/);
  await page.screenshot({ path:path.join(SHOTS,'06-owner-upload-active.png'),fullPage:true });
  assert.deepEqual(pageErrors,[]);

  const verified = openDatabase(databasePath);
  try {
    const sku = verified.prepare("SELECT * FROM skus WHERE workspace_id=? AND code='LIVE-9'").get(registered.workspaceId);
    assert.ok(sku);
    assert.equal(verified.prepare('SELECT SUM(on_hand) AS n FROM balances WHERE workspace_id=? AND sku_id=?')
      .get(registered.workspaceId,sku.id).n,14);
    assert.equal(verified.prepare('SELECT amount_minor FROM sku_prices WHERE workspace_id=? AND sku_id=? ORDER BY rowid DESC LIMIT 1')
      .get(registered.workspaceId,sku.id).amount_minor,9900);
    assert.ok(verified.prepare("SELECT id FROM purchase_orders WHERE workspace_id=? AND po_number='PO-LIVE-9'").get(registered.workspaceId));
    assert.ok(verified.prepare("SELECT id FROM sales_orders WHERE workspace_id=? AND order_number='SO-LIVE-9'").get(registered.workspaceId));
  } finally { verified.close(); }
});
