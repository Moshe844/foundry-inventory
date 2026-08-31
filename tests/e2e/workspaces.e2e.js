'use strict';

/**
 * Multi-inventory acceptance run, in a real browser, from a clean database,
 * with two real Foundry configurations.
 *
 * Sign up → create "Clothing Business" → configure it through Foundry as
 * variant inventory → add a second inventory → create "Equipment Company" →
 * configure it through Foundry as serialized inventory → switch between them →
 * confirm each has its own configuration, vocabulary, data and intelligence →
 * confirm nothing whatsoever leaks between them.
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
const engine = require('../../src/domain/inventory-engine');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'artifacts', 'screenshots', 'workspaces');
const PORT = Number(process.env.E2E_WORKSPACE_PORT || 3996);
const BASE = `http://127.0.0.1:${PORT}`;

const ACCOUNT = {
  name: 'Rae Bennett',
  email: 'rae@twobusinesses.test',
  password: 'two-businesses-2026',
};

const CLOTHING = {
  name: 'Clothing Business',
  description:
    'We wholesale casual clothing. Every style comes in several colours and sizes, and we count ' +
    'them by the piece. We keep stock in a Brooklyn warehouse and a New Jersey warehouse.',
};

const EQUIPMENT = {
  name: 'Equipment Company',
  description:
    'We hire out construction equipment. Every machine is individually identified by its own ' +
    'serial number, and we need to know which one is at which site and what condition it is in. ' +
    'We work out of a main yard and a service center.',
};

let shotIndex = 0;
async function shot(page, name) {
  shotIndex += 1;
  await page.screenshot({ path: path.join(SHOTS, `${String(shotIndex).padStart(2, '0')}-${name}.png`), fullPage: true });
}

function startServer(databasePath) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_PATH: databasePath,
      SESSION_SECRET: 'workspaces-e2e-secret',
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

/** Creates an item through the real form, exactly as the Mission 1 run does. */
async function createItem(page, { name, code, mode, options }) {
  await page.goto(`${BASE}/inventory/new`);
  await page.fill('#name', name);
  if (code) await page.fill('#baseCode', code);
  await page.check(`input[name="trackingMode"][value="${mode}"]`);
  if (options) {
    await page.check('input[name="hasVariants"]');
    for (let i = 0; i < options.length; i += 1) {
      await page.fill(`input[name="options[${i}][name]"]`, options[i].name);
      await page.fill(`input[name="options[${i}][values]"]`, options[i].values);
    }
  }
  await page.click('form[action="/inventory"] button[type=submit]');
  await page.waitForURL(/\/inventory\/item_/);
  return page.url();
}

/** Describe the business to Foundry and approve whatever it proposes. */
async function configureThroughFoundry(page, description) {
  await page.fill('#description', description);
  await Promise.all([
    page.waitForURL(/\/foundry\/thinking\//, { timeout: 30000 }),
    page.click('button:has-text("Understand my inventory")'),
  ]);
  await page.waitForURL(/\/foundry\/proposal\//);
  await page.click('button:has-text("Configure my inventory")');
  await page.waitForURL(/\/foundry\/ready\//);
}

/** The inventory the console is currently showing, read from the switcher. */
async function currentInventory(page) {
  return (await page.locator('.wsp-switch-text strong').first().innerText()).trim();
}

async function switchTo(page, name) {
  await page.goto(`${BASE}/inventories`);
  const card = page.locator('.wsp-card', { hasText: name });
  // The card for the inventory already open offers "Go to it", not "Open".
  const open = card.locator('button:has-text("Open")');
  if (await open.count()) {
    await open.click();
  } else {
    await card.locator('a:has-text("Go to it")').click();
  }
  await page.waitForURL(`${BASE}/`);
  assert.equal(await currentInventory(page), name);
}

test(
  'Multi-inventory end to end: one account, two completely separate inventories',
  { skip: !config.ai.configured, timeout: 1800000 },
  async (t) => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-wsp-e2e-'));
    const databasePath = path.join(dataDir, 'e2e.db');
    assert.equal(fs.existsSync(databasePath), false, 'the run starts with no database');

    const server = startServer(databasePath);
    await waitForServer();

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    context.setDefaultTimeout(600000);
    context.setDefaultNavigationTimeout(600000);
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    const state = {};

    t.after(async () => {
      await context.close();
      await browser.close();
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    await t.test('1-2. sign up, creating the Clothing Business inventory', async () => {
      await page.goto(`${BASE}/register`);
      await page.fill('#name', ACCOUNT.name);
      await page.fill('#email', ACCOUNT.email);
      await page.fill('#password', ACCOUNT.password);
      await page.click('form[action="/register"] button[type=submit]');
      await page.waitForURL(`${BASE}/inventories`);
      await page.click('a[href="/inventories/new"]');
      await page.waitForURL(`${BASE}/inventories/new`);
      await page.fill('#name', CLOTHING.name);
      await page.click('form[action="/inventories"] button[type=submit]');
      await page.waitForURL(`${BASE}/onboarding`);
      // A new inventory is asked how it is managed today. These customers are
      // starting from nothing, so they take the Starting Fresh path — which is
      // the Mission 2 experience, unchanged.
      await Promise.all([
        page.waitForURL(`${BASE}/foundry/describe`),
        page.click('button:has-text("Enter it in Foundry")'),
      ]);

      assert.equal(await currentInventory(page), CLOTHING.name);
      await shot(page, 'first-inventory-setup');
    });

    await t.test('3. Foundry configures it as variant inventory', async () => {
      await configureThroughFoundry(page, CLOTHING.description);
      await shot(page, 'clothing-configured');

      state.clothingId = inspect(databasePath, (db) =>
        db.prepare('SELECT id FROM workspaces WHERE name = ?').get(CLOTHING.name).id
      );
      const model = inspect(databasePath, (db) =>
        JSON.parse(
          db.prepare('SELECT inventory_model FROM workspace_configuration WHERE workspace_id = ?')
            .get(state.clothingId).inventory_model
        )
      );
      assert.equal(model.usesVariants, true, `clothing should use variants: ${JSON.stringify(model)}`);
      assert.notEqual(model.primaryArchetype, 'serial');

      state.clothingLocations = inspect(databasePath, (db) =>
        db.prepare('SELECT name FROM locations WHERE workspace_id = ?').all(state.clothingId).map((l) => l.name)
      );
      assert.ok(state.clothingLocations.length >= 1);
    });

    await t.test('4-5. add a second inventory: Equipment Company', async () => {
      await page.goto(`${BASE}/inventories`);
      await shot(page, 'inventories-one');
      await page.click('.page-actions a:has-text("New inventory")');
      await page.waitForURL(`${BASE}/inventories/new`);

      await page.fill('#name', EQUIPMENT.name);
      await page.click('button:has-text("Create and set up with Foundry")');
      await page.waitForURL(`${BASE}/onboarding`);
      // A new inventory is asked how it is managed today. These customers are
      // starting from nothing, so they take the Starting Fresh path — which is
      // the Mission 2 experience, unchanged.
      await Promise.all([
        page.waitForURL(`${BASE}/foundry/describe`),
        page.click('button:has-text("Enter it in Foundry")'),
      ]);

      assert.equal(await currentInventory(page), EQUIPMENT.name, 'the new inventory is now open');
      const body = await page.locator('body').innerText();
      assert.match(body, /Give Foundry what you already have/);
      assert.match(body, new RegExp(EQUIPMENT.name));
      assert.match(body, /Nothing here is shared/);
      await shot(page, 'second-inventory-setup');
    });

    await t.test('6. Foundry configures it as serialized inventory', async () => {
      await configureThroughFoundry(page, EQUIPMENT.description);
      await shot(page, 'equipment-configured');

      state.equipmentId = inspect(databasePath, (db) =>
        db.prepare('SELECT id FROM workspaces WHERE name = ?').get(EQUIPMENT.name).id
      );
      const model = inspect(databasePath, (db) =>
        JSON.parse(
          db.prepare('SELECT inventory_model FROM workspace_configuration WHERE workspace_id = ?')
            .get(state.equipmentId).inventory_model
        )
      );
      assert.equal(model.primaryArchetype, 'serial', `equipment should be serialized: ${JSON.stringify(model)}`);
      assert.equal(Boolean(model.serialRules && model.serialRules.enabled), true);
      assert.notEqual(state.clothingId, state.equipmentId);
    });

    await t.test('7. each inventory got a genuinely different configuration', async () => {
      const [clothing, equipment] = inspect(databasePath, (db) =>
        [state.clothingId, state.equipmentId].map((id) =>
          db.prepare('SELECT * FROM workspace_configuration WHERE workspace_id = ?').get(id)
        )
      );

      const clothingModel = JSON.parse(clothing.inventory_model);
      const equipmentModel = JSON.parse(equipment.inventory_model);
      assert.notEqual(clothingModel.primaryArchetype, equipmentModel.primaryArchetype);
      assert.notEqual(clothingModel.usesVariants, equipmentModel.usesVariants);

      // Foundry chose the wording for each business separately.
      const clothingTerms = JSON.parse(clothing.terminology);
      const equipmentTerms = JSON.parse(equipment.terminology);
      assert.notDeepEqual(clothingTerms, equipmentTerms, 'the vocabularies are not the same');

      // And separate locations, which are inside a workspace, not the same thing as one.
      const locations = inspect(databasePath, (db) => ({
        clothing: db.prepare('SELECT name FROM locations WHERE workspace_id = ?').all(state.clothingId).map((l) => l.name),
        equipment: db.prepare('SELECT name FROM locations WHERE workspace_id = ?').all(state.equipmentId).map((l) => l.name),
      }));
      assert.ok(locations.clothing.length >= 1 && locations.equipment.length >= 1);
      assert.equal(
        locations.clothing.filter((n) => locations.equipment.includes(n)).length,
        0,
        'no location object is shared between inventories'
      );
    });

    await t.test('8. build real, different stock in each', async () => {
      // Clothing: a variant item.
      await switchTo(page, CLOTHING.name);
      state.clothingItemUrl = await createItem(page, {
        name: 'Harbour Tee',
        code: 'HT-100',
        mode: 'quantity',
        options: [{ name: 'Colour', values: 'Navy, Cream' }],
      });

      await page.click('button[data-modal-open="modal-receive"]');
      await page.waitForSelector('#modal-receive[open]');
      const dialog = page.locator('#modal-receive');
      await dialog.locator('select[name="skuId"]').selectOption({ index: 0 });
      await dialog.locator('#receive-location').selectOption({ index: 0 });
      await dialog.locator('#receive-quantity').fill('140');
      await dialog.locator('button[type=submit]').click();
      await page.waitForURL(/\/inventory\/item_/);
      await shot(page, 'clothing-stock');

      // Equipment: a serialized item.
      await switchTo(page, EQUIPMENT.name);
      state.equipmentItemUrl = await createItem(page, {
        name: 'Site Generator',
        code: 'SG-200',
        mode: 'serial',
      });

      await page.click('button[data-modal-open="modal-receive"]');
      await page.waitForSelector('#modal-receive[open]');
      const serialDialog = page.locator('#modal-receive');
      await serialDialog.locator('#receive-location').selectOption({ index: 0 });
      await serialDialog.locator('textarea[name="serials"]').fill('SG-0001\nSG-0002\nSG-0003');
      await serialDialog.locator('button[type=submit]').click();
      await page.waitForURL(/\/inventory\/item_/);
      await shot(page, 'equipment-stock');
    });

    await t.test('9. switching shows completely different data', async () => {
      await switchTo(page, CLOTHING.name);
      const clothingBody = await page.locator('body').innerText();
      assert.match(clothingBody, new RegExp(CLOTHING.name));

      await page.goto(`${BASE}/inventory`);
      const clothingItems = await page.locator('body').innerText();
      assert.match(clothingItems, /Harbour Tee/);
      assert.ok(!clothingItems.includes('Site Generator'), 'the other inventory is not here');
      await shot(page, 'clothing-console');

      await switchTo(page, EQUIPMENT.name);
      await page.goto(`${BASE}/inventory`);
      const equipmentItems = await page.locator('body').innerText();
      assert.match(equipmentItems, /Site Generator/);
      assert.ok(!equipmentItems.includes('Harbour Tee'), 'and neither is the first');
      await shot(page, 'equipment-console');

      // Search, activity and locations agree.
      await page.goto(`${BASE}/search?q=Harbour`);
      assert.ok(!(await page.locator('body').innerText()).includes('Harbour Tee'), 'search does not cross over');

      await page.goto(`${BASE}/activity`);
      const activity = await page.locator('body').innerText();
      assert.match(activity, /Site Generator/);
      assert.ok(!activity.includes('Harbour Tee'), 'nor does the ledger');
    });

    await t.test('10. the intelligence layers are separate too', async () => {
      // Each inventory answers about itself, and only about itself.
      await switchTo(page, CLOTHING.name);
      await page.goto(`${BASE}/ask`);
      await page.fill('#ask-question', 'How many harbour tees do we have?');
      await page.locator('[data-ask-form] button[type=submit]').click();
      await page.waitForURL(/\/ask\?q=/);
      const clothingAnswer = await page.locator('body').innerText();
      assert.match(clothingAnswer, /140/);
      await shot(page, 'clothing-ask');

      await switchTo(page, EQUIPMENT.name);
      await page.goto(`${BASE}/ask`);
      await page.fill('#ask-question', 'How many harbour tees do we have?');
      await page.locator('[data-ask-form] button[type=submit]').click();
      await page.waitForURL(/\/ask\?q=/);
      const equipmentAnswer = await page.locator('body').innerText();
      assert.match(equipmentAnswer, /could not find/, 'the other inventory has never heard of it');
      assert.ok(!equipmentAnswer.includes('140'));
      await shot(page, 'equipment-ask');

      // Attention items belong to one inventory each.
      const counts = inspect(databasePath, (db) => ({
        clothing: db.prepare('SELECT COUNT(*) AS n FROM attention_items WHERE workspace_id = ?').get(state.clothingId).n,
        equipment: db.prepare('SELECT COUNT(*) AS n FROM attention_items WHERE workspace_id = ?').get(state.equipmentId).n,
        stray: db.prepare('SELECT COUNT(*) AS n FROM attention_items WHERE workspace_id NOT IN (?, ?)')
          .get(state.clothingId, state.equipmentId).n,
      }));
      assert.equal(counts.stray, 0, 'no finding belongs to nothing');
    });

    await t.test('11. nothing leaks: every scoped table is cleanly divided', async () => {
      const leaks = inspect(databasePath, (db) => {
        const tables = [
          'items', 'skus', 'balances', 'locations', 'movements', 'adjustments',
          'lots', 'serial_units', 'workspace_configuration', 'foundry_understandings',
          'foundry_plans', 'attention_items',
        ];
        const problems = [];
        for (const table of tables) {
          // Every row belongs to exactly one of the two inventories…
          const stray = db
            .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id NOT IN (?, ?)`)
            .get(state.clothingId, state.equipmentId).n;
          if (stray > 0) problems.push(`${table}: ${stray} rows outside both inventories`);
        }

        // …and no SKU, location or movement is reachable from the wrong side.
        const crossedSkus = db
          .prepare(
            `SELECT COUNT(*) AS n FROM balances b JOIN skus s ON s.id = b.sku_id
              WHERE b.workspace_id <> s.workspace_id`
          )
          .get().n;
        if (crossedSkus > 0) problems.push(`balances point at SKUs in another inventory: ${crossedSkus}`);

        const crossedLocations = db
          .prepare(
            `SELECT COUNT(*) AS n FROM balances b JOIN locations l ON l.id = b.location_id
              WHERE b.workspace_id <> l.workspace_id`
          )
          .get().n;
        if (crossedLocations > 0) problems.push(`balances point at locations elsewhere: ${crossedLocations}`);

        const crossedMovements = db
          .prepare(
            `SELECT COUNT(*) AS n FROM movements m JOIN users u ON u.id = m.actor_user_id
              WHERE m.workspace_id <> u.workspace_id`
          )
          .get().n;
        if (crossedMovements > 0) problems.push(`movements attributed across inventories: ${crossedMovements}`);

        return problems;
      });

      assert.deepEqual(leaks, [], 'nothing may cross between inventories');
    });

    await t.test('12. both inventories are internally correct, and the browser is clean', async () => {
      for (const id of [state.clothingId, state.equipmentId]) {
        const result = inspect(databasePath, (db) => engine.verifyIntegrity(db, id));
        assert.equal(result.ok, true, JSON.stringify(result.problems || []));
      }

      const totals = inspect(databasePath, (db) => ({
        clothing: db.prepare('SELECT COALESCE(SUM(on_hand),0) AS n FROM balances WHERE workspace_id = ?').get(state.clothingId).n,
        equipment: db.prepare('SELECT COALESCE(SUM(on_hand),0) AS n FROM balances WHERE workspace_id = ?').get(state.equipmentId).n,
      }));
      assert.equal(totals.clothing, 140);
      assert.equal(totals.equipment, 3);

      await page.goto(`${BASE}/inventories`);
      const listing = await page.locator('body').innerText();
      assert.match(listing, new RegExp(CLOTHING.name));
      assert.match(listing, new RegExp(EQUIPMENT.name));
      assert.match(listing, /140 on hand/);
      assert.match(listing, /3 on hand/);
      await shot(page, 'inventories-both');

      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors.filter((e) => !/favicon/i.test(e)), []);
    });
  }
);
