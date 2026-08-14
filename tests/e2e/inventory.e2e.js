'use strict';

/**
 * The Mission 1 acceptance run, in a real browser, from an empty database.
 *
 * It starts its own server process, signs up, builds one item of each
 * archetype, exercises every operation, then reloads and restarts to prove the
 * numbers are stored rather than remembered. Screenshots land in
 * artifacts/screenshots so the run can be reviewed afterwards.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'artifacts', 'screenshots', 'e2e');
const PORT = Number(process.env.E2E_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;

const ACCOUNT = {
  workspaceName: 'Harbour Supply',
  name: 'Alex Kim',
  email: 'alex@harbour.test',
  password: 'harbour-2026',
};

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
      SESSION_SECRET: 'e2e-fixed-secret',
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
    } catch {
      /* not up yet */
    }
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
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

// --- page helpers ----------------------------------------------------------

async function signIn(page, email = ACCOUNT.email, password = ACCOUNT.password) {
  await page.goto(`${BASE}/login`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/`);
}

async function addLocation(page, name, kind) {
  await page.goto(`${BASE}/locations`);
  await page.click('button[data-modal-open="modal-location"]');
  const dialog = page.locator('#modal-location');
  await dialog.locator('#location-name').fill(name);
  await dialog.locator('#location-kind').selectOption(kind);
  await dialog.locator('button[type=submit]').click();
  await page.waitForURL(`${BASE}/locations`);
  await assertVisibleText(page, name);
}

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
  // Scoped to the form: the app shell also contains a sign-out submit button.
  await page.click('form[action="/inventory"] button[type=submit]');
  await page.waitForURL(/\/inventory\/item_/);
  return page.url();
}

async function openAction(page, action) {
  await page.click(`button[data-modal-open="modal-${action}"]`);
  await page.waitForSelector(`#modal-${action}[open]`);
  return page.locator(`#modal-${action}`);
}

/** Selects a variant inside a modal by its human label. */
async function selectSku(dialog, label) {
  const value = await dialog
    .locator('select[name="skuId"] option')
    .filter({ hasText: label })
    .first()
    .getAttribute('value');
  await dialog.locator('select[name="skuId"]').selectOption(value);
}

async function submitAction(page, dialog) {
  await Promise.all([page.waitForNavigation(), dialog.locator('button[type=submit]').click()]);
}

/** Total on hand shown at the top of an item page. */
async function itemTotal(page) {
  return Number((await page.locator('.item-total .value').innerText()).replace(/[^\d-]/g, ''));
}

/** Per-location total from the "Where it is" panel. */
async function locationTotal(page, locationName) {
  const bar = page.locator('.location-bar').filter({ hasText: locationName });
  if ((await bar.count()) === 0) return 0;
  return Number((await bar.first().locator('.value').innerText()).replace(/[^\d-]/g, ''));
}

async function rowQuantity(page, rowText) {
  const row = page.locator('tbody tr').filter({ hasText: rowText }).first();
  const cell = row.locator('td.cell-end strong, td.right strong').last();
  return Number((await cell.innerText()).replace(/[^\d-]/g, ''));
}

async function assertVisibleText(page, text) {
  await page.locator(`text=${text}`).first().waitFor({ state: 'visible', timeout: 5000 });
}

// --- the run ---------------------------------------------------------------

test('Mission 1 end to end, from a clean database', { timeout: 240000 }, async (t) => {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-e2e-'));
  const databasePath = path.join(dataDir, 'e2e.db');
  assert.equal(fs.existsSync(databasePath), false, 'the run starts with no database at all');

  let server = startServer(databasePath);
  await waitForServer();

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('requestfailed', (req) => {
    // Navigations aborted by a redirect are normal; anything else is not.
    if (!['aborted', 'canceled'].includes(String(req.failure() && req.failure().errorText))) {
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure().errorText}`);
    }
  });

  const state = {};

  t.after(async () => {
    await context.close();
    await browser.close();
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await t.test('a new workspace can be created and signed into', async () => {
    await page.goto(`${BASE}/register`);
    await page.fill('#workspaceName', ACCOUNT.workspaceName);
    await page.fill('#name', ACCOUNT.name);
    await page.fill('#email', ACCOUNT.email);
    await page.fill('#password', ACCOUNT.password);
    await page.click('button[type=submit]');

    // Mission 2 puts Foundry first. This run is about the Mission 1 console, so
    // take the documented manual path — which exercises that route too.
    await page.waitForURL(`${BASE}/foundry`);
    await assertVisibleText(page, 'Tell Foundry about');
    await Promise.all([
      page.waitForURL(`${BASE}/locations`),
      page.click('button:has-text("Set it up manually")'),
    ]);

    await page.goto(`${BASE}/`);
    await assertVisibleText(page, 'Start with a location');
    await shot(page, 'empty-overview');

    // Prove real authentication: sign out, then sign back in.
    await page.click('button:has-text("Sign out")');
    await page.waitForURL(/\/login/);
    await signIn(page);
    await assertVisibleText(page, 'Overview');
    await shot(page, 'signed-in');
  });

  await t.test('two locations can be created', async () => {
    await addLocation(page, 'Main Warehouse', 'warehouse');
    await addLocation(page, 'Downtown Store', 'store');
    const rows = await page.locator('tbody tr').count();
    assert.equal(rows, 2);
    await shot(page, 'locations');
  });

  await t.test('quantity item: receive 100', async () => {
    state.elbowUrl = await createItem(page, {
      name: 'Copper Elbow 1/2 in.',
      code: 'CE-100',
      mode: 'quantity',
    });
    await shot(page, 'new-item-created');

    const dialog = await openAction(page, 'receive');
    await dialog.locator('#receive-location').selectOption({ label: 'Main Warehouse' });
    await dialog.locator('#receive-quantity').fill('100');
    await submitAction(page, dialog);

    assert.equal(await itemTotal(page), 100);
    assert.equal(await locationTotal(page, 'Main Warehouse'), 100);
    await shot(page, 'quantity-received');
  });

  await t.test('quantity item: transfer 25 leaves Main 75, Downtown 25, total 100', async () => {
    const dialog = await openAction(page, 'transfer');
    await dialog.locator('#transfer-from').selectOption({ label: 'Main Warehouse' });
    await dialog.locator('#transfer-to').selectOption({ label: 'Downtown Store' });
    await dialog.locator('#transfer-quantity').fill('25');
    await submitAction(page, dialog);

    assert.equal(await locationTotal(page, 'Main Warehouse'), 75);
    assert.equal(await locationTotal(page, 'Downtown Store'), 25);
    assert.equal(await itemTotal(page), 100);
    await shot(page, 'quantity-transferred');
  });

  await t.test('quantity item: issue 5 from Downtown leaves 95', async () => {
    const dialog = await openAction(page, 'issue');
    await dialog.locator('#issue-location').selectOption({ label: 'Downtown Store' });
    await dialog.locator('#issue-quantity').fill('5');
    await dialog.locator('#issue-reason').selectOption('sold');
    await submitAction(page, dialog);

    assert.equal(await locationTotal(page, 'Downtown Store'), 20);
    assert.equal(await itemTotal(page), 95);
  });

  await t.test('quantity item: adjust Main from 75 to 72 with a reason leaves 92', async () => {
    const dialog = await openAction(page, 'adjust');
    await dialog.locator('#adjust-location').selectOption({ label: 'Main Warehouse' });
    assert.equal(await dialog.locator('[data-expected]').inputValue(), '75', 'the app shows what it expects');
    await dialog.locator('#adjust-counted').fill('72');
    await dialog.locator('#adjust-reason').selectOption('physical_count');
    await dialog.locator('#adjust-notes').fill('Quarterly count.');
    await submitAction(page, dialog);

    assert.equal(await locationTotal(page, 'Main Warehouse'), 72);
    assert.equal(await itemTotal(page), 92);
    await assertVisibleText(page, 'Adjusted');
    await shot(page, 'quantity-adjusted');
  });

  await t.test('variant item: two variants are received and stay independent', async () => {
    state.sweaterUrl = await createItem(page, {
      name: "Children's Sweater",
      code: 'CS-200',
      mode: 'quantity',
      options: [
        { name: 'Colour', values: 'Navy, Cream' },
        { name: 'Size', values: '4, 5' },
      ],
    });
    assert.equal(await page.locator('tbody tr').filter({ hasText: '/' }).count() >= 4, true);

    for (const [label, quantity] of [['Navy / 4', '12'], ['Cream / 4', '16']]) {
      const dialog = await openAction(page, 'receive');
      await selectSku(dialog, label);
      await dialog.locator('#receive-location').selectOption({ label: 'Downtown Store' });
      await dialog.locator('#receive-quantity').fill(quantity);
      await submitAction(page, dialog);
    }

    assert.equal(await rowQuantity(page, 'Navy / 4'), 12);
    assert.equal(await rowQuantity(page, 'Cream / 4'), 16);
    assert.equal(await rowQuantity(page, 'Navy / 5'), 0, 'a sibling variant is untouched');
    assert.equal(await itemTotal(page), 28);
    await shot(page, 'variants');
  });

  await t.test('serialized item: two units received, one moved, never in two places', async () => {
    state.laptopUrl = await createItem(page, {
      name: 'Dell Latitude 5450',
      code: 'DL-5450',
      mode: 'serial',
    });

    const receive = await openAction(page, 'receive');
    await receive.locator('#receive-location').selectOption({ label: 'Main Warehouse' });
    await receive.locator('#receive-serials').fill('DL-829193\nDL-829194');
    await submitAction(page, receive);
    assert.equal(await itemTotal(page), 2);

    const transfer = await openAction(page, 'transfer');
    await transfer.locator('#transfer-from').selectOption({ label: 'Downtown Store' });
    assert.equal(
      await transfer.locator('.unit-option:visible').count(),
      0,
      'only units actually at the chosen location may be offered'
    );
    await transfer.locator('#transfer-from').selectOption({ label: 'Main Warehouse' });
    assert.equal(await transfer.locator('.unit-option:visible').count(), 2);
    await transfer.locator('#transfer-to').selectOption({ label: 'Downtown Store' });
    await transfer.locator('.unit-option').filter({ hasText: 'DL-829193' }).locator('input').check();
    await submitAction(page, transfer);

    const movedRow = page.locator('tbody tr').filter({ hasText: 'DL-829193' });
    const stayedRow = page.locator('tbody tr').filter({ hasText: 'DL-829194' });
    assert.equal(await movedRow.count(), 1, 'the serial appears exactly once');
    assert.match(await movedRow.innerText(), /Downtown Store/);
    assert.match(await stayedRow.innerText(), /Main Warehouse/);
    assert.equal(await itemTotal(page), 2, 'moving a unit does not change the total');
    assert.equal(await locationTotal(page, 'Main Warehouse'), 1);
    assert.equal(await locationTotal(page, 'Downtown Store'), 1);
    await shot(page, 'serialized');

    // Receiving the same serial again is refused.
    const duplicate = await openAction(page, 'receive');
    await duplicate.locator('#receive-location').selectOption({ label: 'Main Warehouse' });
    await duplicate.locator('#receive-serials').fill('DL-829193');
    await submitAction(page, duplicate);
    await assertVisibleText(page, 'already in stock');
    assert.equal(await itemTotal(page), 2);
    await shot(page, 'duplicate-serial-refused');
  });

  await t.test('lot item: two lots received, quantity moved from one lot', async () => {
    state.rationUrl = await createItem(page, {
      name: 'Trail Ration Pack',
      code: 'FOOD-200',
      mode: 'lot',
    });

    for (const [code, quantity, expires] of [
      ['L240812', '84', '2026-10-30'],
      ['L240902', '120', '2027-01-15'],
    ]) {
      const dialog = await openAction(page, 'receive');
      await dialog.locator('#receive-location').selectOption({ label: 'Main Warehouse' });
      await dialog.locator('#receive-quantity').fill(quantity);
      await dialog.locator('#receive-lot').fill(code);
      await dialog.locator('#receive-expires').fill(expires);
      await submitAction(page, dialog);
    }

    assert.equal(await itemTotal(page), 204);
    assert.equal(await rowQuantity(page, 'L240812'), 84);
    assert.equal(await rowQuantity(page, 'L240902'), 120);

    const transfer = await openAction(page, 'transfer');
    await transfer.locator('#transfer-from').selectOption({ label: 'Main Warehouse' });
    await transfer.locator('#transfer-to').selectOption({ label: 'Downtown Store' });
    await transfer.locator('#transfer-lot').selectOption({ index: 1 });
    await transfer.locator('#transfer-quantity').fill('24');
    await submitAction(page, transfer);

    assert.equal(await rowQuantity(page, 'L240812'), 84, 'the lot total is unchanged by a move');
    assert.equal(await rowQuantity(page, 'L240902'), 120);
    assert.equal(await itemTotal(page), 204);
    assert.equal(await locationTotal(page, 'Downtown Store'), 24);

    const movedLotRow = page.locator('tbody tr').filter({ hasText: 'L240812' }).first();
    const text = await movedLotRow.innerText();
    assert.match(text, /Main Warehouse\s*60/);
    assert.match(text, /Downtown Store\s*24/);
    await shot(page, 'lots');

    // A lot cannot give up more than it holds.
    const tooMuch = await openAction(page, 'issue');
    await tooMuch.locator('#issue-location').selectOption({ label: 'Downtown Store' });
    await tooMuch.locator('#issue-lot').selectOption({ index: 1 });
    await tooMuch.locator('#issue-quantity').fill('25');
    await submitAction(page, tooMuch);
    await assertVisibleText(page, 'only has 24');
    assert.equal(await itemTotal(page), 204);
  });

  await t.test('search finds items, serials and lots and leads to the record', async () => {
    await page.goto(`${BASE}/inventory`);
    await page.fill('#global-search', 'DL-829193');
    await page.waitForSelector('.search-hit', { timeout: 5000 });
    await shot(page, 'search-typeahead');
    await page.click('.search-hit >> nth=0');
    await page.waitForURL(/\/inventory\/item_/);
    await assertVisibleText(page, 'Dell Latitude 5450');

    await page.goto(`${BASE}/search?q=L240812`);
    await assertVisibleText(page, 'Lot L240812');
    await page.goto(`${BASE}/search?q=Copper`);
    await assertVisibleText(page, 'Copper Elbow');
  });

  await t.test('the activity ledger explains everything that happened', async () => {
    await page.goto(`${BASE}/activity`);
    const body = await page.locator('.ledger').innerText();
    assert.match(body, /Received 100 × Copper Elbow 1\/2 in\. into Main Warehouse\./);
    assert.match(body, /Transferred 25 × Copper Elbow 1\/2 in\. from Main Warehouse to Downtown Store\./);
    assert.match(body, /Adjusted Copper Elbow 1\/2 in\. at Main Warehouse from 75 to 72\./);
    assert.match(body, /Transferred 1 × Dell Latitude 5450 \(DL-829193\) from Main Warehouse to Downtown Store\./);
    assert.match(body, /Physical count/);
    await shot(page, 'activity');

    await page.selectOption('select[name="operation"]', 'adjust');
    await page.waitForLoadState('networkidle');
    const filtered = await page.locator('.ledger').innerText();
    assert.match(filtered, /Adjusted/);
    assert.doesNotMatch(filtered, /Received 100/);
  });

  await t.test('the overview reports the same numbers', async () => {
    await page.goto(`${BASE}/`);
    const text = await page.locator('.stat-grid').innerText();
    assert.match(text, /Tracked items/);
    // 92 elbows + 28 sweaters + 2 laptops + 204 rations
    assert.match(text, /326/);
    await shot(page, 'overview');
  });

  await t.test('refreshing the browser keeps every value', async () => {
    await page.goto(state.elbowUrl);
    await page.reload();
    assert.equal(await itemTotal(page), 92);
    assert.equal(await locationTotal(page, 'Main Warehouse'), 72);
    assert.equal(await locationTotal(page, 'Downtown Store'), 20);

    await page.goto(state.sweaterUrl);
    await page.reload();
    assert.equal(await rowQuantity(page, 'Navy / 4'), 12);
    assert.equal(await rowQuantity(page, 'Cream / 4'), 16);

    await page.goto(state.laptopUrl);
    await page.reload();
    assert.match(await page.locator('tbody tr').filter({ hasText: 'DL-829193' }).innerText(), /Downtown Store/);

    await page.goto(state.rationUrl);
    await page.reload();
    assert.equal(await itemTotal(page), 204);
  });

  await t.test('restarting the server and database keeps every value', async () => {
    await stopServer(server);
    server = startServer(databasePath);
    await waitForServer();

    // The session cookie is still in the browser; the session table survived.
    await page.goto(state.elbowUrl);
    if (page.url().includes('/login')) await signIn(page);
    await page.goto(state.elbowUrl);

    assert.equal(await itemTotal(page), 92);
    assert.equal(await locationTotal(page, 'Main Warehouse'), 72);
    assert.equal(await locationTotal(page, 'Downtown Store'), 20);

    await page.goto(state.rationUrl);
    assert.equal(await rowQuantity(page, 'L240812'), 84);
    assert.match(await page.locator('tbody tr').filter({ hasText: 'L240812' }).first().innerText(), /Downtown Store\s*24/);

    await page.goto(state.laptopUrl);
    assert.match(await page.locator('tbody tr').filter({ hasText: 'DL-829193' }).innerText(), /Downtown Store/);

    await page.goto(`${BASE}/settings`);
    await assertVisibleText(page, 'Every balance matches its movement history');
    await shot(page, 'settings-after-restart');
  });

  await t.test('the critical workflows work on a phone', async () => {
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const mobile = await phone.newPage();
    const mobileErrors = [];
    mobile.on('pageerror', (error) => mobileErrors.push(String(error)));

    await mobile.goto(`${BASE}/login`);
    await mobile.fill('#email', ACCOUNT.email);
    await mobile.fill('#password', ACCOUNT.password);
    await mobile.click('button[type=submit]');
    await mobile.waitForURL(`${BASE}/`);
    await shot(mobile, 'mobile-overview');

    // The bottom navigation is the mobile way around the app.
    assert.equal(await mobile.locator('.mobilenav').isVisible(), true);
    assert.equal(await mobile.locator('.sidebar').isVisible(), false);

    // Search and item lookup.
    await mobile.fill('#global-search', 'CE-100');
    await mobile.waitForSelector('.search-hit');
    await mobile.click('.search-hit >> nth=0');
    await mobile.waitForURL(/\/inventory\/item_/);
    assert.equal(Number((await mobile.locator('.item-total .value').innerText()).replace(/\D/g, '')), 92);
    await shot(mobile, 'mobile-item');

    // Current stock is readable without sideways scrolling.
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    assert.ok(overflow <= 1, `the page must not scroll sideways (overflow ${overflow}px)`);

    // Receiving from a phone.
    await mobile.click('button[data-modal-open="modal-receive"]');
    await mobile.waitForSelector('#modal-receive[open]');
    const dialog = mobile.locator('#modal-receive');
    await dialog.locator('#receive-location').selectOption({ label: 'Downtown Store' });
    await dialog.locator('#receive-quantity').fill('8');
    await shot(mobile, 'mobile-receive');
    await Promise.all([mobile.waitForNavigation(), dialog.locator('button[type=submit]').click()]);
    assert.equal(Number((await mobile.locator('.item-total .value').innerText()).replace(/\D/g, '')), 100);

    // A basic movement from a phone.
    await mobile.click('button[data-modal-open="modal-transfer"]');
    await mobile.waitForSelector('#modal-transfer[open]');
    const move = mobile.locator('#modal-transfer');
    await move.locator('#transfer-from').selectOption({ label: 'Downtown Store' });
    await move.locator('#transfer-to').selectOption({ label: 'Main Warehouse' });
    await move.locator('#transfer-quantity').fill('3');
    await Promise.all([mobile.waitForNavigation(), move.locator('button[type=submit]').click()]);

    const main = mobile.locator('.location-bar').filter({ hasText: 'Main Warehouse' }).first();
    assert.equal(Number((await main.locator('.value').innerText()).replace(/\D/g, '')), 75);
    assert.equal(Number((await mobile.locator('.item-total .value').innerText()).replace(/\D/g, '')), 100);
    await shot(mobile, 'mobile-after-transfer');

    assert.deepEqual(mobileErrors, [], 'no uncaught errors on mobile');
    await phone.close();
  });

  await t.test('the browser reported no blocking errors', async () => {
    assert.deepEqual(pageErrors, [], 'uncaught JavaScript errors');
    assert.deepEqual(failedRequests, [], 'failed network requests');
    const blocking = consoleErrors.filter((message) => !/favicon/i.test(message));
    assert.deepEqual(blocking, [], 'console errors');
  });

  await t.test('inventory integrity holds at the end of the run', async () => {
    await page.goto(`${BASE}/settings`);
    await assertVisibleText(page, 'Every balance matches its movement history');
    console.log(`\nScreenshots: ${SHOTS}`);
  });
});
