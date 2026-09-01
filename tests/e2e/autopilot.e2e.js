'use strict';

/**
 * Mission 8 manager-loop acceptance run, in a real browser, from a clean database.
 *
 * The scenario from the brief: Kids Tights, Black / Size 5, eight left in
 * Brooklyn against sixty-one in New Jersey, with Brooklyn doing all the selling.
 *
 * What is being proved is not that Foundry can move stock — that was Mission 4.
 * It is the order of the gates. A workspace that has approved nothing gets
 * nothing done to it. Approving a policy on its own still gets nothing done.
 * Only with both does Foundry act, and then it has to be able to say what it
 * did, why, and stop when told to. The last run is the one that matters most:
 * pausing mid-flight. Mission 8 adds the primary manager surface and the
 * evidence-backed physical discrepancy that becomes exactly one human exception.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const { openDatabase } = require('../../src/db');
const engine = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const locationService = require('../../src/domain/location-service');
const repo = require('../../src/domain/repository');
const investigations = require('../../src/manager/investigations');
const workItems = require('../../src/autopilot/work-items');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'artifacts', 'screenshots', 'autopilot');
const PORT = Number(process.env.E2E_AUTOPILOT_PORT || 3994);
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = 24 * 60 * 60 * 1000;

const ACCOUNT = {
  workspaceName: 'Little Legs',
  name: 'Marta Okonkwo',
  email: 'marta@littlelegs.test',
  password: 'little-legs-2026',
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
      SESSION_SECRET: 'autopilot-e2e-secret',
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

/** Two warehouses, one of which does all the selling. */
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
      JSON.stringify({ item: 'Style' }),
      JSON.stringify({ adjustmentsRequireReason: true, allowNegativeStock: false, transfersEnabled: true }),
      JSON.stringify({ primaryArchetype: 'quantity', usesVariants: true, serialRules: { enabled: false }, lotRules: { enabled: false } })
    );

    const brooklyn = locationService.createLocation(db, ctx, { name: 'Brooklyn Warehouse', kind: 'warehouse' });
    const jersey = locationService.createLocation(db, ctx, { name: 'New Jersey Warehouse', kind: 'warehouse' });

    const item = itemService.createItem(db, ctx, {
      name: 'Kids Tights',
      baseCode: 'KT-100',
      trackingMode: 'quantity',
      hasVariants: true,
      options: [
        { name: 'Colour', values: 'Black, White' },
        { name: 'Size', values: '2, 5, 8' },
      ],
    });
    const skus = repo.listSkusForItem(db, workspaceId, item.itemId);
    const black5 = skus.find((sku) => sku.variant_label === 'Black / 5');

    engine.receive(db, ctx, { skuId: black5.id, locationId: brooklyn.id, quantity: 26 });
    engine.receive(db, ctx, { skuId: black5.id, locationId: jersey.id, quantity: 65 });

    db.exec('DROP TRIGGER IF EXISTS movements_no_update');
    const backdate = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
    const issue = (locationId, quantity, daysAgo) => {
      const result = engine.issue(db, ctx, { skuId: black5.id, locationId, quantity, reasonCode: 'sold' });
      for (const id of result.movementIds) backdate.run(new Date(Date.now() - daysAgo * DAY).toISOString(), id);
    };
    // Brooklyn sells 18 over the month; New Jersey sells 4. Brooklyn ends on
    // eight and the real 30-day evaluator recommends exactly twelve.
    for (const [quantity, daysAgo] of [[4, 28], [4, 22], [3, 16], [3, 10], [4, 4]]) issue(brooklyn.id, quantity, daysAgo);
    issue(jersey.id, 4, 12);
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
       BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
    );

    return { workspaceId, userId, accountId, skuId: black5.id, brooklyn: brooklyn.id, jersey: jersey.id };
  } finally {
    db.close();
  }
}

async function signIn(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('#email', ACCOUNT.email);
  await page.fill('#password', ACCOUNT.password);
  await page.click('form[action="/login"] button[type=submit]');
  await page.waitForURL(`${BASE}/`);
}

/** Test mode disables the production scheduler; trigger one authenticated turn. */
async function runSchedulerTurn(page) {
  const csrf = await page.locator('input[name="_csrf"]').first().inputValue();
  await Promise.all([
    page.waitForNavigation(),
    page.evaluate((token) => {
      const form = document.createElement('form');
      form.method = 'post';
      form.action = '/autopilot/run';
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = '_csrf';
      input.value = token;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    }, csrf),
  ]);
}

const balance = (databasePath, state, locationId) =>
  inspect(databasePath, (db) => repo.getBalance(db, state.workspaceId, state.skuId, locationId));

// ---------------------------------------------------------------------------

test('Mission 8 end to end: Foundry runs the operation, investigates, and stops when told', { timeout: 1200000 }, async (t) => {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-m7-e2e-'));
  const databasePath = path.join(dataDir, 'e2e.db');
  const state = buildWorkspace(databasePath);

  const server = startServer(databasePath);
  await waitForServer();

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(30000);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  let workPath = null;

  t.after(async () => {
    await stopServer(server);
    await context.close();
    await browser.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await t.test('0. the home page is what Foundry is doing, not a table of counts', async () => {
    await signIn(page);
    const text = await page.locator('body').innerText();
    assert.match(text, /Getting Foundry ready/i);
    assert.match(text, /Do this next/i);
    assert.match(text, /Your business right now/i);
    await shot(page, 'operator-home');
  });

  await t.test('1. with nothing approved, checking now moves nothing', async () => {
    const before = { brooklyn: balance(databasePath, state, state.brooklyn), jersey: balance(databasePath, state, state.jersey) };
    assert.equal(before.brooklyn, 8, 'Brooklyn is down to eight');

    await runSchedulerTurn(page);

    assert.equal(balance(databasePath, state, state.brooklyn), before.brooklyn, 'nothing was authorised, so nothing moved');
    assert.equal(balance(databasePath, state, state.jersey), before.jersey);
    await shot(page, 'nothing-authorised');
  });

  await t.test('2. writing the balancing policy', async () => {
    await page.goto(`${BASE}/autopilot`);
    await page.click('#advanced-authority > summary');
    await page.fill('#advanced-authority form[action="/autopilot/policies"] input[name="maximumQuantity"]', '12');
    await page.click('#advanced-authority form[action="/autopilot/policies"] button[type=submit]');
    await page.waitForURL(/\/autopilot/);
    await shot(page, 'policy-written');

    const text = await page.locator('body').innerText();
    assert.match(text, /not approved|waiting for your approval/i, 'a written policy is not a live one');
  });

  await t.test('3. an approved policy on its own still does nothing', async () => {
    await page.click('form[action$="/approve"] button[type=submit]');
    await page.waitForURL(/\/autopilot/);

    const before = balance(databasePath, state, state.brooklyn);
    await page.goto(`${BASE}/`);
    await runSchedulerTurn(page);

    assert.equal(balance(databasePath, state, state.brooklyn), before, 'still supervised — it prepares, it does not act');

    const text = await page.locator('body').innerText();
    assert.match(text, /need(s)? you/i, 'the prepared transfer is waiting for a person');
    await shot(page, 'prepared-awaiting-approval');
  });

  await t.test('4. Foundry explains the transfer it is proposing, with the numbers', async () => {
    const waiting = inspect(databasePath, (db) =>
      workItems.awaitingApproval(db, state.workspaceId)
        .find((item) => item.category === 'balance_transfer'));
    assert.ok(waiting, 'the supervised run prepared one transfer for approval');
    workPath = `/autopilot/work/${waiting.id}`;
    await page.goto(`${BASE}${workPath}`);

    const text = await page.locator('body').innerText();
    assert.match(text, /Brooklyn Warehouse/);
    assert.match(text, /New Jersey Warehouse/);
    assert.match(text, /What I measured/);
    assert.match(text, /What I checked before doing it/);
    await shot(page, 'why-this-transfer');
  });

  await t.test('5. handing over authority immediately reconsiders and carries out eligible work', async () => {
    const before = { brooklyn: balance(databasePath, state, state.brooklyn), jersey: balance(databasePath, state, state.jersey) };

    await page.goto(`${BASE}/autopilot`);
    await page.click('button[name="mode"][value="POLICY_AUTOMATED"]');
    await page.waitForURL(/\/autopilot/);
    await shot(page, 'mode-run-it');

    assert.equal(balance(databasePath, state, state.brooklyn), before.brooklyn + 12, 'twelve arrived in Brooklyn');
    assert.equal(balance(databasePath, state, state.jersey), before.jersey - 12, 'twelve left New Jersey');
    assert.equal(
      balance(databasePath, state, state.brooklyn) + balance(databasePath, state, state.jersey),
      before.brooklyn + before.jersey,
      'the total did not change — nothing was created'
    );

    await page.goto(`${BASE}${workPath}`);
    const text = await page.locator('body').innerText();
    assert.match(text, /I transferred 12\./);
    assert.doesNotMatch(text, /not verified/);
    await shot(page, 'it-did-it');
  });

  await t.test('6. running again does not move it twice', async () => {
    const before = balance(databasePath, state, state.brooklyn);
    await runSchedulerTurn(page);
    await runSchedulerTurn(page);
    assert.equal(balance(databasePath, state, state.brooklyn), before, 'one shortage is one piece of work');
  });

  await t.test('7. "why did you do that" answers from the record, not from memory', async () => {
    await page.goto(`${BASE}${workPath}`);
    const text = await page.locator('body').innerText();
    assert.match(text, /What I checked afterwards/);
    assert.match(text, /Automatic warehouse balancing/i, 'the policy that authorised it is named');
    assert.match(text, /Total unchanged/i);
    await shot(page, 'after-the-fact');
  });

  await t.test('8. the history page says what happened, in words', async () => {
    await page.goto(`${BASE}/autopilot/history`);
    const text = await page.locator('body').innerText();
    assert.match(text, /Completed automatically/);
    assert.match(text, /Moved 12 Kids Tights/);
    await shot(page, 'history');
  });

  await t.test('9. a physical discrepancy is investigated and becomes exactly one human exception', async () => {
    inspect(databasePath, (db) => {
      const ctx = { workspaceId: state.workspaceId, actorId: state.userId, accountId: state.accountId };
      const expected = repo.getBalance(db, state.workspaceId, state.skuId, state.brooklyn);
      const opened = investigations.openPhysicalCount(db, ctx, { skuId: state.skuId,
        locationId: state.brooklyn, countedQuantity: expected - 3, displayName: 'Kids Tights / Black / 5' });
      investigations.investigate(db, state.workspaceId, opened.investigation.investigationId);
    });
    await page.goto(`${BASE}/`);
    const home = await page.locator('body').innerText();
    assert.match(home, /things? need you/i);
    assert.match(home, /Kids Tights \/ Black \/ 5 does not match the records/i);
    assert.equal(inspect(databasePath, (db) => db.prepare('SELECT COUNT(*) n FROM adjustments WHERE workspace_id = ?').get(state.workspaceId).n), 0,
      'investigation never silently changes the ledger');
    await page.click('a[href^="/investigations/"]');
    const detail = await page.locator('body').innerText();
    assert.match(detail, /Recorded/);
    assert.match(detail, /Counted/);
    assert.match(detail, /Difference/);
    assert.match(detail, /will not invent/i);
    await shot(page, 'physical-discrepancy-investigated');
  });

  await t.test('10. the kill switch stops everything, immediately', async () => {
    await page.goto(`${BASE}/`);
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('form[action="/autopilot/pause"] button[type=submit]');
    await page.waitForURL(`${BASE}/`);

    const text = await page.locator('body').innerText();
    assert.match(text, /Foundry is paused/);
    await shot(page, 'paused');

    // Even asked directly, it does nothing while paused.
    const before = balance(databasePath, state, state.brooklyn);
    await runSchedulerTurn(page);
    assert.equal(balance(databasePath, state, state.brooklyn), before, 'paused means paused');
  });

  await t.test('11. what it already did survives the pause', async () => {
    await page.goto(`${BASE}/autopilot/history`);
    assert.match(await page.locator('body').innerText(), /Moved 12 Kids Tights/);
    assert.deepEqual(pageErrors, [], 'no client-side errors anywhere in the run');
  });
});
