'use strict';

/**
 * Mission 5 against the real model.
 *
 * The deterministic mapper already handles files with sensible headers, and it
 * is tested offline. These tests use files it cannot read on its own — headers
 * that are abbreviations, internal jargon, or nothing at all — because that is
 * the only part of the import where the model earns its place.
 *
 * What is asserted is never "the model said the right thing" alone: it is that
 * the resulting import creates the right records, and that Foundry refuses the
 * things it must refuse regardless of how confidently the model answers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mappingService = require('../../src/imports/mapping-service');
const planService = require('../../src/imports/plan-service');
const executor = require('../../src/imports/executor');
const verification = require('../../src/imports/verification');
const parser = require('../../src/imports/parser');
const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');
const scenarios = require('../helpers/scenarios');

const LIVE = Boolean(process.env.ANTHROPIC_API_KEY);
const TIMEOUT = 120000;

test.after(cleanupAll);

function setup(model = { primaryArchetype: 'quantity', usesVariants: true }) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Live Import Co' });
  scenarios.configure(db, workspace.workspaceId, { inventoryModel: model });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, membership, ctx: workspace.ctx };
}

const sheetFrom = (text) => {
  const parsed = parser.parse({ text });
  return { ...parsed.sheets[parsed.primarySheet], sourceName: 'export.csv' };
};

const columnNamed = (sheet, index) => (sheet.columns.find((c) => c.index === index) || {}).name;

test('headers Foundry cannot read are named by the model', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  // Nothing here matches a known heading: this is an ERP export with internal
  // abbreviations, which is what a real customer's file usually looks like.
  const sheet = sheetFrom(
    [
      'MATNR,MAKTX,LGORT,LABST,NETPR',
      'CE-050,Copper Elbow 1/2in,Main Warehouse,140,2.40',
      'CE-075,Copper Tee 3/4in,Main Warehouse,86,3.10',
      'BF-10,Brass Fitting,Downtown Store,12,5.00',
    ].join('\n')
  );

  const result = await mappingService.proposeMappings(sheet);

  assert.equal(result.aiUsed, true);
  assert.equal(columnNamed(sheet, result.mappings.code), 'MATNR');
  assert.equal(columnNamed(sheet, result.mappings.name), 'MAKTX');
  assert.equal(columnNamed(sheet, result.mappings.location), 'LGORT');
  assert.equal(columnNamed(sheet, result.mappings.quantity), 'LABST');
  // A price column has nowhere to go, and is left alone rather than forced in.
  assert.ok(
    !Object.values(result.mappings).includes(4),
    `NETPR was mapped to ${JSON.stringify(result.mappings)}`
  );
  assert.equal(result.detectedType, 'inventory');
});

test('a column of values decides what it is, not its heading', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const sheet = sheetFrom(
    [
      'Product,Ref A,Ref B',
      'Laptop,SN-88213,each',
      'Laptop,SN-88214,each',
      'Laptop,SN-88215,each',
    ].join('\n')
  );

  const result = await mappingService.proposeMappings(sheet);

  // "Ref A" is unique per row — a serial. "Ref B" repeats and is a word.
  assert.equal(columnNamed(sheet, result.mappings.serial), 'Ref A');
  assert.notEqual(result.mappings.serial, result.mappings.unitLabel);
  assert.equal(result.detectedType, 'serials');
});

test('an opaque file imports into exactly the right records', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = setup();
  const { plan } = await planService.analyse(env.db, env.ctx, env.membership, {
    text: [
      'MATNR,MAKTX,LGORT,LABST',
      'CE-050,Copper Elbow,Main Warehouse,140',
      'CE-075,Copper Tee,Main Warehouse,86',
    ].join('\n'),
    filename: 'export.csv',
  });

  assert.equal(plan.recordsValid, 2, JSON.stringify(plan.warnings));
  planService.approve(env.db, env.ctx, env.membership, plan.id);
  const run = executor.execute(env.db, env.ctx, env.membership, plan.id);
  const verified = verification.verify(env.db, env.ctx.workspaceId, plan.id, run.executionId);

  assert.equal(run.result.itemsCreated, 2);
  assert.equal(run.result.unitsEstablished, 226);
  assert.equal(verified.verified, true, JSON.stringify(verified.problems));

  const elbow = env.db
    .prepare('SELECT * FROM items WHERE workspace_id = ? AND base_code = ?')
    .get(env.ctx.workspaceId, 'CE-050');
  assert.equal(elbow.name, 'Copper Elbow');
});

test('a file about things Foundry does not track imports nothing', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = setup();
  // A purchase-order report. There is no product list in it to import.
  const { plan } = await planService.analyse(env.db, env.ctx, env.membership, {
    text: [
      'PO Number,Supplier,Order Date,Order Total,Payment Terms',
      'PO-1001,Acme Supplies,2026-02-01,4820.00,Net 30',
      'PO-1002,Widgets Ltd,2026-02-03,912.50,Net 15',
    ].join('\n'),
    filename: 'purchase-orders.csv',
  });

  // Every column is something Foundry deliberately does not store, so there is
  // no product to create — and it says so rather than inventing two products
  // called PO-1001 and PO-1002.
  assert.equal(plan.fieldMappings.quantity, undefined);
  assert.equal(plan.fieldMappings.location, undefined);
  assert.ok(
    plan.recordsValid === 0 || plan.detectedType === 'unknown',
    `expected nothing importable, got ${plan.detectedType} with ${plan.recordsValid} valid rows`
  );
});

test('the model cannot make Foundry overwrite a product that exists', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = setup();
  itemService.createItem(env.db, env.ctx, {
    name: 'Copper Elbow',
    baseCode: 'CE-050',
    trackingMode: 'quantity',
    unitLabel: 'unit',
  });
  const before = env.db
    .prepare('SELECT * FROM items WHERE workspace_id = ? AND base_code = ?')
    .get(env.ctx.workspaceId, 'CE-050');

  const { plan } = await planService.analyse(env.db, env.ctx, env.membership, {
    text: ['MATNR,MAKTX,LGORT,LABST', 'CE-050,Copper Elbow REVISED,Main Warehouse,10'].join('\n'),
    filename: 'export.csv',
  });
  planService.approve(env.db, env.ctx, env.membership, plan.id);
  executor.execute(env.db, env.ctx, env.membership, plan.id);

  const after = env.db
    .prepare('SELECT * FROM items WHERE workspace_id = ? AND base_code = ?')
    .get(env.ctx.workspaceId, 'CE-050');
  assert.equal(after.id, before.id);
  assert.equal(after.name, 'Copper Elbow', 'the existing product must not be renamed by a file');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 1);

  // The stock did arrive, on the existing product.
  const balance = env.db
    .prepare(
      `SELECT SUM(on_hand) AS n FROM balances b JOIN skus s ON s.id = b.sku_id
        WHERE b.workspace_id = ? AND s.item_id = ?`
    )
    .get(env.ctx.workspaceId, before.id).n;
  assert.equal(balance, 10);
});

test('a variant file with jargon headings makes one product', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = setup();
  const { plan } = await planService.analyse(env.db, env.ctx, env.membership, {
    text: [
      'Style Desc,Attr 1,Attr 2,Whse,OH Qty',
      'Kids Sweater,Navy,4,Main Warehouse,10',
      'Kids Sweater,Navy,5,Main Warehouse,6',
      'Kids Sweater,Red,4,Main Warehouse,3',
      'Kids Sweater,Red,5,Main Warehouse,1',
    ].join('\n'),
    filename: 'seasonal.csv',
  });

  assert.equal(plan.detectedType, 'variant_inventory', JSON.stringify(plan.fieldMappings));
  planService.approve(env.db, env.ctx, env.membership, plan.id);
  const run = executor.execute(env.db, env.ctx, env.membership, plan.id);

  assert.equal(run.result.itemsCreated, 1);
  assert.equal(run.result.skusCreated, 4);
  assert.equal(run.result.unitsEstablished, 20);
});
