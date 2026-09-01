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

  const findings = CHECKS
    .map((check) => {
      const found = check.run(data, { money, currency });
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
