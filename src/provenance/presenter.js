'use strict';

const graph = require('./service');
const registry = require('./registry');
const permissions = require('../actions/permissions');

const ACCOUNTING = new Set(['supplier_bill','supplier_bill_line','customer_invoice',
  'customer_invoice_line','payment','journal_entry']);

function safeJson(value) { try { return JSON.parse(value || '{}'); } catch { return {}; } }

function rowFor(db, workspaceId, ref) {
  const node = registry.NODES[ref.type];
  return node ? db.prepare(`SELECT * FROM ${node.table} WHERE id = ? AND workspace_id = ?`).get(ref.id, workspaceId) : null;
}

function title(type, row) {
  if (!row) return registry.NODES[type]?.label || type;
  if (type === 'purchase_order_line') return `${Number(row.quantity_units)} units on purchase order`;
  if (type === 'sales_order_line') return `${Number(row.quantity_ordered)} units ordered by customer`;
  if (type === 'purchase_receipt_line') return `${Number(row.quantity_units)} units received`;
  if (type === 'purchase_order_event') return String(row.event || 'purchase event').replaceAll('_', ' ');
  if (type === 'sales_order_event') return String(row.event_type || 'customer order event').replaceAll('_', ' ').toLowerCase();
  if (type === 'work_item') return String(row.category || 'Foundry work item').replaceAll('_', ' ');
  if (type === 'inventory_movement') return `${Math.abs(Number(row.quantity_delta || 0))} units ${row.operation || 'moved'}`;
  if (type === 'inventory_transfer') return row.transfer_number || 'inventory transfer';
  if (type === 'inventory_transfer_line') return `${Number(row.requested_quantity || 0)} units on transfer`;
  if (type === 'inventory_transfer_event') return String(row.event_type || 'transfer event').replaceAll('_', ' ').toLowerCase();
  if (type === 'shipment') return row.shipment_number || 'shipment';
  if (type === 'domain_event') return String(row.event_type || 'business event').replaceAll('.', ' ');
  return row.order_number || row.po_number || row.invoice_number || row.bill_number
    || row.payment_number || row.document_reference || row.reference
    || (type === 'journal_entry' ? `Accounting entry ${row.entry_number}` : null)
    || registry.NODES[type]?.label || type;
}

function href(type, row) {
  if (!row) return null;
  if (type === 'sales_order') return `/orders/${row.id}`;
  if (type === 'purchase_order') return `/purchasing/orders/${row.id}`;
  if (type === 'supplier_bill' || type === 'customer_invoice' || type === 'payment') return '/money';
  if (type === 'journal_entry') return '/accounting/transactions';
  if (type === 'inventory_movement') return '/activity';
  if (type === 'inventory_transfer') return `/transfers/${row.id}`;
  if (type === 'inventory_transfer_line' || type === 'inventory_transfer_event') return `/transfers/${row.transfer_id}`;
  if (type === 'shipment') return `/fulfilment/${row.id}`;
  if (type === 'attention_item') return '/needs-you';
  if (type === 'work_item') return `/autopilot/work/${row.id}`;
  return null;
}

function time(row, fallback) {
  return row?.paid_at || row?.received_at || row?.posting_date || row?.payment_date
    || row?.processed_at || row?.occurred_at || row?.created_at || fallback || null;
}

function facts(type, row) {
  if (!row || type !== 'work_item') return [];
  const values = safeJson(row.source_evidence);
  return Array.isArray(values) ? values.filter((fact) => fact && fact.label !== undefined).map((fact) => ({
    label: String(fact.label), value: String(fact.value), note: fact.note ? String(fact.note) : null,
  })) : [];
}

function canSee(membership) {
  return (ref) => !ACCOUNTING.has(ref.type) || permissions.can(membership, permissions.VIEW_ACCOUNTING);
}

function forRecord(db, workspaceId, start, { membership = null } = {}) {
  const traced = graph.trace(db, workspaceId, start, { canSee: canSee(membership) });
  const rootRow = rowFor(db, workspaceId, start);
  const maySeeAccounting = permissions.can(membership, permissions.VIEW_ACCOUNTING);
  const details = traced.relations.map((relation) => {
    const from = rowFor(db, workspaceId, { type: relation.from_type, id: relation.from_id });
    const to = rowFor(db, workspaceId, { type: relation.to_type, id: relation.to_id });
    return {
      id: relation.id,
      relation: relation.relation_type,
      phrase: registry.RELATIONS[relation.relation_type]?.phrase || 'is connected to',
      from: { type: relation.from_type, id: relation.from_id, title: title(relation.from_type, from), href: href(relation.from_type, from), facts: facts(relation.from_type, from) },
      to: { type: relation.to_type, id: relation.to_id, title: title(relation.to_type, to), href: href(relation.to_type, to), facts: facts(relation.to_type, to) },
      when: time(to, relation.created_at),
      basis: relation.basis,
      metadata: relation.metadata,
    };
  });
  const types = new Set(details.flatMap((entry) => [entry.from.type, entry.to.type]));
  const purchase = start.type === 'purchase_order';
  const hasSupplyResponse = details.some((entry) => entry.relation === 'RESPONDS_TO'
    && entry.from.type === 'purchase_order' && entry.to.type === 'sales_order');
  const stages = purchase
    ? [
      { label: 'Purchase order', present: true },
      { label: 'Inventory received', present: types.has('purchase_receipt'),
        expected: ['PARTIALLY_RECEIVED','RECEIVED'].includes(rootRow?.status) },
      { label: 'Supplier bill', present: types.has('supplier_bill'), expected: false },
      { label: 'Supplier payment', present: types.has('payment'), expected: false },
      { label: 'Accounting recorded', present: types.has('journal_entry'),
        expected: maySeeAccounting && (types.has('purchase_receipt') || types.has('supplier_bill')) },
    ]
    : [
      { label: 'Customer demand', present: true },
      { label: 'Supply response', present: hasSupplyResponse, expected: false },
      { label: 'Fulfillment', present: details.some((entry) => entry.relation === 'FULFILLED_BY'
          && ['sales_order_event','shipment'].includes(entry.to.type)),
        expected: ['PARTIALLY_FULFILLED','FULFILLED'].includes(rootRow?.status) },
      { label: 'Customer invoice', present: types.has('customer_invoice'),
        expected: maySeeAccounting && ['PARTIALLY_FULFILLED','FULFILLED'].includes(rootRow?.status) },
      { label: 'Customer payment', present: types.has('payment'), expected: false },
      { label: 'Revenue and product cost recorded', present: types.has('journal_entry'),
        expected: maySeeAccounting && ['PARTIALLY_FULFILLED','FULFILLED'].includes(rootRow?.status) },
    ];
  const present = stages.filter((stage) => stage.present).map((stage) => stage.label);
  return {
    root: traced.root,
    summary: present.length > 1 ? `${present.join(' → ')}.` : `${present[0]}. No later linked outcome is recorded yet.`,
    stages,
    details,
    incomplete: traced.incomplete,
    // An absent edge remains absent. This wording is important: it reports
    // the boundary of evidence without claiming that an event did not happen.
    unknown: stages.filter((stage) => stage.expected && !stage.present)
      .map((stage) => `${stage.label} is claimed by the source record but is not linked by available evidence.`),
  };
}

function displayMoney(minor, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency,
    minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(minor || 0) / 100);
}

/**
 * Turn the typed graph behind a customer order into the five facts an owner
 * actually needs. Raw relation rows remain available separately for an
 * auditor, but they are never the primary explanation.
 */
function salesOrderStory(db, workspaceId, order, extras = {}, options = {}) {
  const trace = forRecord(db, workspaceId, { type: 'sales_order', id: order.id }, options);
  const steps = [];
  const currency = extras.money?.currency || order.currency || 'USD';
  const orderHref = `/orders/${order.id}`;
  const customer = order.customer?.name || 'The customer';
  const hasPart = trace.details.some((entry) => entry.relation === 'HAS_PART'
    && entry.from.type === 'sales_order' && entry.from.id === order.id);
  steps.push({
    label: 'Customer order',
    text: hasPart
      ? `${customer} ordered ${Number(order.totals?.ordered || 0)} ${Number(order.totals?.ordered || 0) === 1 ? 'unit' : 'units'} on ${order.order_number}.`
      : `${order.order_number} exists, but its item links are not available in the evidence graph.`,
    href: orderHref,
    linkText: `Open ${order.order_number}`,
    complete: hasPart,
  });

  const confirmed = db.prepare(`SELECT id, detail FROM sales_order_events
    WHERE workspace_id = ? AND sales_order_id = ? AND event_type = 'CONFIRMED'
    ORDER BY created_at, rowid LIMIT 1`).get(workspaceId, order.id);
  const confirmationLinked = confirmed && trace.details.some((entry) => entry.relation === 'HAS_EVENT'
    && entry.to.type === 'sales_order_event' && entry.to.id === confirmed.id);
  if (confirmed) {
    const detail = safeJson(confirmed.detail);
    const allocations = Array.isArray(detail.allocations) ? detail.allocations : [];
    const committed = allocations.reduce((sum, row) => sum + Number(row.allocated || 0), 0);
    const waiting = allocations.reduce((sum, row) => sum + Number(row.backordered || 0), 0);
    const locationName = db.prepare('SELECT name FROM locations WHERE id = ? AND workspace_id = ?');
    const positions = allocations.flatMap((row) => Array.isArray(row.allocations) ? row.allocations : [row]);
    const places = [...new Set(positions.map((row) => row.locationName
      || (row.locationId || row.location_id
        ? locationName.get(row.locationId || row.location_id, workspaceId)?.name
        : null)).filter(Boolean))];
    steps.push({
      label: 'Stock reserved',
      text: confirmationLinked
        ? committed
          ? `Foundry reserved ${committed} ${committed === 1 ? 'unit' : 'units'}${places.length ? ` from ${places.join(' and ')}` : ''} for this customer.${waiting ? ` ${waiting} ${waiting === 1 ? 'unit was' : 'units were'} still waiting for stock.` : ''}`
          : `The order was confirmed, but no stock was reserved.${waiting ? ` ${waiting} ${waiting === 1 ? 'unit was' : 'units were'} waiting for stock.` : ''}`
        : 'The order is confirmed, but its confirmation is not linked in the evidence graph.',
      href: orderHref,
      linkText: 'Show the order evidence',
      complete: Boolean(confirmationLinked),
    });
  }

  /*
   * A purchase may be larger than one customer's shortage because supplier
   * packs and stock targets still apply. Say both numbers: the quantity that
   * caused the decision and the quantity actually ordered. Conflating those
   * is how a correct PO looks like an unexplained over-purchase.
   */
  const supplyLinks = trace.details.filter((entry) => entry.relation === 'RESPONDS_TO'
    && entry.from.type === 'purchase_order' && entry.to.type === 'sales_order'
    && entry.to.id === order.id);
  const seenSupply = new Set();
  for (const link of supplyLinks) {
    if (seenSupply.has(link.from.id)) continue;
    seenSupply.add(link.from.id);
    const supply = db.prepare(`SELECT po.*, s.name AS supplier_name
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.id = ? AND po.workspace_id = ?`).get(link.from.id, workspaceId);
    if (!supply) continue;
    const skuId = link.metadata?.skuId || null;
    const ordered = db.prepare(`SELECT COALESCE(SUM(quantity_units), 0) AS units
      FROM purchase_order_lines WHERE workspace_id = ? AND purchase_order_id = ?
        AND (? IS NULL OR sku_id = ?)`).get(workspaceId, supply.id, skuId, skuId).units;
    const waiting = Number(link.metadata?.waitingQuantity || 0);
    const product = link.metadata?.displayName ? ` of ${link.metadata.displayName}` : '';
    steps.push({
      label: 'Supply arranged',
      text: `${supply.po_number} ordered ${ordered} ${Number(ordered) === 1 ? 'unit' : 'units'}${product} from ${supply.supplier_name}.${waiting ? ` This purchase was linked to the ${waiting} ${waiting === 1 ? 'unit' : 'units'} this customer was waiting for.` : ''}`,
      href: `/purchasing/orders/${supply.id}`,
      linkText: `Open ${supply.po_number}`,
      complete: true,
    });

    const receiptIds = [...new Set(trace.details.filter((entry) => entry.relation === 'RECEIVED_AS'
      && entry.from.type === 'purchase_order' && entry.from.id === supply.id
      && entry.to.type === 'purchase_receipt').map((entry) => entry.to.id))];
    if (receiptIds.length) {
      const marks = receiptIds.map(() => '?').join(',');
      const received = db.prepare(`SELECT COALESCE(SUM(porl.quantity_units), 0) AS units
        FROM purchase_order_receipt_lines porl
        WHERE porl.workspace_id = ? AND porl.receipt_id IN (${marks})
          AND (? IS NULL OR porl.sku_id = ?)`).get(workspaceId, ...receiptIds, skuId, skuId).units;
      steps.push({
        label: 'Stock arrived',
        text: `${received} ${Number(received) === 1 ? 'unit was' : 'units were'} physically received against ${supply.po_number}.`,
        href: `/purchasing/orders/${supply.id}/detail#receipts`,
        linkText: 'Show the receipt',
        complete: true,
      });
    }
  }

  const reservationUpdates = db.prepare(`SELECT id, event_type, detail FROM sales_order_events
    WHERE workspace_id = ? AND sales_order_id = ?
      AND event_type IN ('ALLOCATED_FROM_STOCK','ALLOCATION_CHANGED')
    ORDER BY created_at, rowid`).all(workspaceId, order.id);
  if (reservationUpdates.length) {
    const update = reservationUpdates.at(-1);
    const detail = safeJson(update.detail);
    const linked = trace.details.some((entry) => entry.relation === 'HAS_EVENT'
      && entry.to.type === 'sales_order_event' && entry.to.id === update.id);
    const cleared = detail.status && detail.status !== 'BACKORDERED';
    steps.push({
      label: 'Reservation rechecked',
      text: linked
        ? cleared
          ? 'After stock changed, Foundry rechecked this order and recorded that it was no longer short.'
          : 'After stock changed, Foundry rechecked this order; some units were still waiting for stock.'
        : 'The reservation changed, but the update is not linked in the evidence graph.',
      href: orderHref,
      linkText: 'Show the order evidence',
      complete: Boolean(linked),
    });
  }

  const linkedShipments = new Set(trace.details
    .filter((entry) => entry.relation === 'FULFILLED_BY' && entry.from.type === 'sales_order'
      && entry.from.id === order.id && entry.to.type === 'shipment')
    .map((entry) => entry.to.id));
  for (const shipment of extras.shipments || []) {
    if (!['SHIPPED','DELIVERED'].includes(shipment.status)) continue;
    const linked = linkedShipments.has(shipment.id);
    const movementLinked = trace.details.some((entry) => entry.relation === 'CAUSED_MOVEMENT'
      && entry.from.type === 'shipment' && entry.from.id === shipment.id
      && entry.to.type === 'inventory_movement');
    const from = shipment.ship_from_location_name ? ` from ${shipment.ship_from_location_name}` : '';
    steps.push({
      label: shipment.wentBy || 'Goods left',
      text: linked && movementLinked
        ? `${shipment.shipment_number} moved ${shipment.units} ${shipment.units === 1 ? 'unit' : 'units'}${from} out of on-hand stock.`
        : linked
          ? `${shipment.shipment_number} is linked to this order, but its inventory movement is not linked.`
          : `${shipment.shipment_number} is recorded, but Foundry cannot prove its link to this order.`,
      href: `/fulfilment/${shipment.id}`,
      linkText: `Open ${shipment.shipment_number}`,
      complete: linked && movementLinked,
    });
  }

  const accounting = extras.accounting || {};
  const posted = accounting.status === 'POSTED' ? (accounting.outcome || {}) : null;
  const accountingLinked = accounting.journal_entry_id && trace.details.some((entry) =>
    entry.relation === 'POSTED_AS' && entry.to.type === 'journal_entry'
      && entry.to.id === accounting.journal_entry_id);
  if (posted) {
    const revenue = Number(posted.revenueMinor || 0);
    const cost = Number(posted.cogsMinor || 0);
    steps.push({
      label: 'Sale and product cost',
      text: accountingLinked
        ? `${displayMoney(revenue, currency)} sale − ${displayMoney(cost, currency)} product cost = ${displayMoney(revenue - cost, currency)} gross profit before other expenses.`
        : 'The sale is recorded, but its Accounting entry is not linked in the evidence graph.',
      href: accounting.journal_entry_id ? `/accounting/entries/${accounting.journal_entry_id}` : '/accounting',
      linkText: 'Show the exact sale and product cost',
      complete: Boolean(accountingLinked),
    });
  }

  const paid = Number(extras.money?.paidMinor || 0);
  const remaining = Number(extras.money?.remainingMinor || 0);
  const orderInvoiceIds = new Set(trace.details.filter((entry) => entry.relation === 'BILLED_BY'
    && entry.from.type === 'sales_order' && entry.from.id === order.id
    && entry.to.type === 'customer_invoice').map((entry) => entry.to.id));
  const linkedPaymentIds = new Set(trace.details.filter((entry) => entry.relation === 'PAID_BY'
    && ((entry.from.type === 'sales_order' && entry.from.id === order.id)
      || (entry.from.type === 'customer_invoice' && orderInvoiceIds.has(entry.from.id))))
    .map((entry) => entry.to.id));
  if (paid > 0) {
    const receipts = extras.customerReceipts || [];
    for (const receipt of receipts) {
      const linked = linkedPaymentIds.has(receipt.id);
      steps.push({
        label: 'Customer payment',
        text: linked
          ? `${receipt.payment_number} recorded ${displayMoney(receipt.order_amount_minor ?? receipt.amount_minor, currency)}${receipt.method ? ` by ${String(receipt.method).toLowerCase()}` : ''}.`
          : `${receipt.payment_number} recorded ${displayMoney(receipt.order_amount_minor ?? receipt.amount_minor, currency)}, but its link to this order is missing.`,
        href: `/orders/${order.id}/receipt/${receipt.id}`,
        linkText: `Open receipt ${receipt.payment_number}`,
        complete: linked,
      });
    }
    if (!receipts.length) {
      steps.push({
        label: 'Customer payment',
        text: `${displayMoney(paid, currency)} is recorded as paid, but no receipt record is available here.`,
        href: '/money', linkText: 'Show customer payments', complete: false,
      });
    }
    steps.push({
      label: remaining > 0 ? 'Balance remaining' : 'Paid in full',
      text: `The customer has paid ${displayMoney(paid, currency)} in total and now owes ${displayMoney(remaining, currency)}.`,
      href: `/orders/${order.id}/detail?open=money#money`,
      linkText: 'Show the order balance',
      complete: receipts.length > 0 && receipts.every((receipt) => linkedPaymentIds.has(receipt.id)),
    });
  } else if (remaining > 0) {
    steps.push({
      label: 'Payment still due',
      text: `No customer payment is recorded, so ${customer} still owes ${displayMoney(remaining, currency)}.`,
      href: `/orders/${order.id}/detail?open=money#money`,
      linkText: 'Take or record payment',
      complete: false,
    });
  }

  return {
    ...trace,
    ownerSummary: 'This is the recorded path from the customer order to stock, Accounting, and payment.',
    ownerSteps: steps,
  };
}

/**
 * Turn a purchase graph into the business sequence an owner recognises.
 * The graph still supplies the proof; receipt, bill, and payment read models
 * supply the quantities and money displayed beside those proven links.
 */
function purchaseOrderStory(db, workspaceId, order, extras = {}, options = {}) {
  const trace = forRecord(db, workspaceId, { type: 'purchase_order', id: order.id }, options);
  const currency = order.currency || 'USD';
  const orderHref = `/purchasing/orders/${order.id}`;
  const steps = [];
  const reason = order.sourceDetail?.explanation || order.sourceDetail?.reason;
  const decision = trace.details.find((entry) => entry.relation === 'DECIDED_BY'
    && entry.from.type === 'purchase_order' && entry.from.id === order.id
    && entry.to.type === 'work_item');
  const customerDemand = trace.details.filter((entry) => entry.relation === 'RESPONDS_TO'
    && entry.from.type === 'purchase_order' && entry.from.id === order.id
    && entry.to.type === 'sales_order');
  if (reason || order.source === 'foundry_recommendation') {
    const demandText = customerDemand.map((entry) => {
      const quantity = Number(entry.metadata?.waitingQuantity || 0);
      const product = entry.metadata?.displayName;
      return `${entry.to.title} is waiting for ${quantity} ${quantity === 1 ? 'unit' : 'units'}${product ? ` of ${product}` : ''}`;
    }).join('; ');
    const planText = order.sourceDetail?.reorderPoint !== undefined && order.sourceDetail?.target !== undefined
      ? ` Available inventory was below the reorder point of ${order.sourceDetail.reorderPoint}; the plan covers the customer demand and restores the target of ${order.sourceDetail.target}.`
      : '';
    steps.push({
      label: 'Why it was ordered',
      text: demandText
        ? `${demandText}.${planText}`
        : reason || 'Recorded replenishment evidence showed the stock was below its reorder point, so Foundry prepared this purchase.',
      href: decision?.to.href || null,
      linkText: 'Show the purchase decision',
      complete: Boolean(decision),
    });
  }

  const orderLinked = trace.details.some((entry) => entry.relation === 'HAS_PART'
    && entry.from.type === 'purchase_order' && entry.from.id === order.id);
  steps.push({
    label: 'Purchase order',
    text: `${order.poNumber} ordered ${Number(order.orderedUnits || 0)} ${Number(order.orderedUnits || 0) === 1 ? 'unit' : 'units'} from ${order.supplierName} for ${displayMoney(Math.round(Number(order.subtotal || 0) * 100), currency)}.`,
    href: orderHref,
    linkText: `Open ${order.poNumber}`,
    complete: orderLinked,
  });

  for (const receipt of extras.receipts || []) {
    const linked = trace.details.some((entry) => entry.relation === 'RECEIVED_AS'
      && entry.from.type === 'purchase_order' && entry.from.id === order.id
      && entry.to.type === 'purchase_receipt' && entry.to.id === receipt.id);
    const units = Number(receipt.totalUnits || receipt.units || 0);
    const destination = [...new Set((receipt.lines || []).map((line) => line.locationName).filter(Boolean))];
    steps.push({
      label: 'Inventory received',
      text: linked
        ? `${units} ${units === 1 ? 'unit was' : 'units were'} physically received and counted${destination.length ? ` at ${destination.join(' and ')}` : ''}${receipt.reference ? ` (${receipt.reference})` : ''}.`
        : `${units} ${units === 1 ? 'unit is' : 'units are'} recorded as received, but the evidence link to ${order.poNumber} is missing.`,
      href: `${orderHref}/detail#receipts`,
      linkText: 'Show the receipt',
      complete: linked,
    });
  }

  const bills = extras.supplierBills || [];
  for (const bill of bills) {
    // A supplier bill can be evidenced directly by the PO, or by one of the
    // physical receipts that belongs to it. Both are valid purchase proof;
    // requiring only PO -> bill incorrectly labels receipt-backed invoices as
    // unconnected even though the immutable graph proves the chain.
    const linked = trace.details.some((entry) => entry.relation === 'BILLED_BY'
      && entry.to.type === 'supplier_bill' && entry.to.id === bill.id
      && (entry.from.type === 'purchase_order' || entry.from.type === 'purchase_receipt'));
    steps.push({
      label: 'Supplier bill',
      text: linked
        ? `${bill.supplier_invoice_number || bill.bill_number} billed ${displayMoney(bill.total_minor, bill.currency || currency)} for this purchase.`
        : `${bill.supplier_invoice_number || bill.bill_number} is recorded, but its evidence link to ${order.poNumber} is missing.`,
      href: '/accounting#suppliers',
      linkText: 'Show the supplier bill',
      complete: linked,
    });
  }

  const summary = extras.billSummary || {};
  if (Number(summary.paidMinor || 0) > 0) {
    const billIds = new Set(bills.map((bill) => bill.id));
    const linked = trace.details.some((entry) => entry.relation === 'PAID_BY'
      && entry.from.type === 'supplier_bill' && billIds.has(entry.from.id)
      && entry.to.type === 'payment');
    steps.push({
      label: 'Supplier payment',
      text: linked
        ? `You paid ${displayMoney(summary.paidMinor, currency)} and now owe ${displayMoney(summary.owedMinor, currency)} on this purchase.`
        : `${displayMoney(summary.paidMinor, currency)} is recorded as paid, but its link to this purchase is missing.`,
      href: '/accounting#suppliers',
      linkText: 'Show the supplier payment',
      complete: linked,
    });
  } else if (bills.length && Number(summary.owedMinor || 0) > 0) {
    steps.push({
      label: 'Payment still due',
      text: `No supplier payment is recorded, so you still owe ${displayMoney(summary.owedMinor, currency)}.`,
      href: '/accounting#suppliers',
      linkText: 'Show what you owe',
      complete: false,
    });
  }

  return {
    ...trace,
    ownerSummary: 'This is the recorded path from the reason for the purchase to the inventory, supplier bill, and payment.',
    ownerSteps: steps,
  };
}

function explainWhy(db, workspaceId, start, options = {}) {
  const trace = forRecord(db, workspaceId, start, options);
  const rootRow = rowFor(db, workspaceId, start);
  const rootTitle = title(start.type, rootRow);
  const evidence = trace.details.filter((entry) => ['CREATED_FROM','EVIDENCED_BY','DECIDED_BY','RESPONDS_TO'].includes(entry.relation));
  const consequences = trace.details.filter((entry) => ['RECEIVED_AS','CAUSED_MOVEMENT','FULFILLED_BY','BILLED_BY','PAID_BY','POSTED_AS','VERIFIED_BY'].includes(entry.relation));
  const decisionFacts = evidence.flatMap((entry) => [...entry.from.facts, ...entry.to.facts]);
  const why = decisionFacts.length
    ? `${rootTitle} was based on recorded evidence: ${decisionFacts.slice(0, 12)
      .map((fact) => `${fact.label} ${fact.value}${fact.note ? ` (${fact.note})` : ''}`).join('; ')}.`
    : evidence.length
      ? evidence.map((entry) => `${entry.from.title} ${entry.phrase} ${entry.to.title}`).join('. ') + '.'
    : 'Foundry has no linked cause or decision evidence for this record. It will not guess one.';
  const outcome = consequences.length
    ? consequences.map((entry) => `${entry.from.title} ${entry.phrase} ${entry.to.title}`).join('. ') + '.'
    : 'No linked consequence has been recorded yet.';
  const contents = trace.details.filter((entry) => entry.relation === 'HAS_PART')
    .map((entry) => entry.to.title).join(', ');
  const happened = `${rootTitle}${contents ? ` includes ${contents}` : ''}. ${trace.summary}`;
  let next = trace.unknown[0] || 'No later action is required by the linked evidence.';
  if (start.type === 'purchase_order') {
    next = ({ DRAFT: 'The draft still needs approval before it is sent.', AWAITING_APPROVAL: 'The purchase order is waiting for approval.',
      APPROVED: 'The approved order has not yet been placed with the supplier.', ORDERED: 'The supplier delivery is still expected.',
      PARTIALLY_RECEIVED: 'Some units are still expected; receiving and supplier payment remain separate.',
      RECEIVED: 'The goods are received; any supplier bill and payment remain separate records.' })[rootRow?.status] || next;
  } else if (start.type === 'sales_order') {
    next = ({ DRAFT: 'The order still needs confirmation.', CONFIRMED: 'The committed goods are ready for fulfillment.',
      BACKORDERED: 'The shortage still needs a linked supply response.', PARTIALLY_FULFILLED: 'The remaining committed goods still need fulfillment.',
      FULFILLED: typesForNext(trace).has('payment') ? 'The customer payment is linked.' : 'The customer balance remains separate until a payment is recorded.' })[rootRow?.status] || next;
  }
  return { ...trace, rootTitle, happened, why, outcome, next,
    answer: `${happened} ${why} ${outcome}`, evidence, consequences };
}

function typesForNext(trace) {
  return new Set(trace.details.flatMap((entry) => [entry.from.type, entry.to.type]));
}

module.exports = { forRecord, salesOrderStory, purchaseOrderStory, explainWhy };
