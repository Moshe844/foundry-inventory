'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const { after } = require('node:test');
const { makeApp, cleanupAll, seedWorkspace, signIn, plain } = require('../helpers');
const migrations = require('../../src/onboarding/canonical-migration');
const ownerMigration = require('../../src/onboarding/owner-migration');
const publicApi = require('../../src/connections/public-api');
const { multipart } = require('../../src/web/multipart');
const { errorHandler } = require('../../src/web/middleware');

after(cleanupAll);

test('the owner sees staged source truth, reconciliation and the gated cutover in the browser', async () => {
  const store = makeApp();
  const seeded = seedWorkspace(store.db);
  const member = { role: 'owner' };
  const pkg = migrations.createPackage(store.db, seeded.ctx, member, {
    sourceNamespace: 'browser-source', sourceLabel: 'Previous system', sourceSnapshotHash: 'browser-1',
  });
  migrations.stagePage(store.db, seeded.ctx, member, pkg.id, [
    { entityType: 'product', sourceKey: 'p1', payload: { name: 'Browser product', trackingMode: 'quantity',
      variants: [{ sourceKey: 's1', code: 'BROWSER-1' }] } },
  ]);
  migrations.validate(store.db, seeded.ctx, member, pkg.id);
  const agent = request.agent(store.app);
  await signIn(agent, seeded.account.email);
  const response = await agent.get(`/onboarding/migrations/${pkg.id}`);
  assert.equal(response.status, 200);
  const text = plain(response.text);
  assert.match(text, /The source totals match. Approve the switch/);
  assert.match(text, /StockChief records prepared 1/);
  assert.match(text, /Approve and switch/);
  const needsYou = plain((await agent.get('/needs-you')).text);
  assert.match(needsYou,/Previous system is verified and ready to become live/);
  assert.match(needsYou,/Review and switch/);
});

test('a completed source analysis redirects to one visible serial-evidence decision instead of a dead end', async () => {
  const store = makeApp();
  const seeded = seedWorkspace(store.db);
  const member = { role:'owner' };
  const pkg = migrations.createPackage(store.db,seeded.ctx,member,{
    sourceNamespace:'browser-serial-gap',sourceLabel:'Any inventory export',sourceSnapshotHash:'serial-gap-browser-1',
  });
  migrations.stagePage(store.db,seeded.ctx,member,pkg.id,[
    { entityType:'location',sourceKey:'L1',payload:{ name:'Main',kind:'warehouse' } },
    { entityType:'product',sourceKey:'P1',payload:{ name:'Serialized device',trackingMode:'serial' } },
    { entityType:'sku',sourceKey:'S1',payload:{ productKey:'P1',code:'DEVICE-1' } },
    { entityType:'inventory_position',sourceKey:'POS1',payload:{ skuKey:'S1',locationKey:'L1',quantity:7 } },
  ]);
  assert.equal(migrations.validate(store.db,seeded.ctx,member,pkg.id).problems,1);
  const agent = request.agent(store.app);
  await signIn(agent,seeded.account.email);

  const oldSourcesPage = await agent.get(`/onboarding/migrations/${pkg.id}/sources`);
  assert.equal(oldSourcesPage.status,303);
  assert.equal(oldSourcesPage.headers.location,`/onboarding/migrations/${pkg.id}`);

  const report = plain((await agent.get(`/onboarding/migrations/${pkg.id}`)).text);
  assert.match(report,/One decision is needed before StockChief can continue/);
  assert.match(report,/Accept recommendation and continue/);
  assert.doesNotMatch(report,/Run verification again/);
  assert.ok(report.indexOf('Accept recommendation and continue') < report.indexOf('Source rows prepared'));
});

test('the owner upload names every file, needs no manual source label and returns an in-page destination', async () => {
  const store = makeApp();
  const seeded = seedWorkspace(store.db);
  const agent = request.agent(store.app);
  const session = await signIn(agent,seeded.account.email);
  const token = await session.token('/onboarding/migrations/new');

  const screen = await agent.get('/onboarding/migrations/new');
  assert.equal(screen.status,200);
  assert.match(screen.text,/data-migration-upload/);
  assert.doesNotMatch(screen.text,/name="sourceLabel" required/);

  const response = await agent.post('/onboarding/migrations/new')
    .set('Accept','application/json')
    .field('_csrf',token)
    .attach('files',Buffer.from('SKU,Product,Quantity\nOWNER-1,Owner product,8'),{
      filename:'the-owner-file.csv',contentType:'text/csv',
    });
  assert.equal(response.status,201);
  assert.equal(response.body.ok,true);
  assert.match(response.body.location,/^\/onboarding\/migrations\/mig_[^/]+\/sources$/);

  const packageRow = store.db.prepare('SELECT source_label FROM migration_packages WHERE workspace_id=? ORDER BY created_at DESC LIMIT 1')
    .get(seeded.workspaceId);
  assert.equal(packageRow.source_label,'Existing inventory records');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM migration_sources WHERE workspace_id=? AND name='the-owner-file.csv'")
    .get(seeded.workspaceId).n,1);
});

test('a failed owner upload reports the exact filename without redirecting away', async () => {
  const store = makeApp();
  const seeded = seedWorkspace(store.db);
  const agent = request.agent(store.app);
  const session = await signIn(agent,seeded.account.email);
  const token = await session.token('/onboarding/migrations/new');
  const brokenZip = Buffer.alloc(30);
  brokenZip.writeUInt32LE(0x04034b50,0);

  const response = await agent.post('/onboarding/migrations/new')
    .set('Accept','application/json')
    .field('_csrf',token)
    .attach('files',brokenZip,{ filename:'warehouse-truth.xlsx',contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  assert.equal(response.status,400);
  assert.equal(response.body.ok,false);
  assert.match(response.body.message,/warehouse-truth\.xlsx/);
  assert.deepEqual(response.body.files.map((file) => file.name),['warehouse-truth.xlsx']);
});

test('an unfinished migration replaces the empty-home dead end without asking for understood raw fields', async () => {
  const store = makeApp(); const seeded = seedWorkspace(store.db); const member = { role:'owner' };
  const text = 'InventoryID,SKU,LocationID,OnHand,Reserved\nINV-1,BOOT-9,MAIN,7,2';
  const intake = ownerMigration.createFromFiles(store.db,seeded.ctx,member,{ files:[{
    filename:'current-system.csv',buffer:Buffer.from(text),size:Buffer.byteLength(text),field:'files',
  }] });
  assert.equal(intake.datasets[0].status,'READY_TO_STAGE');
  const agent = request.agent(store.app);
  await signIn(agent,seeded.account.email);
  const home = plain((await agent.get('/')).text);
  assert.match(home,/Your workbook is saved. Nothing was cleared/);
  assert.match(home,/Continue migration/);
  assert.doesNotMatch(home,/This inventory is empty. Let's fill it/);
  const needs = plain((await agent.get('/needs-you')).text);
  assert.match(needs,/current-system.csv/);
  assert.match(needs,/Nothing is live yet/);
});

test('an upload rejected at the deployment boundary returns a useful 413 instead of aborting the browser connection', async () => {
  const app = express();
  app.use((req,res,next) => { req.db = { prepare() { return { run() {} }; } }; next(); });
  app.use(multipart({ limit:64,maxFiles:2 }));
  app.post('/upload',(req,res) => res.json({ ok:true }));
  app.use(errorHandler(false));
  const response = await request(app).post('/upload').set('Accept','application/json')
    .attach('files',Buffer.alloc(256),{ filename:'large-source.csv',contentType:'text/csv' });
  assert.equal(response.status,413);
  assert.match(response.body.error.message,/deployment can safely receive/);
});

test('a connector can stage evidence through the generic API but cannot approve its own cutover', async () => {
  const store = makeApp();
  const seeded = seedWorkspace(store.db);
  const client = publicApi.create(store.db, seeded.ctx, {
    name: 'Migration connector', scopes: ['migration:read', 'migration:write'],
  });
  const created = await request(store.app).post('/api/v1/public/migrations')
    .set('Authorization', `Bearer ${client.token}`).set('Idempotency-Key', 'create-1')
    .send({ sourceNamespace: 'generic-source', sourceLabel: 'Generic source', sourceSnapshotHash: 'api-1' });
  assert.equal(created.status, 201);
  const packageId = created.body.result.id;
  const staged = await request(store.app).post(`/api/v1/public/migrations/${packageId}/records`)
    .set('Authorization', `Bearer ${client.token}`).set('Idempotency-Key', 'stage-1')
    .send({ records: [{ entityType: 'product', sourceKey: 'p1', payload: {
      name: 'API product', trackingMode: 'quantity', variants: [{ sourceKey: 'sku1', code: 'API-1' }],
    } }] });
  assert.equal(staged.status, 201);
  const validated = await request(store.app).post(`/api/v1/public/migrations/${packageId}/validate`)
    .set('Authorization', `Bearer ${client.token}`).set('Idempotency-Key', 'validate-1').send({});
  assert.equal(validated.status, 200);
  assert.equal(validated.body.result.package.status, 'READY');
  const cannotApprove = await request(store.app).post(`/api/v1/public/migrations/${packageId}/approve`)
    .set('Authorization', `Bearer ${client.token}`).set('Idempotency-Key', 'approve-1').send({});
  assert.equal(cannotApprove.status, 403);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM items WHERE workspace_id = ? AND name = 'API product'")
    .get(seeded.workspaceId).n, 0);
});

test('a connector may propose unfamiliar mappings and deltas but owner authority remains separate', async () => {
  const store = makeApp(); const seeded = seedWorkspace(store.db);
  const client = publicApi.create(store.db,seeded.ctx,{ name:'Custom source connector',
    scopes:['migration:read','migration:write'] });
  const headers = (key) => ({ Authorization:`Bearer ${client.token}`,'Idempotency-Key':key });
  const created = await request(store.app).post('/api/v1/public/migrations').set(headers('live-create')).send({
    sourceNamespace:'customer-built-api',sourceSnapshotHash:'live-api-1',cutoverMode:'SNAPSHOT_DELTA',
    sourceCheckpoint:'cursor-1',sourceSnapshotAt:'2026-09-14T12:00:00.000Z',
  });
  assert.equal(created.status,201); const packageId = created.body.result.id;
  const proposed = await request(store.app).post(`/api/v1/public/migrations/${packageId}/mappings`)
    .set(headers('mapping-propose')).send({ sourceDataset:'Products',entityType:'product',
      columns:[{ name:'External ID' },{ name:'Name' },{ name:'Unfamiliar Flag' }] });
  assert.equal(proposed.status,201); const profileId = proposed.body.result.id;
  const premature = await request(store.app).post(`/api/v1/public/migrations/mappings/${profileId}/rows`)
    .set(headers('mapping-stage-early')).send({ rows:[{ 'External ID':'A','Name':'Assembly','Unfamiliar Flag':'x' }] });
  assert.equal(premature.status,409);
  const started = await request(store.app).post(`/api/v1/public/migrations/${packageId}/delta/start`)
    .set(headers('delta-start')).send({ sourceCursor:'cursor-1' });
  assert.equal(started.status,200);
  const delta = await request(store.app).post(`/api/v1/public/migrations/${packageId}/delta/records`)
    .set(headers('delta-page')).send({ sourceCursor:'cursor-2',changes:[{ operation:'UPSERT',record:{
      entityType:'product',sourceKey:'B',payload:{ name:'Delta assembly' } } }] });
  assert.equal(delta.status,201);
  const cannotFreeze = await request(store.app).post(`/api/v1/public/migrations/${packageId}/freeze`)
    .set(headers('freeze-attempt')).send({ finalCheckpoint:'cursor-2' });
  assert.equal(cannotFreeze.status,403);
  assert.equal(store.db.prepare('SELECT source_frozen_at FROM migration_packages WHERE id=?').get(packageId).source_frozen_at,null);
});
