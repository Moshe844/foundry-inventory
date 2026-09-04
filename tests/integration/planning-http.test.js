'use strict';

/**
 * The planning surfaces, through HTTP.
 *
 * Forecasting is spread across five screens on purpose, and a template that
 * throws takes the whole screen with it — so the point of this file is less
 * about the arithmetic (that is covered elsewhere) and more that every page it
 * touches still renders, on a business with plenty of history and on one with
 * none at all.
 *
 * The empty case matters most. A new inventory has no demand to forecast, and
 * the failure everybody ships is a planning panel that renders "undefined" or
 * "NaN days" on somebody's first afternoon.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, cleanupAll, seedWorkspace, signIn, makeQuantityItem } = require('../helpers');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const supplierService = require('../../src/purchasing/supplier-service');
const purchasingPolicy = require('../../src/purchasing/policy-service');
const planning = require('../../src/forecasting/planning-service');

test.after(cleanupAll);

const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

async function traded() {
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db, { workspaceName: 'Planning Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small' });
  const supplier = supplierService.createSupplier(db, workspace.ctx, membership, {
    name: 'ABC Apparel', defaultLeadTimeDays: 10,
  });
  supplierService.linkItem(db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: item.skuId, supplierSku: 'BS-1', purchaseUnit: 'unit',
    unitsPerPurchaseUnit: 1, lastUnitCost: 4.5, leadTimeDays: 10, isPreferred: true,
  });

  inventory.receive(db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 6 * 100 + 250, occurredAt: ago(105),
  });
  for (let day = 100; day >= 1; day -= 1) {
    inventory.issue(db, workspace.ctx, {
      skuId: item.skuId, locationId: workspace.main.id, quantity: 6,
      reasonCode: 'sold', occurredAt: ago(day),
    });
  }
  purchasingPolicy.setPolicy(db, workspace.ctx, membership, item.skuId,
    { reorderPoint: 20, targetStock: 400 });
  planning.sweepAndRecord(db, workspace.workspaceId, {});

  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  return { db, app, agent, workspace, membership, item, supplier };
}

test('the planning page shows what is coming and offers the two answers', async () => {
  const env = await traded();
  const page = await env.agent.get('/planning');
  assert.equal(page.status, 200);

  assert.match(page.text, /What happens next/);
  assert.match(page.text, /Rules that no longer match the trade/);
  assert.match(page.text, /Use \d+/, 'the recommendation carries its own figure');
  assert.match(page.text, /Keep 20/, 'and the setting it would replace');
  assert.match(page.text, /Money asleep on a shelf/);
  assert.match(page.text, /Has Foundry been right\?/);
  assert.match(page.text, /What matters to you/);
  assert.doesNotMatch(page.text, /undefined|NaN/);
  env.db.close();
});

test('accepting a recommendation from the page changes the setting', async () => {
  const env = await traded();
  const before = purchasingPolicy.effectivePolicy(env.db, env.workspace.workspaceId, env.item.skuId);
  assert.equal(before.reorderPoint, 20);

  const page = await env.agent.get('/planning');
  const token = (page.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  // Named explicitly rather than taken from the first form on the page: the
  // page legitimately offers several, and a test that accepts whichever came
  // first is a test that changes meaning when the ordering does.
  const id = env.db.prepare(`SELECT id FROM planning_recommendations
    WHERE workspace_id = ? AND kind = 'reorder_point' AND status = 'OPEN'`)
    .get(env.workspace.workspaceId).id;
  assert.ok(page.text.includes(`/planning/recommendations/${id}/accept`),
    'the reorder point recommendation is on the page with a button');

  const posted = await env.agent.post(`/planning/recommendations/${id}/accept`)
    .type('form').send({ _csrf: token, returnTo: '/planning#rules' });
  assert.equal(posted.status, 303);

  const after = purchasingPolicy.effectivePolicy(env.db, env.workspace.workspaceId, env.item.skuId);
  assert.ok(after.reorderPoint > 20, `the level moved, was ${before.reorderPoint} now ${after.reorderPoint}`);
  env.db.close();
});

test('stating a goal is stored and shown back, and grants nothing', async () => {
  const env = await traded();
  const page = await env.agent.get('/planning');
  const token = (page.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];

  const posted = await env.agent.post('/planning/goals').type('form').send({
    _csrf: token, serviceLevel: 'protective', maxDaysOfSupply: '60', inventoryCap: '250000',
  });
  assert.equal(posted.status, 303);

  const after = await env.agent.get('/planning');
  assert.match(after.text, /Avoid stockouts/);
  assert.match(after.text, /value="60"/);

  // A goal is a preference, never a permission.
  const granted = env.db.prepare(`SELECT COUNT(*) AS n FROM autopilot_capabilities
    WHERE workspace_id = ? AND granted = 1`).get(env.workspace.workspaceId).n;
  assert.equal(granted, 0, 'saying what matters authorises nothing');
  env.db.close();
});

test('the product page carries the outlook, its working, and the two buttons', async () => {
  const env = await traded();
  const page = await env.agent.get(`/inventory/${env.item.itemId}`);
  assert.equal(page.status, 200);

  assert.match(page.text, /What happens next/);
  assert.match(page.text, /See how I worked this out/);
  assert.match(page.text, /High confidence|Moderate confidence|Still learning/);
  assert.match(page.text, /\/planning\/recommendations\/rec_[a-z0-9]+\/accept/);
  assert.doesNotMatch(page.text, /undefined|NaN/);
  env.db.close();
});

test('purchasing says what is coming short and the supplier page says whether they turn up', async () => {
  const env = await traded();

  const purchasing = await env.agent.get('/purchasing');
  assert.equal(purchasing.status, 200);
  assert.doesNotMatch(purchasing.text, /undefined|NaN/);

  const supplier = await env.agent.get(`/suppliers/${env.supplier.id}`);
  assert.equal(supplier.status, 200);
  assert.doesNotMatch(supplier.text, /undefined|NaN/);
  // No delivered orders yet, so Foundry must not be claiming a record.
  assert.doesNotMatch(supplier.text, /Do they turn up\?/,
    'a supplier with no deliveries gets no reliability panel at all');
  env.db.close();
});

test('a brand new inventory renders every planning surface without inventing anything', async () => {
  const { db, app } = makeApp();
  const workspace = seedWorkspace(db, { workspaceName: 'Day One Co' });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Never Sold' });
  inventory.receive(db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 12,
  });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const planningPage = await agent.get('/planning');
  assert.equal(planningPage.status, 200);
  assert.match(planningPage.text, /Nothing Foundry can measure a sales rate for/);
  assert.match(planningPage.text, /No forecast has reached the end of its horizon yet/);
  assert.doesNotMatch(planningPage.text, /undefined|NaN/);

  const product = await agent.get(`/inventory/${item.itemId}`);
  assert.equal(product.status, 200);
  assert.match(product.text, /cannot estimate how fast this sells yet/);
  assert.doesNotMatch(product.text, /undefined|NaN/);

  const home = await agent.get('/');
  assert.equal(home.status, 200);
  assert.doesNotMatch(home.text, /undefined|NaN/);
  db.close();
});
