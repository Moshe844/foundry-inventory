'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const auth = require('../../src/domain/auth-service');
const connections = require('../../src/connections/service');
const repairs = require('../../src/repairs/service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

test('an owner reports a real incorrect product match in StockChief and it becomes one Needs You repair', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Owner Repair Co' });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  const wrongProduct = makeQuantityItem(db, workspace.ctx, { name: 'Wrong Shoe' });
  const correctProduct = makeQuantityItem(db, workspace.ctx, { name: 'Correct Shoe' });
  const connection = connections.create(db, workspace.ctx, membership, {
    providerType: 'reference_webhook', displayName: 'Owner POS',
  }).connection;
  const mapping = connections.mapExternal(db, workspace.ctx, connection.id, {
    entityType: 'sku', externalId: 'SHOE-35', foundryRecordId: wrongProduct.skuId,
  });
  const app = createApp({ db, env: 'test', sessionSecret: 'owner-repair-http' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const report = await agent.get(`/repairs/report?connectorId=${connection.id}`).expect(200);
  assert.match(plain(report.text), /Report something that looks wrong.*Owner POS.*SHOE-35.*Wrong Shoe/i);
  const opened = await agent.post('/repairs/report/wrong-mapping').type('form').send({
    _csrf: csrfFrom(report.text), mappingId: mapping.id, correctSkuId: correctProduct.skuId,
    note: 'Sales are appearing under the wrong shoe.',
  }).expect(303);
  assert.match(opened.headers.location, /^\/repairs\/repair_/);

  const needs = plain((await agent.get('/needs-you').expect(200)).text);
  assert.equal((needs.match(/SHOE-35 is connected to the wrong StockChief product/g) || []).length, 1);
  assert.match(needs, /Authorize the repair/i);
  assert.match(needs, /Report something else wrong/i);
  const repair = repairs.list(db, workspace.workspaceId, { statuses: 'NEEDS_AUTHORITY' })[0];
  assert.equal(repair.affectedRecords.foundryRecordId, correctProduct.skuId);
  assert.equal(repair.evidence.some((row) => row.source === 'owner_report'), true);
  assert.equal(connections.mapping(db, workspace.workspaceId, connection.id, 'sku', 'SHOE-35').foundry_record_id,
    wrongProduct.skuId, 'reporting and simulation cannot silently change the mapping');

  // A repeated browser submission is idempotent and does not create a second owner decision.
  const again = await agent.get('/repairs/report').expect(200);
  await agent.post('/repairs/report/wrong-mapping').type('form').send({
    _csrf: csrfFrom(again.text), mappingId: mapping.id, correctSkuId: correctProduct.skuId,
  }).expect(303);
  assert.equal(repairs.list(db, workspace.workspaceId, { statuses: 'NEEDS_AUTHORITY' }).length, 1);
  db.close();
});

test('Needs You compresses a mismatch into one simulated repair and the browser flow verifies it', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Repair Browser Co' });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  const oldProduct = makeQuantityItem(db, workspace.ctx, { name: 'Wrong Product' });
  const correctProduct = makeQuantityItem(db, workspace.ctx, { name: 'Correct Product' });
  const connection = connections.create(db, workspace.ctx, membership, {
    providerType: 'reference_webhook', displayName: 'Store POS',
  }).connection;
  connections.mapExternal(db, workspace.ctx, connection.id, {
    entityType: 'sku', externalId: 'POS-100', foundryRecordId: oldProduct.skuId,
  });
  const repair = repairs.openAndAssess(db, workspace.ctx, {
    kind: 'wrong_mapping', symptom: 'POS-100 is connected to the wrong StockChief product',
    failedInvariant: 'External product POS-100 must resolve to the owner-approved StockChief SKU',
    affectedRecords: { connectorId: connection.id, entityType: 'sku', externalId: 'POS-100',
      foundryRecordId: correctProduct.skuId },
    evidence: [{ source: 'owner confirmation', expectedSkuId: correctProduct.skuId }],
    idempotencyKey: 'browser-wrong-mapping',
  }).repairCase;
  const app = createApp({ db, env: 'test', sessionSecret: 'repairs-http' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const needs = await agent.get('/needs-you').expect(200);
  assert.equal((plain(needs.text).match(/POS-100 is connected to the wrong StockChief product/g) || []).length, 1,
    'one failed invariant becomes one owner decision');
  assert.match(needs.text, new RegExp(`/repairs/${repair.id}`));

  let detail = await agent.get(`/repairs/${repair.id}`).expect(200);
  let text = plain(detail.text);
  assert.match(text, /What StockChief found.*What the repair would do.*One next step/i);
  assert.match(text, /Historical business records are not rewritten/i);
  assert.match(detail.text, /owner confirmation/i, 'opening evidence survives deterministic diagnosis');
  assert.match(text, /Approve this repair/i);
  assert.equal(connections.mapping(db, workspace.workspaceId, connection.id, 'sku', 'POS-100').foundry_record_id,
    oldProduct.skuId, 'opening and simulating the screen changes nothing');

  await agent.post(`/repairs/${repair.id}/approve`).type('form')
    .send({ _csrf: csrfFrom(detail.text) }).expect(303);
  detail = await agent.get(`/repairs/${repair.id}`).expect(200);
  assert.match(plain(detail.text), /Run and verify repair/i);
  await agent.post(`/repairs/${repair.id}/execute`).type('form')
    .send({ _csrf: csrfFrom(detail.text) }).expect(303);

  const finished = plain((await agent.get(`/repairs/${repair.id}`).expect(200)).text);
  assert.match(finished, /RESOLVED.*What StockChief verified.*Passed/i);
  assert.equal(connections.mapping(db, workspace.workspaceId, connection.id, 'sku', 'POS-100').foundry_record_id,
    correctProduct.skuId);
  assert.equal(repairs.list(db, workspace.workspaceId, { statuses: repairs.ACTIVE }).length, 0);
  db.close();
});
