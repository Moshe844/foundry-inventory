'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { completeTransfer } = require('./transfer-helper');

const { openDatabase } = require('../../src/db');
const modes = require('../../src/autopilot/modes');
const policyService = require('../../src/autopilot/policy-service');
const workItems = require('../../src/autopilot/work-items');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const supplierCommunications = require('../../src/purchasing/supplier-communications');
const connections = require('../../src/connections/service');
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

function setupCompletedOptimizerReport(databasePath) {
  const db = openDatabase(databasePath);
  try {
    const env = seedAuthorityWorkspace(db, { requiredQuantity: 5, workspaceName: 'Optimizer Browser' });
    db.prepare(
      `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
         operational_defaults, inventory_model, updated_at)
       VALUES (?, datetime('now'), 1, '{}', '{}', '{}', datetime('now'))`
    ).run(env.workspace.workspaceId);
    const supplier = suppliers.createSupplier(db, env.ctx, env.membership, {
      name: 'Verified Supply', email: 'orders@verified.test', defaultLeadTimeDays: 4,
    });
    suppliers.linkItem(db, env.ctx, env.membership, {
      supplierId: supplier.id, skuId: env.sku.id, purchaseUnit: 'unit',
      unitsPerPurchaseUnit: 1, lastUnitCost: 3.5, leadTimeDays: 4, isPreferred: true,
    });
    const mailbox = connections.create(db, env.ctx, env.membership, {
      providerType: 'supplier_email', displayName: 'Purchasing Gmail',
    }).connection;
    db.prepare(`UPDATE workspace_connectors SET provider_type='gmail', status='connected',
      setup_status='CONNECTED', paused_at=NULL, capabilities='["MAIL_READ","MAIL_SEND"]'
      WHERE id=?`).run(mailbox.id);
    suppliers.updateSupplier(db, env.ctx, env.membership, supplier.id, {
      watchedConnectorId: mailbox.id, prepareCommunications: true,
      autoSendEnabled: true, autoSendLimit: 500,
    });
    let order = poService.createOrder(db, env.ctx, env.membership, {
      supplierId: supplier.id, source: 'foundry_recommendation',
      lines: [{ skuId: env.sku.id, quantityUnits: 10, unitCost: 3.5,
        destinationLocationId: env.destination.id }],
    });
    order = poService.approve(db, env.ctx, env.membership, order.id, {
      expectedHash: order.integrityHash, markOrdered: false,
    });
    const [queued] = supplierCommunications.queueForOrder(db, env.workspace.workspaceId, order.id);
    db.prepare(`UPDATE supplier_communications SET status='SENT', transport='gmail',
      external_message_id='browser-provider-message', external_thread_id='browser-provider-thread',
      sent_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(queued.id);
    const sent = supplierCommunications.get(db, env.workspace.workspaceId, queued.id);
    order = poService.markOrderedFromSupplierSend(db, env.ctx, order.id, sent);

    const action = {
      decision: 'transfer_and_purchase', decisionSource: 'adaptive_optimizer',
      explanation: 'Transfer 5 and buy 10 after comparing evidenced stock, timing, cost and cash.',
      displayName: 'Dated Demand Fixture', skuId: env.sku.id, itemId: env.itemId,
      unitLabel: 'units', onHandTotal: 64, committed: 0, backordered: 0,
      onOrder: 0, networkPosition: 64, reorderPoint: 70, target: 79,
      byLocation: [
        { locationId: env.destination.id, locationName: env.destination.name, onHand: 4, need: 9, available: 4 },
        { locationId: env.source.id, locationName: env.source.name, onHand: 60, need: 0, available: 60 },
      ],
      transfers: [{ fromLocationId: env.source.id, fromLocationName: env.source.name,
        toLocationId: env.destination.id, toLocationName: env.destination.name, quantity: 5 }],
      purchase: { supplierId: supplier.id, supplierName: supplier.name, quantityUnits: 10,
        quantityPurchaseUnits: 10, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1,
        unitCost: 3.5, estimatedCost: 35, leadTimeDays: 4 },
      after: { onHandAfterMoves: 64, byLocation: [
        { locationId: env.destination.id, locationName: env.destination.name, before: 4, after: 9 },
        { locationId: env.source.id, locationName: env.source.name, before: 60, after: 55 },
      ] },
    };
    const created = workItems.upsert(db, env.workspace.workspaceId, {
      category: 'replenishment_plan', source: 'adaptive_optimizer',
      sourceEvidence: [{ label: 'Decision engine', value: 'Transfer versus buy optimizer' }],
      affectedEntities: { skuId: env.sku.id, displayName: action.displayName },
      recommendedAction: action, priority: 80, urgency: 'soon', confidence: 'high',
      approvalRequirement: 'NONE', executionStatus: workItems.STATUS.AUTHORIZED,
      verificationStatus: 'PENDING', idempotencyKey: 'optimizer-browser-report',
    }).item;
    const completed = workItems.transition(db, env.workspace.workspaceId, created.id,
      workItems.STATUS.COMPLETED, {
        purchaseOrderId: order.id, verificationStatus: 'VERIFIED',
        outcome: { purchaseOrderId: order.id, checks: [
          { kind: 'transfer', from: env.source.name, to: env.destination.name, quantity: 5,
            transferId: 'tr_browser', transferNumber: 'TR-1001', status: 'APPROVED', ok: true,
            sourceBefore: 60, sourceAfter: 60, destinationBefore: 4, destinationAfter: 4 },
          { kind: 'purchase', poNumber: order.poNumber, status: order.status, ok: true },
        ] },
      });
    return { workspaceId: env.workspace.workspaceId, email: env.workspace.account.email,
      password: env.workspace.account.password, workItemId: completed.id, orderId: order.id,
      poNumber: order.poNumber };
  } finally { db.close(); }
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
      assert.match(await page.locator('body').innerText(), /StockChief is paused/);
      await runSchedulerTurn(page);
      assert.equal(inspect(databasePath, (db) =>
        db.prepare('SELECT on_hand FROM balances WHERE workspace_id = ? AND sku_id = ? AND location_id = ?')
          .get(state.workspaceId, state.skuId, state.destinationId).on_hand), 4);

      await page.click('form[action="/autopilot/resume"] button[type=submit]');
      await page.waitForURL(`${BASE}/`);
      await runSchedulerTurn(page);
      assert.equal(inspect(databasePath, (db) =>
        db.prepare('SELECT on_hand FROM balances WHERE workspace_id = ? AND sku_id = ? AND location_id = ?')
          .get(state.workspaceId, state.skuId, state.destinationId).on_hand), 4);
      const completed = inspect(databasePath, (db) =>
        workItems.list(db, state.workspaceId, { category: 'balance_transfer' })
          .find((item) => item.executionStatus === 'COMPLETED'));
      assert.ok(completed, 'the resumed authority prepared the waiting transfer');
      await page.goto(`${BASE}/autopilot/work/${completed.id}`);
      const detail = await page.locator('body').innerText();
      assert.match(detail, /Dated Demand Fixture — move stock between locations/);
      assert.match(detail, /I prepared TR-\d+ for 5/);
      await page.getByRole('link', { name: 'Open the prepared transfer' }).click();
      await completeTransfer(page);
      assert.equal(inspect(databasePath, (db) =>
        db.prepare('SELECT on_hand FROM balances WHERE workspace_id = ? AND sku_id = ? AND location_id = ?')
          .get(state.workspaceId, state.skuId, state.destinationId).on_hand), 9);
    });
  });
});

test('optimizer browser report proves transfer, supplier execution and provider verification', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-optimizer-report-e2e-'));
  const databasePath = path.join(dir, 'optimizer.db');
  const state = setupCompletedOptimizerReport(databasePath);
  const server = startServer(databasePath);
  server.stderr.on('data', (chunk) => process.stderr.write(`[optimizer-report-server] ${chunk}`));
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
    await page.goto(`${BASE}/autopilot/work/${state.workItemId}`);
    const work = await page.locator('body').innerText();
    assert.match(work, /Transfer 5 and buy 10 after comparing evidenced stock, timing, cost and cash/);
    assert.match(work, /Verified transfer prepared: TR-1001 for 5 units/);
    assert.match(work, new RegExp(`${state.poNumber} is placed; 10 units are on order; supplier delivery is provider-confirmed`));
    await page.getByRole('link', { name: new RegExp(`Open ${state.poNumber}`) }).click();
    await page.goto(`${BASE}/purchasing/orders/${state.orderId}/detail`);
    const order = await page.locator('body').innerText();
    assert.match(order, /Sent successfully through Gmail from Purchasing Gmail to orders@verified\.test/);
    assert.match(order, /Ordered/);
  } finally {
    await browser.close();
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
