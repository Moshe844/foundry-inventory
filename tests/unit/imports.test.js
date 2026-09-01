'use strict';

/**
 * Mission 5 foundations: reading customer files, and turning a described
 * product into a real catalogue record.
 *
 * The parser tests use files written by a *different* XLSX implementation, so
 * Foundry's own reader is not marking its own homework.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const parser = require('../../src/imports/parser');
const fields = require('../../src/imports/fields');
const xlsxReader = require('../../src/imports/xlsx-reader');
const catalog = require('../../src/imports/catalog-service');
const proposals = require('../../src/actions/proposal-service');
const actionService = require('../../src/actions/action-service');
const execution = require('../../src/actions/execution-service');
const presenter = require('../../src/actions/presenter');
const permissions = require('../../src/actions/permissions');
const authService = require('../../src/domain/auth-service');
const itemService = require('../../src/domain/item-service');
const repo = require('../../src/domain/repository');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');
const scenarios = require('../helpers/scenarios');

test.after(cleanupAll);

function setup(model = { primaryArchetype: 'quantity', usesVariants: true }) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  scenarios.configure(db, workspace.workspaceId, { inventoryModel: model });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, membership, ctx: workspace.ctx };
}

/** A real .xlsx, written by SheetJS rather than by the code under test. */
function writeWorkbook(sheets) {
  const XLSX = require('xlsx');
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), name);
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

// --- reading files -----------------------------------------------------------

test('an xlsx written by another tool is read correctly', () => {
  const buffer = writeWorkbook({
    Inventory: [
      ['Item Number', 'Description', 'Colour', 'Size', 'Warehouse', 'Qty On Hand'],
      ['CE-100', 'Copper Elbow', '', '', 'Brooklyn', 50],
      ['HT-1', 'Harbour Tee', 'Navy', '8', 'New Jersey', 12],
    ],
    Notes: [['ignore me']],
  });

  const { sheets, format } = parser.parse({ buffer, filename: 'stock.xlsx' });
  assert.equal(format, 'xlsx');
  assert.deepEqual(sheets.map((s) => s.name), ['Inventory', 'Notes']);

  const inventory = sheets[0];
  assert.deepEqual(inventory.columns.map((c) => c.name), [
    'Item Number', 'Description', 'Colour', 'Size', 'Warehouse', 'Qty On Hand',
  ]);
  assert.equal(inventory.rows.length, 2);
  assert.deepEqual(inventory.rows[0].cells, ['CE-100', 'Copper Elbow', '', '', 'Brooklyn', '50']);
  assert.equal(inventory.rows[1].cells[4], 'New Jersey');
});

test('dates, entities and accents survive the trip', () => {
  const buffer = writeWorkbook({
    Lots: [
      ['SKU', 'Lot', 'Expires', 'Note'],
      ['CY-1', 'L240812', new Date(2027, 3, 17), 'Crème & <brûlée> "quoted"'],
    ],
  });
  const sheet = parser.parse({ buffer, filename: 'lots.xlsx' }).sheets[0];
  assert.equal(sheet.rows[0].cells[2], '2027-04-17', 'a date serial becomes a date');
  assert.equal(sheet.rows[0].cells[3], 'Crème & <brûlée> "quoted"');
});

test('a messy export is understood without being cleaned first', () => {
  const messy = [
    'Warehouse Stock Export',
    'Generated 2026-08-13',
    '',
    'Item Number,Description,Colour,Size,Warehouse,Qty On Hand,,',
    'CE-100,Copper Elbow,,,Brooklyn,50,,',
    ',,,,,,,',
    'HT-1,"Harbour Tee, cotton",Navy,8,New Jersey,12,,',
    'Item Number,Description,Colour,Size,Warehouse,Qty On Hand,,',
    'HT-1,"Harbour Tee, cotton",Navy,9,New Jersey,0,,',
  ].join('\n');

  const sheet = parser.parse({ text: messy, filename: 'stock.csv' }).sheets[0];

  assert.equal(sheet.headerRowIndex, 3, 'the title rows above the header are skipped');
  assert.equal(sheet.columns.length, 6, 'the empty trailing columns are dropped');
  assert.equal(sheet.droppedBlankRows, 1);
  assert.equal(sheet.repeatedHeaderRows, 1, 'a second export stacked underneath');
  assert.equal(sheet.rows.length, 3);
  // Values still line up with their columns after the trailing ones went.
  assert.deepEqual(sheet.rows[1].cells, ['HT-1', 'Harbour Tee, cotton', 'Navy', '8', 'New Jersey', '12']);
  assert.equal(sheet.rows[1].sourceRow, 7, 'the line number in their file');
});

test('pasted data with no header keeps every row', () => {
  const sheet = parser.parse({ text: 'CE-100\tCopper Elbow\t50\nCT-200\tCopper Tee\t25' }).sheets[0];
  assert.equal(sheet.headerless, true);
  assert.equal(sheet.rows.length, 2, 'the first line is data, not a header');
  assert.deepEqual(sheet.rows[0].cells, ['CE-100', 'Copper Elbow', '50']);
});

test('semicolon and pipe files are read as readily as commas', () => {
  for (const delimiter of [';', '|', '\t']) {
    const text = ['SKU', 'Name', 'Qty'].join(delimiter) + '\n' + ['A-1', 'Thing', '5'].join(delimiter);
    const sheet = parser.parse({ text, filename: 'x.csv' }).sheets[0];
    assert.deepEqual(sheet.columns.map((c) => c.name), ['SKU', 'Name', 'Qty'], `delimiter ${JSON.stringify(delimiter)}`);
    assert.deepEqual(sheet.rows[0].cells, ['A-1', 'Thing', '5']);
  }
});

test('duplicate column names stay distinguishable', () => {
  const sheet = parser.parse({ text: 'SKU,Qty,Qty\nA-1,5,7' }).sheets[0];
  assert.deepEqual(sheet.columns.map((c) => c.name), ['SKU', 'Qty', 'Qty (2)']);
});

test('a file that is not a spreadsheet is refused, not misread', () => {
  assert.throws(
    () => parser.parse({ buffer: Buffer.from('not a spreadsheet at all'), filename: 'x.xlsx' }),
    /not a readable spreadsheet|not a spreadsheet/i
  );
  assert.throws(() => parser.parse({ text: '   ' }), /nothing in that/i);
});

test('a CSV somebody renamed .xlsx is read rather than refused', () => {
  // The bytes decide what a file is, not its name. Refusing a perfectly
  // readable CSV over its extension would be Foundry making its own filing
  // rules the customer's problem.
  const parsed = parser.parse({
    buffer: Buffer.from('Item,Qty\nCopper Elbow,12'),
    filename: 'stock.xlsx',
  });
  assert.equal(parsed.format, 'delimited');
  assert.equal(parsed.sheets[0].rows.length, 1);
  assert.deepEqual(parsed.sheets[0].columns.map((c) => c.name), ['Item', 'Qty']);
});

test('the reader refuses a file claiming to be enormous', () => {
  assert.ok(xlsxReader.LIMITS.maxTotalBytes > 0);
  assert.throws(
    () => parser.parse({ buffer: Buffer.alloc(parser.LIMITS.maxBytes + 1), filename: 'big.xlsx' }),
    /larger than Foundry can read/
  );
});

// --- describing a product ----------------------------------------------------

test('ranges are expanded by Foundry, never by the model', () => {
  assert.deepEqual(catalog.expandValues('6 through 12'), ['6', '7', '8', '9', '10', '11', '12']);
  assert.deepEqual(catalog.expandValues('6-9'), ['6', '7', '8', '9']);
  assert.deepEqual(catalog.expandValues('S, M, L and XL'), ['S', 'M', 'L', 'XL']);
  assert.deepEqual(catalog.expandValues('Navy, navy, NAVY'), ['Navy'], 'the same value once');
});

test('the tracking mode comes from the configuration, not a question', () => {
  const quantity = setup({ primaryArchetype: 'quantity', usesVariants: true });
  const planned = catalog.planItem(quantity.db, quantity.workspace.workspaceId, { name: 'Oxford Shirt' });
  assert.equal(planned.plan.trackingMode, 'quantity');

  const serial = setup({ primaryArchetype: 'serial', serialRules: { enabled: true } });
  const machine = catalog.planItem(serial.db, serial.workspace.workspaceId, { name: 'Site Generator' });
  assert.equal(machine.plan.trackingMode, 'serial');
  assert.match(machine.plan.assumptions.join(' '), /individual unit/);

  const lots = setup({ primaryArchetype: 'lot', lotRules: { enabled: true } });
  const yoghurt = catalog.planItem(lots.db, lots.workspace.workspaceId, { name: 'Chilled Yoghurt' });
  assert.equal(yoghurt.plan.trackingMode, 'lot');
});

test('a described product becomes the right number of variants', () => {
  const env = setup();
  const planned = catalog.planItem(env.db, env.workspace.workspaceId, {
    name: "Children's Oxford",
    variantAxes: 'Colour: Navy, Black | Size: 6 through 12',
  });
  assert.equal(planned.plan.variantCount, 14);
  assert.deepEqual(planned.plan.axes.map((a) => a.name), ['Colour', 'Size']);
  assert.deepEqual(planned.plan.axes[1].values, ['6', '7', '8', '9', '10', '11', '12']);
});

test('an unreasonable number of variants is refused rather than attempted', () => {
  const env = setup();
  const planned = catalog.planItem(env.db, env.workspace.workspaceId, {
    name: 'Everything',
    variantAxes: 'A: 1 through 40 | B: 1 through 40',
  });
  assert.equal(planned.ok, false);
  assert.match(planned.unsupported, /1600 variants/);
});

test('an existing code or name blocks creation; a resemblance only warns', () => {
  const env = setup();
  itemService.createItem(env.db, env.ctx, {
    name: 'Copper Elbow 1/2 in.', baseCode: 'CE-100', trackingMode: 'quantity',
  });

  const sameCode = catalog.planItem(env.db, env.workspace.workspaceId, { name: 'Something Else', code: 'CE-100' });
  assert.ok(sameCode.plan.conflicts.some((c) => c.kind === 'duplicate_code' && c.decisive));

  const sameName = catalog.planItem(env.db, env.workspace.workspaceId, { name: 'copper elbow 1/2 in.' });
  assert.ok(sameName.plan.conflicts.some((c) => c.kind === 'duplicate_name' && c.decisive));

  // The mission's own example: same product, different word order.
  const similar = catalog.planItem(env.db, env.workspace.workspaceId, { name: '1/2in Copper Elbow' });
  const possible = similar.plan.conflicts.filter((c) => c.kind === 'possible_duplicate');
  assert.equal(possible.length, 1);
  assert.equal(possible[0].decisive, false, 'a resemblance is never decisive');
  assert.match(possible[0].message, /may be the same as/);
});

// --- creating it, through the approval pipeline -------------------------------

function createProposal(env, intent) {
  const built = proposals.build(env.db, env.ctx, { actionType: 'create_item', serials: [], ...intent });
  assert.ok(built.ok, built.question || built.unsupported);
  return proposals.persist(env.db, env.ctx, built.proposal, { instruction: 'test' });
}

test('creating a product needs approval, and nothing exists before it', () => {
  const env = setup();
  const proposal = createProposal(env, {
    productName: "Children's Oxford",
    productCode: 'CO-1',
    variantAxes: 'Colour: Navy, Black | Size: 6 through 12',
  });

  assert.equal(proposal.status, 'AWAITING_APPROVAL');
  assert.equal(proposal.safetyLevel, 'LOW', 'a catalogue record changes no stock');
  assert.equal(proposal.requiredPermission, permissions.OPERATE);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 0);

  const view = presenter.present(env.db, env.workspace.workspaceId, proposal);
  assert.equal(view.oneLine, "Add Children's Oxford with 14 variants");
  assert.deepEqual(view.subject.axes.map((a) => `${a.name}:${a.values.length}`), ['Colour:2', 'Size:7']);

  execution.approve(env.db, env.ctx, env.membership, proposal.proposalId);
  const result = execution.execute(env.db, env.ctx, env.membership, proposal.proposalId);
  assert.equal(result.verified, true, JSON.stringify(result.verification.problems));

  const item = env.db
    .prepare('SELECT * FROM items WHERE workspace_id = ? AND name = ?')
    .get(env.workspace.workspaceId, "Children's Oxford");
  assert.ok(item);
  assert.equal(item.tracking_mode, 'quantity');
  const skus = repo.listSkusForItem(env.db, env.workspace.workspaceId, item.id);
  assert.equal(skus.length, 14);
  assert.deepEqual(
    skus.map((s) => s.variant_label).filter((l) => l.startsWith('Navy')),
    ['Navy / 6', 'Navy / 7', 'Navy / 8', 'Navy / 9', 'Navy / 10', 'Navy / 11', 'Navy / 12']
  );
});

test('adding a received product preserves its stated variant, quantity and location as one atomic action', () => {
  const env = setup();
  const proposal = createProposal(env, {
    productName: 'white_socks',
    productCode: 'AE_345',
    variantAxes: 'Size: 6',
    quantity: 35,
    destinationLocation: 'Main Warehouse',
  });

  assert.equal(proposal.quantity, 35);
  assert.equal(proposal.destinationLocationId, env.workspace.main.id);
  assert.equal(proposal.settings.initialStock.quantity, 35);
  assert.equal(proposal.safetyLevel, 'MUTATION');
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n,
    0,
    'preview changes nothing'
  );

  const view = presenter.present(env.db, env.workspace.workspaceId, proposal);
  assert.equal(view.title, 'Foundry is ready to add a product and receive its stock');
  assert.match(view.subjectName, /white_socks \/ Size: 6 · AE_345/);
  assert.deepEqual(view.rows.map((row) => [row.label, row.before, row.after]), [['Main Warehouse', 0, 35]]);
  assert.deepEqual(view.total, { before: 0, after: 35 });
  assert.match(view.oneLine, /receive 35 at Main Warehouse/);

  execution.approve(env.db, env.ctx, env.membership, proposal.proposalId);
  const result = execution.execute(env.db, env.ctx, env.membership, proposal.proposalId);
  assert.equal(result.verified, true, JSON.stringify(result.verification.problems));

  const item = env.db
    .prepare('SELECT id FROM items WHERE workspace_id = ? AND base_code = ?')
    .get(env.workspace.workspaceId, 'AE_345');
  assert.ok(item);
  const [sku] = repo.listSkusForItem(env.db, env.workspace.workspaceId, item.id);
  assert.equal(sku.variant_label, '6');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, sku.id, env.workspace.main.id), 35);
  assert.equal(repo.getSkuTotal(env.db, env.workspace.workspaceId, sku.id), 35);
  assert.equal(
    env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'receive'")
      .get(env.workspace.workspaceId).n,
    1,
    'the opening receipt is in the same immutable ledger as every other receipt'
  );
});

test('a received new product asks for the actual location instead of dropping its quantity', () => {
  const env = setup();
  const built = proposals.build(env.db, env.ctx, {
    actionType: 'create_item',
    serials: [],
    productName: 'white_socks',
    productCode: 'AE_345',
    variantAxes: 'Size: 6',
    quantity: 35,
    destinationLocation: '',
  });

  assert.equal(built.ok, false);
  assert.match(built.question, /Where should the 35 white_socks \/ 6 be received/);
  assert.deepEqual(built.choices.map((choice) => choice.value), ['Downtown Store', 'Main Warehouse']);
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n,
    0
  );
});

test('answering the receiving-location question resumes the same create request with its quantity intact', async () => {
  const env = setup();
  const parsedIntent = {
    lines: [{
      actionType: 'create_item',
      item: '', variant: '', sourceText: 'new white_socks size 6, quantity 35',
      lotCode: '', serials: [], sourceLocation: '', destinationLocation: '',
      quantity: 35, adjustmentTarget: -1, reasonCode: '',
      productName: 'white_socks', productCode: 'AE_345', variantAxes: 'Size: 6', unitLabel: '',
    }],
    clarifyingQuestion: '',
    unsupportedReason: '',
  };
  const original = "I received a new item called white_socks size 6, quantity 35, code AE_345";
  const question = await actionService.interpret(
    env.db, env.ctx, env.membership, original, { parsedIntent }
  );
  assert.equal(question.kind, 'question');
  assert.equal(question.continuation.kind, 'create_item_receiving_location');

  const resumed = await actionService.continueInterpretation(
    env.db, env.ctx, env.membership, question.continuation, 'Main Warehouse'
  );
  assert.equal(resumed.kind, 'proposal');
  assert.equal(resumed.proposal.quantity, 35);
  assert.equal(resumed.proposal.destinationLocationId, env.workspace.main.id);
  assert.equal(resumed.proposal.settings.axes[0].values[0], '6');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 0, 'answering only prepares the same action');
});

test('initial stock is never guessed across several new variants', () => {
  const env = setup();
  const built = proposals.build(env.db, env.ctx, {
    actionType: 'create_item',
    serials: [],
    productName: 'Crew Socks',
    productCode: 'SOCK',
    variantAxes: 'Size: 6, 7',
    quantity: 35,
    destinationLocation: 'Main Warehouse',
  });

  assert.equal(built.ok, false);
  assert.match(built.question, /Which variant should receive the 35/);
});

test('a retried creation does not create the product twice', () => {
  const env = setup();
  const proposal = createProposal(env, { productName: 'Copper Tee', productCode: 'CT-500' });
  execution.approve(env.db, env.ctx, env.membership, proposal.proposalId);

  const first = execution.execute(env.db, env.ctx, env.membership, proposal.proposalId);
  const second = execution.execute(env.db, env.ctx, env.membership, proposal.proposalId);
  const third = execution.execute(env.db, env.ctx, env.membership, proposal.proposalId);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(third.replayed, true);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 1);
});

test('creating a duplicate is refused before a proposal exists', () => {
  const env = setup();
  itemService.createItem(env.db, env.ctx, { name: 'Copper Tee', baseCode: 'CT-500', trackingMode: 'quantity' });

  const built = proposals.build(env.db, env.ctx, {
    actionType: 'create_item', serials: [], productName: 'Copper Tee', productCode: 'CT-500',
  });
  assert.equal(built.ok, false);
  assert.match(built.unsupported, /already uses the code CT-500/);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM action_proposals').get().n, 0);
});

test('several products in one instruction become one reviewable plan', () => {
  const env = setup({ primaryArchetype: 'quantity', usesVariants: false });
  const actionService = require('../../src/actions/action-service');

  const built = ['Copper Elbow CE-100', 'Copper Tee CT-200', 'Copper Pipe CP-300'].map((line) => {
    const [name, code] = [line.slice(0, line.lastIndexOf(' ')), line.slice(line.lastIndexOf(' ') + 1)];
    const result = proposals.build(env.db, env.ctx, {
      actionType: 'create_item', serials: [], productName: name, productCode: code,
    });
    assert.ok(result.ok, result.question || result.unsupported);
    return result.proposal;
  });

  const plan = actionService.createPlan(env.db, env.ctx, built, { instruction: 'create three' });
  assert.equal(plan.lines.length, 3);

  execution.approvePlan(env.db, env.ctx, env.membership, plan.planId);
  const result = execution.executePlan(env.db, env.ctx, env.membership, plan.planId);
  assert.equal(result.verified, true);

  const items = env.db
    .prepare('SELECT name, base_code FROM items WHERE workspace_id = ? ORDER BY name')
    .all(env.workspace.workspaceId);
  assert.deepEqual(items.map((i) => i.base_code), ['CE-100', 'CP-300', 'CT-200']);

  // And running the plan again changes nothing.
  execution.executePlan(env.db, env.ctx, env.membership, plan.planId);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 3);
});

test('creation is bound to one inventory', () => {
  const env = setup();
  const other = seedWorkspace(env.db, { workspaceName: 'Elsewhere' });

  const proposal = createProposal(env, { productName: 'Oxford Shirt', productCode: 'OS-1' });
  execution.approve(env.db, env.ctx, env.membership, proposal.proposalId);
  execution.execute(env.db, env.ctx, env.membership, proposal.proposalId);

  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n, 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(other.workspaceId).n, 0);
});

test('a read-only member cannot add products', () => {
  const viewer = { role: 'staff', permissions: JSON.stringify(['VIEW']) };
  assert.throws(() => permissions.assertCanPerform(viewer, 'create_item'), /do not have permission to add products/);
});

/**
 * A workbook whose elements carry a namespace prefix.
 *
 * OOXML lets a producer choose its own prefix, and plenty do: the file that
 * exposed this writes <x:workbook>, <x:sheets>, <x:sheet>, and the same for
 * every row, cell and shared string. Every pattern in the reader matched the
 * bare name, so a perfectly ordinary spreadsheet — one Excel and every other
 * tool opens without comment — reported "no readable sheets".
 *
 * The relationships in that file are also written Type, Target, Id, while the
 * reader required Id before Target, so no sheet could be located by id either.
 *
 * Both are exactly the failure mode of parsing XML with regular expressions:
 * it works until it meets a producer that made different, equally valid,
 * choices about spelling.
 */
function prefixedWorkbook() {
  const zip = require('node:zlib');
  const entries = new Map();
  const put = (name, xml) => entries.set(name, Buffer.from(xml, 'utf8'));

  put('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  put('xl/workbook.xml',
    '<?xml version="1.0" encoding="utf-8"?>'
    + '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<x:sheets>'
    + '<x:sheet name="Clothing Inventory" sheetId="1" r:id="Rabc" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" />'
    + '</x:sheets></x:workbook>');
  // Attribute order Type, Target, Id — and an absolute target path.
  put('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="utf-8"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
    + ' Target="/xl/worksheets/sheet1.xml" Id="Rabc" /></Relationships>');
  put('xl/sharedStrings.xml',
    '<?xml version="1.0" encoding="utf-8"?>'
    + '<x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<x:si><x:t>SKU</x:t></x:si><x:si><x:t>Classic Crew T-Shirt</x:t></x:si>'
    + '</x:sst>');
  put('xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="utf-8"?>'
    + '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>'
    + '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row>'
    + '<x:row r="2"><x:c r="A2" t="s"><x:v>1</x:v></x:c><x:c r="B2"><x:v>34</x:v></x:c></x:row>'
    + '</x:sheetData></x:worksheet>');

  // Minimal store-only zip: local headers, then the central directory.
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = (() => {
      let c = ~0;
      for (const byte of body) {
        c ^= byte;
        for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
      }
      return ~c >>> 0;
    })();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(body.length, 24); dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralPart.length, 12); end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

test('a namespace-prefixed workbook is read like any other', () => {
  const workbook = xlsxReader.readWorkbook(prefixedWorkbook());

  assert.equal(workbook.sheets.length, 1, 'the sheet is found despite the x: prefix');
  assert.equal(workbook.sheets[0].name, 'Clothing Inventory');

  const [header, first] = workbook.sheets[0].rows;
  assert.deepEqual(header, ['SKU'], 'shared strings resolve through prefixed <x:t>');
  assert.equal(first[0], 'Classic Crew T-Shirt');
  assert.equal(first[1], '34', 'and inline numbers still read');
});

test('an unreadable spreadsheet is the uploader’s problem, not a server fault', () => {
  const { DomainError } = require('../../src/domain/errors');
  const error = new xlsxReader.SpreadsheetError('That spreadsheet has no readable sheets.');

  // The web layer decides between "here is what is wrong with your file" and
  // "something went wrong on our side" by asking this exact question.
  assert.ok(error instanceof DomainError, 'so the real message reaches the person');
  assert.equal(error.status, 400);
  assert.equal(error.code, 'spreadsheet_unreadable');
});

/**
 * A barcode and an SKU are two different facts.
 *
 * "barcode", "upc", "ean" and "gtin" used to be wordings for the `code` field,
 * and a field can be claimed by one column. So a file carrying both an SKU
 * column and a Barcode column had them competing: SKU won, and the barcodes
 * were reported as a column Foundry could find no home for — forty real GTINs
 * dropped on the way in, unrecoverable once the file was gone.
 *
 * One is what the business calls the product. The other is what is printed on
 * the box, and it is the only one a scanner can resolve.
 */
test('a file with both an SKU and a barcode column keeps both', () => {
  const columns = ['SKU', 'Item Name', 'Qty On Hand', 'Barcode']
    .map((name, index) => ({ index, name }));
  const rows = [
    { cells: ['TSH-BLK-S', 'Classic Crew T-Shirt', '34', '810001000001'] },
    { cells: ['TSH-BLK-M', 'Classic Crew T-Shirt', '42', '810001000002'] },
  ];
  const { mappings, unnamed } = fields.guessMappings(columns, rows);

  assert.equal(columns[mappings.code].name, 'SKU');
  assert.equal(columns[mappings.barcode].name, 'Barcode', 'the barcode has its own field');
  assert.deepEqual(unnamed.map((column) => column.name), [],
    'and nothing is left as a column with no home');
});

test('a barcode column alone is still recognised as a barcode', () => {
  // Common enough: a file that identifies products only by what is on the box.
  for (const header of ['Barcode', 'UPC', 'EAN', 'GTIN', 'Bar Code']) {
    const columns = [{ index: 0, name: header }, { index: 1, name: 'Item Name' }];
    const rows = [{ cells: ['810001000001', 'Classic Crew T-Shirt'] }];
    const { mappings } = fields.guessMappings(columns, rows);
    assert.equal(mappings.barcode, 0, `${header} is a barcode`);
    assert.notEqual(mappings.code, 0, `${header} is not the business code`);
  }
});
