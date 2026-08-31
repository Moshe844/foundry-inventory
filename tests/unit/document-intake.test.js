'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas, loadImage, PDFDocument } = require('@napi-rs/canvas');

const documentIntake = require('../../src/foundry/document-intake');
const authService = require('../../src/domain/auth-service');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');
const { fakeProvider, buildUnderstanding } = require('../helpers/fake-provider');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, membership, ctx: workspace.ctx };
}

function invoiceInterpretation() {
  return {
    documentType: 'invoice',
    businessDescription: 'The business buys children’s shoes as size variants from Step & Style Wholesale and receives them into Brooklyn Warehouse.',
    unitLabel: 'pair',
    supplierName: 'Step & Style Wholesale', supplierCodeLabel: 'Supplier Code', supplierEmail: 'sales@example.com',
    documentNumber: 'INV-2026-0816', documentDate: '2026-08-16', paymentTerms: 'Net 15', currency: 'USD',
    destinationName: 'Brooklyn Warehouse', destinationAddress: '78 Distribution Ave, Brooklyn, NY 11222',
    lines: [
      { styleName: 'Kids Classic Loafer', color: 'Black', variantDimension: 'Size', size: '23', supplierSku: 'SH-101-BLK', description: 'Kids Classic Loafer - Black', quantity: 12, unitCost: 11.5 },
      { styleName: 'Kids Classic Loafer', color: 'Black', variantDimension: 'Size', size: '24', supplierSku: 'SH-101-BLK', description: 'Kids Classic Loafer - Black', quantity: 10, unitCost: 11.5 },
      { styleName: 'Boys Dress Oxford', color: 'Brown', variantDimension: 'Size', size: '28', supplierSku: 'SH-204-BRN', description: 'Boys Dress Oxford - Brown', quantity: 8, unitCost: 14.75 },
    ],
    warnings: [],
  };
}

test('a spreadsheet or text source is read from its actual bytes', async () => {
  const text = await documentIntake.extractText({
    filename: 'opening-invoice.csv',
    buffer: Buffer.from('Code,Description,Size,Qty\nSH-101-BLK,Kids Classic Loafer,23,12\n'),
  });
  assert.match(text, /SH-101-BLK/);
  assert.match(text, /Kids Classic Loafer/);
});

test('an image-only scanned PDF is rendered and read with local OCR', async () => {
  const imageCanvas = createCanvas(1400, 700);
  const imageContext = imageCanvas.getContext('2d');
  imageContext.fillStyle = '#ffffff';
  imageContext.fillRect(0, 0, 1400, 700);
  imageContext.fillStyle = '#000000';
  imageContext.font = 'bold 58px Arial';
  imageContext.fillText('INVOICE SCAN-2048', 80, 130);
  imageContext.font = '44px Arial';
  imageContext.fillText('Blue Widget   Size 12   Quantity 24', 80, 240);
  imageContext.fillText('Supplier Code BW-12', 80, 330);

  const image = await loadImage(imageCanvas.toBuffer('image/png'));
  const pdf = new PDFDocument();
  const pdfContext = pdf.beginPage(1400, 700);
  pdfContext.drawImage(image, 0, 0, 1400, 700);
  pdf.endPage();

  const text = await documentIntake.extractText({ filename: 'scanned-invoice.pdf', buffer: pdf.close() });
  assert.match(text, /INVOICE SCAN-2048/i);
  assert.match(text, /Blue Widget/i);
  assert.match(text, /Quantity 24/i);
  assert.match(text, /BW-12/i);
});

test('an approved setup document creates products, supplier, order, receipt and ledger truth', async () => {
  const env = setup();
  const understanding = buildUnderstanding({
    businessDescription: invoiceInterpretation().businessDescription,
    variantDimensions: [{ name: 'Size', exampleValues: ['23', '24', '28'] }],
    likelyLocations: [{ name: 'Brooklyn Warehouse', kind: 'warehouse', certainty: 'inferred_confidently' }],
    recommendedConfiguration: {
      trackingMode: 'quantity', usesVariants: true, allowNegativeStock: false,
      summary: 'Each shoe size is counted separately.',
    },
  });
  const { recommendations, unresolvedDecisions, ...core } = understanding;
  const provider = fakeProvider([invoiceInterpretation(), core, { recommendations, unresolvedDecisions }]);
  const prepared = await documentIntake.prepare(env.db, env.ctx, env.membership, {
    filename: 'opening-invoice.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Code,Style,Color,Size,Qty,Cost\nSH-101-BLK,Kids Classic Loafer,Black,23,12,11.50\n'),
  }, { provider });

  assert.equal(prepared.document.status, 'PREPARED');
  assert.equal(prepared.document.supplierCodeLabel, 'Supplier Code');
  const storedUnderstanding = env.db.prepare('SELECT provider, payload FROM foundry_understandings WHERE id = ?').get(prepared.understandingId);
  const payload = JSON.parse(storedUnderstanding.payload);
  assert.equal(storedUnderstanding.provider, 'document-evidence');
  assert.deepEqual(payload.likelyLocations.map((location) => location.name), ['Brooklyn Warehouse']);
  assert.deepEqual(payload.variantDimensions, [{ name: 'Size', exampleValues: ['23', '24', '28'] }]);
  assert.deepEqual(payload.unresolvedDecisions, []);
  assert.deepEqual(payload.recommendations, []);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 0);

  documentIntake.setSupplierCodeLabel(env.db, env.ctx, prepared.understandingId, 'Style #');
  const applied = documentIntake.apply(env.db, env.ctx, env.membership, prepared.understandingId, null);
  assert.equal(applied.status, 'APPLIED');
  assert.equal(applied.result.products, 2);
  assert.equal(applied.result.variants, 3);
  assert.equal(applied.result.units, 30);
  assert.equal(applied.result.unitLabel, 'pair');
  assert.equal(applied.result.supplier, 'Step & Style Wholesale');
  assert.equal(applied.result.location, 'Brooklyn Warehouse');
  assert.equal(applied.result.poNumber, 'INV-2026-0816');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 2);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 3);
  assert.equal(env.db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 30);
  assert.equal(env.db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(applied.result.purchaseOrderId).status, 'RECEIVED');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 3);
  const supplier = supplierService.listSuppliers(env.db, env.ctx.workspaceId)[0];
  assert.equal(supplier.itemCodeLabel, 'Style #');
  assert.ok(supplier.itemCodeAliases.includes('Supplier Code'));
  assert.equal(poService.get(env.db, env.ctx.workspaceId, applied.result.purchaseOrderId).supplierItemCodeLabel, 'Style #');

  const replayed = documentIntake.apply(env.db, env.ctx, env.membership, prepared.understandingId, null);
  assert.equal(replayed.result.units, 30);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 3);

  const nextInterpretation = { ...invoiceInterpretation(), documentNumber: 'INV-2026-0817',
    lines: invoiceInterpretation().lines.map((line) => ({ ...line, quantity: 1 })) };
  const next = documentIntake.prepareFromInterpretation(env.db, env.ctx, env.membership, {
    filename: 'next-invoice.csv', mimeType: 'text/csv', buffer: Buffer.from('different invoice bytes'),
  }, nextInterpretation, 'next inventory list');
  assert.deepEqual(documentIntake.matchPreview(env.db, env.ctx.workspaceId, nextInterpretation)
    .map((entry) => entry.status), ['match', 'match', 'match']);
  documentIntake.apply(env.db, env.ctx, env.membership, next.understandingId, null);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 2,
    'a later document reuses exact supplier SKU and variant matches');
  assert.equal(env.db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?').get(env.ctx.workspaceId).n, 33);
});

test('a stock document can preserve separate quantities for multiple locations', () => {
  const env = setup();
  const interpretation = {
    ...invoiceInterpretation(), documentType: 'stock_report', documentNumber: 'COUNT-10',
    destinationName: '', destinationAddress: '',
    lines: [{ styleName: 'Work Shirt', color: 'Blue', variantDimension: 'Size', size: 'M',
      supplierSku: 'WS-BLU-M', description: 'Work Shirt / Blue / M', quantity: 9, unitCost: 8,
      locationQuantities: [{ locationName: 'Main Warehouse', quantity: 6 },
        { locationName: 'Downtown Store', quantity: 3 }] }],
  };
  const prepared = documentIntake.prepareFromInterpretation(env.db, env.ctx, env.membership, {
    filename: 'inventory.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('workbook bytes'),
  }, interpretation, 'inventory workbook');
  documentIntake.apply(env.db, env.ctx, env.membership, prepared.understandingId, null);
  const locations = env.db.prepare('SELECT id, name FROM locations WHERE workspace_id = ? ORDER BY name')
    .all(env.ctx.workspaceId);
  assert.deepEqual(locations.map((row) => row.name), ['Downtown Store', 'Main Warehouse']);
  const balances = env.db.prepare(`SELECT l.name, b.on_hand FROM balances b JOIN locations l ON l.id = b.location_id
    WHERE b.workspace_id = ? ORDER BY l.name`).all(env.ctx.workspaceId);
  assert.deepEqual(balances, [{ name: 'Downtown Store', on_hand: 3 }, { name: 'Main Warehouse', on_hand: 6 }]);
  env.db.close();
});
