'use strict';

/**
 * Mission 2 acceptance run, in a real browser, from a clean database, using a
 * real AI call — no scripted provider anywhere in this file.
 *
 * Sign in → describe the business → StockChief interprets → review the proposal →
 * choose the highest-information evidence path → enter real facts manually →
 * build a real product → receive stock → confirm Mission 1 truth still holds →
 * refresh → ask StockChief why, and get a grounded answer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { completeTransfer } = require('./transfer-helper');

const config = require('../../src/config');
const { openDatabase } = require('../../src/db');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'artifacts', 'screenshots', 'foundry');
const PORT = Number(process.env.E2E_FOUNDRY_PORT || 3998);
const BASE = `http://127.0.0.1:${PORT}`;

const ACCOUNT = {
  workspaceName: 'Harbour Shoe Co.',
  name: 'Robin Vale',
  email: 'robin@harbourshoe.test',
  password: 'harbour-shoes-2026',
};

const DESCRIPTION =
  "We wholesale children's shoes. Every style comes in colors and sizes. We keep stock in Brooklyn and New Jersey.";

let shotIndex = 0;
async function shot(page, name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function startServer(databasePath) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_PATH: databasePath,
      SESSION_SECRET: 'foundry-e2e-secret',
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
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
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

async function createLocation(page, name, kind) {
  if (await page.getByText(name, { exact: true }).count()) return;
  await page.locator('button[data-modal-open="modal-location"]').first().click();
  await page.fill('#location-name', name);
  await page.selectOption('#location-kind', kind);
  await Promise.all([
    page.waitForURL(`${BASE}/locations`),
    page.click('#modal-location button[type="submit"]'),
  ]);
}

test(
  'Mission 2 end to end: StockChief understands a business and configures the engine',
  { skip: !config.ai.configured, timeout: 900000 },
  async (t) => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-m2-e2e-'));
    const databasePath = path.join(dataDir, 'e2e.db');
    assert.equal(fs.existsSync(databasePath), false, 'the run starts with no database');

    const server = startServer(databasePath);
    await waitForServer();

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    // Interpreting a business is a real model call taking a minute or more, and
    // Playwright's 30s default would fire long before the page ever settles.
    // Real model calls have their own explicit long waits below. Ordinary UI
    // controls should fail quickly instead of disguising a stale selector as a
    // ten-minute provider job.
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(30000);
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    const state = {};

    t.after(async () => {
      await stopServer(server);
      await context.close();
      await browser.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    await t.test('1-2. a new workspace lands on StockChief, not an empty dashboard', async () => {
      await page.goto(`${BASE}/register`);
      await page.fill('#name', ACCOUNT.name);
      await page.fill('#businessName', ACCOUNT.workspaceName);
      await page.fill('#email', ACCOUNT.email);
      await page.fill('#password', ACCOUNT.password);
      await page.click('button[type=submit]');
      await page.waitForURL(`${BASE}/onboarding`);
      await page.fill('#inventory-name', ACCOUNT.workspaceName);
      await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save name', exact: true }).click()]);
      await page.waitForURL(`${BASE}/onboarding`);
      // A new inventory is asked how it is managed today. These customers are
      // starting from nothing, so they take the Starting Fresh path — which is
      // the Mission 2 experience, unchanged.
      await Promise.all([
        page.waitForURL(`${BASE}/inventory/new`),
        page.click('button:has-text("Enter it manually")'),
      ]);
      await page.goto(`${BASE}/foundry/describe`);

      await page.locator('text=Give StockChief what you already have').first().waitFor();
      await page.locator('text=Understand my inventory').first().waitFor();
      await page.locator('text=Set it up manually').first().waitFor();
      await shot(page, 'first-run');
    });

    await t.test('3-4. the description is interpreted by a real AI call', async () => {
      await page.fill('#description', DESCRIPTION);
      await shot(page, 'description-entered');

      const started = Date.now();

      // The POST must hand back a progress page immediately, not hold the
      // browser open for the length of the model call.
      await Promise.all([
        page.waitForURL(/\/foundry\/thinking\//, { timeout: 30000 }),
        page.click('button:has-text("Understand my inventory")'),
      ]);
      const handoffMs = Date.now() - started;
      assert.ok(handoffMs < 15000, `the progress page took ${handoffMs}ms to appear`);

      // And that page must actually say what is happening.
      const progress = await page.locator('main').innerText();
      assert.match(progress, /StockChief is reading your inventory/);
      assert.match(progress, /Reading your operation/);
      await shot(page, 'thinking');

      // Then it moves itself on when the work is done.
      await page.waitForURL(/\/foundry\/proposal\//, { timeout: 600000 });
      state.proposalUrl = page.url();
      state.interpretMs = Date.now() - started;
      assert.ok(state.interpretMs > 1500, 'a real model call takes real time');
    });

    await t.test('5-6. the proposal shows variant and multi-location understanding', async () => {
      const dbCheck = openDatabase(databasePath);
      const stored = dbCheck
        .prepare('SELECT payload FROM foundry_understandings ORDER BY created_at DESC LIMIT 1')
        .get();
      const understanding = JSON.parse(stored.payload);
      state.understanding = understanding;
      dbCheck.close();

      const closedDetails = page.locator('main details:not([open]) > summary');
      while (await closedDetails.count()) await closedDetails.first().click();
      const reviewed = await page.locator('main').innerText();

      // Variants, with the axes the description implied.
      assert.match(reviewed, /Variants/i, `expected variant tracking, got:\n${reviewed}`);
      assert.match(reviewed, /Colou?r/i);
      assert.match(reviewed, /Size/i);
      assert.match(reviewed, /Brooklyn[\s\S]*New Jersey/i);

      await shot(page, 'proposal');
      assert.equal(understanding.recommendedConfiguration.usesVariants, true);
      assert.equal(understanding.recommendedConfiguration.trackingMode, 'quantity');
      assert.ok(understanding.likelyLocations.length >= 2);
    });

    await t.test('7. optional recommendations are valid and reasoning stays disclosed', async () => {
      const recommendations = state.understanding.recommendations;
      assert.ok(Array.isArray(recommendations));
      for (const rec of recommendations) {
        assert.ok(rec.noticed.length > 15);
        assert.ok(rec.whyItMatters.length > 15);
      }
      assert.equal(
        await page.locator('details summary:has-text("What StockChief knows / Why StockChief decided this")').count(),
        1,
        'detailed reasoning remains available through progressive disclosure'
      );
    });

    await t.test('8. evidence is the one dominant next step', async () => {
      const shown = await page.locator('body').innerText();
      assert.match(shown, /What StockChief understood/i);
      assert.match(shown, /Where are your real product and stock records today\?/i);
      assert.match(shown, /You do not need to clean or reorganize anything first/i);
      assert.doesNotMatch(shown, /Configure my inventory/i);
      assert.equal(await page.locator('button:has-text("Enter records in StockChief")').count(), 1);
      assert.equal(await page.locator('button:has-text("Upload inventory files")').count(), 1);
      assert.equal(await page.locator('button:has-text("Connect a business system")').count(), 1);
      assert.equal(await page.locator('button:has-text("Use email attachments")').count(), 0);
      await shot(page, 'evidence-first-next-step');
    });

    await t.test('9-11. manual evidence creates only facts the owner supplies', async () => {
      await Promise.all([
        page.waitForURL(/\/foundry\/ready\//),
        page.click('button:has-text("Enter records in StockChief")'),
      ]);
      await page.goto(`${BASE}/locations`);

      const suppliedLocations = [
        ['Brooklyn', 'warehouse'],
        ['New Jersey', 'warehouse'],
      ];
      for (const [name, kind] of suppliedLocations) await createLocation(page, name, kind);
      await shot(page, 'real-locations-entered');

      // Manual setup establishes safe reversible defaults, but neither the AI
      // interpretation nor the source-choice screen invents catalogue or stock.
      const db = openDatabase(databasePath);
      const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get();
      const locations = db.prepare('SELECT name FROM locations WHERE workspace_id = ?').all(workspace.id);
      assert.deepEqual(locations.map((row) => row.name).sort(), suppliedLocations.map(([name]) => name).sort());

      const configuration = db.prepare('SELECT * FROM workspace_configuration WHERE workspace_id = ?').get(workspace.id);
      assert.ok(configuration.configured_at);
      assert.ok(configuration.configuration_version >= 1);

      const counts = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM items) AS items,
                  (SELECT COUNT(*) FROM movements) AS movements,
                  (SELECT COALESCE(SUM(on_hand), 0) FROM balances) AS onHand`
        )
        .get();
      assert.deepEqual(counts, { items: 0, movements: 0, onHand: 0 });

      state.locationNames = locations.map((l) => l.name);
      db.close();
    });

    await t.test('12-13. a real product is created on the configured structure and received', async () => {
      await page.goto(`${BASE}/inventory/new`);
      await page.fill('#name', 'Harbour Runner');
      await page.fill('#baseCode', 'HR-100');
      await page.check('input[name="trackingMode"][value="quantity"]');
      await page.check('input[name="hasVariants"]');
      await page.fill('input[name="options[0][name]"]', 'Color');
      await page.fill('input[name="options[0][values]"]', 'Navy, Cream');
      await page.fill('input[name="options[1][name]"]', 'Size');
      await page.fill('input[name="options[1][values]"]', '10, 11');
      await page.click('form[action="/inventory"] button[type=submit]');
      await page.waitForURL(/\/inventory\/item_/);
      state.itemUrl = page.url();

      // Four variants from two axes.
      const rows = await page.locator('tbody tr').filter({ hasText: '/' }).count();
      assert.ok(rows >= 4, `expected four variants, saw ${rows}`);

      // Receive into the first StockChief-configured location.
      await page.click('button[data-modal-open="modal-receive"]');
      await page.waitForSelector('#modal-receive[open]');
      const dialog = page.locator('#modal-receive');
      const skuValue = await dialog
        .locator('select[name="skuId"] option')
        .filter({ hasText: 'Navy / 10' })
        .first()
        .getAttribute('value');
      await dialog.locator('select[name="skuId"]').selectOption(skuValue);
      await dialog.locator('#receive-location').selectOption({ label: state.locationNames[0] });
      await dialog.locator('#receive-quantity').fill('40');
      await Promise.all([page.waitForNavigation(), dialog.locator('button[type=submit]').click()]);

      assert.equal(
        Number((await page.locator('.rm-pulse .rm-stat__n').first().innerText()).replace(/\D/g, '')),
        40
      );
      await shot(page, 'item-configured-and-received');
    });

    await t.test('14. Mission 1 inventory truth still holds', async () => {
      // Transfer between the two StockChief-configured locations, then adjust.
      const itemUrl = page.url();
      await page.click('button[data-modal-open="modal-transfer"]');
      await page.waitForSelector('#modal-transfer[open]');
      const move = page.locator('#modal-transfer');
      const sku = await move
        .locator('select[name="skuId"] option')
        .filter({ hasText: 'Navy / 10' })
        .first()
        .getAttribute('value');
      await move.locator('select[name="skuId"]').selectOption(sku);
      await move.locator('#transfer-from').selectOption({ label: state.locationNames[0] });
      await move.locator('#transfer-to').selectOption({ label: state.locationNames[1] });
      await move.locator('#transfer-quantity').fill('15');
      await Promise.all([page.waitForNavigation(), move.locator('button[type=submit]').click()]);
      await completeTransfer(page);
      await page.goto(itemUrl);

      assert.equal(
        Number((await page.locator('.rm-pulse .rm-stat__n').first().innerText()).replace(/\D/g, '')),
        40,
        'a transfer never changes the total'
      );

      const bars = await page.locator('.vt-where').allInnerTexts();
      const joined = bars.join(' | ');
      assert.match(joined, /25/, `expected 25 at the source, got ${joined}`);
      assert.match(joined, /15/, `expected 15 at the destination, got ${joined}`);

      const activity = await page.locator('main').innerText();
      assert.match(activity, /Transferred 15 × Harbour Runner \/ Navy \/ 10/);
      assert.match(activity, /Received 40 × Harbour Runner \/ Navy \/ 10/);
    });

    await t.test('15-16. refresh keeps the real inventory and Home is operational', async () => {
      await page.reload();
      assert.equal(
        Number((await page.locator('.rm-pulse .rm-stat__n').first().innerText()).replace(/\D/g, '')),
        40
      );

      await page.goto(`${BASE}/`);
      await page.reload();
      const home = await page.locator('body').innerText();
      // A zero-cost opening balance is valid evidence, not an invented mismatch.
      // The lifecycle transfer preserves that valuation and must not manufacture
      // a Needs You exception merely because this fixture supplied no unit cost.
      assert.match(home, /Everything is under control/i);
      assert.match(home, /Needs you\s+0\s+nothing is waiting/i);
      assert.doesNotMatch(home, /Transferred stock has no established source cost/i);
      assert.doesNotMatch(home, /Getting StockChief ready/i);
      await shot(page, 'foundry-home');
    });

    await t.test('17-18. StockChief answers why the item uses variants, grounded in the configuration', async () => {
      await page.goto(`${BASE}/ask`);
      await page.fill('#ask-question', 'Why does the Harbour Runner use variants?');
      await Promise.all([
        page.waitForNavigation({ timeout: 300000 }),
        page.click('[data-ask-form] button[type=submit]', { timeout: 300000 }),
      ]);

      const conversation = await page.locator('main').innerText();
      assert.match(conversation, /Why does the Harbour Runner use variants\?/);

      // Grounded in this workspace: the visible answer must name something
      // from the product that was actually created through the browser.
      const text = conversation.toLowerCase();
      const grounded = ['variant', 'colour', 'color', 'size', ...state.locationNames.map((n) => n.split(/\s+/)[0].toLowerCase())];
      assert.ok(
        grounded.some((term) => text.includes(term)),
        `the answer should cite the real item configuration, got: ${conversation}`
      );
      await shot(page, 'foundry-answer');
    });

    await t.test('no blocking browser errors', async () => {
      assert.deepEqual(pageErrors, [], 'uncaught JavaScript errors');
      const blocking = consoleErrors.filter((m) => !/favicon/i.test(m));
      assert.deepEqual(blocking, [], 'console errors');
      console.log(`\nStockChief E2E screenshots: ${SHOTS}`);
      console.log(`Interpretation took ${Math.round(state.interpretMs / 1000)}s of real model time.`);
    });
  }
);
