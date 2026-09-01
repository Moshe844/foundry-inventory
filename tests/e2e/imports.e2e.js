'use strict';

/**
 * Mission 5 acceptance run, in a real browser, from an empty inventory.
 *
 * A bakery supplier signs up with nothing in Foundry and an .xlsx exported from
 * whatever they were using before: messy headings, a title row, a blank line, a
 * price column, a location spelled wrong, a row with no quantity and a row with
 * a quantity that is not a number.
 *
 * They upload it, read what Foundry made of it, fix the one thing it could not
 * settle, approve, and end up with a real catalogue and real opening stock —
 * with movements explaining every unit. Then the two things that must not
 * happen: importing it twice, and a second inventory seeing any of it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const config = require('../../src/config');
const { openDatabase } = require('../../src/db');
const authService = require('../../src/domain/auth-service');
const locationService = require('../../src/domain/location-service');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'artifacts', 'screenshots', 'imports');
const PORT = Number(process.env.E2E_IMPORTS_PORT || 3994);
const BASE = `http://127.0.0.1:${PORT}`;

const ACCOUNT = {
  workspaceName: 'Meridian Bakery Supply',
  name: 'Nadia Okafor',
  email: 'nadia@meridianbakery.test',
  password: 'meridian-bakery-2026',
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
      SESSION_SECRET: 'imports-e2e-secret',
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

/** An empty, configured inventory with two real locations and nothing in them. */
function buildWorkspace(databasePath) {
  const db = openDatabase(databasePath);
  try {
    const { accountId, workspaceId, userId } = authService.registerAccount(db, ACCOUNT);
    const ctx = { workspaceId, actorId: userId, accountId };

    db.prepare(
      `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
         operational_defaults, inventory_model, updated_at)
       VALUES (?, datetime('now'), 1, ?, ?, ?, datetime('now'))`
    ).run(
      workspaceId,
      JSON.stringify({ item: 'Product', location: 'Depot' }),
      JSON.stringify({ adjustmentsRequireReason: true, allowNegativeStock: false, transfersEnabled: true }),
      JSON.stringify({ primaryArchetype: 'quantity', usesVariants: false, serialRules: { enabled: false }, lotRules: { enabled: false } })
    );

    const north = locationService.createLocation(db, ctx, { name: 'North Depot', kind: 'warehouse' });
    const south = locationService.createLocation(db, ctx, { name: 'South Depot', kind: 'warehouse' });
    return { workspaceId, accountId, north: north.id, south: south.id };
  } finally {
    db.close();
  }
}

/**
 * The spreadsheet the customer actually has: written by SheetJS, not by the
 * code under test, and deliberately untidy in the ways real exports are.
 */
function writeWorkbook(file) {
  const XLSX = require('xlsx');
  const rows = [
    ['Meridian Bakery Supply — stock on hand', '', '', '', ''],
    ['Exported 12 August 2026', '', '', '', ''],
    ['', '', '', '', ''],
    ['Item Description', 'Item Code', 'Depot', 'Qty On Hand', 'Unit Cost'],
    ['Strong White Flour 16kg', 'FL-16', 'North Depot', 240, 18.4],
    ['Wholemeal Flour 16kg', 'FL-W16', 'North Depot', 120, 19.2],
    ['Caster Sugar 25kg', 'SU-25', 'South Depot', 96, 22.5],
    ['Dark Chocolate Buttons 5kg', 'CH-05', 'South Depot', 44, 41],
    ['Vanilla Extract 1L', 'VA-01', 'Sout Depot', 18, 63],        // misspelled depot
    ['Baking Parchment 500m', 'BP-500', 'North Depot', '', 12],   // no quantity
    ['Almond Flour 5kg', 'AF-05', 'North Depot', 'call', 33],     // not a number
    ['', '', '', '', ''],
    ['Item Description', 'Item Code', 'Depot', 'Qty On Hand', 'Unit Cost'],   // stacked export
    ['Sea Salt Flakes 2kg', 'SS-02', 'North Depot', 60, 9.75],
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Stock On Hand');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Notes'], ['Prices exclude VAT']]), 'Notes');
  fs.writeFileSync(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  return file;
}

test(
  'Mission 5 end to end: a real spreadsheet becomes a real inventory',
  { skip: !config.ai.configured, timeout: 1200000 },
  async (t) => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-m5-e2e-'));
    const databasePath = path.join(dataDir, 'e2e.db');
    const workbookPath = writeWorkbook(path.join(dataDir, 'stock-on-hand.xlsx'));
    const state = buildWorkspace(databasePath);

    const server = startServer(databasePath);
    await waitForServer();

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(30000);
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    let importPath = null;
    let expectedNotFound = null;

    t.after(async () => {
      await stopServer(server);
      await context.close();
      await browser.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    await t.test('0. sign in to an inventory with nothing in it', async () => {
      await page.goto(`${BASE}/login`);
      await page.fill('#email', ACCOUNT.email);
      await page.fill('#password', ACCOUNT.password);
      await page.click('form[action="/login"] button[type=submit]');
      await page.waitForURL(`${BASE}/`);

      assert.equal(inspect(databasePath, (db) => db.prepare('SELECT COUNT(*) AS n FROM items').get().n), 0);
      await shot(page, 'empty-inventory');
    });

    await t.test('1. upload the spreadsheet', async () => {
      await page.goto(`${BASE}/imports`);
      await shot(page, 'import-start');

      await page.setInputFiles('input[name="file"]', workbookPath);
      await Promise.all([
        page.waitForURL(/\/imports\/imp_/),
        page.click('button:has-text("Read the file")'),
      ]);
      importPath = new URL(page.url()).pathname;
      await shot(page, 'preview');
    });

    await t.test('2. Foundry says what it read, and has created nothing', async () => {
      const text = await page.locator('body').innerText();

      // The title rows, the blank lines and the repeated header are gone; the
      // Notes sheet was not mistaken for the data.
      assert.match(text, /8 rows read/, text.slice(0, 800));
      assert.match(text, /Item Description/);
      assert.match(text, /Qty On Hand/);
      // The price column is named as something deliberately left out.
      assert.match(text, /Unit Cost[\s\S]{0,120}does not track/i);
      // The row with no number, and the row that says "call".
      assert.match(text, /not a number Foundry can count/);
      assert.match(text, /no opening stock/);
      // The misspelled depot is either corrected in front of them or asked about.
      assert.match(text, /Sout Depot/);

      assert.equal(inspect(databasePath, (db) => db.prepare('SELECT COUNT(*) AS n FROM items').get().n), 0);
      assert.equal(inspect(databasePath, (db) => db.prepare('SELECT COUNT(*) AS n FROM movements').get().n), 0);
    });

    await t.test('3. approve, and watch it run', async () => {
      await Promise.all([
        page.waitForURL(/approved=1/),
        page.click('button:has-text("Approve")'),
      ]);
      await shot(page, 'approved');

      await Promise.all([
        page.waitForURL((url) => url.pathname === importPath && !url.search.includes('approved')),
        page.click('button:has-text("Import it")'),
      ]);
      await page.waitForLoadState('networkidle');
      await shot(page, 'imported');

      const text = await page.locator('body').innerText();
      assert.match(text, /products created/);
      assert.match(text, /units established/);
      assert.match(text, /Verified against your inventory/);
    });

    await t.test('4. the stock is real, and every unit has a movement', async () => {
      const rows = inspect(databasePath, (db) => ({
        items: db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(state.workspaceId).n,
        units: db
          .prepare(`SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?`)
          .get(state.workspaceId).n,
        receipts: db
          .prepare(
            `SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'receive'
               AND reference LIKE 'import:%'`
          )
          .get(state.workspaceId).n,
        north: db
          .prepare(
            `SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ? AND location_id = ?`
          )
          .get(state.workspaceId, state.north).n,
      }));

      // Seven products described, six of them with a usable quantity; the
      // "call" row is not one of them and was never invented.
      assert.equal(rows.items, 7);
      assert.equal(rows.units, 240 + 120 + 96 + 44 + 18 + 60);
      assert.equal(rows.receipts, 6);
      assert.equal(rows.north, 240 + 120 + 60);

      await page.goto(`${BASE}/inventory`);
      await shot(page, 'inventory-after');
      const inventoryText = await page.locator('body').innerText();
      assert.match(inventoryText, /Strong White Flour 16kg/);
      assert.match(inventoryText, /Baking Parchment 500m/);   // created, with no stock

      await page.goto(`${BASE}/activity`);
      await shot(page, 'activity-after');
      assert.match(await page.locator('body').innerText(), /Initial inventory import/i);
    });

    await t.test('5. submitting the import again does not import it again', async () => {
      const before = inspect(databasePath, (db) => ({
        items: db.prepare('SELECT COUNT(*) AS n FROM items').get().n,
        movements: db.prepare('SELECT COUNT(*) AS n FROM movements').get().n,
      }));

      // Straight at the endpoint, the way a refreshed POST arrives.
      await page.goto(`${BASE}${importPath}`);
      const token = await page.getAttribute('input[name="_csrf"]', 'value');
      const status = await page.evaluate(
        async ({ path: target, csrf }) => {
          const response = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: `_csrf=${encodeURIComponent(csrf)}`,
          });
          return response.status;
        },
        { path: `${importPath}/run`, csrf: token }
      );
      assert.ok(status < 500, `replayed run returned ${status}`);

      const after = inspect(databasePath, (db) => ({
        items: db.prepare('SELECT COUNT(*) AS n FROM items').get().n,
        movements: db.prepare('SELECT COUNT(*) AS n FROM movements').get().n,
      }));
      assert.deepEqual(after, before);
    });

    await t.test('6. a second inventory sees none of it', async () => {
      await page.goto(`${BASE}/inventories/new`);
      await page.fill('#name', 'Meridian Coffee');
      await Promise.all([
        page.waitForURL(`${BASE}/onboarding`),
        page.click('button[type=submit]:has-text("Continue with Foundry")'),
      ]);

      await page.goto(`${BASE}/inventory`);
      const text = await page.locator('body').innerText();
      assert.doesNotMatch(text, /Strong White Flour/);

      // The import itself is not reachable from the other inventory either.
      // This 404 is the assertion, so it is not counted as a page fault below.
      expectedNotFound = consoleErrors.length;
      const response = await page.goto(`${BASE}${importPath}`);
      assert.equal(response.status(), 404);
      await shot(page, 'other-inventory');
    });

    await t.test('7. no page errors anywhere in the run', () => {
      assert.deepEqual(pageErrors, []);
      const unexpected = consoleErrors
        .slice(0, expectedNotFound === null ? consoleErrors.length : expectedNotFound)
        .filter((line) => !/favicon/i.test(line));
      assert.deepEqual(unexpected, []);
    });
  }
);

/**
 * The other half of Mission 5: getting data in by describing it.
 *
 * The same bakery, a week later, adding stock the way people actually ask —
 * one product with sizes, several products in one sentence — and finding that
 * Foundry knows how this business counts things without asking, and still
 * creates nothing until it is approved.
 *
 * Runs after the import test, on its own database and its own server.
 */
test(
  'Mission 5 end to end: products described in a sentence',
  { skip: !config.ai.configured, timeout: 1200000 },
  async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-m5-talk-'));
    const databasePath = path.join(dataDir, 'e2e.db');
    const state = buildWorkspace(databasePath);

    const server = startServer(databasePath);
    await waitForServer();

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(30000);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    t.after(async () => {
      await stopServer(server);
      await context.close();
      await browser.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const ask = async (instruction) => {
      await page.goto(`${BASE}/actions`);
      await page.fill('#action-instruction', instruction);
      await Promise.all([
        page.waitForResponse((r) => r.url().endsWith('/foundry/tell') && r.request().method() === 'POST',
          { timeout: 120000 }),
        page.click('button:has-text("Continue")', { noWaitAfter: true }),
      ]);
      await page.waitForLoadState('domcontentloaded');
    };

    const items = () =>
      inspect(databasePath, (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(state.workspaceId).n
      );

    await t.test('0. sign in', async () => {
      await page.goto(`${BASE}/login`);
      await page.fill('#email', ACCOUNT.email);
      await page.fill('#password', ACCOUNT.password);
      await page.click('form[action="/login"] button[type=submit]');
      await page.waitForURL(`${BASE}/`);
      assert.equal(items(), 0);
    });

    await t.test('1. a described product becomes a proposal, not a product', async () => {
      await ask('Add a new product called Sourdough Starter Culture, code SD-01');
      const text = await page.locator('body').innerText();
      assert.match(text, /Foundry is ready to add a product/);
      assert.match(text, /Sourdough Starter Culture/);
      // Not asked how it is counted: the business already answered that once.
      assert.doesNotMatch(text, /serial number\?|how do you track/i);
      assert.equal(items(), 0);
      await shot(page, 'described-product');
    });

    await t.test('2. approving it creates exactly one product', async () => {
      await Promise.all([
        page.waitForLoadState('networkidle'),
        page.click('button:has-text("Approve")'),
      ]);
      assert.equal(items(), 1);

      const created = inspect(databasePath, (db) =>
        db.prepare('SELECT * FROM items WHERE workspace_id = ? AND base_code = ?').get(state.workspaceId, 'SD-01')
      );
      assert.equal(created.name, 'Sourdough Starter Culture');
      assert.equal(created.tracking_mode, 'quantity');    // as this inventory is set up
      await shot(page, 'described-product-created');
    });

    await t.test('3. several products in one sentence become several lines', async () => {
      await ask('Add three products: Rye Flour 16kg, Spelt Flour 16kg and Semolina 10kg');
      const text = await page.locator('body').innerText();
      assert.match(text, /Foundry is ready to make 3 changes/);
      assert.match(text, /Rye Flour 16kg/);
      assert.match(text, /Spelt Flour 16kg/);
      assert.match(text, /Semolina 10kg/);
      assert.equal(items(), 1, 'still nothing created before approval');
      await shot(page, 'three-products');

      await Promise.all([
        page.waitForLoadState('networkidle'),
        page.click('button:has-text("Approve")'),
      ]);
      assert.equal(items(), 4);
      await shot(page, 'three-products-created');
    });

    await t.test('4. a range of sizes is expanded by Foundry, not by the model', async () => {
      await ask('Add Baking Trays in sizes 1 through 6');
      assert.match(await page.locator('body').innerText(), /Foundry is ready to add a product/);
      await Promise.all([
        page.waitForLoadState('networkidle'),
        page.click('button:has-text("Approve")'),
      ]);

      const skus = inspect(databasePath, (db) => {
        const item = db
          .prepare('SELECT * FROM items WHERE workspace_id = ? AND name LIKE ?')
          .get(state.workspaceId, '%Baking Tray%');
        return item
          ? db
              .prepare('SELECT variant_label FROM skus WHERE item_id = ? ORDER BY position')
              .all(item.id)
              .map((row) => row.variant_label)
          : [];
      });
      // Six, with none of them quietly missing.
      assert.deepEqual(skus, ['1', '2', '3', '4', '5', '6']);
      await shot(page, 'sizes-expanded');
    });

    await t.test('5. no page errors', () => {
      assert.deepEqual(pageErrors, []);
    });
  }
);
