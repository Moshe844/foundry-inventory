'use strict';

/**
 * "I paid ABC $400 toward invoice 8832 by ACH."
 *
 * A payment made outside Foundry cannot be observed by Foundry, so somebody has
 * to report it — there is no way around that. What was in Foundry's control was
 * the cost of reporting it: open payables, find the bill, enter a payment,
 * check the supplier balance, trust that the accounting followed. Seven steps
 * for one fact.
 *
 * The sentence carries the same fact. It adds no financial logic — the posting,
 * the allocation and the unapplied remainder are the payment engine, already
 * tested for partial payments and multi-document allocation — and it refuses to
 * decide which bill a payment settles when neither the sentence nor the records
 * say. A misapplied payment is two wrong balances.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../../src/accounting/ledger');
const payables = require('../../src/accounting/payables');
const paymentIntent = require('../../src/accounting/payment-intent');
const suppliers = require('../../src/purchasing/supplier-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Reported Payments Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, { name: 'ABC Apparel' });
  return { db, workspace, membership, supplier };
}

function openBill(env, { number, totalMinor, sourceKey }) {
  const expense = env.db.prepare(
    "SELECT id FROM accounting_accounts WHERE workspace_id = ? AND system_key = 'OPERATING_EXPENSE'"
  ).get(env.workspace.workspaceId);
  const draft = payables.createDraft(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, supplierInvoiceNumber: number,
    issueDate: '2026-01-01', dueDate: '2026-01-31', sourceKey,
    lines: [{ description: 'Goods', quantity: 1, unitCostMinor: totalMinor, debitAccountId: expense.id }],
  });
  return payables.open(env.db, env.workspace.ctx, env.membership, draft.bill.id);
}

const said = (fields) => ({
  direction: 'SUPPLIER_PAYMENT', counterpartyName: 'ABC Apparel',
  amountText: '', reference: '', method: '', dateText: '', ...fields,
});

test('a reported payment becomes an approvable proposal, then a posted payment', () => {
  const env = setup();
  const bill = openBill(env, { number: '8832', totalMinor: 100_000, sourceKey: 'bill:8832' });

  const proposed = paymentIntent.propose(env.db, env.workspace.workspaceId,
    said({ amountText: '$400', reference: '8832', method: 'ACH' }));

  assert.equal(proposed.ok, true);
  assert.equal(proposed.proposal.amountMinor, 40_000);
  assert.equal(proposed.proposal.target.balanceBeforeMinor, 100_000);
  assert.equal(proposed.proposal.target.appliedMinor, 40_000);
  assert.equal(proposed.proposal.target.balanceAfterMinor, 60_000);
  assert.equal(proposed.proposal.unappliedMinor, 0);

  // The preview is the thing being approved, stated in the owner's terms.
  assert.ok(proposed.proposal.preview.some((line) => /\$600\.00 remaining after/.test(line)),
    `preview said: ${proposed.proposal.preview.join(' | ')}`);

  paymentIntent.apply(env.db, env.workspace.ctx, env.membership, proposed.proposal,
    { sourceKey: 'reported:8832:1' });

  const after = payables.requireBill(env.db, env.workspace.workspaceId, bill.id);
  assert.equal(after.balance_minor, 60_000, 'the bill moved');
  assert.equal(after.status, 'PARTIALLY_PAID');
  env.db.close();
});

test('several reported payments settle one bill exactly', () => {
  const env = setup();
  const bill = openBill(env, { number: '9001', totalMinor: 100_000, sourceKey: 'bill:9001' });

  ['$400', '$600'].forEach((amountText, index) => {
    const proposed = paymentIntent.propose(env.db, env.workspace.workspaceId,
      said({ amountText, reference: '9001' }));
    assert.equal(proposed.ok, true, `payment ${index + 1} proposes`);
    paymentIntent.apply(env.db, env.workspace.ctx, env.membership, proposed.proposal,
      { sourceKey: `reported:9001:${index}` });
  });

  const settled = payables.requireBill(env.db, env.workspace.workspaceId, bill.id);
  assert.equal(settled.balance_minor, 0);
  assert.equal(settled.status, 'PAID');
  env.db.close();
});

test('Foundry asks which bill rather than choosing one', () => {
  const env = setup();
  openBill(env, { number: '7001', totalMinor: 50_000, sourceKey: 'bill:7001' });
  openBill(env, { number: '7002', totalMinor: 50_000, sourceKey: 'bill:7002' });

  // Two open bills and no reference. Choosing wrongly is two wrong balances.
  const vague = paymentIntent.propose(env.db, env.workspace.workspaceId, said({ amountText: '$400' }));
  assert.equal(vague.ok, false);
  assert.match(vague.question, /which bill/i);
  assert.equal(vague.candidates.length, 2, 'and the real ones are offered');

  // A reference matching nothing open is said plainly, not quietly applied elsewhere.
  const wrong = paymentIntent.propose(env.db, env.workspace.workspaceId,
    said({ amountText: '$400', reference: '9999' }));
  assert.equal(wrong.ok, false);
  assert.match(wrong.question, /no open bill matching/i);
  env.db.close();
});

test('one open bill needs no reference, because nothing is being chosen', () => {
  const env = setup();
  openBill(env, { number: '5001', totalMinor: 20_000, sourceKey: 'bill:5001' });

  const proposed = paymentIntent.propose(env.db, env.workspace.workspaceId,
    said({ amountText: '$200', method: 'cheque' }));
  assert.equal(proposed.ok, true);
  assert.equal(proposed.proposal.target.appliedMinor, 20_000);
  env.db.close();
});

test('what the sentence did not say is asked for, never invented', () => {
  const env = setup();
  openBill(env, { number: '4001', totalMinor: 20_000, sourceKey: 'bill:4001' });

  const noAmount = paymentIntent.propose(env.db, env.workspace.workspaceId, said({ reference: '4001' }));
  assert.equal(noAmount.ok, false);
  assert.match(noAmount.question, /how much/i);

  const noParty = paymentIntent.propose(env.db, env.workspace.workspaceId,
    said({ counterpartyName: 'Someone Else Entirely', amountText: '$100' }));
  assert.equal(noParty.ok, false);
  assert.match(noParty.question, /no supplier called/i);

  const unclear = paymentIntent.propose(env.db, env.workspace.workspaceId,
    said({ direction: 'UNCLEAR', amountText: '$100' }));
  assert.equal(unclear.ok, false);
  assert.match(unclear.question, /pay them, or did they pay you/i);
  env.db.close();
});

test('money beyond what is owed is held, not forced onto the bill', () => {
  const env = setup();
  openBill(env, { number: '3001', totalMinor: 10_000, sourceKey: 'bill:3001' });

  const proposed = paymentIntent.propose(env.db, env.workspace.workspaceId,
    said({ amountText: '$150', reference: '3001' }));
  assert.equal(proposed.proposal.target.appliedMinor, 10_000);
  assert.equal(proposed.proposal.unappliedMinor, 5_000);
  assert.ok(proposed.proposal.preview.some((line) => /unapplied/.test(line)));
  env.db.close();
});

test('the amount is read from the sentence, not from a retyping of it', () => {
  // The model reports what it saw; the figure that moves money is parsed here.
  assert.equal(paymentIntent.amountFrom('$400'), 40_000);
  assert.equal(paymentIntent.amountFrom('1,250.50'), 125_050);
  assert.equal(paymentIntent.amountFrom('$1,000'), 100_000);
  assert.equal(paymentIntent.amountFrom('nothing'), null);
  assert.equal(paymentIntent.amountFrom('-50'), null, 'a payment is not negative');
  assert.equal(paymentIntent.amountFrom(''), null);
});
