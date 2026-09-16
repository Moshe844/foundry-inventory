'use strict';

/**
 * One business event, told as one story.
 *
 * A customer order used to be five addresses — the order, the fulfilment
 * queue, the mailbox, the receivable, the payment panel — and understanding
 * what was going on meant visiting four of them and assembling the answer
 * yourself. That is the orchestration this product exists to stop somebody
 * doing, and no amount of renaming the navigation fixes it while the pages
 * stay apart.
 *
 * So there is one shape, and it tells both an order and a purchase, because an
 * order and a purchase are the same kind of story: something started it,
 * StockChief did a series of things about it, and something is going to happen
 * next. The spine runs through a bright line marking now. Solid marks are what
 * happened. Hollow marks are what StockChief intends to do, and that half is what
 * makes this a manager rather than a ledger — a record tells you where you
 * have been.
 *
 * Two rules, both of which come straight from the doctrine:
 *
 *   Nothing here originates a figure or a date. Every line is read from a
 *   record, and where nobody gave a date the line says so rather than
 *   estimating one.
 *
 *   Every judgement StockChief made carries its reason inline — why that
 *   supplier, why that quantity, what authority covered sending it — because
 *   auditability written as prose beside the event is worth more than an audit
 *   screen nobody opens.
 */

const DAY = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

function todayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** "Fri 29 Aug", or "Today" / "Tomorrow" where that is what somebody would say. */
function stamp(value, now = Date.now()) {
  const key = dateOnly(value);
  if (!key) return '';
  const day = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return '';
  const start = new Date(`${todayKey(now)}T00:00:00Z`);
  const days = Math.round((day - start) / 86400000);
  if (days === 0) return 'Today';
  if (days === -1) return 'Yesterday';
  if (days === 1) return 'Tomorrow';
  return `${DAY[day.getUTCDay()]} ${day.getUTCDate()} ${MONTH[day.getUTCMonth()]}`;
}

function money(minor, currency = 'USD') {
  const amount = Number(minor || 0) / 100;
  const sign = amount < 0 ? '-' : '';
  return `${sign}${currency === 'USD' ? '$' : `${currency} `}${Math.abs(amount)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const plural = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;

function mark(at, text, options = {}) {
  return {
    at: at || null,
    when: stamp(at, options.now),
    text,
    sub: options.sub || [],
    state: options.state || 'past',
  };
}

/**
 * Sorts marks by when they happened, with the undated ones last.
 *
 * Undated goes last rather than first because an undated mark is always the
 * weakest thing on the spine — nobody has said when it happens — and sorting
 * an empty string first put "no date" above a real Saturday, which reads as
 * StockChief not knowing what order its own work goes in.
 */
function chronological(marks) {
  return marks
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = a.entry.at ? String(a.entry.at) : '￿';
      const right = b.entry.at ? String(b.entry.at) : '￿';
      return left.localeCompare(right) || (a.index - b.index);
    })
    .map((wrapped) => wrapped.entry);
}


/* ------------------------------------------------------------------ stages */

/**
 * Where a story has got to, as a handful of named stages.
 *
 * Read from the record rather than from the timeline: the spine says what
 * happened, and this says how far through the whole thing that leaves you. A
 * stage is `done`, `now`, or nothing at all — StockChief never marks a stage
 * reached on the strength of a stage after it.
 */
function stagesFor(reached, labels) {
  return labels.map((label, index) => ({
    label,
    state: index < reached ? 'done' : index === reached ? 'now' : 'ahead',
  }));
}

/* ------------------------------------------------------------ sales orders */

/**
 * Purchases that exist because this order was short.
 *
 * A shortage is a decision and not a dead end: if StockChief has already ordered
 * the missing stock, the order says so and links to the purchase, so nobody
 * walks Inventory to Purchasing by hand to find out.
 */
function purchasesCovering(db, workspaceId, skuIds) {
  if (!skuIds.length) return [];
  const marks = skuIds.map(() => '?').join(',');
  try {
    return db.prepare(`SELECT DISTINCT po.id, po.po_number, po.status, po.expected_date,
        s.name AS supplier_name
      FROM purchase_orders po
      JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
      JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.workspace_id = ? AND pol.sku_id IN (${marks})
        AND po.status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED')
      ORDER BY COALESCE(po.expected_date, '9999-12-31') LIMIT 4`)
      .all(workspaceId, ...skuIds);
  } catch {
    return [];
  }
}

const SALES_EVENT = {
  CREATED: (order) => `They ordered ${plural(order.lines.length, 'line', 'lines')}, ${plural(order.totals.ordered, 'unit', 'units')}.`,
  CUSTOMER_CREATED_FROM_EMAIL: () => 'The order arrived by email from somebody not yet on file.',
  CUSTOMER_MATCHED: () => 'I matched the sender to a customer you already had.',
  CHANGED: () => 'The order was changed.',
  CANCELLED: () => 'The order was cancelled.',
  DELIVERY_CONFIRMED: () => 'Delivery was confirmed.',
};

/**
 * @param {object} order the hydrated sales order
 * @param {object} extras everything the order page already gathered
 */
function salesOrder(db, workspaceId, order, extras = {}) {
  const now = extras.now || Date.now();
  const today = todayKey(now);
  const currency = (extras.money && extras.money.currency) || order.currency || 'USD';
  const past = [];
  const future = [];
  const shippingTimeline = extras.shippingTimeline
    || require('../shipping/timeline').forOrder(db, workspaceId, order.id);

  for (const event of order.events || []) {
    const detail = event.detail || {};
    if (event.event_type === 'CONFIRMED') {
      const committed = (detail.allocations || []).reduce((sum, line) => sum + Number(line.allocated || 0), 0);
      const places = [...new Set((detail.allocations || []).map((line) => line.locationName).filter(Boolean))];
      past.push(mark(event.created_at,
        committed
          ? `I committed ${plural(committed, 'unit', 'units')}${places.length ? ` from ${places.join(' and ')}` : ''}, and held them for this customer.`
          : 'I confirmed the order.',
        { now,
          sub: order.totals.backordered
            ? [{ text: `${plural(order.totals.backordered, 'unit is', 'units are')} short. Stock is never taken from the next customer to cover this one, so the shortage is a decision rather than something I do quietly.` }]
            : [] }));
      continue;
    }
    if (event.event_type === 'ALLOCATED_FROM_STOCK' || event.event_type === 'ALLOCATION_CHANGED') {
      past.push(mark(event.created_at, 'I committed more stock to this order as it arrived.', { now }));
      continue;
    }
    if (event.event_type === 'PARTIALLY_FULFILLED' || event.event_type === 'FULFILLED') {
      const units = Number(detail.units || detail.quantity || 0);
      past.push(mark(event.created_at,
        units ? `${plural(units, 'unit', 'units')} went out.` : 'Goods went out.', { now }));
      continue;
    }
    const say = SALES_EVENT[event.event_type];
    if (say) past.push(mark(event.created_at, say(order), { now }));
  }

  // What the customer has been told, on the same page as the thing they were
  // told about. "Does she know it shipped?" should never need a mailbox.
  for (const notice of extras.customerNotices || []) {
    const sent = notice.sentAt || notice.sent_at;
    const label = sent ? 'I wrote to them' : 'I drafted a message to them';
    past.push(mark(sent || notice.createdAt || notice.created_at,
      `${label}: “${notice.subject || 'about this order'}”.`,
      { now, sub: sent ? [] : [{ text: 'Waiting for you to read it before it goes — that is what you asked for.' }] }));
  }

  for (const receipt of extras.customerReceipts || []) {
    past.push(mark(receipt.payment_date,
      `They paid ${money(receipt.amount_minor, currency)}${receipt.method ? ` by ${String(receipt.method).toLowerCase()}` : ''}.`,
      { now }));
  }

  /*
   * What the shipment did to the books, said in the owner's words and on the
   * order rather than in an accounting screen. StockChief raises the invoice and
   * the cost entry when the goods go, so this is a consequence of the story
   * and belongs in it — an owner should never have to open a journal to find
   * out whether a sale was accounted for.
   */
  const posted = extras.accounting;
  if (posted && posted.entry_number) {
    past.push(mark(posted.processed_at || posted.created_at,
      'It went on the books automatically: revenue, the customer receivable, product cost, and inventory value.',
      { now, sub: [{ text: `Entry ${posted.entry_number}`, href: '/accounting/transactions' }] }));
  }

  for (const shipment of extras.shipments || []) {
    if (shipment.packedAt || shipment.packed_at) {
      past.push(mark(shipment.packedAt || shipment.packed_at, 'I picked and packed it.', { now }));
    }
    if (shipment.shippedAt || shipment.shipped_at) {
      const carrier = shipment.carrier ? ` with ${shipment.carrier}` : '';
      const tracking = shipment.trackingNumber || shipment.tracking_number;
      const destination = shipment.ship_to_address
        ? { text: `Sent to ${shipment.ship_to_address}` }
        : { text: 'No delivery address on this order.' };
      past.push(mark(shipment.shippedAt || shipment.shipped_at, `It went out${carrier}.`, {
        now,
        sub: [destination].concat(tracking
          ? [{ text: `Tracking ${tracking}`, href: shipment.trackingUrl || shipment.tracking_url || null }]
          : []),
      }));
    }
    if ((shipment.deliveredAt || shipment.delivered_at)
        && !shippingTimeline.some((event) => event.kind === 'TRACKING'
          && event.shipmentId === shipment.id && event.status === 'DELIVERED')) {
      past.push(mark(shipment.deliveredAt || shipment.delivered_at, 'Delivery was recorded.', { now }));
    }
  }

  for (const event of shippingTimeline) {
    const carrierService = [event.carrier, event.service].filter(Boolean).join(' ');
    if (event.kind === 'LABEL_PURCHASE') {
      const amount = Number.isFinite(Number(event.amountMinor))
        ? ` for ${money(Number(event.amountMinor), event.currency || currency)}` : '';
      past.push(mark(event.occurredAt,
        `I selected ${carrierService || 'the carrier service'} and bought the label${amount}.`,
        { now, sub: event.trackingNumber ? [{ text: `Tracking ${event.trackingNumber}` }] : [] }));
      continue;
    }
    if (event.kind === 'LABEL_VOID') {
      past.push(mark(event.occurredAt, event.status === 'REVIEW'
        ? 'The carrier label void needs verification.'
        : `The unused carrier label was voided${Number(event.amountMinor) > 0 ? ` and ${money(Number(event.amountMinor), event.currency || currency)} was refunded` : ''}.`,
      { now, state: event.status === 'REVIEW' ? 'blocked' : 'past' }));
      continue;
    }
    if (event.kind === 'LABEL_ADJUSTMENT') {
      past.push(mark(event.occurredAt,
        `The carrier recorded a ${money(Math.abs(Number(event.amountMinor || 0)), event.currency || currency)} postage ${Number(event.amountMinor) < 0 ? 'credit' : 'adjustment'}.`,
      { now, sub: event.detail ? [{ text: event.detail }] : [] }));
      continue;
    }
    if (event.kind !== 'TRACKING') continue;
    const status = String(event.status || '').toUpperCase();
    const wording = {
      PRE_TRANSIT: 'The carrier has the label but not the parcel yet.',
      IN_TRANSIT: `${event.carrier || 'The carrier'} accepted the parcel and it is in transit.`,
      OUT_FOR_DELIVERY: 'The parcel is out for delivery.',
      DELIVERED: 'The carrier verified delivery.',
      FAILURE: 'The carrier reported a delivery exception.',
      RETURNED: 'The carrier reported the parcel returned.',
    }[status] || `The carrier reported ${status.toLowerCase().replaceAll('_', ' ')}.`;
    const detail = [];
    if (event.detail) detail.push({ text: event.detail });
    if (event.location) detail.push({ text: event.location });
    past.push(mark(event.occurredAt, wording,
      { now, state: ['FAILURE', 'RETURNED'].includes(status) ? 'blocked' : 'past', sub: detail }));
  }

  /* --------------------------------------------------------------- ahead */

  const shortSkus = (extras.shortageDetails || []).map((row) => row.skuId).filter(Boolean);
  const covering = purchasesCovering(db, workspaceId, shortSkus);
  for (const purchase of covering) {
    future.push(mark(purchase.expected_date,
      purchase.expected_date
        ? `${purchase.supplier_name} delivers what this order is short of.`
        : `${purchase.supplier_name} owes me what this order is short of — nobody has given a date.`,
      { now,
        state: 'future',
        sub: [{ text: `${purchase.po_number} · ${String(purchase.status).toLowerCase().replaceAll('_', ' ')}`, href: `/purchasing/orders/${purchase.id}` }] }));
  }

  if (order.needed_by && order.status !== 'FULFILLED' && order.status !== 'CANCELLED') {
    future.push(mark(order.needed_by,
      order.needed_by < today
        ? 'They wanted this by now.'
        : 'This is the day they asked for.',
      { now, state: order.needed_by < today ? 'blocked' : 'future' }));
  }

  const paid = extras.money || {};
  if (paid.dueDate && Number(paid.remainingMinor) > 0) {
    future.push(mark(paid.dueDate,
      `${money(paid.remainingMinor, currency)} falls due.`,
      { now,
        state: paid.dueDate < today ? 'blocked' : 'future',
        sub: paid.dueDate < today ? [{ text: 'Already past. It is in what you are owed.', href: '/money' }] : [] }));
  } else if (Number(paid.remainingMinor) > 0 && order.status !== 'DRAFT') {
    future.push(mark(null,
      `${money(paid.remainingMinor, currency)} is still to be paid. Nothing has given it a due date yet.`,
      { now, state: 'future' }));
  }

  /* ----------------------------------------------------------------- now */

  const state = extras.fulfilment || {};
  const goneLabel = state.label || state.state || 'Gone';
  let nowText = null;
  if (order.status === 'CANCELLED') nowText = 'Cancelled. Nothing further will happen on it.';
  else if (order.status === 'FULFILLED') {
    nowText = goneLabel === 'Collected'
      ? 'The customer collected everything on this order.'
      : goneLabel === 'Delivered'
        ? 'Everything on this order was delivered.'
        : goneLabel === 'Shipped'
          ? 'Everything on this order was shipped.'
          : 'Everything on it has gone out.';
  }
  else if (order.totals.backordered && covering.length) nowText = 'Waiting on the delivery that covers what this is short of.';
  else if (order.totals.backordered) nowText = `${plural(order.totals.backordered, 'unit is', 'units are')} short and nothing is on order to cover it.`;
  else if ((extras.shipments || []).some((s) => s.status === 'PACKED')) nowText = 'Packed, and waiting for a carrier.';
  else if ((extras.shipments || []).some((s) => s.status === 'PICKING')) nowText = 'Being picked.';
  else if (order.status === 'DRAFT') nowText = 'A draft. Nothing is committed and nobody has been told anything.';
  else if (order.totals.allocated && Number(paid.totalMinor || 0) > 0
    && Number(paid.remainingMinor || 0) === 0) {
    nowText = `Paid in full. ${plural(order.totals.allocated, 'unit is', 'units are')} committed and ready to pick.`;
  } else if (order.totals.allocated) nowText = 'Stock is committed and it is ready to pick.';
  if (nowText) {
    past.push(mark(null, nowText, { now, state: 'now' }));
  }

  const meta = [`${order.order_number} · ${plural(order.lines.length, 'line', 'lines')}, ${plural(order.totals.ordered, 'unit', 'units')}`];
  if (order.pricing && order.pricing.totalMinor) meta.push(money(order.pricing.totalMinor, currency));

  /* Ordered → committed → picked → shipped → paid, with the stage it has
     actually reached derived from the records rather than from the status
     word, so a partly-shipped order does not claim to be shipped. */
  const shipments = extras.shipments || [];
  const shipped = shipments.some((s) => s.status === 'SHIPPED' || s.status === 'DELIVERED')
    || order.status === 'FULFILLED';
  const picked = shipped || shipments.some((s) => s.status === 'PACKED' || s.status === 'PICKING');
  const settled = Number(paid.totalMinor || 0) > 0
    && Number(paid.remainingMinor || 0) === 0
    && order.status !== 'DRAFT';
  /*
   * Fulfilment and payment are independent facts. A customer may prepay, so a
   * single left-to-right "reached" number made a paid order look unpaid until
   * it shipped. Each marker is derived separately; it is perfectly truthful
   * for Paid to be complete while Picked is the current physical step.
   */
  const stages = [
    { label: 'Ordered', state: order.status === 'DRAFT' ? 'now' : 'done' },
    { label: 'Committed', state: order.status !== 'DRAFT' ? 'done' : 'future' },
    { label: 'Picked', state: picked ? 'done' : (order.totals.allocated && !shipped ? 'now' : 'future') },
    { label: shipped ? goneLabel : 'Shipped', state: shipped ? 'done' : (picked ? 'now' : 'future') },
    { label: settled ? 'Paid' : 'Awaiting payment', state: settled ? 'done' : 'future' },
  ];

  return {
    head: {
      title: (order.customer && order.customer.name) || order.order_number,
      meta,
      state: order.status === 'FULFILLED'
        ? goneLabel.toLowerCase()
        : String(order.status || '').toLowerCase().replaceAll('_', ' '),
      hot: Boolean(order.totals.backordered) || (paid.dueDate && paid.dueDate < today),
    },
    stages,
    marks: [...chronological(past.filter((entry) => entry.state !== 'now')),
      ...past.filter((entry) => entry.state === 'now'),
      ...chronological(future)],
  };
}

/* --------------------------------------------------------- purchase orders */

const PO_EVENT = {
  created: () => 'I drafted the order.',
  submitted: () => 'I sent it to the supplier.',
  approved: () => 'You approved it.',
  prices_updated: () => 'The prices on it were corrected.',
  cancelled: () => 'It was cancelled.',
  supplier_follow_up_prepared: () => 'I wrote a chaser for the supplier.',
};

function purchaseOrder(db, workspaceId, order, extras = {}) {
  const now = extras.now || Date.now();
  const today = todayKey(now);
  const currency = order.currency || 'USD';
  const past = [];
  const future = [];

  /*
   * Why this order exists at all, in front of everything it did. A purchase
   * that cannot say what made it necessary is a purchase somebody has to
   * audit; one that can is a purchase they can read.
   */
  const because = order.sourceDetail || {};
  if (order.source === 'foundry_recommendation' || because.reason || because.explanation) {
    past.push(mark(order.createdAt,
      because.explanation || because.reason
        || 'A replenishment plan found this below its reorder point.',
      { now, sub: [{ text: 'StockChief prepared this rather than being asked for it.' }] }));
  }

  for (const event of order.eventsFor || extras.events || []) {
    const say = PO_EVENT[event.event];
    if (!say) continue;
    const sub = [];
    if (event.event === 'submitted') {
      const mail = (extras.communications || []).find((row) => row.kind === 'purchase_order' || row.direction === 'OUTBOUND');
      if (mail) {
        sub.push({
          text: mail.sentAt
            ? `Sent from ${mail.mailboxName || 'your mailbox'}${mail.subject ? ` — “${mail.subject}”` : ''}`
            : 'Written and waiting to be sent',
          href: `/purchasing/orders/${order.id}#supplier-mail`,
        });
      }
    }
    if (event.event === 'approved' && event.actorName) sub.push({ text: `Approved by ${event.actorName}.` });
    past.push(mark(event.createdAt, say(order), { now, sub }));
  }

  for (const receipt of extras.receipts || []) {
    const units = Number(receipt.units || receipt.totalUnits || 0);
    past.push(mark(receipt.receivedAt || receipt.received_at || receipt.createdAt,
      units ? `${plural(units, 'unit', 'units')} were counted in.` : 'A delivery was counted in.',
      { now, sub: [{ text: 'Stock moved only for what was actually counted, not for what the order said.' }] }));
  }

  for (const bill of extras.supplierBills || []) {
    past.push(mark(bill.issue_date,
      `Their invoice for ${money(bill.total_minor, bill.currency || currency)} went on the books.`,
      { now,
        sub: [{ text: 'Posted at the cost on the invoice, not the cost on the order.', href: '/money' }] }));
    if (Number(bill.balance_minor) > 0 && bill.due_date) {
      future.push(mark(bill.due_date,
        `${money(bill.balance_minor, bill.currency || currency)} is due.`,
        { now,
          state: bill.due_date < today ? 'blocked' : 'future',
          sub: [{ text: 'I will ask before paying it.' }] }));
    }
  }

  const supplierMessages = extras.communications || [];
  const sentToSupplier = supplierMessages.some((message) => message.status === 'SENT');
  const missingSupplierRecipient = supplierMessages.some((message) => !message.recipient);
  const missingSendingMailbox = supplierMessages.some((message) => !message.connectorId);

  if (sentToSupplier && order.expectedDate && order.outstandingUnits > 0) {
    const assumed = order.expectedDateSource === 'unknown' || !order.expectedDateSource;
    future.push(mark(order.expectedDate,
      order.expectedDate < today
        ? `It should have arrived. ${plural(order.outstandingUnits, 'unit is', 'units are')} still outstanding.`
        : `${plural(order.outstandingUnits, 'unit', 'units')} arrive. I will count them against the order.`,
      { now,
        state: order.expectedDate < today ? 'blocked' : 'future',
        sub: assumed
          ? [{ text: 'This date is a lead time, not something the supplier said.' }]
          : [{ text: 'If it is short, or the price has moved, that becomes a decision for you.' }] }));
  } else if (sentToSupplier && !order.expectedDate && order.outstandingUnits > 0 && order.status === 'ORDERED') {
    future.push(mark(null,
      'Nobody has said when this arrives, so I am not going to guess.',
      { now, state: 'future' }));
  }

  let nowText = null;
  if (order.status === 'CANCELLED') nowText = 'Cancelled.';
  else if (order.status === 'RECEIVED') nowText = 'All of it arrived and is on the shelf.';
  else if (order.status === 'PARTIALLY_RECEIVED') nowText = `Part of it arrived. ${plural(order.outstandingUnits, 'unit is', 'units are')} still to come.`;
  else if (order.status === 'ORDERED' && sentToSupplier) nowText = 'With the supplier.';
  else if (order.status === 'ORDERED' && missingSupplierRecipient) {
    nowText = `Approved in StockChief, but not sent. ${order.supplierName} has no email on file.`;
  } else if (order.status === 'ORDERED' && missingSendingMailbox) {
    nowText = 'Approved in StockChief, but not sent. No supplier mailbox is connected.';
  } else if (order.status === 'ORDERED') nowText = 'Approved in StockChief. The supplier message has not been sent.';
  else if (order.status === 'AWAITING_APPROVAL') nowText = 'Ready to send, and waiting on you.';
  else if (order.status === 'APPROVED') nowText = 'Approved and ready to go to the supplier.';
  else if (order.status === 'DRAFT') nowText = 'A draft. The supplier has not been told anything.';
  if (nowText) past.push(mark(null, nowText, { now, state: 'now' }));

  const meta = [`${order.poNumber} · ${plural(order.orderedUnits, 'unit', 'units')}`];
  if (order.subtotal) meta.push(money(Math.round(order.subtotal * 100), currency));

  const bills = extras.supplierBills || [];
  const billed = bills.length > 0;
  const settled = billed && bills.every((bill) => Number(bill.balance_minor) === 0);
  const reachedStage = ['DRAFT', 'AWAITING_APPROVAL'].includes(order.status) ? 0
    : order.status === 'CANCELLED' ? 0
      : settled ? 5
        : billed ? 4
          : order.receivedUnits > 0 ? 3
            : order.status === 'ORDERED' && sentToSupplier ? 2
              : 1;

  return {
    head: {
      title: order.supplierName,
      meta,
      state: String(order.status || '').toLowerCase().replaceAll('_', ' '),
      hot: Boolean(order.expectedDate && order.expectedDate < today && order.outstandingUnits > 0),
    },
    stages: stagesFor(reachedStage, ['Prepared', 'Approved', 'With supplier', 'Received', 'Invoiced', 'Paid']),
    marks: [...chronological(past.filter((entry) => entry.state !== 'now')),
      ...past.filter((entry) => entry.state === 'now'),
      ...chronological(future)],
  };
}

module.exports = { salesOrder, purchaseOrder, stamp, money };
