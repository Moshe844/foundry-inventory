'use strict';

/**
 * "Is anything wrong with my books?"
 *
 * The owner dashboard already computes everything an accountant would look at —
 * overdue customers and bills, supplier bills that were received but never
 * invoiced, duplicate-looking payments, stock with no recorded sale, cash due
 * out against cash coming in. It then flattened those into a list of sentences
 * with no structure behind them: no record to open, no action to take, and no
 * way to ask "which ones?".
 *
 * This turns the same numbers into findings, and answers the question a person
 * actually asks. Nothing here recomputes anything: every check reads the
 * dashboard's own figures, so the audit and the screen can never disagree.
 *
 * Each check is an entry in CHECKS rather than a branch in a function, so a new
 * thing worth noticing is a new entry — and each one must answer the same four
 * questions Foundry asks of anything it puts in front of a person:
 *
 *   what      what happened, in the owner's words
 *   why       why it matters, or why Foundry stopped
 *   proof     the records that establish it, and where to read them
 *   action    the one thing to do about it
 *
 * A check that cannot answer all four does not belong here, because a finding
 * nobody can act on is just a worry.
 */

const ownerDashboard = require('./owner-dashboard');

/*
 * What counts as notable.
 *
 * Some threshold is unavoidable for "is this worth mentioning", so they are
 * named here rather than buried in a check, and every finding states the
 * comparison it made. What is deliberately not here is any figure about a
 * business other than this one: the baselines are the customer's own previous
 * period and their own typical spend, never an industry number.
 */
const MARGIN_DROP_SHARE = 0.25;   // a quarter of the margin they had before
const UNUSUAL_MULTIPLE = 3;       // three times that category's own typical entry
const MINIMUM_HISTORY = 4;        // fewer entries than this is not yet a habit

const SEVERITY = { URGENT: 'urgent', IMPORTANT: 'important', WORTH_KNOWING: 'worth knowing' };
const RANK = { [SEVERITY.URGENT]: 0, [SEVERITY.IMPORTANT]: 1, [SEVERITY.WORTH_KNOWING]: 2 };

const count = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

/**
 * The checks, in no particular order — severity sorts them, not position here.
 *
 * `data` is exactly what the dashboard returned. A check reads it and returns a
 * finding or null; it never queries, so it cannot drift from the screen.
 */
const CHECKS = [
  {
    id: 'customers_overdue',
    run: ({ customers }, { money }) => (customers.overdueMinor > 0 ? {
      severity: SEVERITY.IMPORTANT,
      what: `${money(customers.overdueMinor)} is overdue from customers.`,
      why: 'Money already earned that has not arrived. It is counted in profit but not in cash.',
      proof: { label: 'the unpaid customer invoices', href: '/accounting/receivables' },
      action: { label: 'Review who owes you', href: '/accounting/receivables' },
      amountMinor: customers.overdueMinor,
    } : null),
  },
  {
    id: 'suppliers_overdue',
    run: ({ suppliers }, { money }) => (suppliers.overdueMinor > 0 ? {
      severity: SEVERITY.URGENT,
      what: `${money(suppliers.overdueMinor)} is past due to suppliers.`,
      why: 'Late payment is the fastest way to lose supply and terms.',
      proof: { label: 'the unpaid supplier bills', href: '/accounting/payables' },
      action: { label: 'Review what you owe', href: '/accounting/payables' },
      amountMinor: suppliers.overdueMinor,
    } : null),
  },
  {
    id: 'received_without_bill',
    run: ({ missingBills }) => (missingBills.length ? {
      severity: SEVERITY.IMPORTANT,
      what: `${count(missingBills.length, 'received order')} ${missingBills.length === 1 ? 'has' : 'have'} no supplier bill.`,
      why: 'You hold the stock and its cost, but nothing records what you owe for it, '
        + 'so both what you owe and your profit are understated.',
      proof: {
        label: `${count(missingBills.length, 'purchase order')} received without a bill`,
        href: '/accounting/payables',
      },
      action: {
        label: 'Add the supplier bill',
        href: `/accounting/payables/new?purchaseOrderId=${missingBills[0].id}`,
      },
      amountMinor: missingBills.reduce((total, row) => total + Number(row.receivedCostMinor || 0), 0),
    } : null),
  },
  {
    id: 'duplicate_supplier_payments',
    run: ({ duplicateSupplierPayments }, { money }) => (duplicateSupplierPayments.length ? {
      severity: SEVERITY.URGENT,
      what: `${count(duplicateSupplierPayments.length, 'supplier payment')} ${duplicateSupplierPayments.length === 1 ? 'looks' : 'look'} like ${duplicateSupplierPayments.length === 1 ? 'it was' : 'they were'} made twice.`,
      why: 'Same supplier, same day, same amount, same reference. Usually one payment entered twice; '
        + 'occasionally money genuinely sent twice.',
      proof: {
        label: duplicateSupplierPayments
          .map((row) => `${row.supplier_name} ${money(row.amount_minor)} on ${row.payment_date}`)
          .join('; '),
        href: '/accounting/transactions',
      },
      action: { label: 'Check these payments', href: '/accounting/transactions' },
      amountMinor: duplicateSupplierPayments.reduce((total, row) => total + Number(row.amount_minor || 0), 0),
    } : null),
  },
  {
    id: 'sales_without_payment',
    run: ({ unconfirmedCustomerPayments }, { money }) => (unconfirmedCustomerPayments.length ? {
      severity: SEVERITY.IMPORTANT,
      what: `${count(unconfirmedCustomerPayments.length, 'completed sale')} ${unconfirmedCustomerPayments.length === 1 ? 'has' : 'have'} no payment recorded at all.`,
      why: 'Foundry does not know whether these were paid and never entered, or genuinely unpaid. '
        + 'It will not assume either.',
      proof: {
        label: 'the sales with no payment against them',
        href: '/accounting/receivables',
      },
      action: { label: 'Say whether these were paid', href: '/accounting/receivables' },
      amountMinor: unconfirmedCustomerPayments
        .reduce((total, row) => total + Number(row.balance_minor || 0), 0),
    } : null),
  },
  {
    id: 'cash_due_out_exceeds_in',
    run: ({ suppliers, cashActivity }, { money }) => {
      const shortfall = Number(suppliers.dueSoonMinor || 0) - Number(cashActivity.customerReceivedMinor || 0);
      return shortfall > 0 ? {
        severity: SEVERITY.IMPORTANT,
        what: `${money(shortfall)} more is due to suppliers soon than customers have paid you.`,
        why: 'Bills falling due outrun the money coming in. This is how a profitable business runs out of cash.',
        proof: { label: 'bills due against payments received', href: '/accounting/payables' },
        action: { label: 'Look at what is due', href: '/accounting/payables' },
        amountMinor: shortfall,
      } : null;
    },
  },
  {
    id: 'inventory_without_proven_cost',
    run: ({ inventory }) => (inventory.missingCostUnits > 0 ? {
      severity: SEVERITY.IMPORTANT,
      what: `${count(inventory.missingCostUnits, 'unit')} on your shelves ${inventory.missingCostUnits === 1 ? 'has' : 'have'} no proven cost.`,
      why: 'Foundry will not guess what stock cost, so inventory value and profit are both '
        + 'incomplete until the evidence exists.',
      proof: { label: 'the positions with no cost evidence', href: '/accounting#inventory' },
      action: { label: 'Add the missing cost', href: '/accounting/migration?focus=inventory-cost#inventory-costs' },
      amountMinor: null,
    } : null),
  },
  {
    /*
     * Gross margin against the business's own previous period.
     *
     * There is no correct margin for a business, so nothing is compared to an
     * industry figure or a number chosen here. The only meaningful baseline is
     * what this business itself earned over the same span immediately before,
     * and a drop only counts when the prior period actually sold something —
     * otherwise every first month of trading is a collapse from nothing.
     */
    id: 'margin_dropped',
    run: ({ pnl }, { money, priorPnl, marginDropShare }) => {
      if (!priorPnl || priorPnl.revenueMinor <= 0 || pnl.revenueMinor <= 0) return null;
      const now = pnl.grossProfitMinor / pnl.revenueMinor;
      const before = priorPnl.grossProfitMinor / priorPnl.revenueMinor;
      if (before <= 0 || now >= before) return null;
      const lostShare = (before - now) / before;
      if (lostShare < marginDropShare) return null;

      const pct = (value) => `${(value * 100).toFixed(1)}%`;
      return {
        severity: SEVERITY.IMPORTANT,
        what: `Gross margin fell from ${pct(before)} to ${pct(now)}.`,
        why: 'You are keeping less of every sale than you were. Either buying cost rose, selling '
          + 'price fell, or the mix shifted toward products that earn less.',
        proof: {
          label: `${money(pnl.revenueMinor)} of sales at ${pct(now)}, against `
            + `${money(priorPnl.revenueMinor)} at ${pct(before)} in the period before`,
          href: '/accounting/reports/profit-and-loss',
        },
        action: { label: 'Compare the two periods', href: '/accounting/reports/profit-and-loss' },
        amountMinor: Math.round((before - now) * pnl.revenueMinor),
      };
    },
  },
  {
    /*
     * An expense far outside what this business normally spends on that thing.
     *
     * "Unusual" only means anything against a habit, so the comparison is each
     * category against its own typical entry — the median, which one large
     * payment cannot drag upward the way an average can. A category with too
     * little history to have a habit is skipped rather than guessed at.
     */
    id: 'unusual_expense',
    run: ({ expenses }, { money, unusualMultiple, minimumHistory }) => {
      const byCategory = new Map();
      for (const row of expenses.rows || []) {
        const key = row.category_name || 'Uncategorised';
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key).push(row);
      }

      const unusual = [];
      for (const [category, rows] of byCategory) {
        if (rows.length < minimumHistory) continue;
        const amounts = rows.map((row) => Math.abs(Number(row.amountMinor || 0))).sort((a, b) => a - b);
        const median = amounts[Math.floor(amounts.length / 2)];
        if (median <= 0) continue;
        for (const row of rows) {
          const amount = Math.abs(Number(row.amountMinor || 0));
          if (amount >= median * unusualMultiple) {
            unusual.push({ category, amount, row });
          }
        }
      }
      if (!unusual.length) return null;

      const biggest = unusual.sort((a, b) => b.amount - a.amount)[0];
      return {
        severity: SEVERITY.WORTH_KNOWING,
        what: `${money(biggest.amount)} on ${biggest.category} is well above what you usually spend there.`,
        why: 'Not necessarily wrong — a quarterly bill or a one-off purchase looks exactly like this. '
          + 'Worth confirming it is the amount you meant to pay.',
        proof: {
          label: `${biggest.row.entry_description || biggest.category} on ${biggest.row.posting_date}`
            + (unusual.length > 1 ? `, and ${unusual.length - 1} other like it` : ''),
          href: '/accounting/transactions',
        },
        action: { label: 'Check this expense', href: '/accounting/transactions' },
        amountMinor: biggest.amount,
      };
    },
  },
  {
    /*
     * Stock whose recorded balance disagrees with its own movement history.
     *
     * The inventory engine already proves this on demand — balances against the
     * ledger, lots and serials against their balances, and anything negative.
     * Nothing is recomputed here; a disagreement between what Foundry says it
     * holds and what its own records add up to is the most serious thing in
     * this list, because every value above it is built on those quantities.
     */
    id: 'inventory_discrepancy',
    run: (data, { integrity }) => {
      if (!integrity || integrity.ok || !integrity.problems.length) return null;
      const kinds = [...new Set(integrity.problems.map((problem) => problem.kind))]
        .map((kind) => kind.replaceAll('_', ' '));
      return {
        severity: SEVERITY.URGENT,
        what: `${count(integrity.problems.length, 'stock record')} `
          + `${integrity.problems.length === 1 ? 'does' : 'do'} not match its own history.`,
        why: 'Every inventory value and every profit figure is built on these quantities. '
          + 'Foundry recomputes this from the movement ledger, so a mismatch is real, not a display fault.',
        proof: { label: kinds.join(', '), href: '/settings#inventory-integrity' },
        action: { label: 'Open inventory integrity', href: '/settings#inventory-integrity' },
        amountMinor: null,
      };
    },
  },
  {
    id: 'stock_not_selling',
    run: ({ slowInventory }, { money }) => (slowInventory.totalCostMinor > 0 ? {
      severity: SEVERITY.WORTH_KNOWING,
      what: `${money(slowInventory.totalCostMinor)} of stock has no recorded sale in 90 days.`,
      why: 'Money spent and still sitting on a shelf. Not an error — a decision about what to do with it.',
      proof: { label: 'the stock that has not sold', href: '/accounting#inventory' },
      action: { label: 'See what is not moving', href: '/inventory?sort=least' },
      amountMinor: slowInventory.totalCostMinor,
    } : null),
  },
];

/**
 * Every check, run against one set of the dashboard's figures.
 *
 * Returns what was found and how many checks were made, because "nothing is
 * wrong" is only worth hearing if you know how much was looked at.
 */
function review(db, workspaceId, options = {}) {
  /*
   * The same window the Accounting screen uses, for the same reason: a
   * dashboard that stops at midnight while a posting is dated today reports an
   * empty business. The latest posted date wins over the calendar.
   */
  const latestPosting = db.prepare(`SELECT MAX(posting_date) AS date
    FROM accounting_journal_entries WHERE workspace_id = ? AND status = 'POSTED'`)
    .get(workspaceId).date;
  const asOf = options.asOf
    || [new Date().toISOString().slice(0, 10), latestPosting].filter(Boolean).sort().at(-1);
  const from = options.from
    || new Date(new Date(`${asOf}T00:00:00Z`).getTime() - 29 * 86400000).toISOString().slice(0, 10);

  const data = ownerDashboard.ownerDashboard(db, workspaceId, { from, to: options.to || asOf, asOf });
  const currency = options.currency || 'USD';
  const money = (amount) => new Intl.NumberFormat('en-US', { style: 'currency', currency })
    .format(Number(amount || 0) / 100);

  /*
   * The same span again, immediately before, so a change can be measured
   * against this business rather than against a number chosen for it.
   */
  const spanDays = Math.max(1, Math.round(
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000
  ) + 1);
  const priorTo = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const priorFrom = new Date(Date.parse(`${priorTo}T00:00:00Z`) - (spanDays - 1) * 86400000)
    .toISOString().slice(0, 10);
  const priorPnl = require('./reports').profitAndLoss(db, workspaceId, { from: priorFrom, to: priorTo });

  // Proven from the movement ledger by the inventory engine, not recomputed here.
  let integrity = null;
  try {
    integrity = require('../domain/inventory-engine').verifyIntegrity(db, workspaceId);
  } catch {
    integrity = null;
  }

  const context = {
    money,
    currency,
    priorPnl,
    priorPeriod: { from: priorFrom, to: priorTo },
    integrity,
    marginDropShare: MARGIN_DROP_SHARE,
    unusualMultiple: UNUSUAL_MULTIPLE,
    minimumHistory: MINIMUM_HISTORY,
  };

  const findings = CHECKS
    .map((check) => {
      const found = check.run(data, context);
      return found ? { id: check.id, ...found } : null;
    })
    .filter(Boolean)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);

  return {
    findings,
    checksRun: CHECKS.length,
    urgent: findings.filter((f) => f.severity === SEVERITY.URGENT).length,
    clean: findings.length === 0,
    data,
  };
}

module.exports = { review, CHECKS, SEVERITY };
