'use strict';

/**
 * "Can you add two items 1: … 2: …" — the request that showed what was
 * still wrong: the introduction counted as a third change, the model read
 * one product of two, the prices were dropped without a word, and the
 * location was asked once per product. Each of those is a test here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const intentService = require('../../src/actions/intent-service');
const actionService = require('../../src/actions/action-service');
const proposals = require('../../src/actions/proposal-service');
const execution = require('../../src/actions/execution-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, seedWorkspace, cleanupAll } = require('../helpers');

test.after(cleanupAll);

const MESSAGE = 'Can you add two items 1: laufer shoes size 16 quantity 22, cost price: $20.00 Selling price: $100.00 2: sol shoes size 32 quantity 20, cost price: $15.00 Selling price: $80.00';
const CONTEXT = { itemNames: ['Copper Elbow'], locationNames: ['Main Warehouse', 'Downtown Store'] };

function line(productName, quantity, sellingPrice, unitCost, axes) {
  return {
    actionType: 'create_item', item: '', variant: '', recordKind: '', recordName: '', lotCode: '', serials: [],
    sourceLocation: '', destinationLocation: '', quantity, adjustmentTarget: -1, reasonCode: '', terminologyKey: '', terminologyValue: '',
    productName, productCode: '', variantAxes: axes, unitLabel: '', kitComponents: [], supplier: '', purchaseUnit: '',
    amount: -1, reference: '', recipient: '', messageBody: '', sellingPrice, unitCost,
  };
}

test('the words that introduce a numbered list are not counted as a change', () => {
  assert.equal(intentService.enumeratedClauses(MESSAGE).length, 2);
  assert.equal(intentService.enumeratedClauses('1) move 2 Copper Elbow from A to B; 2) move 1 Copper Elbow from B to A').length, 2);
  assert.deepEqual(intentService.enumeratedClauses('Set these selling prices:\nJEANS-BLACK-S: $12.00 each\nJEANS-NAVY-M: $18.75 each'), ['JEANS-BLACK-S: $12.00 each', 'JEANS-NAVY-M: $18.75 each'], 'a heading over a list is not a line of it');
});

test('a list the model read only partly is read again one clause at a time, prices included', async () => {
  const calls = [];
  const provider = { async complete(r) {
    const text = r.prompt.split('Instruction: ')[1] || '';
    calls.push(text);
    if (/laufer shoes.*sol shoes/s.test(text)) return { data: { lines: [line('laufer shoes', 22, 100, 20, 'Size: 16')], clarifyingQuestion: '', unsupportedReason: '' } };
    if (/laufer shoes/.test(text)) return { data: { lines: [line('laufer shoes', 22, 100, 20, 'Size: 16')], clarifyingQuestion: '', unsupportedReason: '' } };
    if (/sol shoes/.test(text)) return { data: { lines: [line('sol shoes', 20, 80, 15, 'Size: 32')], clarifyingQuestion: '', unsupportedReason: '' } };
    return { data: { lines: [], clarifyingQuestion: 'What?', unsupportedReason: '' } };
  } };
  const intent = await intentService.readInstruction(MESSAGE, { context: CONTEXT, provider });
  assert.equal(intent.lines.length, 2, 'both products, read one at a time after the whole read dropped one');
  assert.equal(calls.length, 3);
  assert.match(calls[1], /^Can you add two items: laufer shoes/, 'each clause is read with the introduction in front of it');
  assert.deepEqual(intent.lines.map((l) => [l.productName, l.quantity, l.sellingPriceMinor, l.unitCostMinor]),
    [['laufer shoes', 22, 10000, 2000], ['sol shoes', 20, 8000, 1500]]);
});

test('a clause that cannot be read is named in the person’s own words, and nothing is prepared', async () => {
  const provider = { async complete(r) {
    const text = r.prompt.split('Instruction: ')[1] || '';
    if (/laufer shoes/.test(text) && !/sol shoes/.test(text)) return { data: { lines: [line('laufer shoes', 22, 100, 20, 'Size: 16')], clarifyingQuestion: '', unsupportedReason: '' } };
    if (/sol shoes/.test(text) && !/laufer/.test(text)) return { data: { lines: [], clarifyingQuestion: 'Which size?', unsupportedReason: '' } };
    return { data: { lines: [line('laufer shoes', 22, 100, 20, 'Size: 16')], clarifyingQuestion: '', unsupportedReason: '' } };
  } };
  const intent = await intentService.readInstruction(MESSAGE, { context: CONTEXT, provider });
  assert.equal(intent.lines.length, 0);
  assert.match(intent.clarifyingQuestion, /StockChief could read 1 of them, so it prepared none/);
  assert.match(intent.clarifyingQuestion, /It could not read: “sol shoes size 32 quantity 20, cost price: \$15\.00 Selling price: \$80\.00”/);
  assert.doesNotMatch(intent.clarifyingQuestion, /move 2 <product>/);
});

test('two new products with no place named get one question, and the answer places both; the stated prices are recorded', async () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const parsedIntent = { lines: [
    intentService.normaliseLine(line('laufer shoes', 22, 100, 20, 'Size: 16')),
    intentService.normaliseLine(line('sol shoes', 20, 80, 15, 'Size: 32')),
  ], clarifyingQuestion: '', unsupportedReason: '' };
  const asked = await actionService.interpret(db, w.ctx, membership, MESSAGE, { parsedIntent });
  assert.equal(asked.kind, 'question');
  assert.match(asked.question, /Where should the stock for these 2 new products be received\? 22 laufer shoes \(Size: 16\), 20 sol shoes \(Size: 32\)/);
  const planned = await actionService.continueInterpretation(db, w.ctx, membership, asked.continuation, 'Main Warehouse');
  assert.equal(planned.kind, 'plan', JSON.stringify(planned).slice(0, 300));
  assert.equal(planned.plan.lines.length, 2);
  const presenter = require('../../src/actions/presenter');
  const lines = planned.plan.lines.map((p) => presenter.oneLine(db, w.workspaceId, p));
  assert.match(lines[0], /Add laufer shoes \/ Size: 16 at \$100\.00 and receive 22 at Main Warehouse/);
  assert.match(lines[1], /Add sol shoes \/ Size: 32 at \$80\.00 and receive 20 at Main Warehouse/);

  execution.approvePlan(db, w.ctx, membership, planned.plan.planId);
  const ran = execution.executePlan(db, w.ctx, membership, planned.plan.planId, { idempotencyKey: `plan:${planned.plan.planId}` });
  assert.equal(ran.verified, true);
  const rows = db.prepare(`SELECT i.name, b.on_hand,
      (SELECT amount_minor FROM sku_prices p WHERE p.sku_id = s.id ORDER BY p.rowid DESC LIMIT 1) AS price,
      (SELECT amount_minor FROM sku_purchase_costs c WHERE c.sku_id = s.id ORDER BY c.rowid DESC LIMIT 1) AS cost
    FROM items i JOIN skus s ON s.item_id = i.id LEFT JOIN balances b ON b.sku_id = s.id
    WHERE i.workspace_id = ? AND i.name IN ('laufer shoes', 'sol shoes') ORDER BY i.name`).all(w.workspaceId);
  assert.deepEqual(rows.map((r) => [r.name, r.on_hand, r.price, r.cost]), [['laufer shoes', 22, 10000, 2000], ['sol shoes', 20, 8000, 1500]]);
});

test('a photo or screenshot of a document is read, and a note that names its order matches that order', async () => {
  const documentIntake = require('../../src/foundry/document-intake');
  const documentEvents = require('../../src/manager/document-events');
  const fs = require('node:fs');
  const path = require('node:path');
  const buffer = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'delivery-note.png'));
  const text = await documentIntake.extractText({ filename: 'delivery-note.png', buffer, mimeType: 'image/png' });
  assert.match(text, /Acme Trade Supply/);
  assert.match(text, /PO-1001/);
  assert.match(text, /Copper Elbow 1\/2 in\.\s+CE-100\s+240/);
  await assert.rejects(documentIntake.extractText({ filename: 'blank.png', buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') }),
  /could not make out any text in that image/);

  const order = { id: 'po1', poNumber: 'PO-1001', supplierName: 'Someone Else', destinationLocationName: 'Main Warehouse', lines: [] };
  const other = { id: 'po2', poNumber: 'PO-1009', supplierName: 'Acme Trade Supply', destinationLocationName: 'Main Warehouse', lines: [] };
  const interpretation = { referencedOrderNumber: 'PO-1001', supplierName: 'Acme Trade Supply', destinationName: 'Main Warehouse', documentNumber: 'DN-88213', lines: [] };
  const named = documentEvents.scoreOrder(interpretation, order);
  const unnamed = documentEvents.scoreOrder(interpretation, other);
  assert.ok(named.score > unnamed.score, `${named.score} > ${unnamed.score}: the order the note names outranks a supplier match`);
  assert.ok(named.reasons.includes('the document names PO-1001'));
});
