'use strict';

/**
 * What this customer has to pay, when, and what that lets happen.
 *
 * Foundry could already record that money arrived. What it could not do was
 * know that money was *supposed* to arrive first — so an order with nothing
 * paid on it picked, packed and shipped exactly like one paid in full, and the
 * only thing standing between a business and shipping to a customer who never
 * pays was somebody remembering.
 *
 * Terms belong to the customer rather than the order. "ABC School pays 30% up
 * front" is a fact about a relationship somebody agreed once; deciding it again
 * per order is how the exception becomes the rule.
 *
 * Two things this deliberately does not do.
 *
 * It never blocks anything silently. A hold is a refusal in words, naming the
 * amount and the term it came from, and the owner can lift it for one order —
 * which is recorded, because a hold that can be waved away without trace is
 * not a hold.
 *
 * And it computes nothing about money that the accounting engine has not
 * already posted. Paid is the sum of receipts against the invoice; remaining is
 * the invoice balance. This decides what those figures *permit*, and invents
 * none of them.
 */

const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');

const KINDS = ['ON_ACCOUNT', 'BEFORE_FULFILMENT', 'DEPOSIT'];

/*
 * With nothing agreed, nothing is held.
 *
 * The alternative — holding every order until somebody sets terms up — would
 * greet a new workspace by refusing to ship anything, which is a worse first
 * morning than the risk it prevents.
 */
const HOUSE_DEFAULT = {
  kind: 'ON_ACCOUNT',
  depositPercent: null,
  depositMinor: null,
  netDays: null,
  holdShipping: false,
  creditApproved: true,
  creditLimitMinor: null,
  note: null,
  isDefault: true,
  source: 'nothing agreed',
};

function hydrate(row, source) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    kind: row.kind,
    depositPercent: row.deposit_percent,
    depositMinor: row.deposit_minor,
    netDays: row.net_days,
    holdShipping: Boolean(row.hold_shipping),
    creditApproved: Boolean(row.credit_approved),
    creditLimitMinor: row.credit_limit_minor,
    note: row.note,
    isDefault: !row.customer_id,
    source,
  };
}

/**
 * The terms that apply to a customer: theirs, else the house rule, else nothing.
 */
function forCustomer(db, workspaceId, customerId) {
  if (customerId) {
    const mine = db.prepare(`SELECT * FROM customer_payment_terms
      WHERE workspace_id = ? AND customer_id = ?`).get(workspaceId, customerId);
    if (mine) return hydrate(mine, 'agreed with this customer');
  }
  const house = db.prepare(`SELECT * FROM customer_payment_terms
    WHERE workspace_id = ? AND customer_id IS NULL`).get(workspaceId);
  if (house) return hydrate(house, 'your rule for every customer');
  return { ...HOUSE_DEFAULT };
}

function listTerms(db, workspaceId) {
  return db.prepare(`SELECT t.*, c.name AS customer_name
    FROM customer_payment_terms t
    LEFT JOIN customers c ON c.id = t.customer_id
    WHERE t.workspace_id = ?
    ORDER BY t.customer_id IS NOT NULL, c.name COLLATE NOCASE`).all(workspaceId)
    .map((row) => ({ ...hydrate(row, row.customer_id ? 'agreed with this customer' : 'your rule for every customer'),
      customerName: row.customer_name }));
}

function setTerms(db, ctx, input = {}) {
  const kind = trimOrNull(input.kind);
  if (!KINDS.includes(kind)) {
    throw new ValidationError('Choose whether they pay on account, before fulfilment, or with a deposit.');
  }
  const percent = input.depositPercent === '' || input.depositPercent === undefined || input.depositPercent === null
    ? null : Number(input.depositPercent);
  const flat = input.depositMinor === '' || input.depositMinor === undefined || input.depositMinor === null
    ? null : Math.round(Number(input.depositMinor));

  if (kind === 'DEPOSIT') {
    if (percent === null && flat === null) {
      throw new ValidationError('Say how much of the order they pay up front.');
    }
    if (percent !== null && flat !== null) {
      throw new ValidationError('A deposit is either a share of the order or a fixed amount, not both.');
    }
    if (percent !== null && !(percent > 0 && percent <= 100)) {
      throw new ValidationError('A deposit share is between 1 and 100 per cent.');
    }
    if (flat !== null && !(flat > 0)) throw new ValidationError('A fixed deposit has to be more than nothing.');
  }

  const netDays = input.netDays === '' || input.netDays === undefined || input.netDays === null
    ? null : Math.round(Number(input.netDays));
  if (netDays !== null && (!Number.isInteger(netDays) || netDays < 0)) {
    throw new ValidationError('Payment terms are a whole number of days.');
  }

  const customerId = trimOrNull(input.customerId);
  if (customerId) {
    const known = db.prepare('SELECT id FROM customers WHERE id = ? AND workspace_id = ?')
      .get(customerId, ctx.workspaceId);
    if (!known) throw new NotFoundError('That customer is not in this inventory.');
  }

  const now = nowIso();
  const existing = db.prepare(`SELECT id FROM customer_payment_terms
    WHERE workspace_id = ? AND IFNULL(customer_id, '') = ?`).get(ctx.workspaceId, customerId || '');
  const values = [kind, kind === 'DEPOSIT' ? percent : null, kind === 'DEPOSIT' ? flat : null,
    kind === 'ON_ACCOUNT' ? netDays : null,
    input.holdShipping ? 1 : 0, input.creditApproved ? 1 : 0,
    input.creditLimitMinor ? Math.round(Number(input.creditLimitMinor)) : null,
    trimOrNull(input.note)];

  if (existing) {
    db.prepare(`UPDATE customer_payment_terms SET kind = ?, deposit_percent = ?, deposit_minor = ?,
      net_days = ?, hold_shipping = ?, credit_approved = ?, credit_limit_minor = ?, note = ?,
      agreed_by_user_id = ?, updated_at = ? WHERE id = ?`)
      .run(...values, ctx.actorId || null, now, existing.id);
  } else {
    db.prepare(`INSERT INTO customer_payment_terms
      (id, workspace_id, customer_id, kind, deposit_percent, deposit_minor, net_days,
       hold_shipping, credit_approved, credit_limit_minor, note, agreed_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId('cpt'), ctx.workspaceId, customerId, ...values, ctx.actorId || null, now, now);
  }
  return forCustomer(db, ctx.workspaceId, customerId);
}

function clearTerms(db, ctx, customerId) {
  db.prepare(`DELETE FROM customer_payment_terms
    WHERE workspace_id = ? AND IFNULL(customer_id, '') = ?`).run(ctx.workspaceId, customerId || '');
  return forCustomer(db, ctx.workspaceId, customerId);
}

/** In words, so the same sentence appears wherever the terms do. */
function describe(terms) {
  if (!terms) return 'Payment is due on the invoice.';
  if (terms.kind === 'BEFORE_FULFILMENT') return 'Pays in full before anything is picked.';
  if (terms.kind === 'DEPOSIT') {
    const share = terms.depositPercent !== null && terms.depositPercent !== undefined
      ? `${terms.depositPercent}% of the order`
      : 'a fixed deposit';
    return `Pays ${share} up front${terms.holdShipping ? ', and the balance before it ships' : ''}.`;
  }
  if (terms.netDays === null || terms.netDays === undefined) {
    return `On account${terms.holdShipping ? ', and nothing ships while a balance is owed' : ''}.`;
  }
  return `Net ${terms.netDays}${terms.holdShipping ? ', and nothing ships while a balance is owed' : ''}.`;
}

const percentOf = (amount, percent) => Math.round((Number(amount) * Number(percent)) / 100);

/**
 * Where an order stands on money, and what that permits.
 *
 * Every figure is read: the invoice's own total and balance, and receipts the
 * accounting engine posted against it. Nothing here is a second opinion about
 * how much a customer owes.
 */
function positionForOrder(db, workspaceId, order) {
  const invoices = db.prepare(`SELECT * FROM accounting_customer_invoices
    WHERE workspace_id = ? AND sales_order_id = ? AND status <> 'VOID'
    ORDER BY issue_date, rowid`).all(workspaceId, order.id);

  const terms = forCustomer(db, workspaceId, order.customer_id || (order.customer && order.customer.id));
  const override = db.prepare(`SELECT * FROM sales_order_payment_overrides
    WHERE workspace_id = ? AND sales_order_id = ?`).get(workspaceId, order.id);

  const totalMinor = invoices.reduce((sum, row) => sum + Number(row.total_minor), 0);
  const remainingMinor = invoices.reduce((sum, row) => sum + Number(row.balance_minor), 0);
  const paidMinor = totalMinor - remainingMinor;
  const currency = (invoices[0] && invoices[0].currency) || order.currency || 'USD';
  const dueDate = invoices.map((row) => row.due_date).filter(Boolean).sort()[0] || null;

  /*
   * What has to be paid before the next thing can happen.
   *
   * For a deposit that is the deposit, until it is covered. After that the
   * remainder is only due when shipping is held, because "due now" on an order
   * nobody is holding is just the balance, and calling it due now would make
   * every open invoice look like a problem.
   */
  let dueNowMinor = 0;
  let depositMinor = 0;
  if (terms.kind === 'DEPOSIT' && totalMinor > 0) {
    depositMinor = terms.depositMinor !== null && terms.depositMinor !== undefined
      ? Math.min(Number(terms.depositMinor), totalMinor)
      : percentOf(totalMinor, terms.depositPercent || 0);
    dueNowMinor = Math.max(0, depositMinor - paidMinor);
  } else if (terms.kind === 'BEFORE_FULFILMENT') {
    dueNowMinor = remainingMinor;
  }

  const status = totalMinor === 0 ? 'Not invoiced'
    : remainingMinor === 0 ? 'Paid'
      : paidMinor > 0 ? 'Partly paid' : 'Unpaid';

  // What each stage is allowed to do, and the sentence to say when it is not.
  const held = { pick: null, ship: null };
  if (totalMinor > 0 && remainingMinor > 0) {
    if (terms.kind === 'BEFORE_FULFILMENT') {
      held.pick = `This customer pays before anything is picked, and ${money(remainingMinor, currency)} is still owed.`;
      held.ship = held.pick;
    } else if (terms.kind === 'DEPOSIT' && dueNowMinor > 0) {
      held.pick = `A deposit of ${money(depositMinor, currency)} is due before this is picked, and ${money(dueNowMinor, currency)} of it has not arrived.`;
      held.ship = held.pick;
    } else if (terms.holdShipping) {
      held.ship = `${money(remainingMinor, currency)} is still owed, and this customer's balance has to be paid before an order ships.`;
    }
  }

  const overridden = Boolean(override);
  return {
    terms,
    termsText: describe(terms),
    invoices,
    invoiced: invoices.length > 0,
    currency,
    totalMinor,
    paidMinor,
    remainingMinor,
    dueNowMinor,
    depositMinor,
    dueDate,
    status,
    override: override ? { reason: override.reason, at: override.created_at } : null,
    // A lifted hold is still described, so the page can say it was lifted
    // rather than pretend it never applied.
    heldReason: held,
    blocksPicking: Boolean(held.pick) && !overridden,
    blocksShipping: Boolean(held.ship) && !overridden,
  };
}

function money(minor, currency = 'USD') {
  const amount = (Number(minor) / 100).toFixed(2);
  return currency === 'USD' ? `$${amount}` : `${currency} ${amount}`;
}

/**
 * Let one order past its own hold, on the record.
 */
function overrideHold(db, ctx, orderId, reason = null) {
  const order = db.prepare('SELECT id FROM sales_orders WHERE id = ? AND workspace_id = ?')
    .get(orderId, ctx.workspaceId);
  if (!order) throw new NotFoundError('That sales order is not in this inventory.');
  db.prepare(`INSERT INTO sales_order_payment_overrides
      (id, workspace_id, sales_order_id, reason, approved_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, sales_order_id) DO UPDATE SET
      reason = excluded.reason, approved_by_user_id = excluded.approved_by_user_id`)
    .run(newId('spo'), ctx.workspaceId, orderId, trimOrNull(reason), ctx.actorId || null, nowIso());
  return true;
}

function clearOverride(db, ctx, orderId) {
  db.prepare('DELETE FROM sales_order_payment_overrides WHERE workspace_id = ? AND sales_order_id = ?')
    .run(ctx.workspaceId, orderId);
  return true;
}

module.exports = {
  KINDS, HOUSE_DEFAULT,
  forCustomer, listTerms, setTerms, clearTerms, describe,
  positionForOrder, overrideHold, clearOverride, money,
};
