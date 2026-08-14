'use strict';

/**
 * Mission 4 acceptance run, in a real browser, from a clean database.
 *
 * A configured clothing wholesaler with Brooklyn at 4 and New Jersey at 48.
 * Mission 3 raises the imbalance; the person reviews the transfer Foundry
 * proposes, changes the quantity, approves it, and watches it happen. Then the
 * things that must not happen: a retried execution moving stock twice, an
 * unapproved mutation, an invented purchase.
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
const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const locationService = require('../../src/domain/location-service');
const repo = require('../../src/domain/repository');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'artifacts', 'screenshots', 'actions');
const PORT = Number(process.env.E2E_ACTIONS_PORT || 3995);
const BASE = `http://127.0.0.1:${PORT}`;
const DAY = 24 * 60 * 60 * 1000;

const ACCOUNT = {
  workspaceName: 'Harbour Clothing',
  name: 'Sarah Vance',
  email: 'sarah@harbourclothing.test',
  password: 'harbour-clothing-2026',
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
      SESSION_SECRET: 'actions-e2e-secret',
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

/**
 * Submits an instruction and lands on the proposal it produced. If Foundry asks
 * a question or refuses instead, that is reported straight away rather than
 * waiting out a navigation that is never coming.
 */
async function askFoundry(page, instruction) {
  await page.goto(`${BASE}/actions`);
  await page.fill('#action-instruction', instruction);
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/actions/ask') && r.request().method() === 'POST'),
    page.click('button:has-text("Work it out")'),
  ]);
  await page.waitForLoadState('networkidle');
  if (!/\/actions\/(act_|plan)/.test(page.url())) {
    const said = await page.locator('.act-question').first().innerText().catch(() => '(no answer shown)');
    throw new Error(`Foundry did not propose an action for "${instruction}". It said: ${said}`);
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

function inspect(databasePath, fn) {
  const db = openDatabase(databasePath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * A configured clothing wholesaler at the mission's starting numbers, with
 * enough trading history for the imbalance to be a measured finding rather
 * than an assertion.
 */
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
      JSON.stringify({ item: 'Style', variant: 'Colour/Size' }),
      JSON.stringify({ adjustmentsRequireReason: true, allowNegativeStock: false, transfersEnabled: true }),
      JSON.stringify({ primaryArchetype: 'quantity', usesVariants: true, serialRules: { enabled: false }, lotRules: { enabled: false } })
    );

    const brooklyn = locationService.createLocation(db, ctx, { name: 'Brooklyn Warehouse', kind: 'warehouse' });
    const jersey = locationService.createLocation(db, ctx, { name: 'New Jersey Warehouse', kind: 'warehouse' });

    const item = itemService.createItem(db, ctx, {
      name: 'Navy Oxford',
      baseCode: 'NO-100',
      trackingMode: 'quantity',
      hasVariants: true,
      options: [{ name: 'Size', values: '8, 9' }],
    });
    const skus = repo.listSkusForItem(db, workspaceId, item.itemId);
    const size8 = skus.find((s) => s.variant_label === '8');
    const size9 = skus.find((s) => s.variant_label === '9');

    // History, back-dated so Mission 3 has something real to measure.
    const at = (days, operation, input) => {
      const result = engine[operation](db, ctx, input);
      const when = new Date(Date.now() - days * DAY).toISOString();
      db.exec('DROP TRIGGER IF EXISTS movements_no_update');
      const stmt = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
      for (const id of result.movementIds) stmt.run(when, id);
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
         BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
      );
      return result;
    };

    at(60, 'receive', { skuId: size8.id, locationId: jersey.id, quantity: 60 });
    at(60, 'receive', { skuId: size8.id, locationId: brooklyn.id, quantity: 40 });
    at(60, 'receive', { skuId: size9.id, locationId: jersey.id, quantity: 30 });
    // Brooklyn sells; New Jersey barely moves.
    for (let i = 0; i < 6; i += 1) {
      at(26 - i * 4, 'issue', { skuId: size8.id, locationId: brooklyn.id, quantity: 6, reasonCode: 'sold' });
    }
    at(15, 'issue', { skuId: size8.id, locationId: jersey.id, quantity: 12, reasonCode: 'sold' });

    reevaluate.refresh(db, workspaceId, 'e2e-setup');

    return {
      workspaceId,
      itemId: item.itemId,
      size8: size8.id,
      size9: size9.id,
      brooklyn: brooklyn.id,
      jersey: jersey.id,
    };
  } finally {
    db.close();
  }
}

const balance = (databasePath, state, skuId, locationId) =>
  inspect(databasePath, (db) => repo.getBalance(db, state.workspaceId, skuId, locationId));

test(
  'Mission 4 end to end: Foundry carries out approved inventory work',
  { skip: !config.ai.configured, timeout: 1200000 },
  async (t) => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-m4-e2e-'));
    const databasePath = path.join(dataDir, 'e2e.db');
    const state = buildWorkspace(databasePath);

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

    t.after(async () => {
      await context.close();
      await browser.close();
      await stopServer(server);
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    await t.test('0. sign in, with the imbalance already measured', async () => {
      await page.goto(`${BASE}/login`);
      await page.fill('#email', ACCOUNT.email);
      await page.fill('#password', ACCOUNT.password);
      await page.click('form[action="/login"] button[type=submit]');
      await page.waitForURL(`${BASE}/`);

      assert.equal(balance(databasePath, state, state.size8, state.brooklyn), 4);
      assert.equal(balance(databasePath, state, state.size8, state.jersey), 48);
      await shot(page, 'overview');
    });

    await t.test('1-2. open the finding and choose Review transfer', async () => {
      await page.goto(`${BASE}/attention`);
      const finding = inspect(databasePath, (db) =>
        attention.listAttention(db, state.workspaceId).find(
          (i) => i.category === 'location_imbalance' || i.relatedCategories.includes('location_imbalance')
        )
      );
      assert.ok(finding, 'Mission 3 raised the imbalance');
      state.attentionId = finding.attentionId;

      await page.goto(`${BASE}/attention/${finding.attentionId}`);
      await shot(page, 'finding');
      const body = await page.locator('body').innerText();
      assert.match(body, /Review transfer/);
      assert.ok(!body.includes('Transfer now'), 'never offered as a done deal');

      await page.click('button:has-text("Review transfer")');
      await page.waitForURL(/\/actions\/act_/);
      state.firstProposalUrl = page.url();
    });

    await t.test('3. Foundry proposes a specific transfer, and nothing has moved', async () => {
      const body = await page.locator('body').innerText();
      assert.match(body, /Foundry is ready to transfer/);
      assert.match(body, /Navy Oxford/);
      assert.match(body, /New Jersey Warehouse/);
      assert.match(body, /Brooklyn Warehouse/);
      assert.match(body, /unchanged — stock only moves/);
      await shot(page, 'proposal');

      assert.equal(balance(databasePath, state, state.size8, state.brooklyn), 4, 'still nothing moved');
      assert.equal(balance(databasePath, state, state.size8, state.jersey), 48);
    });

    await t.test('4. change the quantity to 12, which needs approving afresh', async () => {
      await page.fill('#quantity', '12');
      await page.click('button:has-text("Recalculate")');
      await page.waitForURL(/\/actions\/act_/);
      state.proposalUrl = page.url();
      assert.notEqual(state.proposalUrl, state.firstProposalUrl, 'a new number is a new proposal');

      const body = await page.locator('body').innerText();
      assert.match(body, /New Jersey Warehouse[\s\S]{0,60}48[\s\S]{0,20}36/);
      assert.match(body, /Brooklyn Warehouse[\s\S]{0,60}4[\s\S]{0,20}16/);
      assert.match(body, /Approve transfer/);
      await shot(page, 'revised');

      assert.equal(balance(databasePath, state, state.size8, state.brooklyn), 4);
    });

    await t.test('5-7. approve, execute, and verify the resulting balances', async () => {
      await page.click('button:has-text("Approve transfer")');
      await page.waitForURL(/\/actions\/act_/);
      await shot(page, 'done');

      const body = await page.locator('body').innerText();
      assert.match(body, /Done/);
      assert.match(body, /Verified against your records/);

      assert.equal(balance(databasePath, state, state.size8, state.brooklyn), 16);
      assert.equal(balance(databasePath, state, state.size8, state.jersey), 36);
      assert.equal(
        inspect(databasePath, (db) => repo.getSkuTotal(db, state.workspaceId, state.size8)),
        52,
        'total unchanged by a transfer'
      );
      assert.equal(inspect(databasePath, (db) => engine.verifyIntegrity(db, state.workspaceId).ok), true);
    });

    await t.test('8. the movement ledger records it, with who approved it', async () => {
      await page.goto(`${BASE}/activity`);
      const body = await page.locator('body').innerText();
      assert.match(body, /Transferred 12/);
      assert.match(body, /New Jersey Warehouse/);
      assert.match(body, /Sarah Vance/);
      await shot(page, 'activity');

      const movements = inspect(databasePath, (db) =>
        db.prepare("SELECT * FROM movements WHERE workspace_id = ? AND operation = 'transfer'").all(state.workspaceId)
      );
      assert.equal(movements.length, 2, 'both legs, one group');
      assert.equal(movements[0].group_id, movements[1].group_id);
      assert.equal(movements[0].quantity_delta + movements[1].quantity_delta, 0, 'nothing created or destroyed');
      assert.match(movements[0].reference, /^Foundry act_/, 'the ledger says Foundry was involved');
    });

    await t.test('9. the finding it came from resolves itself', async () => {
      const finding = inspect(databasePath, (db) => attention.getAttention(db, state.workspaceId, state.attentionId));
      assert.equal(finding.status, 'RESOLVED');
      assert.ok(finding.resolutionReason);
      assert.ok(finding.firstDetectedAt, 'history kept');
    });

    await t.test('10-11. refreshing keeps the state', async () => {
      await page.goto(state.proposalUrl);
      await page.reload();
      const body = await page.locator('body').innerText();
      assert.match(body, /Done/);
      assert.equal(balance(databasePath, state, state.size8, state.brooklyn), 16);
    });

    await t.test('12-13. retrying the execution does not move stock twice', async () => {
      const runUrl = `${state.proposalUrl}/run`;
      for (let i = 0; i < 3; i += 1) {
        await page.goto(runUrl);
      }
      assert.equal(balance(databasePath, state, state.size8, state.brooklyn), 16, 'still 16');
      assert.equal(balance(databasePath, state, state.size8, state.jersey), 36);
      assert.equal(
        inspect(databasePath, (db) =>
          db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'transfer'")
            .get(state.workspaceId).n
        ),
        2,
        'one transfer, not four'
      );
      assert.equal(
        inspect(databasePath, (db) =>
          db.prepare('SELECT COUNT(*) AS n FROM action_executions WHERE workspace_id = ?').get(state.workspaceId).n
        ),
        1
      );
      await shot(page, 'retry-safe');
    });

    await t.test('14. a written receive instruction is understood and carried out', async () => {
      await askFoundry(page, 'Receive 50 more Navy Oxford size 8 into Brooklyn Warehouse');
      await shot(page, 'receive-proposal');

      const preview = await page.locator('body').innerText();
      assert.match(preview, /Foundry is ready to receive/);
      assert.match(preview, /Brooklyn Warehouse[\s\S]{0,60}16[\s\S]{0,20}66/);
      assert.equal(balance(databasePath, state, state.size8, state.brooklyn), 16, 'not yet');

      await page.click('button:has-text("Approve receive")');
      await page.waitForURL(/\/actions\/act_/);
      assert.match(await page.locator('body').innerText(), /Done/);
      assert.equal(balance(databasePath, state, state.size8, state.brooklyn), 66);
      await shot(page, 'receive-done');
    });

    await t.test('15. a correction warns, records its reason, and verifies', async () => {
      await askFoundry(page, 'Set Brooklyn Warehouse Navy Oxford size 8 to 60 after a physical count');
      await shot(page, 'adjust-proposal');

      const preview = await page.locator('body').innerText();
      assert.match(preview, /correct a count/i);
      assert.match(preview, /Physical count/);
      assert.match(preview, /A correction changes the records without stock moving/);
      assert.match(preview, /I have read the warning/);

      // The extra confirmation really is required.
      const checkbox = page.locator('input[name="acknowledged"]');
      assert.equal(await checkbox.count(), 1);
      assert.equal(await checkbox.isChecked(), false);

      await checkbox.check();
      await page.click('button:has-text("Approve the correction")');
      await page.waitForURL(/\/actions\/act_/);
      assert.match(await page.locator('body').innerText(), /Done/);
      await shot(page, 'adjust-done');

      assert.equal(balance(databasePath, state, state.size8, state.brooklyn), 60);
      const adjustment = inspect(databasePath, (db) =>
        db.prepare('SELECT * FROM adjustments WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1').get(state.workspaceId)
      );
      assert.equal(adjustment.expected_qty, 66);
      assert.equal(adjustment.counted_qty, 60);
      assert.equal(adjustment.reason_code, 'physical_count');
    });

    await t.test('16. Foundry refuses to invent what it does not have', async () => {
      await page.goto(`${BASE}/actions`);
      await page.fill('#action-instruction', 'Order 500 more Navy Oxford size 8 from our supplier');
      await Promise.all([
        page.waitForResponse((r) => r.url().endsWith('/actions/ask') && r.request().method() === 'POST'),
        page.click('button:has-text("Work it out")'),
      ]);
      await page.waitForSelector('.act-question', { timeout: 30000 });
      await shot(page, 'unsupported');

      const body = await page.locator('body').innerText();
      assert.match(body, /purchase|supplier|order/i);
      assert.ok(!body.includes('Foundry is ready to'), 'no fabricated action');
      assert.equal(
        inspect(databasePath, (db) =>
          db.prepare("SELECT COUNT(*) AS n FROM action_proposals WHERE workspace_id = ? AND status = 'AWAITING_APPROVAL'")
            .get(state.workspaceId).n
        ),
        0
      );
    });

    await t.test('17. inventory truth held throughout, and the browser was clean', async () => {
      const result = inspect(databasePath, (db) => engine.verifyIntegrity(db, state.workspaceId));
      assert.equal(result.ok, true, JSON.stringify(result.problems || []));

      // Every movement was made by a real person through the engine.
      const orphaned = inspect(databasePath, (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND actor_user_id IS NULL')
          .get(state.workspaceId).n
      );
      assert.equal(orphaned, 0);

      // And every action that ran was verified.
      const unverified = inspect(databasePath, (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM action_verifications WHERE workspace_id = ? AND verified = 0')
          .get(state.workspaceId).n
      );
      assert.equal(unverified, 0);

      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors.filter((e) => !/favicon/i.test(e)), []);
    });
  }
);
