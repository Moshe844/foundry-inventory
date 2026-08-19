'use strict';

/**
 * Mission 3 acceptance run, in a real browser, from a clean database, against a
 * real server with a real AI call for the language layers.
 *
 * Register → configure through Foundry → build real inventory and trade it →
 * let the operator detect what is wrong → read the briefing → open the evidence
 * → act on the inventory and watch the item resolve itself → ask a question →
 * ask one Foundry cannot answer → give feedback → confirm Mission 1 truth is
 * untouched throughout.
 *
 * The second half re-runs the operator against a completely different business
 * shape (serialized equipment) to prove the categories follow the business.
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
const attention = require('../../src/attention/attention-engine');
const reevaluate = require('../../src/attention/reevaluate');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'artifacts', 'screenshots', 'attention');
const PORT = Number(process.env.E2E_ATTENTION_PORT || 3997);
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = 24 * 60 * 60 * 1000;

const ACCOUNT = {
  workspaceName: 'Kestrel Trading Co.',
  name: 'Mo Idris',
  email: 'mo@kestrel.test',
  password: 'kestrel-ops-2026',
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
      SESSION_SECRET: 'attention-e2e-secret',
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

/**
 * Trading history, written through the engine from a separate connection and
 * then back-dated. The server is running against the same file; only
 * `occurred_at` is rewritten, so every balance stays the engine's own.
 */
function tradeHistory(databasePath, build) {
  const db = openDatabase(databasePath);
  try {
    return build(db, (days, operation, ctx, input) => {
      const result = engine[operation](db, ctx, input);
      const when = new Date(Date.now() - days * DAY).toISOString();
      db.exec('DROP TRIGGER IF EXISTS movements_no_update');
      const stmt = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
      const adj = db.prepare('UPDATE adjustments SET created_at = ? WHERE movement_id = ?');
      for (const id of result.movementIds) {
        stmt.run(when, id);
        adj.run(when, id);
      }
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS movements_no_update
         BEFORE UPDATE ON movements
         BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
      );
      return result;
    });
  } finally {
    db.close();
  }
}

function inspect(databasePath, fn) {
  const db = openDatabase(databasePath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test(
  'Mission 3 end to end: Foundry operates the inventory it configured',
  { skip: !config.ai.configured, timeout: 1200000 },
  async (t) => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-m3-e2e-'));
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

    await t.test('1. a new workspace is configured through Foundry', async () => {
      await page.goto(`${BASE}/register`);
      await page.fill('#name', ACCOUNT.name);
      await page.fill('#email', ACCOUNT.email);
      await page.fill('#password', ACCOUNT.password);
      // The register page has no sidebar, so this is unambiguous.
      await page.click('form[action="/register"] button[type=submit]');
      await page.waitForURL(`${BASE}/inventories`);
      await page.click('a[href="/inventories/new"]');
      await page.waitForURL(`${BASE}/inventories/new`);
      await page.fill('#name', ACCOUNT.workspaceName);
      await page.click('form[action="/inventories"] button[type=submit]');
      await page.waitForURL(`${BASE}/onboarding`);
      // A new inventory is asked how it is managed today. These customers are
      // starting from nothing, so they take the Starting Fresh path — which is
      // the Mission 2 experience, unchanged.
      await Promise.all([
        page.waitForURL(`${BASE}/foundry/describe`),
        page.click('button:has-text("Starting fresh")'),
      ]);

      await page.fill(
        '#description',
        'We supply plumbing parts to trade customers. We keep stock in a warehouse and a trade counter, ' +
          'and we run a van for callouts. We count everything by the unit.'
      );
      // Never a bare button[type=submit] on a signed-in page: the sidebar's
      // Sign out form comes first in the document.
      await Promise.all([
        page.waitForURL(/\/foundry\/thinking\//, { timeout: 30000 }),
        page.click('button:has-text("Understand my inventory")'),
      ]);
      await page.waitForURL(/\/foundry\/proposal\//);
      await shot(page, 'proposal');

      await page.click('button:has-text("Configure my inventory")');
      await page.waitForURL(/\/foundry\/ready\//);

      state.workspaceId = inspect(databasePath, (db) =>
        db.prepare('SELECT workspace_id FROM workspace_configuration LIMIT 1').get().workspace_id
      );
      // The login lives on the account; the membership is what a movement is
      // attributed to, so the ledger keeps naming the right person per inventory.
      state.ownerId = inspect(databasePath, (db) =>
        db
          .prepare(
            `SELECT u.id FROM users u JOIN accounts a ON a.id = u.account_id
              WHERE a.email = ? AND u.workspace_id = ?`
          )
          .get(ACCOUNT.email, state.workspaceId).id
      );
      assert.ok(state.workspaceId);
    });

    await t.test('2. an empty workspace is told plainly that nothing is wrong', async () => {
      await page.goto(`${BASE}/attention`);
      await page.locator('text=Nothing needs your attention').first().waitFor();
      await shot(page, 'all-clear');

      const cards = await page.locator('.att-card').count();
      assert.equal(cards, 0, 'no invented problems on an empty workspace');
    });

    await t.test('3. real trading history produces real findings', async () => {
      const built = tradeHistory(databasePath, (db, at) => {
        const ctx = { workspaceId: state.workspaceId, actorId: state.ownerId };
        const itemService = require('../../src/domain/item-service');
        const repo = require('../../src/domain/repository');
        const locations = repo.listLocations(db, state.workspaceId);
        const primary = locations[0];
        const secondary = locations[1] || locations[0];

        const valve = itemService.createItem(db, ctx, {
          name: 'Brass Gate Valve 22mm',
          baseCode: 'BGV-22',
          trackingMode: 'quantity',
        });
        const valveSku = repo.listSkusForItem(db, state.workspaceId, valve.itemId)[0];
        at(60, 'receive', ctx, { skuId: valveSku.id, locationId: primary.id, quantity: 200, reference: 'PO-9001' });
        for (let i = 0; i < 7; i += 1) {
          at(27 - i * 4, 'issue', ctx, {
            skuId: valveSku.id,
            locationId: primary.id,
            quantity: 27,
            reasonCode: 'sold',
          });
        }

        const flange = itemService.createItem(db, ctx, {
          name: 'Cast Iron Flange 4in',
          baseCode: 'CIF-4',
          trackingMode: 'quantity',
        });
        const flangeSku = repo.listSkusForItem(db, state.workspaceId, flange.itemId)[0];
        at(210, 'receive', ctx, { skuId: flangeSku.id, locationId: primary.id, quantity: 80, reference: 'PO-8800' });
        at(190, 'issue', ctx, { skuId: flangeSku.id, locationId: primary.id, quantity: 6, reasonCode: 'sold' });

        return { valve, valveSku, flange, flangeSku, primary, secondary };
      });
      Object.assign(state, built);

      // Detection is deterministic and runs on the server's own connection.
      const run = inspect(databasePath, (db) => reevaluate.refresh(db, state.workspaceId, 'e2e'));
      assert.ok(run.opened >= 2, `expected findings, got ${run.opened}`);

      await page.goto(`${BASE}/attention`);
      await page.locator('text=Brass Gate Valve').first().waitFor();
      await page.locator('text=Cast Iron Flange').first().waitFor();
      await shot(page, 'briefing');

      const body = await page.locator('body').innerText();
      assert.ok(
        body.indexOf('Brass Gate Valve') < body.indexOf('Cast Iron Flange'),
        'running out ranks above sitting still'
      );
      assert.match(body, /were issued in the last/, 'every card says why');
    });

    await t.test('4. the overview leads with the briefing', async () => {
      // The landing page is now Operator Home. The classic overview, which is
      // what this step is about, stayed at /overview.
      await page.goto(`${BASE}/overview`);
      await page.locator("text=Today's briefing").first().waitFor();
      const body = await page.locator('body').innerText();
      assert.match(body, /need your attention/);
      assert.ok(body.indexOf("Today's briefing") < body.indexOf('Units on hand'));
      await shot(page, 'overview-briefing');
    });

    await t.test('5. the evidence page shows the working, and labels the estimate', async () => {
      await page.goto(`${BASE}/attention`);
      await page.locator('.att-card', { hasText: 'Brass Gate Valve' }).locator('text=Why this?').click();
      await page.waitForURL(/\/attention\/att_/);
      await shot(page, 'evidence');

      const body = await page.locator('body').innerText();
      assert.match(body, /The evidence/);
      assert.match(body, /Current stock/);
      assert.match(body, /Foundry's working/);
      assert.match(body, /not counted/);
      // A stockout has no operation Foundry can carry out — purchasing does not
      // exist — so it says so rather than offering an invented action.
      assert.match(body, /draft the purchase order/);
      assert.ok(!body.includes('Review transfer'));

      state.attentionUrl = page.url();
      state.attentionId = page.url().split('/').pop();
    });

    await t.test('6. every figure on the page is in the ledger', async () => {
      const item = inspect(databasePath, (db) => attention.getAttention(db, state.workspaceId, state.attentionId));
      const total = inspect(databasePath, (db) =>
        db
          .prepare('SELECT COALESCE(SUM(on_hand),0) AS n FROM balances WHERE workspace_id = ? AND sku_id = ?')
          .get(state.workspaceId, state.valveSku.id).n
      );
      assert.equal(item.metrics.onHand, total, 'the stated stock is the engine\'s stock');

      const issued = inspect(databasePath, (db) =>
        db
          .prepare(
            `SELECT COALESCE(SUM(-quantity_delta),0) AS n FROM movements
              WHERE workspace_id = ? AND sku_id = ? AND operation = 'issue' AND occurred_at >= ?`
          )
          .get(state.workspaceId, state.valveSku.id, new Date(Date.now() - 30 * DAY).toISOString()).n
      );
      assert.equal(item.metrics.issuedInWindow, issued, 'the stated usage is the ledger\'s usage');
    });

    await t.test('7. giving feedback records an opinion and changes no rule', async () => {
      await page.goto(state.attentionUrl);
      // Exact text: "Not useful" also contains "Useful".
      await page.getByRole('button', { name: 'Useful', exact: true }).click();
      await page.waitForURL(/\/attention\//);
      await page.locator('text=Noted').first().waitFor();

      const still = inspect(databasePath, (db) => attention.listAttention(db, state.workspaceId));
      assert.ok(still.some((i) => i.attentionId === state.attentionId), 'still detected');
      await shot(page, 'feedback');
    });

    await t.test('8. acting on the inventory resolves the finding, with a reason', async () => {
      await page.goto(`${BASE}/inventory/${state.valve.itemId}`);
      // The record itself says what Foundry has noticed about it.
      await page.locator('.item-attention-row', { hasText: 'may run out' }).first().waitFor();
      await shot(page, 'item-with-finding');

      await page.click('button[data-modal-open="modal-receive"]');
      await page.waitForSelector('#modal-receive[open]');
      const dialog = page.locator('#modal-receive');
      await dialog.locator('#receive-location').selectOption({ label: state.primary.name });
      await dialog.locator('#receive-quantity').fill('500');
      await dialog.locator('button[type=submit]').click();
      await page.waitForURL(new RegExp(`/inventory/${state.valve.itemId}$`));
      await shot(page, 'received');

      const resolved = inspect(databasePath, (db) => attention.getAttention(db, state.workspaceId, state.attentionId));
      assert.equal(resolved.status, 'RESOLVED', 'the operation resolved it, unprompted');
      assert.ok(resolved.resolutionReason);

      // …and the banner on the record clears with it.
      assert.equal(await page.locator('.item-attention-row').count(), 0);

      await page.goto(`${BASE}/attention`);
      const body = await page.locator('body').innerText();
      assert.ok(!body.includes('Brass Gate Valve'), 'gone from the open briefing');

      await page.goto(`${BASE}/attention?show=resolved`);
      await page.locator('text=Brass Gate Valve').first().waitFor();
      await shot(page, 'resolved');
    });

    await t.test('9. dismissing hides a finding without deleting it', async () => {
      await page.goto(`${BASE}/attention`);
      await page.locator('.att-card', { hasText: 'Cast Iron Flange' }).locator('text=Not a problem').click();
      await page.waitForURL(`${BASE}/attention`);

      const body = await page.locator('body').innerText();
      assert.ok(!body.includes('Cast Iron Flange'));

      const hidden = inspect(databasePath, (db) =>
        db.prepare("SELECT * FROM attention_items WHERE workspace_id = ? AND status = 'DISMISSED'").all(state.workspaceId)
      );
      assert.equal(hidden.length, 1, 'kept on record, not deleted');
      assert.ok(hidden[0].dismissed_until);
      await shot(page, 'dismissed');
    });

    await t.test('10. a real question is answered from the ledger', async () => {
      await page.goto(`${BASE}/ask`);
      await page.fill('#ask-question', 'How many brass gate valves do we have?');
      await page.locator('[data-ask-form] button[type=submit]').click();
      await page.waitForURL(/\/ask\?q=/);
      await shot(page, 'ask-answer');

      const body = await page.locator('body').innerText();
      const total = inspect(databasePath, (db) =>
        db
          .prepare('SELECT COALESCE(SUM(on_hand),0) AS n FROM balances WHERE workspace_id = ? AND sku_id = ?')
          .get(state.workspaceId, state.valveSku.id).n
      );
      assert.match(body, new RegExp(String(total)), 'the answer is the engine\'s number');
      assert.match(body, /Foundry read this as/);
      assert.match(body, /changes are approved on the actions page/);
    });

    await t.test('11. a question outside inventory is refused honestly', async () => {
      await page.goto(`${BASE}/ask`);
      await page.fill('#ask-question', 'What was our gross margin on valves last quarter?');
      await page.locator('[data-ask-form] button[type=submit]').click();
      await page.waitForURL(/\/ask\?q=/);
      await shot(page, 'ask-unsupported');

      const body = await page.locator('body').innerText();
      assert.match(body, /Outside what Foundry does/);
      assert.ok(!/\bI (?:ordered|switched|moved)\b/i.test(body), 'no invented action');
    });

    await t.test('12. a different business shape gets different categories', async () => {
      // Same engine, same operator, serialized equipment instead of counted parts.
      const built = tradeHistory(databasePath, (db, at) => {
        const ctx = { workspaceId: state.workspaceId, actorId: state.ownerId };
        const itemService = require('../../src/domain/item-service');
        const repo = require('../../src/domain/repository');
        const primary = repo.listLocations(db, state.workspaceId)[0];

        const pump = itemService.createItem(db, ctx, {
          name: 'Site Transfer Pump',
          baseCode: 'STP-1',
          trackingMode: 'serial',
          unitLabel: 'pump',
        });
        const pumpSku = repo.listSkusForItem(db, state.workspaceId, pump.itemId)[0];
        at(300, 'receive', ctx, {
          skuId: pumpSku.id,
          locationId: primary.id,
          serials: [{ serial: 'STP-0001' }, { serial: 'STP-0002' }],
        });
        return { pump, pumpSku };
      });
      Object.assign(state, built);

      inspect(databasePath, (db) => reevaluate.refresh(db, state.workspaceId, 'e2e-serial'));

      await page.goto(`${BASE}/attention`);
      await page.locator('text=STP-0001').first().waitFor();
      await shot(page, 'serialized-finding');

      const categories = inspect(databasePath, (db) =>
        attention.listAttention(db, state.workspaceId).map((i) => i.category)
      );
      assert.ok(categories.includes('serialized_inactivity'), 'the serial category appeared');
      assert.ok(!categories.includes('expiring_inventory'), 'and one that cannot apply did not');
    });

    await t.test('13. inventory truth is untouched by everything above', async () => {
      const result = inspect(databasePath, (db) => engine.verifyIntegrity(db, state.workspaceId));
      assert.equal(result.ok, true, JSON.stringify(result.problems || []));

      const written = inspect(databasePath, (db) =>
        db
          .prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND actor_user_id IS NULL")
          .get(state.workspaceId).n
      );
      assert.equal(written, 0, 'every movement has a real person behind it');

      assert.deepEqual(pageErrors, []);
      assert.deepEqual(
        consoleErrors.filter((e) => !/favicon/i.test(e)),
        []
      );
    });
  }
);
