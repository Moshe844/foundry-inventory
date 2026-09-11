'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const auth = require('../../src/domain/auth-service');
const permissions = require('../../src/actions/permissions');
const inventory = require('../../src/domain/inventory-engine');
const costing = require('../../src/accounting/costing');
const ledger = require('../../src/accounting/ledger');
const payables = require('../../src/accounting/payables');
const landed = require('../../src/accounting/landed-costs');
const landedProposal = require('../../src/foundry/landed-cost-proposal');
const invoiceIntake = require('../../src/foundry/supplier-invoice-intake');
const uom = require('../../src/uom/service');
const suppliers = require('../../src/purchasing/supplier-service');
const orders = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Costed boot' });
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, { name: 'Cost supplier' });
  suppliers.linkItem(db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: item.skuId, supplierSku: 'BOOT-1', purchaseUnit: 'case',
    unitsPerPurchaseUnit: 1, lastUnitCost: 1,
  });
  let order = orders.createOrder(db, workspace.ctx, membership, {
    supplierId: supplier.id, destinationLocationId: workspace.main.id,
    lines: [{ skuId: item.skuId, quantityUnits: 10, unitCost: 1 }],
  });
  order = orders.approve(db, workspace.ctx, membership, order.id);
  const first = receiving.receive(db, workspace.ctx, membership, order.id, {
    idempotencyKey: 'mission7-first', lines: [{ lineId: order.lines[0].id, quantityUnits: 4 }],
  }).receipt;
  const second = receiving.receive(db, workspace.ctx, membership, order.id, {
    idempotencyKey: 'mission7-second', lines: [{ lineId: order.lines[0].id, quantityUnits: 6 }],
  }).receipt;
  for (const receipt of [first, second]) costing.receive(db, workspace.ctx, {
    movementIds: receipt.lines.flatMap((line) => line.movementIds), unitCostMinor: 100,
    sourceType: 'purchase_receipt_test', sourceRecordId: receipt.id,
  });
  const billDraft = payables.createDraft(db, workspace.ctx, membership, {
    supplierId: supplier.id, supplierInvoiceNumber: 'FREIGHT-1', issueDate: '2026-08-01',
    sourceKey: 'mission7-freight-1', lines: [{ description: 'Inbound freight', quantity: 1, unitCostMinor: 101 }],
  });
  const bill = payables.open(db, workspace.ctx, membership, billDraft.bill.id);
  return { db, workspace, membership, item, supplier, order, first, second, bill };
}

test('compatible UOMs use exact conversions and never bridge unrelated families', () => {
  const env = setup();
  const count = uom.createFamily(env.db, env.workspace.ctx, env.membership, { name: 'Count' });
  const each = uom.defineUnit(env.db, env.workspace.ctx, env.membership, { familyId: count.id, name: 'Each', symbol: 'ea' });
  const case12 = uom.defineUnit(env.db, env.workspace.ctx, env.membership, { familyId: count.id, name: 'Case of 12', symbol: 'cs12', baseNumerator: 12 });
  const mass = uom.createFamily(env.db, env.workspace.ctx, env.membership, { name: 'Mass' });
  const gram = uom.defineUnit(env.db, env.workspace.ctx, env.membership, { familyId: mass.id, name: 'Gram', symbol: 'g' });
  assert.equal(uom.convert(env.db, env.workspace.workspaceId, { quantity: 3, fromUomId: case12.id, toUomId: each.id, requireWhole: true }).quantityConverted, 36);
  assert.throws(() => uom.convert(env.db, env.workspace.workspaceId, { quantity: 1, fromUomId: case12.id, toUomId: gram.id }), /not compatible/i);
  const profile = uom.setSkuProfile(env.db, env.workspace.ctx, env.membership, {
    skuId: env.item.skuId, stockingUomId: each.id, sellingUomId: each.id, unitWeightGrams: 500,
  });
  assert.equal(profile.unit_weight_grams, 500);
});

test('partial receipts and a billed freight charge allocate exactly, capitalise once, and flow into future COGS', () => {
  const env = setup();
  const draft = landed.createDraft(env.db, env.workspace.ctx, env.membership, {
    purchaseOrderId: env.order.id, receiptIds: [env.first.id, env.second.id], allocationMethod: 'quantity',
    charges: [{ category: 'freight', description: 'Carrier freight', amountMinor: 101, sourceBillLineId: env.bill.lines[0].id }],
  });
  assert.equal(draft.preview.sourceTotalMinor, 101);
  assert.deepEqual(draft.preview.allocations.map((row) => row.amountMinor).sort((a, b) => a - b), [40, 61]);
  landed.approve(env.db, env.workspace.ctx, env.membership, draft.document.id);
  const applied = landed.apply(env.db, env.workspace.ctx, env.membership, draft.document.id);
  assert.equal(applied.replayed, false);
  assert.equal(costing.state(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id).total_cost_minor, 1101);
  const replay = landed.apply(env.db, env.workspace.ctx, env.membership, draft.document.id);
  assert.equal(replay.replayed, true);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM landed_cost_allocations').get().n, 2);
  const issue = inventory.issue(env.db, env.workspace.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 5 });
  const cost = costing.issue(env.db, env.workspace.ctx, { movementIds: issue.movementIds,
    sourceType: 'mission7-sale', sourceRecordId: 'mission7-sale-1' });
  assert.equal(cost.totalCostMinor, 551, 'post-allocation weighted cost is used by the next sale');
});

test('allocation by weight refuses missing product evidence instead of estimating it', () => {
  const env = setup();
  assert.throws(() => landed.createDraft(env.db, env.workspace.ctx, env.membership, {
    purchaseOrderId: env.order.id, receiptIds: [env.first.id], allocationMethod: 'weight',
    charges: [{ category: 'insurance', description: 'Cargo insurance', amountMinor: 100, sourceBillLineId: env.bill.lines[0].id }],
  }), /needs the unit weight.*No weight was guessed/i);
});

test('a landed-cost correction creates immutable negative value and accounting entries', () => {
  const env = setup();
  const draft = landed.createDraft(env.db, env.workspace.ctx, env.membership, {
    purchaseOrderId: env.order.id, receiptIds: [env.first.id, env.second.id], allocationMethod: 'quantity',
    charges: [{ category: 'duty', description: 'Import duty', amountMinor: 100, sourceBillLineId: env.bill.lines[0].id }],
  });
  landed.approve(env.db, env.workspace.ctx, env.membership, draft.document.id);
  const applied = landed.apply(env.db, env.workspace.ctx, env.membership, draft.document.id);
  const reversed = landed.reverse(env.db, env.workspace.ctx, env.membership, draft.document.id, { reason: 'Supplier corrected duty' });
  assert.equal(reversed.document.status, 'REVERSED');
  assert.equal(costing.state(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id).total_cost_minor, 1000);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_journal_entries
    WHERE reversal_of_entry_id = ?`).get(applied.journalEntry.id).n, 1);
});

test('separate freight and insurance bills can be capitalised against the same partial receipts', () => {
  const env = setup();
  const insuranceDraft = payables.createDraft(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, supplierInvoiceNumber: 'INSURE-1', issueDate: '2026-08-02',
    sourceKey: 'mission7-insurance-1', lines: [{ description: 'Cargo insurance', quantity: 1, unitCostMinor: 99 }],
  });
  const insurance = payables.open(env.db, env.workspace.ctx, env.membership, insuranceDraft.bill.id);
  const draft = landed.createDraft(env.db, env.workspace.ctx, env.membership, {
    purchaseOrderId: env.order.id, receiptIds: [env.first.id, env.second.id], allocationMethod: 'quantity',
    charges: [
      { category: 'freight', description: 'Carrier freight', amountMinor: 101, sourceBillLineId: env.bill.lines[0].id },
      { category: 'insurance', description: 'Cargo insurance', amountMinor: 99, sourceBillLineId: insurance.lines[0].id },
    ],
  });
  landed.approve(env.db, env.workspace.ctx, env.membership, draft.document.id);
  landed.apply(env.db, env.workspace.ctx, env.membership, draft.document.id);
  assert.equal(costing.state(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id).total_cost_minor, 1200);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM landed_cost_allocations WHERE document_id = ?').get(draft.document.id).n, 4);
});

test('landed-cost authority is separate from ordinary warehouse staff permissions', () => {
  const env = setup();
  const staffAccount = auth.authenticate(env.db, env.workspace.staffEmail, 'password123');
  const staff = auth.getMembership(env.db, env.workspace.workspaceId, staffAccount.id);
  assert.equal(permissions.can(staff, permissions.ALLOCATE_LANDED_COST), false);
  assert.throws(() => landed.createDraft(env.db, env.workspace.ctx, staff, {
    receiptIds: [env.first.id], allocationMethod: 'quantity', charges: [],
  }), /permission/i);
});

test('invoice evidence automatically prepares, but never applies, a landed-cost draft', () => {
  const env = setup();
  const proposal = landedProposal.propose(env.db, env.workspace.ctx, env.membership, {
    purchaseOrder: { id: env.order.id }, bill: env.bill, sourceDocumentId: 'supplier-doc-evidence',
    interpretation: { documentNumber: 'FREIGHT-1', charges: [{ kind: 'freight', label: 'Inbound freight', amountMinor: 101 }] },
  });
  assert.equal(proposal.proposed, true);
  const document = landed.document(env.db, env.workspace.workspaceId, proposal.documentId);
  assert.equal(document.status, 'DRAFT');
  assert.equal(document.allocations.length, 0, 'a document reader cannot change inventory cost without approval');
  assert.match(proposal.reason, /exact quantity-based split/i);
});

test('a parsed supplier invoice with a documented freight-only charge posts the bill and prepares a draft', () => {
  const env = setup();
  const interpretation = {
    documentNumber: 'FREIGHT-2', documentDate: '2026-08-02',
    // A carrier/supplier invoice can contain just the evidenced freight charge.
    // No product line, conversion, quantity or product weight is invented.
    lines: [], charges: [{ kind: 'freight', label: 'Inbound freight', amountMinor: 101 }],
  };
  const billing = invoiceIntake.bill(env.db, env.workspace.ctx, env.membership, {
    interpretation, supplierId: env.supplier.id, order: env.order, sourceName: 'Supplier invoice',
  });
  assert.equal(billing.billed, true);
  assert.equal(billing.bill.status, 'OPEN');
  const proposal = landedProposal.propose(env.db, env.workspace.ctx, env.membership, {
    interpretation, bill: billing.bill, purchaseOrder: env.order, sourceDocumentId: 'supplier-doc-freight-2',
  });
  assert.equal(proposal.proposed, true);
  assert.equal(landed.document(env.db, env.workspace.workspaceId, proposal.documentId).status, 'DRAFT');
});
