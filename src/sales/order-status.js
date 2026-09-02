'use strict';

/**
 * What one order is waiting for, in a sentence.
 *
 * The orders list used to be seven columns — ordered, committed, short, total,
 * needed by, and a badge saying "Confirmed — stock held". Every figure true,
 * and between them they never answered the only question somebody opens that
 * page to ask: which of these needs me, and why.
 *
 * Worse, they could contradict the truth. An order whose deposit had not
 * arrived showed "Confirmed — stock held", which reads like nothing is wrong,
 * while picking it was refused. A list that says fine about something that is
 * stuck is worse than no list.
 *
 * So this composes the two things that actually hold an order up — money and
 * stock — into one sentence and one rank. Nothing here is a new fact: the
 * payment position and the fulfilment state are both read from the engines that
 * own them, and this only decides which of them is the thing to say first.
 *
 * The order of the checks is the order of the blocking. Money first, because a
 * held order does not move however much stock is on the shelf.
 */

const paymentTerms = require('./payment-terms');
const shipments = require('./shipment-service');

/*
 * Higher sorts first. The scale is "how much is this costing you to ignore":
 * a customer waiting on a promise you already broke outranks one whose deposit
 * simply has not arrived yet, and both outrank an order quietly on its way.
 */
const RANK = {
  LATE: 90,
  BLOCKED: 80,
  WAITING_ON_STOCK: 70,
  READY: 60,
  IN_HAND: 40,
  GONE: 20,
  SETTLED: 10,
  CANCELLED: 0,
};

const money = (minor, currency) => paymentTerms.money(minor, currency);

/**
 * @returns {{ text, detail, tone, rank, action, href }}
 */
function nextStep(db, workspaceId, order, options = {}) {
  if (order.status === 'CANCELLED') {
    return { text: 'Cancelled', detail: null, tone: 'muted', rank: RANK.CANCELLED };
  }
  if (order.status === 'DRAFT') {
    return {
      text: 'Not confirmed yet',
      detail: 'Nothing is held for this customer until you confirm it.',
      tone: 'warn',
      rank: RANK.BLOCKED,
      action: 'Confirm it',
    };
  }

  const payment = options.payment || paymentTerms.positionForOrder(db, workspaceId, order);
  const fulfilment = options.fulfilment || shipments.fulfilmentState(db, workspaceId, order);
  const today = String(options.today || new Date().toISOString().slice(0, 10));
  const late = order.needed_by && order.needed_by < today
    && !['Shipped', 'Delivered'].includes(fulfilment.state);

  // Money first: a held order does not move however much stock is on the shelf.
  if (payment.blocksPicking) {
    return {
      text: payment.dueNowMinor
        ? `Waiting for a ${money(payment.dueNowMinor, payment.currency)} deposit`
        : `Waiting for ${money(payment.remainingMinor, payment.currency)}`,
      detail: payment.heldReason.pick,
      tone: late ? 'danger' : 'warn',
      rank: late ? RANK.LATE : RANK.BLOCKED,
      action: 'Ask them to pay',
      href: '#money',
    };
  }
  if (payment.blocksShipping && ['Packed', 'Picking', 'Ready to pick'].includes(fulfilment.state)) {
    return {
      text: `Packed — ${money(payment.remainingMinor, payment.currency)} owed before it ships`,
      detail: payment.heldReason.ship,
      tone: late ? 'danger' : 'warn',
      rank: late ? RANK.LATE : RANK.BLOCKED,
      action: 'Ask them to pay',
      href: '#money',
    };
  }

  if (fulfilment.state === 'Waiting for stock') {
    const short = Number(order.totals ? order.totals.backordered : 0);
    return {
      text: short ? `Short ${short} — waiting for stock` : 'Waiting for stock',
      detail: fulfilment.detail,
      tone: late ? 'danger' : 'warn',
      rank: late ? RANK.LATE : RANK.WAITING_ON_STOCK,
      action: 'See what to do',
    };
  }
  if (fulfilment.state === 'Ready to pick') {
    return {
      text: 'Ready to pick',
      detail: fulfilment.detail,
      tone: late ? 'danger' : 'go',
      rank: late ? RANK.LATE : RANK.READY,
      action: 'Start picking',
    };
  }
  if (fulfilment.state === 'Picking') {
    return { text: 'Being picked', detail: fulfilment.detail, tone: 'info', rank: RANK.IN_HAND };
  }
  if (fulfilment.state === 'Packed') {
    return { text: 'Packed, waiting for a carrier', detail: fulfilment.detail, tone: 'info', rank: RANK.IN_HAND };
  }
  if (fulfilment.state === 'Partly shipped') {
    return { text: 'Partly shipped', detail: fulfilment.detail, tone: 'info', rank: RANK.IN_HAND };
  }

  // It has gone. The only thing that can still be outstanding is the money.
  if (payment.remainingMinor > 0) {
    const overdue = payment.dueDate && payment.dueDate < today;
    return {
      text: `${fulfilment.state} — ${money(payment.remainingMinor, payment.currency)} still owed`,
      detail: overdue ? `That was due ${payment.dueDate}.` : null,
      tone: overdue ? 'danger' : 'warn',
      rank: overdue ? RANK.LATE : RANK.GONE,
      action: 'Chase the payment',
      href: '#money',
    };
  }
  return {
    text: fulfilment.state === 'Delivered' ? 'Delivered and paid' : 'Shipped and paid',
    detail: null,
    tone: 'ok',
    rank: RANK.SETTLED,
  };
}

/**
 * The list, most-in-need-of-a-person first.
 *
 * Within the same rank, the oldest promise leads: two orders equally stuck are
 * separated by which customer has been waiting longer, which is the thing that
 * turns into a phone call.
 */
function decorate(db, workspaceId, orders, options = {}) {
  return orders
    .map((order) => ({ ...order, next: nextStep(db, workspaceId, order, options) }))
    .sort((a, b) => (b.next.rank - a.next.rank)
      || String(a.needed_by || a.order_date || '').localeCompare(String(b.needed_by || b.order_date || '')));
}

/**
 * One sentence about the whole list, for the top of the page.
 *
 * Says how many need a person and stops. A count of everything is a statistic;
 * a count of what is stuck is the reason you opened the page.
 */
function summarise(decorated) {
  const open = decorated.filter((order) => order.next.rank > RANK.SETTLED);
  const stuck = decorated.filter((order) => order.next.rank >= RANK.BLOCKED);
  const ready = decorated.filter((order) => order.next.rank === RANK.READY);

  if (!open.length) return 'Nothing is waiting on you.';
  const parts = [];
  if (stuck.length) parts.push(`${stuck.length} ${stuck.length === 1 ? 'order needs' : 'orders need'} you`);
  if (ready.length) parts.push(`${ready.length} ready to pick`);
  if (!parts.length) return `${open.length} ${open.length === 1 ? 'order is' : 'orders are'} on their way.`;
  return `${parts.join(', ')}.`;
}

module.exports = { nextStep, decorate, summarise, RANK };
