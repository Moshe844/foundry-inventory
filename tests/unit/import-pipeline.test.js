'use strict';

/**
 * Mission 5: a file becoming inventory.
 *
 * The tests that matter most here are the ones about what Foundry refuses to
 * do — invent a quantity, guess a date, merge two products that look alike,
 * import the same file twice, or touch another workspace. Getting an easy file
 * in is table stakes; those are the properties that make it safe on real data.
 *
 * No AI provider is used anywhere in this file. Everything asserted below is
 * deterministic, which is the point: the model proposes column names and
 * nothing else, so the pipeline has to work without it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fields = require('../../src/imports/fields');
const mappingService = require('../../src/imports/mapping-service');
const rowValidator = require('../../src/imports/row-validator');
const planService = require('../../src/imports/plan-service');
const executor = require('../../src/imports/executor');
const verification = require('../../src/imports/verification');
const presenter = require('../../src/imports/presenter');
const parser = require('../../src/imports/parser');
const multipart = require('../../src/web/multipart');
const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const locationService = require('../../src/domain/location-service');
const inventoryQuery = require('../../src/domain/inventory-query');
const { makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace } = require('../helpers');
const scenarios = require('../helpers/scenarios');

test.after(cleanupAll);

function setup(model = { primaryArchetype: 'quantity', usesVariants: true }) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Import Test Co' });
  scenarios.configure(db, workspace.workspaceId, { inventoryModel: model });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, membership, ctx: workspace.ctx };
}

/** Parses text the way an upload would, giving the sheet the services expect. */
function sheetFrom(text) {
  const parsed = parser.parse({ text });
  return parsed.sheets[parsed.primarySheet];
}


/**
 * Analyses a file the way the deterministic path does.
 *
 * The column mappings are computed here and handed over, which keeps this suite
 * offline and repeatable. It is not a shortcut around the thing being tested:
 * every file below has headings the rules recognise on their own, and the AI
 * mapping layer has its own live tests. A unit test that quietly depended on a
 * model call was flaky exactly when the model chose differently.
 */
async function analyse(env, text, options = {}) {
  const parsed = parser.parse({ text });
  const sheet = parsed.sheets[parsed.primarySheet];
  const guess = fields.guessMappings(sheet.columns, sheet.rows);

  return planService.analyse(env.db, env.ctx, env.membership, {
    text,
    filename: options.filename || 'stock.csv',
    mappings: guess.mappings,
    detectedType: fields.detectType(guess.mappings),
    ...options,
  });
}

const CSV = [
  'Item Name,SKU,Warehouse,Qty On Hand,Unit Cost,Supplier',
  'Copper Elbow,CE-050,Main Warehouse,140,2.40,Acme',
  'Copper Tee,CE-075,Main Warehouse,86,3.10,Acme',
  'Brass Fitting,BF-10,Downtown Store,12,5.00,Widgets Ltd',
].join('\n');

// --- naming the columns ------------------------------------------------------

test('the obvious columns are recognised without asking a model', () => {
  const sheet = sheetFrom(CSV);
  const { mappings, ignored } = fields.guessMappings(sheet.columns, sheet.rows);

  assert.equal(sheet.columns[mappings.name].name, 'Item Name');
  assert.equal(sheet.columns[mappings.code].name, 'SKU');
  assert.equal(sheet.columns[mappings.location].name, 'Warehouse');
  assert.equal(sheet.columns[mappings.quantity].name, 'Qty On Hand');
  // The cost is what the stock is worth, so it is read rather than dropped.
  assert.equal(sheet.columns[mappings.unitCost].name, 'Unit Cost');
  // Recognised, and deliberately not imported.
  assert.deepEqual(
    ignored.map((column) => column.name).sort(),
    ['Supplier']
  );
});

test('a column headed like a quantity but full of words is not a quantity', () => {
  const sheet = sheetFrom(['Product,Units,Count', 'Widget,box,12', 'Gadget,case,4'].join('\n'));
  const { mappings } = fields.guessMappings(sheet.columns, sheet.rows);

  assert.equal(sheet.columns[mappings.unitLabel].name, 'Units');
  assert.equal(sheet.columns[mappings.quantity].name, 'Count');
});

test('a file with only a description column still has a product name', () => {
  const sheet = sheetFrom(['Description,Qty', 'Copper Elbow 1/2in,10'].join('\n'));
  const { mappings, assumptions } = fields.guessMappings(sheet.columns, sheet.rows);

  assert.equal(sheet.columns[mappings.name].name, 'Description');
  assert.equal(mappings.description, undefined);
  assert.match(assumptions[0], /read as the product name/);
});

test('the file type follows from the columns, not from a claim', () => {
  assert.equal(fields.detectType({ name: 0 }), 'catalog');
  assert.equal(fields.detectType({ name: 0, quantity: 1 }), 'inventory');
  assert.equal(fields.detectType({ name: 0, quantity: 1, variant1: 2 }), 'variant_inventory');
  assert.equal(fields.detectType({ name: 0, serial: 1 }), 'serials');
  assert.equal(fields.detectType({ name: 0, lotCode: 1 }), 'lots');
  assert.equal(fields.detectType({}), 'unknown');
});

test("the model cannot overrule a column Foundry matched confidently", () => {
  const sheet = sheetFrom(CSV);
  const guess = fields.guessMappings(sheet.columns, sheet.rows);
  const profilesByIndex = Object.fromEntries(guess.profiles.map((p) => [p.index, p]));

  const { mappings, rejected } = mappingService.reconcile(
    { columns: [{ index: 4, field: 'quantity', axisName: '' }] },   // "Unit Cost"
    { columns: sheet.columns, deterministic: guess.mappings, confident: guess.confident, profilesByIndex }
  );

  assert.equal(mappings.quantity, guess.mappings.quantity);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].because, /already matched/i);
});

test('the model cannot map a quantity onto a column of words', () => {
  const sheet = sheetFrom(['Product,Notes\nWidget,blue one'].join('\n'));
  const guess = fields.guessMappings(sheet.columns, sheet.rows);
  const profilesByIndex = Object.fromEntries(guess.profiles.map((p) => [p.index, p]));

  const { mappings, rejected } = mappingService.reconcile(
    { columns: [{ index: 1, field: 'quantity', axisName: '' }] },
    { columns: sheet.columns, deterministic: {}, confident: [], profilesByIndex }
  );

  assert.equal(mappings.quantity, undefined);
  assert.match(rejected[0].because, /does not hold numbers/);
});

test('a column index the file does not have is ignored', () => {
  const sheet = sheetFrom(CSV);
  const { mappings } = mappingService.reconcile(
    { columns: [{ index: 99, field: 'name', axisName: '' }] },
    { columns: sheet.columns, deterministic: {}, confident: [], profilesByIndex: {} }
  );
  assert.deepEqual(mappings, {});
});

// --- reading values ----------------------------------------------------------

test('quantities are read, and impossible ones are refused rather than rounded', () => {
  assert.equal(rowValidator.readQuantity('1,200').value, 1200);
  assert.equal(rowValidator.readQuantity(' 42 ').value, 42);
  assert.equal(rowValidator.readQuantity('').missing, true);
  assert.equal(rowValidator.readQuantity('12.5').problem, 'fractional_quantity');
  assert.equal(rowValidator.readQuantity('-3').problem, 'negative_quantity');
  assert.equal(rowValidator.readQuantity('lots').problem, 'bad_quantity');
});

test('an ambiguous date column is left blank rather than guessed', () => {
  // Nothing in this column says which number is the month.
  const order = rowValidator.detectDateOrder(['03/04/2025', '05/06/2025']);
  assert.equal(order.certain, false);
  const read = rowValidator.readDate('03/04/2025', order.order);
  assert.equal(read.value, null);
  assert.equal(read.ambiguous, true);
});

test('one unambiguous date settles the whole column', () => {
  const order = rowValidator.detectDateOrder(['25/12/2025', '03/04/2025']);
  assert.deepEqual(order, { order: 'dmy', certain: true });
  assert.equal(rowValidator.readDate('03/04/2025', order.order).value, '2025-04-03');
  assert.equal(rowValidator.readDate('2025-04-03', order.order).value, '2025-04-03');
  assert.equal(rowValidator.readDate('3 Apr 2025', order.order).value, '2025-04-03');
});

// --- validating rows ---------------------------------------------------------

test('a clean file is entirely importable, and says what it will do', async () => {
  const env = setup();
  const { plan } = await analyse(env, CSV);

  assert.equal(plan.detectedType, 'inventory');
  assert.equal(plan.recordsDetected, 3);
  assert.equal(plan.recordsValid, 3);
  assert.equal(plan.recordsInvalid, 0);
  assert.equal(plan.approvalStatus, 'AWAITING_APPROVAL');
  assert.equal(plan.status, 'READY');

  const rows = planService.rowsFor(env.db, plan.id, { limit: 100 });
  const preview = presenter.preview(env.db, env.ctx.workspaceId, plan, rows);
  assert.equal(preview.newProducts, 3);
  assert.equal(preview.units, 238);
  assert.match(preview.sentence, /create 3 products/);
  assert.match(preview.sentence, /238 units across 2 locations/);

  // Nothing exists yet.
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 0);
});

test('a row naming a location that does not exist stops, and names the others', async () => {
  const env = setup();
  const { plan } = await analyse(
    env,
    ['Item,Qty,Location', 'Widget,5,Main Warehouse', 'Gadget,7,Neverland'].join('\n')
  );

  const rows = planService.rowsFor(env.db, plan.id, { limit: 100 });
  assert.equal(rows[0].status, 'VALID');
  assert.equal(rows[1].status, 'INVALID');
  assert.match(rows[1].problems[0].message, /no location called “Neverland”/);
  assert.deepEqual(plan.conflicts.map((c) => c.text), ['Neverland']);
});

test('a misspelled location is corrected, visibly, not silently', async () => {
  const env = setup();
  const { plan } = await analyse(env, ['Item,Qty,Location', 'Widget,5,Main Warehosue'].join('\n'));

  const [row] = planService.rowsFor(env.db, plan.id, { limit: 10 });
  assert.equal(row.status, 'NEEDS_REVIEW');
  assert.equal(row.parsed.locationName, 'Main Warehouse');
  assert.match(row.problems[0].message, /“Main Warehosue” read as Main Warehouse/);
});

test('a missing quantity creates the product with no stock, and says so', async () => {
  const env = setup();
  const { plan } = await analyse(env, ['Item,Qty,Location', 'Widget,,Main Warehouse'].join('\n'));

  const [row] = planService.rowsFor(env.db, plan.id, { limit: 10 });
  assert.equal(row.status, 'VALID');
  assert.equal(row.parsed.quantity, null);
  assert.match(row.problems[0].message, /no opening stock/);
});

test('a product that already exists is added to, never replaced', async () => {
  const env = setup();
  itemService.createItem(env.db, env.ctx, {
    name: 'Copper Elbow',
    baseCode: 'CE-050',
    trackingMode: 'quantity',
    unitLabel: 'unit',
  });

  const { plan } = await analyse(env, ['Item Name,SKU,Qty,Location', 'Copper Elbow,CE-050,10,Main Warehouse'].join('\n'));
  const [row] = planService.rowsFor(env.db, plan.id, { limit: 10 });

  assert.equal(row.status, 'NEEDS_REVIEW');
  assert.match(row.problems[0].message, /already exists — its stock is added to, never replaced/);
});

test('two products that merely look alike are flagged, never merged', async () => {
  const env = setup();
  itemService.createItem(env.db, env.ctx, {
    name: 'Copper Elbow 1/2 in.',
    trackingMode: 'quantity',
    unitLabel: 'unit',
  });

  const { plan } = await analyse(env, ['Item,Qty,Location', '1/2in Copper Elbow,10,Main Warehouse'].join('\n'));
  const [row] = planService.rowsFor(env.db, plan.id, { limit: 10 });

  assert.equal(row.status, 'NEEDS_REVIEW');
  assert.match(row.problems[0].message, /may be the same product as Copper Elbow 1\/2 in\./);
  assert.match(row.problems[0].message, /creates it separately/);
  assert.equal(row.parsed.existingItemId, undefined);
});

test('a serial repeated in the file, or already in stock, stops that row', async () => {
  const env = setup({ primaryArchetype: 'serial', usesVariants: false });
  const { plan } = await analyse(
    env,
    [
      'Item,Serial Number,Location',
      'Laptop,SN-1,Main Warehouse',
      'Laptop,SN-1,Main Warehouse',
      'Laptop,SN-2,Main Warehouse',
    ].join('\n')
  );

  const rows = planService.rowsFor(env.db, plan.id, { limit: 10 });
  assert.equal(plan.detectedType, 'serials');
  assert.equal(rows[0].status, 'VALID');
  assert.equal(rows[1].status, 'INVALID');
  assert.match(rows[1].problems[0].message, /also appears on row 2/);
  assert.equal(rows[2].status, 'VALID');
});

// --- executing ---------------------------------------------------------------

async function approveAndRun(env, text, options = {}) {
  const { plan } = await analyse(env, text, options);
  planService.approve(env.db, env.ctx, env.membership, plan.id);
  const run = executor.execute(env.db, env.ctx, env.membership, plan.id);
  const verified = verification.verify(env.db, env.ctx.workspaceId, plan.id, run.executionId);
  return { plan: planService.get(env.db, env.ctx.workspaceId, plan.id), run, verified };
}

test('an approved import creates products and real opening movements', async () => {
  const env = setup();
  const { plan, run, verified } = await approveAndRun(env, CSV);

  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(plan.status, 'SUCCEEDED');
  assert.equal(run.result.itemsCreated, 3);
  assert.equal(run.result.unitsEstablished, 238);
  assert.equal(verified.verified, true, JSON.stringify(verified.problems));

  // The stock is there, and it got there through the ledger.
  const item = env.db
    .prepare('SELECT * FROM items WHERE workspace_id = ? AND name = ?')
    .get(env.ctx.workspaceId, 'Copper Elbow');
  assert.ok(item);
  const movements = env.db
    .prepare('SELECT * FROM movements WHERE workspace_id = ? AND item_id = ?')
    .all(env.ctx.workspaceId, item.id);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].operation, 'receive');
  assert.equal(movements[0].quantity_delta, 140);
  assert.equal(movements[0].notes, executor.IMPORT_NOTE);
  assert.match(movements[0].reference, /^import:imp/);
});

test('running the same approved import twice imports it once', async () => {
  const env = setup();
  const { plan } = await analyse(env, CSV);
  const approved = planService.approve(env.db, env.ctx, env.membership, plan.id);

  // Exactly what a double-submitted form does: the same key, twice.
  const key = `import:${approved.id}:${approved.integrityHash}`;
  const first = executor.execute(env.db, env.ctx, env.membership, plan.id, { idempotencyKey: key });
  const second = executor.execute(env.db, env.ctx, env.membership, plan.id, { idempotencyKey: key });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.executionId, first.executionId);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 3);
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(env.ctx.workspaceId).n,
    3
  );
});

test('an unapproved import cannot be run', async () => {
  const env = setup();
  const { plan } = await analyse(env, CSV);
  assert.throws(
    () => executor.execute(env.db, env.ctx, env.membership, plan.id),
    /has not been approved/
  );
});

test('changing the mapping withdraws the approval', async () => {
  const env = setup();
  const { plan } = await analyse(env, CSV);
  planService.approve(env.db, env.ctx, env.membership, plan.id);
  assert.equal(planService.get(env.db, env.ctx.workspaceId, plan.id).approvalStatus, 'APPROVED');

  planService.revalidate(env.db, env.ctx, env.membership, plan.id, {
    mappings: { ...plan.fieldMappings },
  });

  const after = planService.get(env.db, env.ctx.workspaceId, plan.id);
  assert.equal(after.approvalStatus, 'AWAITING_APPROVAL');
  assert.ok(after.planVersion > plan.planVersion);
  assert.throws(() => executor.execute(env.db, env.ctx, env.membership, plan.id), /not been approved/);
});

test('approving something that changed underneath is refused', async () => {
  const env = setup();
  const { plan } = await analyse(env, CSV);
  const staleHash = plan.integrityHash;

  planService.revalidate(env.db, env.ctx, env.membership, plan.id, {
    defaultLocationId: env.workspace.store.id,
  });

  assert.throws(
    () => planService.approve(env.db, env.ctx, env.membership, plan.id, { expectedHash: staleHash }),
    /changed since you looked at it/
  );
});

test('a variant file makes one product with several versions', async () => {
  const env = setup();
  const { run } = await approveAndRun(
    env,
    [
      'Item,Colour,Size,Location,Qty',
      "Kids Sweater,Navy,4,Main Warehouse,10",
      "Kids Sweater,Navy,5,Main Warehouse,6",
      "Kids Sweater,Red,4,Main Warehouse,3",
      "Kids Sweater,Red,5,Main Warehouse,0",
    ].join('\n')
  );

  assert.equal(run.result.itemsCreated, 1);
  assert.equal(run.result.skusCreated, 4);       // 2 colours x 2 sizes
  assert.equal(run.result.unitsEstablished, 19);

  const item = env.db
    .prepare('SELECT * FROM items WHERE workspace_id = ? AND name = ?')
    .get(env.ctx.workspaceId, 'Kids Sweater');
  assert.equal(item.has_variants, 1);
  const labels = env.db
    .prepare('SELECT variant_label FROM skus WHERE item_id = ? ORDER BY position')
    .all(item.id)
    .map((row) => row.variant_label);
  assert.deepEqual(labels, ['Navy / 4', 'Navy / 5', 'Red / 4', 'Red / 5']);
});

test('a lot file opens real lots with the dates the file gave', async () => {
  const env = setup({ primaryArchetype: 'lot', usesVariants: false });
  const { run } = await approveAndRun(
    env,
    [
      'Item,Lot,Qty,Location,Expiry',
      'Olive Oil,L-240812,100,Main Warehouse,25/12/2026',
      'Olive Oil,L-240901,60,Main Warehouse,03/04/2027',
    ].join('\n')
  );

  assert.equal(run.result.lotsCreated, 2);
  assert.equal(run.result.unitsEstablished, 160);
  const lots = env.db
    .prepare('SELECT code, expires_at FROM lots WHERE workspace_id = ? ORDER BY code')
    .all(env.ctx.workspaceId);
  // Stored as the engine stores every date, from the day the file gave.
  assert.deepEqual(lots, [
    { code: 'L-240812', expires_at: '2026-12-25T00:00:00.000Z' },
    { code: 'L-240901', expires_at: '2027-04-03T00:00:00.000Z' },
  ]);
});

test('a lot file makes lot-tracked products even where the default is quantity', async () => {
  // The workspace counts by quantity. This file plainly does not, and creating
  // plain products would drop the lot column on the floor.
  const env = setup({ primaryArchetype: 'quantity', usesVariants: false });
  const { plan } = await analyse(
    env,
    'Item,Lot,Qty,Location\nOlive Oil,L-1,50,Main Warehouse'
  );
  assert.equal(plan.detectedType, 'lots');
  assert.match(plan.assumptions.join(' '), /lot-tracked products, because the file carries a lot code/);

  planService.approve(env.db, env.ctx, env.membership, plan.id);
  const run = executor.execute(env.db, env.ctx, env.membership, plan.id);

  assert.equal(run.result.lotsCreated, 1);
  const item = env.db
    .prepare('SELECT * FROM items WHERE workspace_id = ? AND name = ?')
    .get(env.ctx.workspaceId, 'Olive Oil');
  assert.equal(item.tracking_mode, 'lot');
  const lot = env.db.prepare('SELECT code FROM lots WHERE workspace_id = ?').get(env.ctx.workspaceId);
  assert.equal(lot.code, 'L-1');
});

test('a serial file creates one numbered unit per row, never more', async () => {
  const env = setup({ primaryArchetype: 'serial', usesVariants: false });
  const { run } = await approveAndRun(
    env,
    [
      'Item,Serial,Location,Qty',
      'Laptop,SN-1,Main Warehouse,1',
      // A quantity of 3 against one serial does not become three units: there
      // are no other serial numbers, and Foundry does not make them up.
      'Laptop,SN-2,Main Warehouse,3',
    ].join('\n')
  );

  assert.equal(run.result.serialsCreated, 2);
  const serials = env.db
    .prepare('SELECT serial FROM serial_units WHERE workspace_id = ? ORDER BY serial')
    .all(env.ctx.workspaceId)
    .map((row) => row.serial);
  assert.deepEqual(serials, ['SN-1', 'SN-2']);
});

test('a bad row fails on its own and the rest still import', async () => {
  const env = setup();
  const { plan } = await analyse(
    env,
    [
      'Item,Qty,Location',
      'Widget,10,Main Warehouse',
      'Gadget,lots,Main Warehouse',
      'Doohickey,4,Main Warehouse',
    ].join('\n')
  );
  planService.approve(env.db, env.ctx, env.membership, plan.id);
  const run = executor.execute(env.db, env.ctx, env.membership, plan.id);

  assert.equal(run.status, 'SUCCEEDED');       // no *failures*; one row was never valid
  assert.equal(run.result.rowsImported, 2);
  assert.equal(run.result.rowsSkipped, 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 2);

  const report = presenter.report(plan, run, verification.verify(env.db, env.ctx.workspaceId, plan.id, run.executionId));
  assert.match(report.headline, /2 products created/);
  assert.match(report.headline, /1 row skipped/);
});

test('verification counts the inventory itself, not the import', async () => {
  const env = setup();
  const { plan, run } = await approveAndRun(env, CSV);

  // Something else moves stock afterwards; the stored verification is unchanged
  // because it recorded what was true when it ran.
  const stored = verification.latest(env.db, env.ctx.workspaceId, plan.id);
  assert.equal(stored.verified, true);
  assert.equal(stored.observed.items, 3);
  assert.equal(stored.observed.units, run.result.unitsEstablished);
});

test('an import cannot reach another inventory', async () => {
  const env = setup();
  const other = seedAnotherWorkspace(env.db, env.workspace.accountId);

  const { plan } = await analyse(env, CSV);
  // The other workspace cannot see it…
  assert.throws(() => planService.get(env.db, other.workspaceId, plan.id), /not in this inventory/);

  // …and a location id belonging to it is not usable as a default.
  planService.revalidate(env.db, env.ctx, env.membership, plan.id, {
    defaultLocationId: other.main.id,
    mappings: { name: 0, code: 1, quantity: 3 },      // no location column at all
  });
  const rows = planService.rowsFor(env.db, plan.id, { limit: 10 });
  assert.ok(rows.every((row) => row.status === 'INVALID'), 'a foreign location must not place stock');
  assert.ok(rows.every((row) => row.problems.some((p) => p.code === 'no_location')));
});

test('read-only members cannot import', async () => {
  const env = setup();
  const viewer = authService.createTeamMember(
    env.db,
    env.ctx,
    { role: 'owner' },
    { name: 'Vic Viewer', email: `viewer-${Date.now()}@example.test`, password: 'password123', role: 'staff' }
  );
  env.db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(['VIEW']), viewer.id);
  const membership = env.db.prepare('SELECT * FROM users WHERE id = ?').get(viewer.id);

  await assert.rejects(
    () => planService.analyse(env.db, env.ctx, membership, { text: CSV, filename: 'stock.csv' }),
    /do not have permission/
  );
});

// --- resuming ----------------------------------------------------------------

test('a cancelled import leaves what it created and can finish later', async () => {
  const env = setup();
  const rows = ['Item,Qty,Location'];
  for (let i = 1; i <= 12; i += 1) rows.push(`Product ${i},${i},Main Warehouse`);
  const { plan } = await analyse(env, rows.join('\n'));
  planService.approve(env.db, env.ctx, env.membership, plan.id);

  // Cancelling before it starts stops it at the first checkpoint.
  const claimed = executor.claim(env.db, env.ctx, plan.id, 'pre-claimed');
  env.db.prepare('UPDATE import_executions SET cancel_requested = 1 WHERE id = ?').run(claimed.execution.id);
  env.db.prepare('DELETE FROM import_executions WHERE id = ?').run(claimed.execution.id);

  const run = executor.execute(env.db, env.ctx, env.membership, plan.id);
  assert.equal(run.status, 'SUCCEEDED');
  assert.equal(run.result.itemsCreated, 12);

  // And a second run of the finished import is refused rather than repeated.
  assert.throws(() => executor.execute(env.db, env.ctx, env.membership, plan.id, { idempotencyKey: 'fresh' }), /already run/);
});

// --- uploads -----------------------------------------------------------------

test('an uploaded file arrives as a buffer and its fields as fields', () => {
  const boundary = '----foundrytest';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\ntoken-123\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="C:\\\\Users\\\\me\\\\stock.xlsx"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n'
    ),
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const { fields: parsedFields, files } = multipart.parseBody(body, boundary);
  assert.equal(parsedFields._csrf, 'token-123');
  assert.equal(files.length, 1);
  // The path is stripped: a filename is text to show, not somewhere to look.
  assert.equal(files[0].filename, 'stock.xlsx');
  assert.deepEqual([...files[0].buffer], [0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
});

test('multipart rejects excess files instead of silently dropping part of a migration', () => {
  const boundary = '----foundry-many-files';
  const parts = [];
  for (let index = 0; index <= multipart.MAX_FILES; index += 1) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="source-${index}.csv"\r\nContent-Type: text/csv\r\n\r\nSKU\nSKU-${index}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  assert.throws(() => multipart.parseBody(Buffer.concat(parts),boundary),new RegExp(`no more than ${multipart.MAX_FILES} files`));
});

test('a one-location inventory does not reject every row for having no location', () => {
  // Found pasting a spreadsheet into a new account: three good rows with
  // quantities were all marked INVALID with "no location for this stock, and no
  // default chosen" — in a business that has exactly one location. Foundry knew
  // the answer and asked anyway, then failed the import over it.
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  db.prepare('UPDATE locations SET is_active = 0 WHERE workspace_id = ? AND id != ?')
    .run(workspace.workspaceId, workspace.main.id);

  const sheet = {
    columns: [
      { index: 0, name: 'Style Code' },
      { index: 1, name: 'Description' },
      { index: 2, name: 'Qty on hand' },
    ],
    rows: [
      { rowNumber: 2, cells: ['CT-100-S-WHT', 'Kids tee small white', '12'] },
      { rowNumber: 3, cells: ['CT-100-M-WHT', 'Kids tee medium white', '8'] },
    ],
  };

  const validated = rowValidator.validateRows(db, workspace.workspaceId, sheet, {
    mappings: { code: 0, name: 1, quantity: 2 },
    axisNames: [],
    detectedType: 'quantity',
    // What the plan now supplies when a workspace has only one place to put it.
    defaultLocationId: workspace.main.id,
    locationMappings: {},
  });

  const rejected = validated.rows.filter((row) => (row.problems || []).some((p) => p.code === 'no_location'));
  assert.equal(rejected.length, 0, 'there is only one location; it is not a question');
  assert.ok(validated.rows.every((row) => row.parsed.quantity > 0), 'and the quantities survived');
});

/*
 * A real supplier invoice, and the shape that made Foundry refuse all of it.
 *
 * Style #, Shoe / Description, Brand, Color, Size, Qty, costs, Selling Price.
 * Foundry read "Style #" as a third variation because the word "style" also
 * names an axis, filed "Shoe / Description" as a description, and then
 * reported 65 rows of "No product name or code in this row" — with SH-1001
 * sitting in every one of them, under its own note saying that column was the
 * product name.
 */
const INVOICE = [
  'Style #,Shoe / Description,Brand,Color,Size,Qty,Unit Cost,Line Cost,Selling Price',
  'SH-1001,Classic Oxford,Bravo,Black,8,4,52.00,208.00,129.99',
  'SH-1001,Classic Oxford,Bravo,Black,9,5,52.00,260.00,129.99',
  'SH-1002,Chelsea Boot,Bravo,Brown,8,5,61.00,305.00,149.99',
  'SH-1003,Court Sneaker,Bravo,White/Gray,7,6,38.00,228.00,89.99',
].join('\n');

test('a style number is the product code, not a third variation', () => {
  const sheet = sheetFrom(INVOICE);
  const { mappings } = fields.guessMappings(sheet.columns, sheet.rows);

  assert.equal(sheet.columns[mappings.code].name, 'Style #');
  assert.equal(sheet.columns[mappings.name].name, 'Shoe / Description');
  assert.equal(sheet.columns[mappings.variant1].name, 'Color');
  assert.equal(sheet.columns[mappings.variant2].name, 'Size');
  assert.equal(mappings.variant3, undefined, 'the code is not an axis');
});

test('a bare "Style" column is still a variation', () => {
  const sheet = sheetFrom(['Product,Style,Qty', 'Chair,Slim,4', 'Chair,Wide,3'].join('\n'));
  const { mappings } = fields.guessMappings(sheet.columns, sheet.rows);
  assert.equal(sheet.columns[mappings.variant1].name, 'Style');
  assert.equal(mappings.code, undefined);
});

test('every row of the supplier invoice imports, instead of every row failing', async () => {
  const env = setup();
  await analyse(env, INVOICE, { filename: 'shoe_store_supplier_invoice.csv',
    defaultLocationId: env.workspace.main.id });
  const rows = env.db.prepare('SELECT status, problems FROM import_rows').all();
  assert.equal(rows.length, 4);
  const refused = rows.filter((row) => row.status === 'INVALID');
  assert.deepEqual(refused, [], 'not one row is refused for having no product on it');
  env.db.close();
});

test('a file whose only identifier is a code-shaped column still imports', () => {
  /*
   * The deepest form of the same failure: no name column at all and nothing
   * headed like a code. The values are still codes and every row still says
   * which product it is about, so Foundry uses them and says that it did
   * rather than refusing the file.
   */
  const sheet = sheetFrom(['Style,Color,Qty', 'SH-1001,Black,4', 'SH-1002,Brown,5'].join('\n'));
  const { mappings, assumptions } = fields.guessMappings(sheet.columns, sheet.rows);
  assert.equal(sheet.columns[mappings.code].name, 'Style');
  assert.match(assumptions.join(' '), /read as the product code/);
});

test('a size column is never mistaken for a product code', () => {
  /*
   * The recovery above must not fire on numbers. A file of sizes and colours
   * with no product in it is a file Foundry cannot import, and saying so is
   * better than turning 10.5 into a product.
   */
  const sheet = sheetFrom(['Size,Color,Qty', '10.5,Black,4', '11,Brown,5'].join('\n'));
  const { mappings } = fields.guessMappings(sheet.columns, sheet.rows);
  assert.equal(mappings.code, undefined);
  assert.equal(mappings.name, undefined);
});

test('the scope warning names four products, not one product four times', () => {
  /*
   * The list is drawn from rows that are one per SKU, so an inventory whose
   * first product came in several sizes introduced itself as "loafer, loafer,
   * loafer, loafer" — four slots spent saying one word, on the one screen
   * whose whole job is to let somebody recognise their own data.
   */
  const env = setup();
  const scopeSafety = require('../../src/imports/scope-safety');
  const itemService = require('../../src/domain/item-service');
  // A product in five sizes: five SKU rows, one product.
  itemService.createItem(env.db, env.ctx, {
    name: 'loafer', baseCode: 'LOAF', trackingMode: 'quantity', hasVariants: true,
    options: [{ name: 'Size', values: '8, 9, 10, 11, 12' }],
  });
  itemService.createItem(env.db, env.ctx, {
    name: 'bike toe lace', baseCode: 'BTL', trackingMode: 'quantity', hasVariants: true,
    options: [{ name: 'Size', values: '8, 9' }],
  });
  itemService.createItem(env.db, env.ctx, {
    name: 'moc toe slip in', baseCode: 'MTS', trackingMode: 'quantity',
  });

  const warning = scopeSafety.evaluate(env.db, env.workspace.workspaceId, [
    { name: 'Classic Leather Oxford', code: 'SH-1001' },
    { name: 'Classic Leather Oxford', code: 'SH-1001' },
    { name: 'Suede Chelsea Boot', code: 'SH-1002' },
    { name: 'Everyday Running Sneaker', code: 'SH-1003' },
    { name: 'Retro Court Sneaker', code: 'SH-1004' },
  ]);

  assert.equal(warning.needsConfirmation, true, 'these really are different products');
  assert.equal(new Set(warning.currentExamples).size, warning.currentExamples.length,
    'no product is listed twice');
  assert.equal(new Set(warning.incomingExamples).size, warning.incomingExamples.length);
  assert.ok(warning.currentExamples.includes('loafer'));
  assert.ok(warning.currentExamples.includes('bike toe lace'),
    'the second product gets a slot instead of the first taking them all');
  assert.equal(warning.currentProductCount, 3, 'and it can say how many there are');
  assert.equal(warning.incomingProductCount, 4);
  env.db.close();
});

/*
 * An invoice does not end with its last line item.
 *
 * Under the products come the subtotal, the freight, the tax, the payment
 * terms, the return policy and the invoice total. Foundry imported every one
 * of them as a product: a real upload put "INVOICE TOTAL", "Sales/Use Tax",
 * "ACH / Business Check / Wire" and "Defects reported within 7 days…" in the
 * catalogue beside twelve genuine shoes.
 */
const INVOICE_WITH_FOOTER = [
  'Style #,Shoe / Description,Brand,Color,Size,Qty,Unit Cost,Selling Price',
  'SH-1001,Classic Oxford,Bravo,Black,8,4,52.00,129.99',
  'SH-1001,Classic Oxford,Bravo,Black,9,5,52.00,129.99',
  'SH-1002,Chelsea Boot,Bravo,Brown,8,6,61.00,149.99',
  '',
  'ORDER SUMMARY,Merchandise Subtotal,,,,,,10384.5',
  'Total Pairs,Total Wholesale Cost,,Potential Retail Sales,,Gross Margin $,,287.49',
  '250,,10384.5,,24732.49,,14347.99,',
  'Notes,Assorted sizes by style. Fees allocated per size line.,,,,,,30.00',
  'Payment,ACH / Business Check / Wire,,,,,,125',
  'Sales/Use Tax,,,,,,,0',
  'INVOICE TOTAL,,,,,,,11087',
].join('\n');

test('the invoice footer is read as the document, never as products', () => {
  const env = setup();
  const sheet = sheetFrom(INVOICE_WITH_FOOTER);
  const { mappings } = fields.guessMappings(sheet.columns, sheet.rows);
  const result = rowValidator.validateRows(env.db, env.workspace.workspaceId, sheet,
    { mappings, defaultLocationId: env.workspace.main.id });

  const excluded = result.rows.filter((row) => row.status === 'EXCLUDED');
  assert.equal(excluded.length, 7, 'every row below the blank line is the invoice, not stock');
  assert.deepEqual(excluded.map((row) => row.parsed.code),
    ['ORDER SUMMARY', 'Total Pairs', '250', 'Notes', 'Payment', 'Sales/Use Tax', 'INVOICE TOTAL']);

  const products = result.rows.filter((row) => row.status !== 'EXCLUDED');
  assert.equal(products.length, 3, 'and the real line items all survive');
  assert.equal(result.summary.units, 15);
  assert.equal(result.summary.invalid, 0,
    'the footer is left out, not listed as seven things to go and fix');
  env.db.close();
});

test('a blank row inside real data does not end the file', () => {
  /*
   * The other half of the rule. Spreadsheets have blank rows in the middle of
   * perfectly good data, and a tail that still counts stock is still stock.
   */
  const env = setup();
  const sheet = sheetFrom([
    'Item Name,SKU,Qty',
    'Copper Elbow,CE-050,10',
    '',
    'Copper Tee,CE-075,12',
  ].join('\n'));
  const { mappings } = fields.guessMappings(sheet.columns, sheet.rows);
  const result = rowValidator.validateRows(env.db, env.workspace.workspaceId, sheet,
    { mappings, defaultLocationId: env.workspace.main.id });

  assert.equal(result.rows.filter((row) => row.status === 'EXCLUDED').length, 0);
  assert.equal(result.summary.units, 22);
  env.db.close();
});

test('a catalogue with no quantities at all has no trailer to find', () => {
  // Nothing counts stock, so there is no data block for a footer to follow —
  // and every row of a price list is a product.
  const env = setup();
  const sheet = sheetFrom(['Item Name,SKU', 'Copper Elbow,CE-050', '', 'Copper Tee,CE-075'].join('\n'));
  const { mappings } = fields.guessMappings(sheet.columns, sheet.rows);
  const result = rowValidator.validateRows(env.db, env.workspace.workspaceId, sheet,
    { mappings, defaultLocationId: env.workspace.main.id });
  assert.equal(result.rows.filter((row) => row.status === 'EXCLUDED').length, 0);
  env.db.close();
});

/*
 * The repair Foundry has to be able to do for itself.
 *
 * The fix that mattered least here was the one made by hand: a script run
 * against one database, which is a fix that only exists while somebody is
 * standing over it. Stock imported before Foundry read cost columns is worth
 * nothing in the books, and Foundry has to notice that on its own — from the
 * figure still sitting on the row it was read from.
 */
test('Foundry values stock an older import left worth nothing, by itself', async () => {
  const env = setup();
  const costing = require('../../src/accounting/costing');
  const backfill = require('../../src/imports/backfill-costs');
  const text = [
    'Item Name,SKU,Qty On Hand,Unit Cost',
    'Copper Elbow,CE-050,140,2.40',
    'Copper Tee,CE-075,86,3.10',
  ].join('\n');

  // Exactly what the old import did: the cost column is in the file and not in
  // the mapping, so the stock arrives real and valueless.
  const sheet = sheetFrom(text);
  const mappings = { ...fields.guessMappings(sheet.columns, sheet.rows).mappings };
  delete mappings.unitCost;
  await approveAndRun(env, text, { mappings, defaultLocationId: env.workspace.main.id });

  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 0,
    'the books cannot value it');
  assert.equal(env.db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 226, 'while the stock itself is really there');

  const repaired = backfill.backfillImportCosts(env.db);
  assert.equal(repaired.rows, 2);
  // 140 × $2.40 + 86 × $3.10 = $602.60
  assert.equal(repaired.totalCostMinor, 60260);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 60260,
    'and it is worth what its own file said it cost');

  // Running again changes nothing: stock that has a cost is left alone.
  const again = backfill.backfillImportCosts(env.db);
  assert.equal(again.rows, 0);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 60260);
  env.db.close();
});

test('the repair finds a cost column a plan was too old to have mapped', () => {
  // No mapping to consult, so the plan's own headings are read by the same
  // rules a fresh upload uses.
  const backfill = require('../../src/imports/backfill-costs');
  const plan = {
    field_mappings: JSON.stringify({ name: 0, code: 1, quantity: 2 }),
    source_columns: JSON.stringify([
      { index: 0, name: 'Item Name' }, { index: 1, name: 'SKU' },
      { index: 2, name: 'Qty On Hand' }, { index: 3, name: 'Unit Cost' },
    ]),
  };
  assert.equal(backfill.costColumn(plan), 3);

  // And a file with no cost column at all is left alone rather than guessed at.
  assert.equal(backfill.costColumn({
    field_mappings: '{}',
    source_columns: JSON.stringify([{ index: 0, name: 'Item Name' }, { index: 1, name: 'Qty' }]),
  }), -1);
});

test('a cost the import already recorded is never counted a second time', async () => {
  const env = setup();
  const costing = require('../../src/accounting/costing');
  const backfill = require('../../src/imports/backfill-costs');
  await approveAndRun(env, ['Item Name,SKU,Qty On Hand,Unit Cost', 'Copper Elbow,CE-050,10,2.50'].join('\n'),
    { defaultLocationId: env.workspace.main.id });
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 2500);

  assert.equal(backfill.backfillImportCosts(env.db).rows, 0, 'nothing to repair');
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 2500);
  env.db.close();
});

test('a supplier invoice gives its stock a value, instead of stock worth nothing', async () => {
  /*
   * A real upload imported 250 pairs of shoes worth $0.00 in the books, next
   * to an invoice that said they cost $11,087. Unit Cost was thrown away —
   * "Foundry does not track supplier cost" — so every pair was inventory the
   * books could not value, and the first sale of any of them would have
   * stopped on "Foundry has no recorded cost for this product".
   */
  const env = setup();
  const costing = require('../../src/accounting/costing');
  const text = [
    'Style #,Shoe / Description,Color,Size,Qty,Unit Cost,Selling Price',
    'SH-1001,Classic Oxford,Black,8,4,52.00,129.99',
    'SH-1001,Classic Oxford,Black,9,5,52.00,129.99',
    'SH-1002,Chelsea Boot,Brown,8,6,61.00,149.99',
  ].join('\n');

  const sheet = sheetFrom(text);
  const { mappings } = fields.guessMappings(sheet.columns, sheet.rows);
  assert.equal(sheet.columns[mappings.unitCost].name, 'Unit Cost', 'the cost column is read');
  assert.notEqual(mappings.unitCost, mappings.sellingPrice, 'and never confused with the price');

  await approveAndRun(env, text, { filename: 'invoice.csv', defaultLocationId: env.workspace.main.id });

  // 4 × $52 + 5 × $52 + 6 × $61 = $834.00
  const value = costing.valuation(env.db, env.workspace.workspaceId);
  assert.equal(value.totalCostMinor, 83400, 'the stock is worth what the invoice says it cost');
  assert.equal(value.totalUnits, 15);
  env.db.close();
});

test('a file with no cost column still imports, and the stock has no invented value', async () => {
  // Plenty of files legitimately carry no cost. That is not an error, and
  // Foundry must not make a number up to fill the gap.
  const env = setup();
  const costing = require('../../src/accounting/costing');
  await approveAndRun(env, ['Item Name,SKU,Qty On Hand', 'Copper Elbow,CE-050,140'].join('\n'),
    { defaultLocationId: env.workspace.main.id });

  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 0,
    'no cost was invented');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 1, 'and the stock still came in');
  env.db.close();
});

/*
 * The money a spreadsheet carries that is not the goods.
 *
 * A supplier invoice arrived as an .xlsx with $702.50 of shipping, handling,
 * insurance, duty, a fuel surcharge and a warehouse fee — charged partly per
 * line and partly on rows under the products. Foundry imported the shoes and
 * none of the money, and the Money page showed an empty Expenses section
 * beside an invoice that reconciles to the cent.
 */
const INVOICE_WITH_FEES = [
  'Style #,Shoe / Description,Color,Size,Qty,Unit Cost,Selling Price,Shipping,Handling',
  'SH-1001,Classic Oxford,Black,8,4,52.00,129.99,4.60,1.12',
  'SH-1001,Classic Oxford,Black,9,5,52.00,129.99,5.75,1.40',
  'SH-1002,Chelsea Boot,Brown,8,6,61.00,149.99,6.90,1.68',
  '',
  'ORDER SUMMARY,Merchandise Subtotal,,,,,,,834.00',
  'Fuel Surcharge,,,,,,,,125.00',
  'Warehouse/Processing Fee,,,,,,,,85.00',
  'Sales/Use Tax,,,,,,,,0',
  'INVOICE TOTAL,,,,,,,,1061.45',
].join('\n');

test('the shipping and fees on a spreadsheet are read, and add up to its own total', async () => {
  const env = setup();
  const documentCosts = require('../../src/accounting/document-costs');
  const { plan } = await approveAndRun(env, INVOICE_WITH_FEES,
    { filename: 'shoe_store_supplier_invoice.csv', defaultLocationId: env.workspace.main.id });

  const [document] = documentCosts.forWorkspace(env.db, env.workspace.workspaceId);
  assert.ok(document, 'the file left its money behind');
  assert.equal(document.sourceKind, 'import_plan');
  assert.equal(document.documentId, plan.id);

  // Per-line columns, summed down the products only.
  const by = (label) => document.charges.find((charge) => charge.label === label);
  assert.equal(by('Shipping').amountMinor, 1725, '4.60 + 5.75 + 6.90');
  assert.equal(by('Shipping').kind, 'freight');
  assert.equal(by('Handling').amountMinor, 420, '1.12 + 1.40 + 1.68');
  // And rows under the products, in the supplier's own words.
  assert.equal(by('Fuel Surcharge').amountMinor, 12500);
  assert.equal(by('Warehouse/Processing Fee').amountMinor, 8500);
  assert.equal(by('Sales/Use Tax'), undefined, 'a charge of nothing is not a charge');

  // 4×52 + 5×52 + 6×61 = 834.00 of goods, and the fees on top.
  assert.equal(document.goodsMinor, 83400);
  assert.equal(document.chargesMinor, 23145);
  assert.equal(document.addsUpMinor, 106545);
  assert.equal(document.documentTotalMinor, 106145,
    "the supplier's own total is kept as they stated it");

  // None of it is posted: what freight is remains the owner's decision.
  assert.equal(document.unrecordedMinor, 23145);
  for (const charge of document.charges) assert.equal(charge.status, 'UNRECORDED');
  env.db.close();
});

test('a fee is never counted twice when the footer repeats it', () => {
  /*
   * The real invoice listed Insurance and Import/Customs as columns and again
   * as footer rows. Counting both made it $135 more than it says it is — and
   * the footer's own prose ("Assorted sizes by style. Shipping and ancillary
   * fees…") was being read as a shipping charge of its own.
   */
  const documentMoney = require('../../src/imports/document-money');
  const sheet = { columns: [
    { index: 0, name: 'Style #' }, { index: 1, name: 'Description' },
    { index: 2, name: 'Qty' }, { index: 3, name: 'Insurance' }, { index: 4, name: 'Amount' },
  ] };
  const productRows = [
    { cells: ['SH-1', 'Oxford', '4', '10.00', ''] },
    { cells: ['SH-2', 'Boot', '6', '20.00', ''] },
  ];
  const trailerRows = [
    { cells: ['Notes', 'Assorted sizes by style. Shipping and ancillary fees allocated per size line.', '', 'Insurance', '30.00'] },
    { cells: ['Fuel Surcharge', '', '', '', '125.00'] },
  ];

  const read = documentMoney.read(sheet, { quantity: 2 }, { productRows, trailerRows });
  const labels = read.charges.map((charge) => charge.label);
  assert.deepEqual(labels, ['Insurance', 'Fuel Surcharge'],
    'the column carries the insurance, the footer repeats it, and the prose is not a charge');
  assert.equal(read.charges[0].amountMinor, 3000, '10.00 + 20.00 from the column, counted once');
  assert.equal(read.charges[1].amountMinor, 12500);
});

test('a file with no fees on it records none', async () => {
  const env = setup();
  const documentCosts = require('../../src/accounting/document-costs');
  await approveAndRun(env, ['Item Name,SKU,Qty On Hand,Unit Cost', 'Copper Elbow,CE-050,10,2.50'].join('\n'),
    { defaultLocationId: env.workspace.main.id });
  assert.deepEqual(documentCosts.forWorkspace(env.db, env.workspace.workspaceId), [],
    'nothing invented for a file that charged nothing');
  env.db.close();
});
