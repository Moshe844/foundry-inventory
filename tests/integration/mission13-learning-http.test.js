'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const auth = require('../../src/domain/auth-service');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const learning = require('../../src/learning/service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName:'Mission 13 Browser' });
  const membership = auth.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(store.db, workspace.ctx, { name:'City Runner', baseCode:'CITY' });
  const supplier = suppliers.createSupplier(store.db, workspace.ctx, membership,
    { name:'Northstar Footwear', defaultLeadTimeDays:10 });
  suppliers.linkItem(store.db, workspace.ctx, membership, { supplierId:supplier.id, skuId:item.skuId,
    supplierSku:'NORTH-CITY', purchaseUnit:'unit', unitsPerPurchaseUnit:1, lastUnitCost:20 });
  for (let n=0; n<4; n += 1) {
    const order = poService.createOrder(store.db, workspace.ctx, membership, { supplierId:supplier.id,
      destinationLocationId:workspace.main.id,
      lines:[{ skuId:item.skuId, quantityPurchaseUnits:2, unitCost:20 }] });
    poService.approve(store.db, workspace.ctx, membership, order.id, { markOrdered:true });
    const sent = new Date(Date.UTC(2026,0,1+n*20));
    const expected = new Date(sent.getTime()+10*86400000).toISOString().slice(0,10);
    const receivedAt = new Date(sent.getTime()+15*86400000).toISOString();
    store.db.prepare(`UPDATE purchase_orders SET ordered_at=?,approved_at=?,expected_date=?,
      expected_date_source='manual' WHERE id=?`).run(sent.toISOString(),sent.toISOString(),expected,order.id);
    const fresh = poService.get(store.db,workspace.workspaceId,order.id);
    receiving.receive(store.db,workspace.ctx,membership,order.id,{idempotencyKey:`http-learning-${n}`,
      receivedAt,lines:[{lineId:fresh.lines[0].id,quantityUnits:2,locationId:workspace.main.id}]});
  }
  const app = createApp({ db:store.db, env:'test', sessionSecret:'mission13-http' });
  return { ...store, app, workspace, membership, supplier };
}

test('owner sees one learned change, approves it, and can restore the previous policy after a bad outcome', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const page = await agent.get('/planning');
  assert.equal(page.status, 200);
  assert.match(plain(page.text), /What StockChief learned/i);
  assert.match(plain(page.text), /Northstar Footwear is configured at 10 days.*averaged 15 days/i);
  assert.match(plain(page.text), /Approve change/i);
  const item = learning.listProposals(env.db, env.workspace.workspaceId)[0];
  const needs = await agent.get('/needs-you');
  assert.match(plain(needs.text), /Plan Northstar Footwear at 15 days/i);
  const applied = await agent.post(`/planning/learning/${item.id}/approve`).type('form').send({
    _csrf:csrfFrom(page.text), integrityHash:item.integrityHash,
  });
  assert.equal(applied.status, 303);
  assert.equal(env.db.prepare('SELECT default_lead_time_days n FROM suppliers WHERE id=?')
    .get(env.supplier.id).n, 15);
  learning.monitor(env.db, env.workspace.workspaceId, item.id,
    { impact:-3, unit:'days', evidence:{ purchaseOrders:3 } });
  const warning = await agent.get('/planning');
  assert.match(plain(warning.text), /Restore previous policy/i);
  const restored = await agent.post(`/planning/learning/${item.id}/rollback`).type('form').send({
    _csrf:csrfFrom(warning.text),
  });
  assert.equal(restored.status, 303);
  assert.equal(env.db.prepare('SELECT default_lead_time_days n FROM suppliers WHERE id=?')
    .get(env.supplier.id).n, 10);
});

test('a viewer cannot use a hidden URL to approve a learned policy change', async () => {
  const env = setup();
  const item = learning.detectBias(env.db, env.workspace.workspaceId, { now:Date.UTC(2026,5,1) })[0];
  const staffAccount = env.db.prepare('SELECT a.email FROM accounts a JOIN users u ON u.account_id=a.id WHERE u.id=?')
    .get(env.workspace.staffId);
  const agent = request.agent(env.app);
  await signIn(agent, staffAccount.email, 'password123');
  const page = await agent.get('/planning');
  assert.doesNotMatch(plain(page.text), /Approve change/i);
  const response = await agent.post(`/planning/learning/${item.id}/approve`).type('form').send({
    _csrf:csrfFrom(page.text), integrityHash:item.integrityHash,
  });
  assert.equal(response.status, 303);
  assert.match(plain((await agent.get(response.headers.location)).text), /do not have permission/i);
  assert.equal(env.db.prepare('SELECT default_lead_time_days n FROM suppliers WHERE id=?')
    .get(env.supplier.id).n, 10);
});
