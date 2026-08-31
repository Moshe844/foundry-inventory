'use strict';

/**
 * Onboarding acceptance runs, in a real browser, from a clean database.
 *
 * Two customers:
 *
 *   the Excel customer — one messy export, migrated and reconciled;
 *   the messy customer — four overlapping files that disagree with each other.
 *
 * Both prove the same thing from different angles: Foundry takes the inventory
 * over rather than handing back an import template, and it only says the
 * migration is verified when the totals actually agree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const { openDatabase } = require('../../src/db');
const authService = require('../../src/domain/auth-service');
const engine = require('../../src/domain/inventory-engine');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'artifacts', 'screenshots', 'onboarding');
const PORT = Number(process.env.E2E_ONBOARDING_PORT || 3992);
const BASE = `http://127.0.0.1:${PORT}`;

const ACCOUNT = {
  workspaceName: 'Harbour Clothing',
  name: 'Ruth Marlowe',
  email: 'ruth@harbourclothing.test',
  password: 'harbour-onboarding-2026',
};

let shotIndex = 0;
async function shot(page, name) {
  shotIndex += 1;
  await page.screenshot({
    path: path.join(SHOTS, `${String(shotIndex).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

function startServer(databasePath) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_PATH: databasePath,
      SESSION_SECRET: 'onboarding-e2e-secret',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('Server did not start in time');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function stopServer(child) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

function inspect(databasePath, fn) {
  const db = openDatabase(databasePath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function workbook(file, sheets) {
  const XLSX = require('xlsx');
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  }
  fs.writeFileSync(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  return file;
}

function csvFile(file, lines) {
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

/** Signs up and lands on the onboarding chooser. */
async function register(page, account) {
  await page.goto(`${BASE}/register`);
  await page.fill('#name', account.name);
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await Promise.all([page.waitForURL(`${BASE}/inventories`), page.click('form[action="/register"] button[type=submit]')]);
  await Promise.all([page.waitForURL(`${BASE}/inventories/new`), page.click('a[href="/inventories/new"]')]);
  await page.fill('#name', account.workspaceName);
  await Promise.all([page.waitForURL(`${BASE}/onboarding`), page.click('form[action="/inventories"] button[type=submit]')]);
}

const workspaceIdFor = (databasePath, name) =>
  inspect(databasePath, (db) => db.prepare('SELECT id FROM workspaces WHERE name = ?').get(name).id);

// ---------------------------------------------------------------------------

test('Onboarding end to end: the Excel customer', { timeout: 600000 }, async (t) => {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-onboard-'));
  const databasePath = path.join(dataDir, 'e2e.db');

  // The export a real wholesaler would hand over: title rows, a blank line, a
  // price column, an abbreviated warehouse, a second header stacked in the
  // middle, and one quantity nobody typed as a number.
  const file = workbook(path.join(dataDir, 'warehouse.xlsx'), {
    Stock: [
      ['Harbour Clothing — stock on hand', '', '', '', '', '', ''],
      ['Exported 14 August 2026', '', '', '', '', '', ''],
      ['', '', '', '', '', '', ''],
      ['Item Code', 'Description', 'Colour', 'Size', 'Warehouse', 'Qty On Hand', 'Unit Cost'],
      ['OX-1002', 'Navy Oxford', 'Navy', '8', 'Brooklyn Warehouse', 18, 42.5],
      ['OX-1002', 'Navy Oxford', 'Navy', '9', 'Brooklyn Warehouse', 12, 42.5],
      ['OX-1003', 'White Oxford', 'White', '8', 'Brooklyn Warehouse', 20, 42.5],
      ['CH-2001', 'Coastal Chino', 'Stone', '32', 'New Jersey Warehouse', 24, 38],
      ['CH-2001', 'Coastal Chino', 'Stone', '34', 'New Jersey Wrhs', 9, 38],
      ['', '', '', '', '', '', ''],
      ['Item Code', 'Description', 'Colour', 'Size', 'Warehouse', 'Qty On Hand', 'Unit Cost'],
      ['SC-4400', 'Wool Scarf', 'Grey', '', 'New Jersey Warehouse', 30, 12],
    ],
    Notes: [['Notes'], ['Prices exclude tax']],
  });

  const server = startServer(databasePath);
  await waitForServer();

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  context.setDefaultTimeout(120000);
  context.setDefaultNavigationTimeout(120000);
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  let reviewUrl = null;

  t.after(async () => {
    await context.close();
    await browser.close();
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await t.test('1. a new inventory asks how it is managed today', async () => {
    await register(page, ACCOUNT);
    const text = await page.locator('body').innerText();

    assert.match(text, /Where should Foundry get your inventory from/);
    for (const label of ['Enter it in Foundry', 'Upload files or documents', 'Use email attachments', 'Connect another system', 'Use several sources']) {
      assert.ok(text.includes(label), `the chooser is missing "${label}"`);
    }
    assert.match(text, /Not sure/);
    await shot(page, 'choose-path');
  });

  await t.test('2. choosing spreadsheets asks for the file, not for a description', async () => {
    await Promise.all([
      page.waitForURL(`${BASE}/onboarding/files`),
      page.click('button:has-text("Upload files or documents")'),
    ]);
    const text = await page.locator('body').innerText();
    assert.match(text, /Give Foundry your spreadsheet/);
    assert.match(text, /you do not need to configure anything first/);
    await shot(page, 'files');
  });

  await t.test('3. Foundry reads the workbook and says what it found', async () => {
    await page.setInputFiles('input[name="files"]', file);
    await Promise.all([page.waitForURL(`${BASE}/onboarding/files`), page.click('button:has-text("Add")')]);

    const text = await page.locator('body').innerText();
    assert.match(text, /warehouse\.xlsx/);
    assert.match(text, /products with stock counts/);
    // 18 + 12 + 20 + 24 + 9 + 30, with the stacked header and title rows gone.
    assert.match(text, /113/);
    assert.match(text, /2026-08-14/);
    await shot(page, 'file-understood');
  });

  await t.test('4. Foundry proposes the structure, and normalises what is obvious', async () => {
    await Promise.all([
      page.waitForURL(/\/onboarding\/review\//),
      page.click('button:has-text("Understand my inventory")'),
    ]);
    reviewUrl = page.url();

    const text = await page.locator('body').innerText();
    assert.match(text, /I understand your inventory/);
    assert.match(text, /Brooklyn Warehouse/);
    assert.match(text, /New Jersey Warehouse/);
    // "New Jersey Wrhs" is the same warehouse; nobody is asked about it.
    assert.doesNotMatch(text, /New Jersey Wrhs\n/);
    assert.match(text, /Sorted out without asking you/);

    // Nothing exists yet.
    assert.equal(inspect(databasePath, (db) => db.prepare('SELECT COUNT(*) AS n FROM items').get().n), 0);
    await shot(page, 'review');
  });

  await t.test('5. migrating creates the inventory and reconciles it', async () => {
    await Promise.all([
      page.waitForURL(/\/onboarding\/done\//),
      page.click('button:has-text("Complete migration")'),
    ]);
    const text = await page.locator('body').innerText();

    assert.match(text, /Foundry is ready/);
    assert.match(text, /Inventory totals match the source/);
    assert.match(text, /Reconciliation/);
    await shot(page, 'takeover-report');

    const workspaceId = workspaceIdFor(databasePath, ACCOUNT.workspaceName);
    const totals = inspect(databasePath, (db) => ({
      items: db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspaceId).n,
      units: db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?').get(workspaceId).n,
      locations: db.prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ?').get(workspaceId).n,
      receipts: db
        .prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'receive'")
        .get(workspaceId).n,
      integrity: engine.verifyIntegrity(db, workspaceId).ok,
    }));

    assert.equal(totals.units, 113, 'the source total has to survive the migration');
    assert.equal(totals.items, 4);
    assert.equal(totals.locations, 2, 'the abbreviated warehouse must not become a third location');
    assert.ok(totals.receipts > 0, 'opening stock must exist as real movements');
    assert.equal(totals.integrity, true);
  });

  await t.test('6. the inventory is there, and Foundry does not invent a history', async () => {
    await page.goto(`${BASE}/inventory`);
    const inventory = await page.locator('body').innerText();
    assert.match(inventory, /Navy Oxford/);
    assert.match(inventory, /Coastal Chino/);
    await shot(page, 'inventory-after');

    await page.goto(`${BASE}/attention`);
    const attention = await page.locator('body').innerText();
    // No issues can be measured from opening balances alone, and none are.
    assert.match(attention, /Nothing needs your attention|no shortages/i);
    await shot(page, 'attention-after');
  });

  await t.test('7. it survives a refresh, and re-running the migration changes nothing', async () => {
    await page.reload();
    const workspaceId = workspaceIdFor(databasePath, ACCOUNT.workspaceName);
    const before = inspect(databasePath, (db) => ({
      items: db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspaceId).n,
      units: db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?').get(workspaceId).n,
      movements: db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspaceId).n,
    }));

    // Straight at the endpoint, the way a refreshed POST arrives.
    await page.goto(reviewUrl);
    const token = await page.getAttribute('input[name="_csrf"]', 'value');
    const status = await page.evaluate(
      async ({ url, csrf }) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: `_csrf=${encodeURIComponent(csrf)}`,
        });
        return response.status;
      },
      { url: `${reviewUrl.replace(/\/$/, '')}/migrate`, csrf: token }
    );
    assert.ok(status < 500, `replayed migration returned ${status}`);

    const after = inspect(databasePath, (db) => ({
      items: db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspaceId).n,
      units: db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?').get(workspaceId).n,
      movements: db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspaceId).n,
    }));
    assert.deepEqual(after, before, 'a retried migration must not duplicate anything');
  });

  await t.test('8. no page errors', () => {
    assert.deepEqual(pageErrors, []);
  });
});

// ---------------------------------------------------------------------------

test('Onboarding end to end: the messy customer', { timeout: 600000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-messy-'));
  const databasePath = path.join(dataDir, 'e2e.db');
  const account = { ...ACCOUNT, workspaceName: 'Scattered Supply', email: 'ops@scattered.test' };

  // Four files that overlap and disagree: a duplicate SKU under a different
  // name, a location spelled two ways, and a count that contradicts the export.
  const main = csvFile(path.join(dataDir, 'inventory-main.csv'), [
    'Exported 10 August 2026,,,',
    'SKU,Description,Location,Qty On Hand',
    'OX-1002,Navy Oxford Size 8,Brooklyn Warehouse,18',
    'OX-1003,White Oxford Size 8,Brooklyn Warehouse,20',
    'CH-2001,Coastal Chino,New Jersey Warehouse,24',
  ]);
  const count = csvFile(path.join(dataDir, 'physical-count.csv'), [
    'Physical count 20 August 2026,,,',
    'SKU,Location,Counted',
    'OX-1002,Brooklyn Whse,14',
    'OX-1003,Brooklyn Whse,20',
  ]);
  const old = csvFile(path.join(dataDir, 'old-products.csv'), [
    'SKU,Description',
    'OX-1002,Oxford Navy 8',
    'SH-9000,Discontinued Sandal',
  ]);
  const extra = csvFile(path.join(dataDir, 'warehouse-count.csv'), [
    'SKU,Location,Qty',
    'CH-2001,New Jersey Whse,24',
  ]);

  const server = startServer(databasePath);
  await waitForServer();

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  context.setDefaultTimeout(120000);
  context.setDefaultNavigationTimeout(120000);
  const page = await context.newPage();

  t.after(async () => {
    await context.close();
    await browser.close();
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await t.test('1. four overlapping files go in together', async () => {
    await register(page, account);
    await Promise.all([
      page.waitForURL(/\/onboarding\/files/),
      page.click('button:has-text("Use several sources")'),
    ]);
    assert.match(await page.locator('body').innerText(), /Give Foundry everything you have/);

    await page.setInputFiles('input[name="files"]', [main, count, old, extra]);
    await Promise.all([page.waitForURL(/\/onboarding\/files/), page.click('button:has-text("Add")')]);

    const text = await page.locator('body').innerText();
    for (const name of ['inventory-main.csv', 'physical-count.csv', 'old-products.csv', 'warehouse-count.csv']) {
      assert.ok(text.includes(name), `${name} is missing from the list`);
    }
    await shot(page, 'messy-files');
  });

  await t.test('2. Foundry surfaces the real conflicts and settles the rest itself', async () => {
    await Promise.all([
      page.waitForURL(/\/onboarding\/review\//),
      page.click('button:has-text("Understand my inventory")'),
    ]);
    const text = await page.locator('body').innerText();

    assert.match(text, /worth checking/);
    // The location spellings are handled without anybody being asked.
    assert.match(text, /Sorted out without asking you/);
    // The quantity disagreement is a real one and is shown with both figures.
    assert.match(text, /18/);
    assert.match(text, /14/);
    await shot(page, 'messy-conflicts');
  });

  await t.test('3. the customer settles what only they can', async () => {
    // Foundry recommends where the files establish an answer; the rest wait.
    const accept = page.locator('button:has-text("Accept everything Foundry recommended")');
    if (await accept.count()) {
      await Promise.all([page.waitForURL(/\/onboarding\/review\//), accept.click()]);
    }

    // Anything still open has no recommendation — decide it as a person would.
    for (let guard = 0; guard < 10; guard += 1) {
      const buttons = page.locator('form[action*="/onboarding/conflicts/"] button');
      if (!(await buttons.count())) break;
      await Promise.all([page.waitForURL(/\/onboarding\/review\//), buttons.first().click()]);
    }
    await shot(page, 'messy-decided');

    const migrate = page.locator('button:has-text("Complete migration")');
    assert.equal(await migrate.isDisabled(), false, 'everything is settled, so the migration can run');
  });

  await t.test('4. the consolidated inventory reconciles, and the sources are kept', async () => {
    await Promise.all([
      page.waitForURL(/\/onboarding\/done\//),
      page.click('button:has-text("Complete migration")'),
    ]);
    await shot(page, 'messy-report');

    const workspaceId = workspaceIdFor(databasePath, account.workspaceName);
    const state = inspect(databasePath, (db) => ({
      locations: db
        .prepare('SELECT name FROM locations WHERE workspace_id = ? ORDER BY name')
        .all(workspaceId)
        .map((row) => row.name),
      items: db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspaceId).n,
      sources: db.prepare('SELECT COUNT(*) AS n FROM migration_sources WHERE workspace_id = ?').get(workspaceId).n,
      hashes: db
        .prepare('SELECT COUNT(DISTINCT content_hash) AS n FROM migration_sources WHERE workspace_id = ?')
        .get(workspaceId).n,
      integrity: engine.verifyIntegrity(db, workspaceId).ok,
    }));

    // Two warehouses, however many ways the files spelled them.
    assert.deepEqual(state.locations, ['Brooklyn Warehouse', 'New Jersey Warehouse']);
    assert.ok(state.items >= 3, `expected the consolidated catalog, got ${state.items} products`);
    assert.equal(state.sources, 4, 'every file is kept as evidence');
    assert.equal(state.hashes, 4, 'each source is recorded under its own hash');
    assert.equal(state.integrity, true);
  });
});
