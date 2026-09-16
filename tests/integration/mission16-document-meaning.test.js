'use strict';

/*
 * Understanding a document before changing the business because of it.
 *
 * A proforma invoice for 800 pairs of shoes still being made in a factory was
 * imported as 800 pairs on the shelf and $21,390 debited to Inventory Asset.
 * Nothing had arrived, nothing was owed, and the owner's balance sheet
 * asserted ownership of goods that did not exist — on their first day.
 *
 * The cause was not a bad reader. It was that every document took the same
 * path: read the lines, create the products, receive the stock. So what is
 * under test here is that StockChief works out what a document *proves* first,
 * says what it will and will not do, and then only does the part the paper
 * actually supports.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const meaning = require('../../src/foundry/document-meaning');
const intake = require('../../src/foundry/document-intake');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

/* The shoe order that started all of this, without the model in the loop. */
function proforma(overrides = {}) {
  return intake.normalise({
    documentType: 'proforma_invoice',
    goodsHaveArrived: false,
    businessDescription: 'Footwear ordered from a factory.',
    unitLabel: 'pair',
    supplierName: 'Chongqing Langchi Shoes Co., Ltd.',
    supplierCodeLabel: 'Model No.',
    supplierEmail: 'langchishoes@example.test',
    documentNumber: '2026042902PI',
    documentDate: '2026-04-29',
    paymentTerms: '40% down payment by T/T against order',
    currency: 'USD',
    destinationName: 'Main Warehouse',
    destinationAddress: '',
    lines: [
      { styleName: 'loafer', color: '', variantDimension: 'Size', size: '38', supplierSku: '6L665-1-2',
        description: 'loafer', quantity: 100, unitCost: 26.7, sellingPrice: -1 },
      { styleName: 'bike toe slip in', color: '', variantDimension: 'Size', size: '40', supplierSku: 'DL665-2',
        description: 'slip on', quantity: 300, unitCost: 26.7, sellingPrice: -1 },
    ],
    charges: [
      { label: 'Sea freight for 800 pairs DDP to door', kind: 'freight', amount: 5411 },
      { label: 'Insurance', kind: 'insurance', amount: 83 },
      { label: 'Deducted 8 pairs sample cost', kind: 'discount', amount: -280 },
    ],
    documentTotal: 26604,
    warnings: [],
    ...overrides,
  });
}

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'HalFi Shoes' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  require('../../src/accounting/automatic').ensure(db, workspace.workspaceId, { actorId: workspace.ctx.actorId });
  return { db, workspace, ctx: workspace.ctx, membership };
}

function importIt(env, interpretation, documentIntent) {
  const prepared = intake.prepareFromInterpretation(env.db, env.ctx, env.membership,
    { filename: 'PI.pdf', buffer: Buffer.from('%PDF-1.4 test'), mimeType: 'application/pdf' },
    interpretation, 'raw text');
  const applied = intake.apply(env.db, env.ctx, env.membership, prepared.understandingId, null, { documentIntent });
  return typeof applied.result === 'string' ? JSON.parse(applied.result) : applied.result;
}

const onHand = (env) => env.db.prepare('SELECT COALESCE(SUM(quantity_delta), 0) AS q FROM movements WHERE workspace_id = ?')
  .get(env.workspace.workspaceId).q;
const ledger = (env, key) => {
  const row = env.db.prepare(`SELECT SUM(COALESCE(l.debit_minor,0)) AS dr, SUM(COALESCE(l.credit_minor,0)) AS cr
    FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id = l.account_id
    WHERE l.workspace_id = ? AND a.system_key = ?`).get(env.workspace.workspaceId, key);
  return { dr: Number(row.dr || 0), cr: Number(row.cr || 0) };
};

test('a proforma invoice says what it will not do, and why', () => {
  const read = meaning.meaningOf(proforma(), { isNewWorkspace: true });

  assert.equal(read.kind, 'proforma_invoice');
  assert.match(read.headline, /quote to be confirmed/i);
  assert.ok(read.wontDo.some((entry) => /on-hand stock/.test(entry.what)),
    'the refusal to create stock is stated, not silent');
  assert.ok(read.wontDo.some((entry) => /money as owed/.test(entry.what)));
  assert.ok(read.needsYou.some((entry) => /place this order/i.test(entry.question)));
});

test('an invoice is money owed and says nothing about delivery', () => {
  const read = meaning.meaningOf(proforma({ documentType: 'supplier_invoice' }), {});
  assert.equal(read.kind, 'supplier_invoice');
  assert.ok(read.willDo.some((entry) => /owed to/.test(entry)), 'the bill is recorded');
  assert.ok(read.wontDo.some((entry) => /on-hand stock/.test(entry.what)),
    'an invoice is not evidence that anything arrived');
});

test("the reader's old vocabulary cannot mean 'receive everything' any more", () => {
  /*
   * Before this existed the only options were invoice, purchase_order,
   * stock_report, catalogue and other — and every one of them led to stock.
   * A document already read as "invoice" has to keep meaning what an invoice
   * means, not what the old code did with it.
   */
  assert.equal(meaning.kindOf({ documentType: 'invoice' }), 'supplier_invoice');
  assert.equal(meaning.kindOf({ documentType: 'stock_report' }), 'opening_inventory');
  assert.equal(meaning.kindOf({ documentType: 'nonsense' }), 'other');
  assert.equal(meaning.KINDS.other.establishes.onHand, false,
    'a document StockChief cannot identify changes nothing');
});

test('placing the order commits to buy and moves nothing', () => {
  const env = setup();
  const result = importIt(env, proforma(), 'Place the order');

  assert.equal(onHand(env), 0, 'nothing has arrived');
  assert.equal(result.unitsOnOrder, 400);
  const po = env.db.prepare('SELECT po_number, status FROM purchase_orders WHERE workspace_id = ?')
    .get(env.workspace.workspaceId);
  assert.equal(po.status, 'ORDERED');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM purchase_order_charges WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 3, 'freight, insurance and the sample credit are kept');
});

test('a document reconciles against its own stated total, whatever was done with it', () => {
  /*
   * The charges panel adds the goods to the charges and compares the result
   * with the total the document states — but it only knew the goods value when
   * the document had been used to open the books. Answer the same proforma with
   * "Place the order" and the goods fell to zero, so the sum came out short by
   * exactly the value of the shoes, and StockChief printed "these lines do not add
   * up ... which means StockChief read a line wrong" about a document it had read
   * perfectly.
   */
  const documentCosts = require('../../src/accounting/document-costs');

  // 400 pairs at 26.70, plus 5411 + 83 − 280 of charges.
  const consistentTotal = 400 * 26.7 + 5411 + 83 - 280;

  for (const answer of ['Place the order', 'This is what I already have in stock']) {
    const env = setup();
    importIt(env, proforma({ documentTotal: consistentTotal }), answer);

    const [doc] = documentCosts.forWorkspace(env.db, env.workspace.workspaceId);
    assert.ok(doc, `${answer}: the document's charges are kept`);
    assert.equal(doc.goodsMinor, 400 * 2670,
      `${answer}: the goods are worth what the lines say, whatever was done with the document`);

    const charges = doc.charges.reduce((sum, charge) => sum + charge.amountMinor, 0);
    assert.equal(doc.addsUpMinor, doc.goodsMinor + charges,
      `${answer}: what StockChief adds up is the goods plus the charges`);
    assert.equal(doc.differsFromStatedMinor, 0,
      `${answer}: and it matches the document's own total, so StockChief does not accuse `
      + 'itself of a misread it did not make');
    env.db.close();
  }
});

test('a document that genuinely does not add up is still called out', () => {
  /*
   * The other half of the same rule. Fixing the false alarm must not silence
   * the true one: this proforma states a total for eight hundred pairs and
   * lists four hundred, and somebody should be told.
   */
  const documentCosts = require('../../src/accounting/document-costs');
  const env = setup();
  importIt(env, proforma({ documentTotal: 26604 }), 'Place the order');

  const [doc] = documentCosts.forWorkspace(env.db, env.workspace.workspaceId);
  assert.notEqual(doc.differsFromStatedMinor, 0, 'a real inconsistency is still reported');
  assert.equal(doc.addsUpMinor + doc.differsFromStatedMinor, doc.documentTotalMinor,
    'and the difference reported is the actual gap, not an artefact');
  env.db.close();
});

test('keeping only the prices creates no order at all', () => {
  const env = setup();
  importIt(env, proforma(), 'Just keep the prices');

  assert.equal(onHand(env), 0);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 0,
  'an order nobody placed would be a delivery to chase that does not exist');
  assert.ok(env.db.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n > 0, 'the catalogue is still worth having');
});

test('opening stock is equity, never a debt to the supplier', () => {
  /*
   * The failure this replaces: an owner saying "this is what I already have"
   * was told they owed a factory $21,390 for goods they already owned,
   * because the only way to put stock on a shelf was to receive it from a
   * supplier.
   */
  const env = setup();
  const result = importIt(env, proforma(), 'This is what I already have in stock');

  assert.equal(onHand(env), 400, 'the stock is on the shelf');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 0, 'nothing was bought');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM accounting_supplier_bills WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n, 0, 'and nothing is owed');

  const expected = Math.round(100 * 26.7 * 100) + Math.round(300 * 26.7 * 100);
  assert.equal(result.openingValueMinor, expected);
  assert.equal(ledger(env, 'INVENTORY_ASSET').dr, expected);
  assert.equal(ledger(env, 'OPENING_BALANCE_EQUITY').cr, expected,
    'the other side of opening stock is what the business was worth, not a payable');
  assert.equal(ledger(env, 'RECEIVED_NOT_INVOICED').cr, 0);

  // And it carries a cost, so selling it later can state a product cost.
  const costed = env.db.prepare(`SELECT COALESCE(SUM(quantity_units),0) AS q, COALESCE(SUM(total_cost_minor),0) AS c
    FROM accounting_inventory_cost_balances WHERE workspace_id = ?`).get(env.workspace.workspaceId);
  assert.equal(costed.q, 400);
  assert.equal(costed.c, expected);
});

test('a document that evidences delivery still receives normally', () => {
  const env = setup();
  importIt(env, proforma({ documentType: 'invoice', goodsHaveArrived: true }), null);
  assert.equal(onHand(env), 400, 'a real delivery is still a real delivery');
});
