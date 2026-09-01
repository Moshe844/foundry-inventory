'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const accounting = require('../../src/accounting/ledger');
const reports = require('../../src/accounting/reports');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Accounting Test Company' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  accounting.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  return { db, workspace, membership };
}

test('accounting is automatic and the workspace starts with a semantic default chart', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  assert.equal(accounting.settings(db, workspace.workspaceId).enabled, true);
  assert.ok(accounting.accountBySystemKey(db, workspace.workspaceId, 'INVENTORY_ASSET'));
  assert.ok(accounting.accountBySystemKey(db, workspace.workspaceId, 'ACCOUNTS_PAYABLE'));

  const configured = accounting.configure(db, workspace.ctx, membership, {
    startDate: '2026-04-01', currency: 'usd', costingMethod: 'weighted_average',
  });
  assert.equal(configured.enabled, true);
  assert.equal(configured.startDate, '2026-04-01');
  assert.equal(configured.currency, 'USD');
  assert.ok(accounting.accountBySystemKey(db, workspace.workspaceId, 'INVENTORY_ASSET'));
  assert.ok(accounting.accountBySystemKey(db, workspace.workspaceId, 'ACCOUNTS_PAYABLE'));
});

test('the deterministic ledger rejects unbalanced and pre-start entries', () => {
  const { db, workspace } = setup();
  assert.throws(() => accounting.post(db, workspace.ctx, {
    postingDate: '2026-02-01', description: 'Bad entry', sourceKey: 'bad:unbalanced',
    lines: [
      { accountKey: 'CASH', debitMinor: 1000 },
      { accountKey: 'OWNERS_EQUITY', creditMinor: 999 },
    ],
  }), /out of balance/i);
  assert.throws(() => accounting.post(db, workspace.ctx, {
    postingDate: '2025-12-31', description: 'Old entry', sourceKey: 'bad:old',
    lines: [
      { accountKey: 'CASH', debitMinor: 1000 },
      { accountKey: 'OWNERS_EQUITY', creditMinor: 1000 },
    ],
  }), /before the accounting start date/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get().n, 0);
});

test('posting is balanced, immutable, traceable, and idempotent', () => {
  const { db, workspace } = setup();
  const input = {
    postingDate: '2026-01-02', description: 'Owner funding', sourceType: 'opening_balance',
    sourceRecordType: 'accounting_setup', sourceRecordId: workspace.workspaceId,
    sourceEventId: 'event-test-1', sourceKey: 'opening:cash', createdByType: 'USER',
    lines: [
      { accountKey: 'CASH', debitMinor: 5_000_000, memo: 'Opening cash' },
      { accountKey: 'OWNERS_EQUITY', creditMinor: 5_000_000, memo: 'Opening equity' },
    ],
  };
  const first = accounting.post(db, workspace.ctx, input);
  const replay = accounting.post(db, workspace.ctx, input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.entry.id, first.entry.id);
  assert.equal(first.entry.status, 'POSTED');
  assert.equal(first.entry.lines.reduce((n, line) => n + line.debit_minor, 0), 5_000_000);
  assert.equal(first.entry.lines.reduce((n, line) => n + line.credit_minor, 0), 5_000_000);
  assert.equal(first.entry.source_event_id, 'event-test-1');
  assert.throws(() => db.prepare('UPDATE accounting_journal_lines SET debit_minor = 1 WHERE entry_id = ?')
    .run(first.entry.id), /immutable/i);
  assert.throws(() => db.prepare('DELETE FROM accounting_journal_entries WHERE id = ?')
    .run(first.entry.id), /cannot be deleted/i);
});

test('a correction is a linked reversing entry and can never reverse twice', () => {
  const { db, workspace, membership } = setup();
  const original = accounting.post(db, workspace.ctx, {
    postingDate: '2026-01-03', description: 'Rent paid', sourceKey: 'expense:rent:1',
    createdByType: 'USER',
    lines: [
      { accountKey: 'RENT_EXPENSE', debitMinor: 10_000 },
      { accountKey: 'CASH', creditMinor: 10_000 },
    ],
  }).entry;
  const reversed = accounting.reverse(db, workspace.ctx, membership, original.id, {
    postingDate: '2026-01-04', reason: 'Entered against the wrong bank account',
  });
  const replay = accounting.reverse(db, workspace.ctx, membership, original.id, {
    postingDate: '2026-01-05',
  });
  assert.equal(reversed.entry.reversal_of_entry_id, original.id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.entry.id, reversed.entry.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounting_journal_entries').get().n, 2);
});

test('closed periods reject postings while later corrections remain possible', () => {
  const { db, workspace, membership } = setup();
  const original = accounting.post(db, workspace.ctx, {
    postingDate: '2026-01-05', description: 'Operating expense', sourceKey: 'expense:1',
    lines: [
      { accountKey: 'OPERATING_EXPENSE', debitMinor: 1000 },
      { accountKey: 'CASH', creditMinor: 1000 },
    ],
  }).entry;
  accounting.closePeriod(db, workspace.ctx, membership, original.period_id, 'January complete');
  assert.throws(() => accounting.post(db, workspace.ctx, {
    postingDate: '2026-01-20', description: 'Late January entry', sourceKey: 'expense:2',
    lines: [
      { accountKey: 'OPERATING_EXPENSE', debitMinor: 1000 },
      { accountKey: 'CASH', creditMinor: 1000 },
    ],
  }), /period.*closed/i);
  const correction = accounting.reverse(db, workspace.ctx, membership, original.id, {
    postingDate: '2026-02-01', reason: 'Post-close correction',
  });
  assert.equal(correction.entry.posting_date, '2026-02-01');
});

test('accounting records and source keys are isolated by workspace', () => {
  const { db, workspace, membership } = setup();
  const other = seedAnotherWorkspace(db, workspace.accountId, 'Other Company');
  const otherMembership = authService.getMembership(db, other.workspaceId, other.accountId);
  accounting.configure(db, other.ctx, otherMembership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const entry = (ctx) => accounting.post(db, ctx, {
    postingDate: '2026-01-01', description: 'Opening cash', sourceKey: 'same-source',
    lines: [
      { accountKey: 'CASH', debitMinor: 100 },
      { accountKey: 'OWNERS_EQUITY', creditMinor: 100 },
    ],
  });
  const a = entry(workspace.ctx);
  const b = entry(other.ctx);
  assert.notEqual(a.entry.id, b.entry.id);
  assert.equal(accounting.getEntry(db, other.workspaceId, a.entry.id), null);
  assert.equal(accounting.listAccounts(db, workspace.workspaceId).length,
    accounting.listAccounts(db, other.workspaceId).length);
  assert.equal(membership.role, 'owner');
});

test('acceptance company reconciles P&L, balance sheet, cash, inventory, AP, and trial balance', () => {
  const { db, workspace } = setup();
  const entries = [
    ['2026-01-01', 'Opening cash', 'acceptance:opening', [
      { accountKey: 'CASH', debitMinor: 5_000_000 },
      { accountKey: 'OWNERS_EQUITY', creditMinor: 5_000_000 },
    ]],
    ['2026-01-02', 'Receive 100 shirts at $8', 'acceptance:receipt', [
      { accountKey: 'INVENTORY_ASSET', debitMinor: 80_000 },
      { accountKey: 'ACCOUNTS_PAYABLE', creditMinor: 80_000 },
    ]],
    ['2026-01-03', 'Sell 20 shirts at $20', 'acceptance:sale', [
      { accountKey: 'CASH', debitMinor: 40_000 },
      { accountKey: 'SALES_REVENUE', creditMinor: 40_000 },
      { accountKey: 'COST_OF_GOODS_SOLD', debitMinor: 16_000 },
      { accountKey: 'INVENTORY_ASSET', creditMinor: 16_000 },
    ]],
    ['2026-01-04', 'Pay supplier', 'acceptance:pay-supplier', [
      { accountKey: 'ACCOUNTS_PAYABLE', debitMinor: 80_000 },
      { accountKey: 'CASH', creditMinor: 80_000 },
    ]],
    ['2026-01-05', 'Pay rent', 'acceptance:rent', [
      { accountKey: 'RENT_EXPENSE', debitMinor: 10_000 },
      { accountKey: 'CASH', creditMinor: 10_000 },
    ]],
  ];
  for (const [postingDate, description, sourceKey, lines] of entries) {
    accounting.post(db, workspace.ctx, { postingDate, description, sourceKey, lines });
  }
  const pnl = reports.profitAndLoss(db, workspace.workspaceId, { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(pnl.revenueMinor, 40_000);
  assert.equal(pnl.cogsMinor, 16_000);
  assert.equal(pnl.grossProfitMinor, 24_000);
  assert.equal(pnl.operatingExpenseMinor, 10_000);
  assert.equal(pnl.operatingProfitMinor, 14_000);
  const balance = reports.balanceSheet(db, workspace.workspaceId, { asOf: '2026-01-31' });
  assert.equal(balance.assetMinor, 5_014_000);
  assert.equal(balance.liabilityMinor, 0);
  assert.equal(balance.currentEarningsMinor, 14_000);
  assert.equal(balance.liabilitiesAndEquityMinor, 5_014_000);
  assert.equal(balance.balanced, true);
  const trial = reports.trialBalance(db, workspace.workspaceId, { from: '1900-01-01', to: '2026-01-31' });
  assert.equal(trial.balanced, true);
  assert.equal(trial.totals.activity_debit_minor, trial.totals.activity_credit_minor);
  const cash = trial.accounts.find((a) => a.system_key === 'CASH');
  const inventory = trial.accounts.find((a) => a.system_key === 'INVENTORY_ASSET');
  const ap = trial.accounts.find((a) => a.system_key === 'ACCOUNTS_PAYABLE');
  assert.equal(cash.net_minor, 4_950_000);
  assert.equal(inventory.net_minor, 64_000);
  assert.equal(ap.net_minor, 0);
});
