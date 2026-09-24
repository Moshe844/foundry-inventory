'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createCanvas, loadImage, PDFDocument } = require('@napi-rs/canvas');
const { chromium } = require('playwright');
const config = require('../../src/config');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');
const inventory = require('../../src/domain/inventory-engine');

test.after(cleanupAll);

async function submit(page, locator) {
  await Promise.all([page.waitForNavigation(), locator.click()]);
}

async function login(page, base, workspace) {
  await page.goto(`${base}/login`);
  await page.getByLabel('Email', { exact:true }).fill(workspace.account.email);
  await page.getByLabel('Password', { exact:true }).fill(workspace.account.password);
  await submit(page, page.getByRole('button', { name:'Sign in', exact:true }));
}

async function launch(store, options = {}) {
  const app = createApp({ db:store.db, env:'test', sessionSecret:'import-safety-ui', ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch({ headless:process.env.UI_VISIBLE !== '1' });
  const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
  return {
    app, server, browser, page, base:`http://127.0.0.1:${server.address().port}`,
    async close() {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function openingInventoryPdf(file) {
  const canvas = createCanvas(1600, 1000);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 1600, 1000);
  context.fillStyle = '#000';
  context.font = 'bold 64px Arial';
  context.fillText('OPENING INVENTORY SNAPSHOT', 70, 110);
  context.font = '40px Arial';
  context.fillText('Current stock physically on hand — September 22, 2026', 70, 190);
  context.fillText('Location: Main Warehouse', 70, 270);
  context.fillText('SKU     Product                    Variant       Quantity', 70, 380);
  context.fillText('MUG-BLU Travel Mug                Blue          18', 70, 460);
  context.fillText('MUG-RED Travel Mug                Red           12', 70, 530);
  context.fillText('TOTAL CURRENT STOCK ON HAND: 30 units', 70, 650);
  context.fillText('This is a physical count, not a purchase order or invoice.', 70, 730);
  const image = await loadImage(canvas.toBuffer('image/png'));
  const pdf = new PDFDocument();
  const pdfContext = pdf.beginPage(1600, 1000);
  pdfContext.drawImage(image, 0, 0, 1600, 1000);
  pdf.endPage();
  fs.writeFileSync(file, pdf.close());
}

test('an opening-inventory PDF is recognized and applied as opening stock, never purchasing activity',
  { skip:!config.ai.configured, timeout:300000 }, async () => {
    const store = makeDatabase();
    const workspace = seedWorkspace(store.db, { workspaceName:'PDF Opening Inventory UI' });
    const runtime = await launch(store);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockchief-pdf-ui-'));
    const file = path.join(directory, 'opening-inventory-snapshot.pdf');
    await openingInventoryPdf(file);
    try {
      await login(runtime.page, runtime.base, workspace);
      await runtime.page.goto(`${runtime.base}/foundry/describe`);
      await runtime.page.setInputFiles('input[name="source"]', file);
      await Promise.all([
        runtime.page.waitForURL(/\/foundry\/thinking\//),
        runtime.page.getByRole('button', { name:/Understand my inventory/i }).click(),
      ]);
      await runtime.page.waitForURL(/\/foundry\/proposal\//, { timeout:240000 });
      const body = await runtime.page.locator('main').innerText();
      assert.match(body, /snapshot of what you have right now/i);
      assert.match(body, /set your opening stock to the 30 units listed/i);
      assert.match(body, /stock report|stock list is a count of goods that already exist/i);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?')
        .get(workspace.workspaceId).n, 0);
      await submit(runtime.page, runtime.page.getByRole('button', { name:/Set up and add 30 units to stock/i }));
      assert.match(await runtime.page.locator('main').innerText(), /30 units/i);
      assert.equal(store.db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?')
        .get(workspace.workspaceId).n, 30);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?')
        .get(workspace.workspaceId).n, 0);
    } finally {
      await runtime.close();
      fs.rmSync(directory, { recursive:true, force:true });
    }
  });

test('an unexpected import failure halfway leaves no products, movements, or balances behind',
  { timeout:60000 }, async () => {
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const store = makeDatabase();
    const workspace = seedWorkspace(store.db, { workspaceName:'Atomic Import UI' });
    const runtime = await launch(store);
    const originalReceive = inventory.receive;
    let receives = 0;
    try {
      await login(runtime.page, runtime.base, workspace);
      await runtime.page.goto(`${runtime.base}/imports`);
      await runtime.page.locator('textarea[name="pasted"]').fill([
        'Item,SKU,Qty,Location',
        'Atomic Alpha,ATOMIC-A,5,Main Warehouse',
        'Atomic Beta,ATOMIC-B,7,Main Warehouse',
      ].join('\n'));
      await submit(runtime.page, runtime.page.getByRole('button', { name:'Read what I pasted', exact:true }));
      const importUrl = runtime.page.url();
      await submit(runtime.page, runtime.page.getByRole('button', { name:/Approve 2 rows/i }));
      inventory.receive = (...args) => {
        receives += 1;
        if (receives === 2) throw new Error('synthetic crash during second import row');
        return originalReceive(...args);
      };
      const responsePromise = runtime.page.waitForResponse((response) =>
        response.url().endsWith('/run') && response.request().method() === 'POST');
      await runtime.page.getByRole('button', { name:'Import it', exact:true }).click();
      const response = await responsePromise;
      assert.equal(response.status(), 303);
      await runtime.page.waitForLoadState('domcontentloaded');
      assert.match(await runtime.page.locator('body').innerText(), /went wrong|could not|try again/i);
      inventory.receive = originalReceive;
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?')
        .get(workspace.workspaceId).n, 0);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?')
        .get(workspace.workspaceId).n, 0);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM balances WHERE workspace_id = ? AND on_hand != 0')
        .get(workspace.workspaceId).n, 0);
      const execution = store.db.prepare('SELECT status, error_message FROM import_executions WHERE workspace_id = ?')
        .get(workspace.workspaceId);
      assert.equal(execution.status, 'FAILED');
      assert.match(execution.error_message, /synthetic crash/i);
      await runtime.page.goto(importUrl);
      const body = await runtime.page.locator('main').innerText();
      assert.match(body, /Needs checking|failed|stopped/i);
      assert.doesNotMatch(body, /Verified against your inventory/i);
    } finally {
      inventory.receive = originalReceive;
      await runtime.close();
      if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
  });
