'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const inventory = require('../../src/domain/inventory-engine');
const policies = require('../../src/purchasing/policy-service');

test.after(cleanupAll);

async function submit(page, locator) {
  await Promise.all([page.waitForNavigation(), locator.click()]);
}

test('an owner applies replenishment rules to a selected product group in one browser action', { timeout:60000 }, async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName:'Bulk Replenishment UI' });
  const products = ['Bulk Alpha', 'Bulk Beta', 'Bulk Gamma'].map((name, index) =>
    makeQuantityItem(store.db, workspace.ctx, { name, baseCode:`BULK-${index + 1}` }));
  for (const product of products) {
    inventory.receive(store.db, workspace.ctx, {
      skuId:product.skuId, locationId:workspace.main.id, quantity:100,
    });
    for (let index = 0; index < 8; index += 1) {
      inventory.issue(store.db, workspace.ctx, {
        skuId:product.skuId, locationId:workspace.main.id, quantity:5, reasonCode:'sold',
      });
    }
  }
  store.db.exec('DROP TRIGGER IF EXISTS movements_no_update');
  store.db.prepare('UPDATE movements SET occurred_at = ? WHERE workspace_id = ?')
    .run(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), workspace.workspaceId);
  store.db.exec(`CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
    BEGIN SELECT RAISE(ABORT, 'movements are immutable'); END`);

  const app = createApp({ db:store.db, env:'test', sessionSecret:'bulk-rules-ui' });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless:process.env.UI_VISIBLE !== '1' });
  const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
  try {
    await page.goto(`${base}/login`);
    await page.getByLabel('Email', { exact:true }).fill(workspace.account.email);
    await page.getByLabel('Password', { exact:true }).fill(workspace.account.password);
    await submit(page, page.getByRole('button', { name:'Sign in', exact:true }));
    await page.goto(`${base}/purchasing/setup`);
    const body = await page.locator('main').innerText();
    assert.match(body, /Reorder points StockChief would set/i);
    assert.match(body, /Bulk Alpha/);
    assert.match(body, /Bulk Beta/);
    assert.match(body, /Bulk Gamma/);

    const form = page.locator('form[action="/purchasing/setup/policies"]');
    const checkboxes = form.locator('input[name="skuIds"]');
    assert.equal(await checkboxes.count(), 3);
    await checkboxes.nth(2).uncheck();
    await submit(page, form.getByRole('button', { name:'Set these reorder points', exact:true }));
    assert.match(await page.locator('main').innerText(), /Reorder points set for 2 line\(s\)/i);
    assert.equal(policies.effectivePolicy(store.db, workspace.workspaceId, products[0].skuId).isSet, true);
    assert.equal(policies.effectivePolicy(store.db, workspace.workspaceId, products[1].skuId).isSet, true);
    assert.equal(policies.effectivePolicy(store.db, workspace.workspaceId, products[2].skuId).isSet, false);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
