'use strict';

/**
 * A payment that never happened must not appear as two payments that did.
 *
 * Providers report the same card payment twice, a receipt gets entered by hand
 * as well as pulled in, an owner corrects a mistake. Foundry reverses the bad
 * entry, and the balances come out right: the pair cancels. The story does not.
 * Read as activity, the mistake and its correction are money arriving from an
 * unnamed source and the same money leaving to an unnamed one — which is how
 * the cash page came to report $300.00 of "other cash received" and $300.00 of
 * "other recorded cash paid" in a business whose only event was one $300 sale.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../../src/accounting/ledger');
const reports = require('../../src/accounting/reports');
const ownerDashboard = require('../../src/accounting/owner-dashboard');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

const TODAY = new Date().toISOString().slice(0, 10);

function books() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  return { db, workspace, membership };
}

test('a duplicate receipt and its reversal are not two more cash movements', () => {
  const { db, workspace, membership } = books();
  const real = ledger.post(db, workspace.ctx, {
    postingDate: TODAY, description: 'Payment received', sourceKey: 'receipt-real',
    lines: [
      { accountKey: 'CASH', debitMinor: 30_000 },
      { accountKey: 'ACCOUNTS_RECEIVABLE', creditMinor: 30_000 },
    ],
  });
  const duplicate = ledger.post(db, workspace.ctx, {
    postingDate: TODAY, description: 'Payment received', sourceKey: 'receipt-duplicate',
    lines: [
      { accountKey: 'CASH', debitMinor: 30_000 },
      { accountKey: 'ACCOUNTS_RECEIVABLE', creditMinor: 30_000 },
    ],
  });
  ledger.reverse(db, workspace.ctx, membership, duplicate.entry.id, {
    postingDate: TODAY, reason: 'The provider reported one payment twice.',
  });

  const cash = reports.cashFlow(db, workspace.workspaceId, { from: TODAY, to: TODAY });
  assert.deepEqual(cash.rows.map((row) => row.id), [real.entry.id],
    'only the payment that actually happened is cash activity');
  assert.equal(cash.netCashChangeMinor, 30_000);

  // The cash page reads its "other" figures as the gap between what moved and
  // what customers and suppliers account for. That gap must be nothing here.
  const moved = cash.rows.reduce((sum, row) => sum + Math.abs(Number(row.cash_change_minor)), 0);
  assert.equal(moved, 30_000, 'no unexplained cash in either direction');
});

test('reversing an expense removes it from the expense list rather than listing both halves', () => {
  const { db, workspace, membership } = books();
  const wrong = ledger.post(db, workspace.ctx, {
    postingDate: TODAY, description: 'Rent charged twice', sourceKey: 'rent-wrong',
    lines: [
      { accountKey: 'RENT_EXPENSE', debitMinor: 5_000 },
      { accountKey: 'CASH', creditMinor: 5_000 },
    ],
  });
  ledger.reverse(db, workspace.ctx, membership, wrong.entry.id, { postingDate: TODAY });

  const expenses = ownerDashboard.expenses(db, workspace.workspaceId, TODAY, TODAY);
  assert.deepEqual(expenses.rows, [], 'a charge that was undone is not an expense that happened');
  assert.equal(expenses.totalMinor, 0);
});

test('the audit trail still shows both halves, because that is what it is for', () => {
  const { db, workspace, membership } = books();
  const entry = ledger.post(db, workspace.ctx, {
    postingDate: TODAY, description: 'Mistake', sourceKey: 'mistake',
    lines: [
      { accountKey: 'CASH', debitMinor: 1_000 },
      { accountKey: 'ACCOUNTS_RECEIVABLE', creditMinor: 1_000 },
    ],
  });
  ledger.reverse(db, workspace.ctx, membership, entry.entry.id, { postingDate: TODAY });

  const trail = reports.generalLedger(db, workspace.workspaceId, { from: TODAY, to: TODAY });
  const entryIds = new Set(trail.rows.map((row) => row.entry_id));
  assert.equal(entryIds.size, 2, 'the mistake and its correction both stay on the record');
});

test('balances are unchanged by the exclusion, because the pair already cancelled', () => {
  const { db, workspace, membership } = books();
  const entry = ledger.post(db, workspace.ctx, {
    postingDate: TODAY, description: 'Mistake', sourceKey: 'mistake',
    lines: [
      { accountKey: 'CASH', debitMinor: 7_500 },
      { accountKey: 'SALES_REVENUE', creditMinor: 7_500 },
    ],
  });
  ledger.reverse(db, workspace.ctx, membership, entry.entry.id, { postingDate: TODAY });

  const pnl = reports.profitAndLoss(db, workspace.workspaceId, { from: TODAY, to: TODAY });
  assert.equal(pnl.revenueMinor, 0, 'revenue that was reversed is no revenue');
  const sheet = reports.balanceSheet(db, workspace.workspaceId, { asOf: TODAY });
  const cash = sheet.assets.filter((row) => row.subtype === 'CASH')
    .reduce((sum, row) => sum + Number(row.net_minor), 0);
  assert.equal(cash, 0);
});
