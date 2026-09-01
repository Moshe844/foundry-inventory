'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const { openDatabase } = require('../../src/db');
const modes = require('../../src/autopilot/modes');
const policyService = require('../../src/autopilot/policy-service');
const workItems = require('../../src/autopilot/work-items');
const {
  seedAuthorityWorkspace,
  approveTransferPolicy,
} = require('../helpers/autopilot-authority-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.E2E_AUTHORITY_PORT || 3996);
const BASE = `http://127.0.0.1:${PORT}`;

function startServer(databasePath) {
  return spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_PATH: databasePath,
      SESSION_SECRET: 'authority-e2e-secret',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Authority E2E server did not start.');
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function setupDatabase(databasePath, { requiredQuantity, paused = false, policyVersion = 1 }) {
  const db = openDatabase(databasePath);
  try {
    const env = seedAuthorityWorkspace(db, { requiredQuantity, workspaceName: `Authority Browser ${requiredQuantity}` });
    db.prepare(
      `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
         operational_defaults, inventory_model, updated_at)
       VALUES (?, datetime('now'), 1, '{}', '{}', '{}', datetime('now'))`
    ).run(env.workspace.workspaceId);

    let policy = approveTransferPolicy(env, {
      maximumQuantity: policyVersion === 1 ? 5 : 4,
      name: 'Browser authority boundary',
    });
    if (policyVersion === 2) {
      const replacement = policyService.revise(db, env.ctx, env.membership, policy.id, { maximumQuantity: 5 });
      policy = policyService.approve(db, env.ctx, env.membership, replacement.id);
    }
    modes.setMode(db, env.ctx, env.membership, modes.MODES.POLICY_AUTOMATED);
    if (paused) modes.pause(db, env.ctx, env.membership, 'Browser kill-switch proof');
    return {
      workspaceId: env.workspace.workspaceId,
      email: env.workspace.account.email,
      password: env.workspace.account.password,
      skuId: env.sku.id,
      destinationId: env.destination.id,
      policyId: policy.id,
    };
  } finally {
    db.close();
  }
}

function inspect(databasePath, callback) {
  const db = openDatabase(databasePath);
  try { return callback(db); } finally { db.close(); }
}

/**
 * Production runs this cycle from the scheduler. Test servers deliberately do
 * not start timers, so acceptance tests trigger exactly one authenticated turn
 * without putting a manual "run automation" control back on the owner Home.
 */
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

async function withBrowserScenario(options, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-authority-e2e-'));
  const databasePath = path.join(dir, 'authority.db');
  const state = setupDatabase(databasePath, options);
  const server = startServer(databasePath);
  server.stderr.on('data', (chunk) => process.stderr.write(`[authority-server] ${chunk}`));
  await waitForServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  page.setDefaultTimeout(60000);
  try {
    await page.goto(`${BASE}/login`);
    await page.fill('#email', state.email);
    await page.fill('#password', state.password);
    await page.click('form[action="/login"] button[type=submit]');
    await page.waitForURL(`${BASE}/`);
    await callback({ page, state, databasePath });
  } finally {
    await browser.close();
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('authority browser E2E: real policy boundaries, audit wording, Pause and Resume', { timeout: 180000 }, async (t) => {
  await t.test('qualifying work runs and displays the exact policy version and dated evidence', async () => {
    await withBrowserScenario({ requiredQuantity: 5, policyVersion: 2 }, async ({ page, state, databasePath }) => {
      await runSchedulerTurn(page);
      const item = inspect(databasePath, (db) =>
        workItems.list(db, state.workspaceId, { category: 'balance_transfer' })[0]);
      assert.equal(item.executionStatus, 'COMPLETED');
      await page.goto(`${BASE}/autopilot/work/${item.id}`);
      const text = await page.locator('body').innerText();
      assert.match(text, /Browser authority boundary · version 2/);
      assert.match(text, /Main Warehouse issued \(30 days\)\s+14/);
      assert.match(text, /Total across both locations is unchanged/);
    });
  });

  await t.test('work above the policy boundary remains full-sized in Needs you', async () => {
    await withBrowserScenario({ requiredQuantity: 8 }, async ({ page, state, databasePath }) => {
      await runSchedulerTurn(page);
      const waiting = inspect(databasePath, (db) => workItems.awaitingApproval(db, state.workspaceId)[0]);
      assert.equal(waiting.recommendedAction.quantity, 8);
      await page.goto(`${BASE}/autopilot/work/${waiting.id}`);
      const text = await page.locator('body').innerText();
      assert.match(text, /allows transfers of up to 5 units/);
      assert.match(text, /I want to move 8\. Nothing has moved yet\./);
      assert.match(text, /Not met — within the policy quantity limit/i);
    });
  });

  await t.test('Pause blocks the run and Resume lets the same eligible work continue', async () => {
    await withBrowserScenario({ requiredQuantity: 5, paused: true }, async ({ page, state, databasePath }) => {
      assert.match(await page.locator('body').innerText(), /Foundry is paused/);
      await runSchedulerTurn(page);
      assert.equal(inspect(databasePath, (db) =>
        db.prepare('SELECT on_hand FROM balances WHERE workspace_id = ? AND sku_id = ? AND location_id = ?')
          .get(state.workspaceId, state.skuId, state.destinationId).on_hand), 4);

      await page.click('form[action="/autopilot/resume"] button[type=submit]');
      await page.waitForURL(`${BASE}/`);
      await runSchedulerTurn(page);
      assert.equal(inspect(databasePath, (db) =>
        db.prepare('SELECT on_hand FROM balances WHERE workspace_id = ? AND sku_id = ? AND location_id = ?')
          .get(state.workspaceId, state.skuId, state.destinationId).on_hand), 9);
      const completed = inspect(databasePath, (db) =>
        workItems.list(db, state.workspaceId, { category: 'balance_transfer' })
          .find((item) => item.executionStatus === 'COMPLETED'));
      assert.ok(completed, 'the resumed authority completed the waiting transfer');
      await page.goto(`${BASE}/autopilot/work/${completed.id}`);
      const detail = await page.locator('body').innerText();
      assert.match(detail, /Dated Demand Fixture — move stock between locations/);
      assert.match(detail, /I transferred 5\./);
    });
  });
});
