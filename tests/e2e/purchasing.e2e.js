'use strict';

/**
 * Mission 6 acceptance run, in a real browser, from a clean database.
 *
 * The clothing wholesaler from the mission brief: ABC Footwear at 21 days,
 * Navy Oxford Size 8 with ten on hand and thirty a month going out, sold in
 * cases of twelve with a minimum of two.
 *
 * The first run is the whole loop — ask what to order, check the arithmetic,
 * approve, receive half, receive the rest — and the retries that must not
 * duplicate anything. The second run is the more important one: the same
 * question when stock is already on its way, where the right answer is to buy
 * nothing.
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
const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const locationService = require('../../src/domain/location-service');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const positionService = require('../../src/purchasing/position');
const repo = require('../../src/domain/repository');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'artifacts', 'screenshots', 'purchasing');
const PORT = Number(process.env.E2E_PURCHASING_PORT || 3993);
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
      SESSION_SECRET: 'purchasing-e2e-secret',
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

/**
 * The wholesaler, with a month of real trading behind it.
 *
 * `onHand` and `monthlyUsage` are the two dials the two runs differ on.
 */
function buildWorkspace(databasePath, { onHand = 10, monthlyUsage = 30, openOrderCases = 0 } = {}) {
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

    const item = itemService.createItem(db, ctx, {
      name: 'Navy Oxford',
      baseCode: 'NO-100',
      trackingMode: 'quantity',
      hasVariants: true,
      options: [{ name: 'Size', values: '8' }],
    });
    const sku = repo.listSkusForItem(db, workspaceId, item.itemId)[0];

    const membership = authService.getMembership(db, workspaceId, accountId);
    const supplier = supplierService.createSupplier(db, ctx, membership, {
      name: 'ABC Footwear',
      contactName: 'Dana Ruiz',
      email: 'orders@abcfootwear.test',
      defaultLeadTimeDays: 21,
      paymentTerms: 'Net 30',
    });
    supplierService.linkItem(db, ctx, membership, {
      supplierId: supplier.id,
      skuId: sku.id,
      supplierSku: 'OX-NV-08',
      purchaseUnit: 'case',
      unitsPerPurchaseUnit: 12,
      minimumOrderQuantity: 2,
      orderMultiple: 1,
      leadTimeDays: 21,
      lastUnitCost: 8.2,
    });

    // Received enough to cover a month of selling and still land on `onHand`.
    engine.receive(db, ctx, { skuId: sku.id, locationId: brooklyn.id, quantity: onHand + monthlyUsage });

    db.exec('DROP TRIGGER IF EXISTS movements_no_update');
    const stmt = db.prepare('UPDATE movements SET occurred_at = ? WHERE id = ?');
    const each = monthlyUsage / 6;
    for (let i = 0; i < 6; i += 1) {
      const result = engine.issue(db, ctx, { skuId: sku.id, locationId: brooklyn.id, quantity: each, reasonCode: 'sold' });
      for (const id of result.movementIds) stmt.run(new Date(Date.now() - (28 - i * 4) * DAY).toISOString(), id);
    }
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
       BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`
    );

    let openOrder = null;
    if (openOrderCases > 0) {
      openOrder = poService.createOrder(db, ctx, membership, {
        supplierId: supplier.id,
        destinationLocationId: brooklyn.id,
        lines: [{ skuId: sku.id, quantityPurchaseUnits: openOrderCases }],
      });
      poService.approve(db, ctx, membership, openOrder.id);
    }

    return {
      workspaceId,
      skuId: sku.id,
      brooklyn: brooklyn.id,
      supplierId: supplier.id,
      openOrderId: openOrder ? openOrder.id : null,
    };
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

const balance = (databasePath, state) =>
  inspect(databasePath, (db) => repo.getBalance(db, state.workspaceId, state.skuId, state.brooklyn));

const onOrder = (databasePath, state) =>
  inspect(databasePath, (db) => positionService.positionForSku(db, state.workspaceId, state.skuId).onOrder);

// ---------------------------------------------------------------------------

test(
  'Mission 6 end to end: Foundry plans, orders and receives',
  { skip: !config.ai.configured, timeout: 1200000 },
  async (t) => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-m6-e2e-'));
    const databasePath = path.join(dataDir, 'e2e.db');
    const state = buildWorkspace(databasePath, { onHand: 10, monthlyUsage: 30 });

    const server = startServer(databasePath);
    await waitForServer();

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(30000);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    let orderPath = null;
    let recommended = null;

    t.after(async () => {
      await stopServer(server);
      await context.close();
      await browser.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    await t.test('0. sign in, with ten on hand and nothing on order', async () => {
      await signIn(page);
      assert.equal(balance(databasePath, state), 10);
      assert.equal(onOrder(databasePath, state), 0);
      await shot(page, 'overview');
    });

    await t.test('1. what should I order?', async () => {
      await page.goto(`${BASE}/purchasing`);
      await shot(page, 'what-to-order');

      const text = await page.locator('body').innerText();
      assert.match(text, /What to order/);
      assert.match(text, /ABC Footwear/);
      assert.match(text, /Navy Oxford/);
    });

    await t.test('2. the recommendation is explained, figure by figure', async () => {
      await page.click('a[href^="/purchasing/why/"]');
      await page.waitForURL(/\/purchasing\/why\//);
      await shot(page, 'why');

      const text = await page.locator('body').innerText();
      for (const label of ['On hand', 'On order', 'Inventory position', 'Lead time', 'Safety stock', 'Reorder point', 'Order up to', 'Shortfall', 'Recommended']) {
        assert.match(text, new RegExp(label), `the evidence is missing "${label}"`);
      }
      assert.match(text, /The calculation, step by step/);
      assert.match(text, /21 days/);
      assert.match(text, /case of 12/);

      // The quantity is whole cases, and at least the two-case minimum.
      recommended = inspect(databasePath, (db) =>
        require('../../src/purchasing/replenishment').evaluateOne(db, state.workspaceId, state.skuId)
      );
      assert.equal(recommended.recommend, true);
      assert.equal(recommended.quantityUnits % 12, 0);
      assert.ok(recommended.quantityPurchaseUnits >= 2);
      assert.ok(recommended.quantityUnits >= recommended.shortfall);
    });

    await t.test('3. Foundry prepares the order; nothing is committed yet', async () => {
      await page.goto(`${BASE}/purchasing`);
      await Promise.all([
        page.waitForURL(/\/purchasing\/orders\/po_/),
        page.click('button:has-text("Prepare ABC Footwear order")'),
      ]);
      orderPath = new URL(page.url()).pathname;
      await shot(page, 'draft-order');

      const text = await page.locator('body').innerText();
      assert.match(text, /prepared by Foundry/);
      assert.match(text, /Nothing has been sent to ABC Footwear/);
      assert.match(text, /OX-NV-08/);
      assert.equal(onOrder(databasePath, state), 0, 'a draft is not incoming stock');
    });

    await t.test('4. approving makes it incoming, and the plan goes quiet', async () => {
      await Promise.all([
        page.waitForLoadState('networkidle'),
        page.click('button:has-text("Approve order")'),
      ]);
      await shot(page, 'approved');

      assert.equal(onOrder(databasePath, state), recommended.quantityUnits);
      assert.equal(balance(databasePath, state), 10, 'approving an order does not create stock');

      await page.goto(`${BASE}/purchasing`);
      const text = await page.locator('body').innerText();
      assert.match(text, /Nothing is below its reorder point/);
      await shot(page, 'nothing-more-to-order');
    });

    await t.test('5. the printable order is a document, not a transmission', async () => {
      const document = await page.goto(`${BASE}${orderPath}/document`);
      assert.equal(document.status(), 200);
      const text = await page.locator('body').innerText();
      assert.match(text, /Purchase order/);
      assert.match(text, /ABC Footwear/);
      assert.match(text, /OX-NV-08/);
      assert.match(text, /has not been sent to the supplier/);
      await shot(page, 'document');
    });

    await t.test('6. part of the shipment arrives', async () => {
      await page.goto(`${BASE}${orderPath}/receive`);
      const lineId = inspect(databasePath, (db) => {
        const order = poService.get(db, state.workspaceId, orderPath.split('/').pop());
        return order.lines[0].id;
      });

      await page.fill(`input[name="qty_${lineId}"]`, '24');
      await page.fill('input[name="reference"]', 'DN-5567');
      await Promise.all([
        page.waitForURL((url) => url.pathname === orderPath),
        page.click('button:has-text("Book it in")'),
      ]);
      await shot(page, 'partially-received');

      assert.equal(balance(databasePath, state), 34);
      assert.equal(onOrder(databasePath, state), recommended.quantityUnits - 24);

      const order = inspect(databasePath, (db) => poService.get(db, state.workspaceId, orderPath.split('/').pop()));
      assert.equal(order.status, 'PARTIALLY_RECEIVED');
      assert.equal(order.outstandingUnits, recommended.quantityUnits - 24);

      // The stock arrived through Mission 1, referencing the order.
      const movement = inspect(databasePath, (db) =>
        db.prepare(
          `SELECT * FROM movements WHERE workspace_id = ? AND operation = 'receive' AND reference = ?
            ORDER BY seq DESC LIMIT 1`
        ).get(state.workspaceId, order.poNumber)
      );
      assert.ok(movement, 'the receipt must be a real movement referencing the PO');
      assert.equal(movement.quantity_delta, 24);
    });

    await t.test('7. the rest arrives and the order closes', async () => {
      const order = inspect(databasePath, (db) => poService.get(db, state.workspaceId, orderPath.split('/').pop()));
      await page.goto(`${BASE}${orderPath}/receive`);
      await page.fill(`input[name="qty_${order.lines[0].id}"]`, String(order.outstandingUnits));
      await Promise.all([
        page.waitForURL((url) => url.pathname === orderPath),
        page.click('button:has-text("Book it in")'),
      ]);
      await shot(page, 'received');

      const done = inspect(databasePath, (db) => poService.get(db, state.workspaceId, orderPath.split('/').pop()));
      assert.equal(done.status, 'RECEIVED');
      assert.equal(done.outstandingUnits, 0);
      assert.equal(balance(databasePath, state), 10 + recommended.quantityUnits);
      assert.equal(onOrder(databasePath, state), 0);
    });

    await t.test('8. a retried receipt does not duplicate the stock', async () => {
      const before = {
        balance: balance(databasePath, state),
        receipts: inspect(databasePath, (db) =>
          db.prepare('SELECT COUNT(*) AS n FROM purchase_order_receipts WHERE workspace_id = ?').get(state.workspaceId).n
        ),
      };

      await page.goto(`${BASE}${orderPath}`);
      const token = await page.getAttribute('input[name="_csrf"]', 'value');
      const status = await page.evaluate(
        async ({ target, csrf }) => {
          const response = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: `_csrf=${encodeURIComponent(csrf)}`,
          });
          return response.status;
        },
        { target: `${orderPath}/receive`, csrf: token }
      );
      assert.ok(status < 500, `retried receipt returned ${status}`);

      assert.equal(balance(databasePath, state), before.balance);
      assert.equal(
        inspect(databasePath, (db) =>
          db.prepare('SELECT COUNT(*) AS n FROM purchase_order_receipts WHERE workspace_id = ?').get(state.workspaceId).n
        ),
        before.receipts
      );
    });

    await t.test('9. everything survives a restart', async () => {
      await stopServer(server);
      const restarted = startServer(databasePath);
      await waitForServer();
      try {
        await page.goto(`${BASE}${orderPath}`);
        const text = await page.locator('body').innerText();
        assert.match(text, /Received/);
        assert.equal(balance(databasePath, state), 10 + recommended.quantityUnits);
      } finally {
        await stopServer(restarted);
      }
    });

    await t.test('10. no page errors anywhere in the run', () => {
      assert.deepEqual(pageErrors, []);
    });
  }
);

// ---------------------------------------------------------------------------

test(
  'Mission 6 end to end: Foundry knows when NOT to buy',
  { skip: !config.ai.configured, timeout: 1200000 },
  async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-m6-nobuy-'));
    const databasePath = path.join(dataDir, 'e2e.db');
    // 40 on hand, 60 on order, 20 a month going out.
    const state = buildWorkspace(databasePath, { onHand: 40, monthlyUsage: 18, openOrderCases: 5 });

    const server = startServer(databasePath);
    await waitForServer();

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
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

    await t.test('0. forty on hand, sixty on order', async () => {
      await signIn(page);
      assert.equal(balance(databasePath, state), 40);
      assert.equal(onOrder(databasePath, state), 60);
    });

    await t.test('1. what should I order? — nothing, with the reason', async () => {
      await page.goto(`${BASE}/purchasing`);
      await shot(page, 'nothing-to-order');

      const text = await page.locator('body').innerText();
      assert.match(text, /Nothing is below its reorder point/);
      assert.match(text, /Everything was checked against how fast it sells and what is already on the way/);
      assert.match(text, /Nothing is below its reorder point/);
      assert.doesNotMatch(text, /Review ABC Footwear order/);
    });

    await t.test('2. the evidence shows the incoming stock doing the work', async () => {
      await page.goto(`${BASE}/purchasing/why/${state.skuId}`);
      await shot(page, 'nothing-why');

      const text = await page.locator('body').innerText();
      assert.match(text, /No additional order/);
      assert.match(text, /40/);
      assert.match(text, /60/);
      assert.match(text, /Inventory position/);
      assert.match(text, /100/);
    });

    await t.test('3. asking repeatedly never creates demand', async () => {
      for (let i = 0; i < 3; i += 1) {
        await page.goto(`${BASE}/purchasing`);
        assert.match(await page.locator('body').innerText(), /Nothing is below its reorder point/);
      }
      const orders = inspect(databasePath, (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?').get(state.workspaceId).n
      );
      assert.equal(orders, 1, 'the one open order, and nothing else');
    });

    await t.test('4. and Mission 3 does not warn about it either', async () => {
      await page.goto(`${BASE}/attention`);
      const text = await page.locator('body').innerText();
      assert.doesNotMatch(text, /Navy Oxford.*may run out/s);
      await shot(page, 'attention-quiet');
    });

    await t.test('5. no page errors', () => {
      assert.deepEqual(pageErrors, []);
    });
  }
);
