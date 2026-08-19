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
  // Recognised, and deliberately not imported.
  assert.deepEqual(
    ignored.map((column) => column.name).sort(),
    ['Supplier', 'Unit Cost']
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
