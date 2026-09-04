'use strict';

/**
 * What an accountant would tell you if you rang them.
 *
 * The Money page used to be eleven balance panels: the state of the business at
 * a moment, laid out the way a ledger is laid out. Every question the owner
 * actually asked of it was a question about *change* — "was this subtracted?",
 * "why is it $5,214 and not $5,411?", "did it update?" — and a page made of
 * balances cannot answer any of them. It shows where you are and never how you
 * got there, so the owner has to hold the old number in their head and argue
 * with the new one.
 *
 * So this module produces a briefing rather than a balance sheet:
 *
 *   status      caught up, or the number of things waiting on you
 *   position    cash, owed to you, owed by you — three figures, not eleven
 *   profit      sales through to net, and why it moved since last period
 *   changed     what actually happened, newest first, each line naming its cause
 *   attention   what is wrong, with the action that fixes it
 *   comingUp    money leaving and arriving, with dates
 *   noticed     the observation an accountant would volunteer unprompted
 *   fees        every freight, duty and handling charge, exactly as billed
 *
 * Two rules hold throughout.
 *
 * Nothing here originates a number. Every figure is read from a posted entry, a
 * bill, a payment or a document, and anything Foundry cannot support it simply
 * does not say — a briefing that guesses is worse than no briefing, because the
 * owner cannot tell which half to trust.
 *
 * And nothing here is a place to do accounting. The owner records a sale, a
 * receipt, a delivery; the books follow on their own. This is where they find
 * out what that meant.
 */

const reports = require('./reports');
const ownerDashboard = require('./owner-dashboard');
const documentCosts = require('./document-costs');

const DAY_MS = 24 * 60 * 60 * 1000;

const number = (value) => Number(value || 0);
const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Percentage change, or null when there is no base to compare against. */
function movement(now, before) {
  if (!before) return null;
  return round(((now - before) / Math.abs(before)) * 100);
}

const dayOf = (value) => String(value || '').slice(0, 10);
const addDays = (date, count) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + count * DAY_MS).toISOString().slice(0, 10);

/**
 * The whole briefing.
 *
 * @param options.from/to the period the owner is asking about
 */
function build(db, workspaceId, options = {}) {
  const now = options.now || Date.now();
  const today = dayOf(new Date(now).toISOString());
  const to = options.to || today;
  const from = options.from || addDays(to, -30);
  const currency = options.currency || 'USD';

  const owner = ownerDashboard.ownerDashboard(db, workspaceId, { from, to, asOf: to });
  const balance = reports.balanceSheet(db, workspaceId, { asOf: to });

  // The period before this one, the same length, so "why did it change" has
  // something to be a change from.
  const span = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS));
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(priorTo, -span);
  const priorPnl = reports.profitAndLoss(db, workspaceId, { from: priorFrom, to: priorTo });

  const position = {
    cashMinor: balance.assets.filter((row) => row.subtype === 'CASH')
      .reduce((sum, row) => sum + number(row.net_minor), 0),
    customersOweMinor: owner.customers.balanceMinor,
    suppliersOwedMinor: owner.suppliers.balanceMinor,
    supplierChargesCommittedMinor: committedCharges(db, workspaceId),
    inventoryMinor: owner.inventory.totalCostMinor,
    inventoryUnits: owner.inventory.totalUnits,
  };
  position.suppliersCommittedMinor = position.suppliersOwedMinor
    + position.supplierChargesCommittedMinor;
  position.workingCapitalMinor = position.cashMinor + position.customersOweMinor
    + position.inventoryMinor - position.suppliersCommittedMinor;

  const profit = profitStory(owner.pnl, priorPnl, { from: priorFrom, to: priorTo });
  const fees = feeBreakdown(db, workspaceId, currency);
  const attention = needsAttention(db, workspaceId, owner, { today, currency, fees });

  return {
    from, to, currency, period: { from, to, priorFrom, priorTo },
    status: status(attention, db, workspaceId, { today }),
    position,
    profit,
    changed: whatChanged(db, workspaceId, { from, to, currency }),
    attention,
    comingUp: comingUp(db, workspaceId, { today, currency }),
    noticed: noticed({ owner, profit, fees, position }),
    fees,
    inventory: owner.inventory,
  };
}

/* ------------------------------------------------------------------ status */

/**
 * "Your books are caught up" is a claim, so it has to be checked rather than
 * assumed. Caught up means: nothing is waiting on a decision, and nothing the
 * business did is sitting unposted.
 */
function status(attention, db, workspaceId, { today }) {
  const stuck = db.prepare(`SELECT COUNT(*) AS n FROM accounting_event_inbox
    WHERE workspace_id = ? AND status IN ('NEEDS_REVIEW', 'FAILED')`).get(workspaceId).n;
  const waiting = attention.length;

  if (!waiting && !stuck) {
    return {
      caughtUp: true,
      headline: 'Your books are caught up.',
      detail: 'Every sale, delivery, bill and payment Foundry has been told about is in the books, '
        + 'and nothing is waiting on you.',
      count: 0,
    };
  }
  const total = waiting + stuck;
  return {
    caughtUp: false,
    headline: `${total} thing${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} you.`,
    detail: stuck
      ? `${stuck} ${stuck === 1 ? 'entry could not be posted' : 'entries could not be posted'} `
        + 'and the rest is up to date.'
      : 'The books are otherwise up to date.',
    count: total,
  };
}

/* ------------------------------------------------------------------ profit */

/**
 * Sales down to net profit, and the honest reason it moved.
 *
 * The reason is attributed rather than listed: an owner who is told "revenue
 * changed, cost changed, expenses changed" has been given the P&L again. What
 * they want is which of the three did most of it, and that is arithmetic —
 * whichever term moved profit furthest is the one named first.
 */
function profitStory(pnl, prior, priorPeriod) {
  const story = {
    revenueMinor: pnl.revenueMinor,
    cogsMinor: pnl.cogsMinor,
    grossMinor: pnl.grossProfitMinor,
    expensesMinor: pnl.operatingExpenseMinor,
    netMinor: pnl.netIncomeMinor,
    marginPct: pnl.revenueMinor ? round((pnl.grossProfitMinor / pnl.revenueMinor) * 100) : null,
    prior: {
      from: priorPeriod.from, to: priorPeriod.to,
      revenueMinor: prior.revenueMinor, cogsMinor: prior.cogsMinor,
      grossMinor: prior.grossProfitMinor, netMinor: prior.netIncomeMinor,
      marginPct: prior.revenueMinor ? round((prior.grossProfitMinor / prior.revenueMinor) * 100) : null,
    },
    why: [],
  };

  // Nothing to compare against: say so rather than implying a flat trend.
  if (!prior.revenueMinor && !prior.cogsMinor && !prior.operatingExpenseMinor) {
    story.changePct = null;
    story.why.push(pnl.revenueMinor
      ? 'This is the first period with recorded trade, so there is nothing to compare it against yet.'
      : 'No completed sale is recorded in this period.');
    return story;
  }

  story.changePct = movement(pnl.netIncomeMinor, prior.netIncomeMinor);
  const direction = pnl.netIncomeMinor >= prior.netIncomeMinor ? 'rose' : 'fell';

  /*
   * How much each part moved the bottom line. Cost and expenses are negated
   * because an increase in either pushes profit down — the sign is what makes
   * "mainly because supplier cost increased" a conclusion rather than a guess.
   */
  const drivers = [
    { name: 'sales', effect: pnl.revenueMinor - prior.revenueMinor,
      pct: movement(pnl.revenueMinor, prior.revenueMinor) },
    { name: 'the cost of what you sold', effect: -(pnl.cogsMinor - prior.cogsMinor),
      pct: movement(pnl.cogsMinor, prior.cogsMinor) },
    { name: 'other expenses', effect: -(pnl.operatingExpenseMinor - prior.operatingExpenseMinor),
      pct: movement(pnl.operatingExpenseMinor, prior.operatingExpenseMinor) },
  ].filter((row) => row.effect !== 0).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));

  if (!drivers.length) {
    story.why.push('Profit is unchanged from the period before.');
    return story;
  }

  const lead = drivers[0];
  story.why.push(`Profit ${direction} ${story.changePct === null ? '' : `${Math.abs(story.changePct)}% `}`
    + `against ${priorPeriod.from} to ${priorPeriod.to}, mainly because ${lead.name} `
    + `${lead.effect > 0 ? 'helped' : 'went against you'}`
    + `${lead.pct === null ? '' : ` — ${lead.pct > 0 ? 'up' : 'down'} ${Math.abs(lead.pct)}%`}.`);

  for (const row of drivers.slice(1)) {
    story.why.push(`${row.name[0].toUpperCase()}${row.name.slice(1)} `
      + `${row.pct === null ? 'moved' : `${row.pct > 0 ? 'rose' : 'fell'} ${Math.abs(row.pct)}%`}.`);
  }

  // Margin is the one an owner is most often surprised by, so it gets said even
  // when it is not the largest mover.
  if (story.marginPct !== null && story.prior.marginPct !== null
    && Math.abs(story.marginPct - story.prior.marginPct) >= 1) {
    story.why.push(`Gross margin went from ${story.prior.marginPct}% to ${story.marginPct}%.`);
  }
  return story;
}

/* ----------------------------------------------------------- what changed */

/**
 * The events that moved money, newest first, each one a sentence.
 *
 * Read from the source records rather than from journal entries. A journal
 * entry says "DR 1200 CR 2100"; a receipt says "ABC invoiced you $2,400", and
 * only one of those is worth putting in front of an owner.
 */
function whatChanged(db, workspaceId, { from, to, currency }) {
  const rows = [];

  for (const row of db.prepare(`SELECT so.order_number, c.name AS customer, i.total_minor,
      i.issue_date, so.id AS order_id
    FROM accounting_customer_invoices i
    LEFT JOIN sales_orders so ON so.id = i.sales_order_id
    LEFT JOIN customers c ON c.id = i.customer_id
    WHERE i.workspace_id = ? AND i.status <> 'VOID' AND i.issue_date BETWEEN ? AND ?`)
    .all(workspaceId, from, to)) {
    rows.push({ at: row.issue_date, kind: 'sale', direction: 'in',
      amountMinor: number(row.total_minor),
      headline: `You sold ${money(row.total_minor, currency)}`,
      detail: `${row.order_number || 'A sale'}${row.customer ? ` to ${row.customer}` : ''} was completed.`,
      href: row.order_id ? `/orders/${row.order_id}` : '/money#customers' });
  }

  for (const row of db.prepare(`SELECT b.bill_number, b.supplier_invoice_number, b.total_minor,
      b.issue_date, s.name AS supplier, b.id
    FROM accounting_supplier_bills b
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.workspace_id = ? AND b.status <> 'VOID' AND b.issue_date BETWEEN ? AND ?`)
    .all(workspaceId, from, to)) {
    rows.push({ at: row.issue_date, kind: 'bill', direction: 'owed',
      amountMinor: number(row.total_minor),
      headline: `${row.supplier || 'A supplier'} invoiced you ${money(row.total_minor, currency)}`,
      detail: `${row.supplier_invoice_number || row.bill_number} was added to what you owe.`,
      href: '/accounting/payables' });
  }

  for (const row of db.prepare(`SELECT p.amount_minor, p.payment_date, p.direction, p.reference,
      c.name AS customer, s.name AS supplier
    FROM accounting_payments p
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.workspace_id = ? AND p.status = 'POSTED' AND p.payment_date BETWEEN ? AND ?`)
    .all(workspaceId, from, to)) {
    const incoming = row.direction === 'CUSTOMER_RECEIPT';
    rows.push({ at: row.payment_date, kind: 'payment', direction: incoming ? 'in' : 'out',
      amountMinor: number(row.amount_minor),
      headline: incoming
        ? `${row.customer || 'A customer'} paid you ${money(row.amount_minor, currency)}`
        : `You paid ${row.supplier || 'a supplier'} ${money(row.amount_minor, currency)}`,
      detail: incoming ? 'Cash in, and their balance came down.' : 'Cash out, and what you owe came down.',
      href: '/money#cash' });
  }

  for (const row of db.prepare(`SELECT r.received_at, po.po_number, s.name AS supplier, po.id,
      (SELECT COALESCE(SUM(rl.quantity_units), 0) FROM purchase_order_receipt_lines rl
        WHERE rl.receipt_id = r.id) AS units
    FROM purchase_order_receipts r
    JOIN purchase_orders po ON po.id = r.purchase_order_id
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE r.workspace_id = ? AND date(r.received_at) BETWEEN ? AND ?`)
    .all(workspaceId, from, to)) {
    rows.push({ at: dayOf(row.received_at), kind: 'receipt', direction: 'stock',
      amountMinor: null,
      headline: `${row.units} units arrived from ${row.supplier || 'a supplier'}`,
      detail: `${row.po_number} was booked in, so inventory went up. Receiving is not paying.`,
      href: `/purchasing/orders/${row.id}` });
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return rows.slice(0, 12);
}

/* -------------------------------------------------------- needs attention */

/**
 * What is actually wrong, each with the thing that fixes it.
 *
 * Ordered by how much money is exposed, not by category — an owner reading this
 * should be able to work top-down and stop when they run out of time.
 */
function needsAttention(db, workspaceId, owner, options) {
  const { today, currency } = options;
  const items = [];

  for (const row of db.prepare(`SELECT i.invoice_number, i.balance_minor, i.due_date,
      c.name AS customer, so.id AS order_id
    FROM accounting_customer_invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN sales_orders so ON so.id = i.sales_order_id
    WHERE i.workspace_id = ? AND i.status IN ('OPEN', 'PARTIALLY_PAID')
      AND i.balance_minor > 0 AND i.due_date IS NOT NULL AND i.due_date < ?
    ORDER BY i.balance_minor DESC`).all(workspaceId, today)) {
    items.push({
      kind: 'overdue_invoice', amountMinor: number(row.balance_minor),
      title: `${row.customer || 'A customer'} is late paying ${money(row.balance_minor, currency)}`,
      why: `${row.invoice_number} was due on ${row.due_date}.`,
      actionLabel: 'Chase it', href: row.order_id ? `/orders/${row.order_id}` : '/accounting/receivables',
    });
  }

  for (const row of db.prepare(`SELECT b.bill_number, b.supplier_invoice_number, b.balance_minor,
      b.match_status, s.name AS supplier
    FROM accounting_supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.workspace_id = ? AND b.status IN ('OPEN', 'PARTIALLY_PAID', 'DISPUTED')
      AND b.match_status IS NOT NULL AND b.match_status <> 'MATCHED'`).all(workspaceId)) {
    items.push({
      kind: 'mismatched_bill', amountMinor: number(row.balance_minor),
      title: `${row.supplier || 'A supplier'}'s invoice does not match what you ordered`,
      why: `${row.supplier_invoice_number || row.bill_number} is ${String(row.match_status).toLowerCase()}. `
        + 'Foundry will not pay a difference nobody has agreed to.',
      actionLabel: 'Compare them', href: '/accounting/payables',
    });
  }

  // Money that arrived and was never matched to anything it was for.
  for (const row of db.prepare(`SELECT p.id, p.amount_minor, p.payment_date, c.name AS customer,
      COALESCE((SELECT SUM(a.amount_minor) FROM accounting_payment_allocations a
        WHERE a.payment_id = p.id), 0) AS applied_minor
    FROM accounting_payments p LEFT JOIN customers c ON c.id = p.customer_id
    WHERE p.workspace_id = ? AND p.status = 'POSTED' AND p.direction = 'CUSTOMER_RECEIPT'`)
    .all(workspaceId)) {
    const spare = number(row.amount_minor) - number(row.applied_minor);
    if (spare <= 0) continue;
    items.push({
      kind: 'unapplied_payment', amountMinor: spare,
      title: `${money(spare, currency)} from ${row.customer || 'a customer'} is not against any invoice`,
      why: `Taken on ${row.payment_date} and still sitting as money held. It is theirs until it is applied.`,
      actionLabel: 'Settle it', href: '/accounting/receivables',
    });
  }

  for (const row of owner.missingBills) {
    items.push({
      kind: 'missing_bill', amountMinor: number(row.receivedCostMinor),
      title: `${row.supplier_name} has not invoiced you for ${row.po_number}`,
      why: `${row.receivedUnits} units arrived and no supplier bill is linked, so what you owe is `
        + 'not yet known. The stock is real; the debt is not recorded.',
      actionLabel: 'Add the bill', href: `/accounting/payables/new?purchaseOrderId=${row.id}`,
    });
  }

  // unrecordedTotal returns { amountMinor, count } — compared against zero as a
  // whole object this silently never fired, and the page reported "your books
  // are caught up" over five thousand dollars of unplaced freight.
  const unplaced = options.fees ? options.fees.needsPlacingMinor : 0;
  if (unplaced > 0) {
    items.push({
      kind: 'unplaced_charges', amountMinor: unplaced,
      title: `${money(unplaced, currency)} of supplier charges are not in your books`,
      why: 'Freight, duty and handling read off your documents. Each is either part of what the '
        + 'stock cost or an expense of its own, and the two give different profit on every sale.',
      actionLabel: 'Place them', href: '/money#fees',
    });
  }

  items.sort((a, b) => number(b.amountMinor) - number(a.amountMinor));
  return items;
}

/* -------------------------------------------------------------- coming up */

/** Money with a date on it, in both directions. */
function comingUp(db, workspaceId, { today, currency }) {
  const horizon = addDays(today, 45);
  const rows = [];

  for (const row of db.prepare(`SELECT b.bill_number, b.supplier_invoice_number, b.balance_minor,
      b.due_date, s.name AS supplier
    FROM accounting_supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.workspace_id = ? AND b.status IN ('OPEN', 'PARTIALLY_PAID') AND b.balance_minor > 0
      AND b.due_date IS NOT NULL AND b.due_date BETWEEN ? AND ?`).all(workspaceId, today, horizon)) {
    rows.push({ date: row.due_date, direction: 'out', amountMinor: number(row.balance_minor),
      what: `Pay ${row.supplier || 'a supplier'}`,
      detail: `${row.supplier_invoice_number || row.bill_number} is due.`,
      href: '/accounting/payables' });
  }

  for (const row of db.prepare(`SELECT i.invoice_number, i.balance_minor, i.due_date,
      c.name AS customer, so.id AS order_id
    FROM accounting_customer_invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    LEFT JOIN sales_orders so ON so.id = i.sales_order_id
    WHERE i.workspace_id = ? AND i.status IN ('OPEN', 'PARTIALLY_PAID') AND i.balance_minor > 0
      AND i.due_date IS NOT NULL AND i.due_date BETWEEN ? AND ?`).all(workspaceId, today, horizon)) {
    rows.push({ date: row.due_date, direction: 'in', amountMinor: number(row.balance_minor),
      what: `${row.customer || 'A customer'} owes you`,
      detail: `${row.invoice_number} falls due.`,
      href: row.order_id ? `/orders/${row.order_id}` : '/accounting/receivables' });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows.slice(0, 10);
}

/* ------------------------------------------------------------------- fees */

/**
 * Every charge a supplier put on a document, exactly as they billed it.
 *
 * Never spread across the units. Freight divided by eight hundred is a unit
 * cost nobody agreed to, and once it is buried in a product's cost there is no
 * way to reconcile the document again. So each charge keeps its own label, its
 * own amount, and a note saying where it currently sits.
 */
function feeBreakdown(db, workspaceId, currency) {
  const documents = documentCosts.forWorkspace(db, workspaceId);
  const byKind = new Map();
  let totalMinor = 0;
  let unrecordedMinor = 0;
  let needsPlacingMinor = 0;     // waiting on the owner to say what they are
  let awaitingBillMinor = 0;     // on a purchase order, waiting on the supplier

  for (const doc of documents) {
    for (const charge of doc.charges) {
      const kind = charge.kind || 'other';
      const entry = byKind.get(kind) || { kind, label: kindLabel(kind), totalMinor: 0, lines: [] };
      entry.totalMinor += number(charge.amountMinor);
      entry.lines.push({
        label: charge.label,
        amountMinor: number(charge.amountMinor),
        status: charge.status,
        where: charge.status === 'UNRECORDED'
        ? (doc.openedBooks ? 'waiting for you to say what it is'
          : 'on the purchase order, until the supplier invoices it')
          : charge.status === 'IN_STOCK_VALUE' ? 'counted in what the stock cost'
            : 'recorded as an expense',
        document: doc.documentNumber || doc.reference || null,
        supplier: doc.supplierName || null,
      });
      byKind.set(kind, entry);
      totalMinor += number(charge.amountMinor);
      if (charge.status === 'UNRECORDED') {
        unrecordedMinor += number(charge.amountMinor);
        if (doc.openedBooks) needsPlacingMinor += number(charge.amountMinor);
        else awaitingBillMinor += number(charge.amountMinor);
      }
    }
  }

  const kinds = [...byKind.values()].sort((a, b) => Math.abs(b.totalMinor) - Math.abs(a.totalMinor));
  return { kinds, documents, totalMinor, unrecordedMinor, needsPlacingMinor, awaitingBillMinor, currency };
}

function kindLabel(kind) {
  return {
    freight: 'Shipping and freight', insurance: 'Insurance', duty: 'Duty and customs',
    tax: 'Tax', discount: 'Credits and discounts', other: 'Handling and other charges',
  }[kind] || 'Other charges';
}

/* ---------------------------------------------------------------- noticed */

/**
 * The thing an accountant would mention without being asked.
 *
 * Deliberately few. An observation nobody acts on is noise, and a page of them
 * teaches an owner to skip the section where the important one lives.
 */
function noticed({ owner, profit, fees, position }) {
  const out = [];

  if (profit.why.length && profit.changePct !== null && Math.abs(profit.changePct) >= 10) {
    out.push({ headline: profit.why[0], detail: profit.why.slice(1).join(' ') || null });
  }

  if (fees.needsPlacingMinor > 0) {
    out.push({
      headline: `${money(fees.needsPlacingMinor, fees.currency)} of freight and handling is not in `
        + 'your profit yet',
      detail: 'Until you say whether it is part of what the stock cost or an expense of its own, '
        + 'every sale from this stock looks more profitable than it was.',
    });
  }
  if (fees.awaitingBillMinor > 0) {
    out.push({
      headline: `${money(fees.awaitingBillMinor, fees.currency)} of freight and handling is on the `
        + 'purchase order, not yet in your books',
      detail: 'That is correct for now — it becomes money owed when the supplier actually invoices '
        + 'it. Nothing is waiting on you.',
    });
  }

  if (position.suppliersOwedMinor > position.cashMinor && position.suppliersOwedMinor > 0) {
    out.push({
      headline: `You owe suppliers ${money(position.suppliersOwedMinor, fees.currency)} and hold `
        + `${money(position.cashMinor, fees.currency)} in cash`,
      detail: 'That is normal when stock has just arrived and customers have not paid yet, but it is '
        + 'worth knowing before the bills fall due.',
    });
  }

  if (owner.inventory.missingCostUnits) {
    out.push({
      headline: `${owner.inventory.missingCostUnits} units have no recorded purchase cost`,
      detail: 'Their value is missing from what you own, and their sale will show more profit than it made.',
    });
  }

  return out.slice(0, 4);
}

/**
 * Freight, duty and handling agreed on an order that the supplier has not
 * invoiced yet.
 *
 * Only orders that are actually live — a cancelled order commits nobody to
 * anything, and a draft is not an agreement.
 */
function committedCharges(db, workspaceId) {
  const row = db.prepare(`SELECT COALESCE(SUM(c.amount_minor), 0) AS n
    FROM purchase_order_charges c
    JOIN purchase_orders po ON po.id = c.purchase_order_id
    WHERE c.workspace_id = ?
      AND po.status NOT IN ('DRAFT', 'CANCELLED')`).get(workspaceId);
  return number(row.n);
}

function money(minor, currency = 'USD') {
  const amount = Number(minor || 0) / 100;
  const text = Math.abs(amount)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = amount < 0 ? '-' : '';
  return `${sign}${currency === 'USD' ? '$' : `${currency} `}${text}`;
}

module.exports = { build, money, profitStory, whatChanged, needsAttention, comingUp, feeBreakdown, noticed };
