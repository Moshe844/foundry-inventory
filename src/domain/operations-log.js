'use strict';

const activityService = require('./activity-service');

/**
 * What actually happened to the operation, as a business would tell it.
 *
 * Activity had become two problems at once. The link in the sidebar went to
 * Foundry's own work log, so the page a customer opened looking for their
 * trading history was fifty near-identical lines of "Scheduled inventory check
 * — 6 stock positions checked". And the real ledger underneath it held only
 * movements, so the things a business thinks of as events — an order placed, a
 * delivery booked in, a discrepancy opened and settled — were not on any
 * timeline at all.
 *
 * This is one stream of operational events, drawn from the records that already
 * exist. Nothing is invented and nothing is deleted: every entry points at the
 * record it came from, and the immutable movement ledger is still the source of
 * truth beneath it.
 *
 * Events carry a stream so the page can separate what a person did to their
 * stock from what Foundry did about it. They are related but they are not the
 * same story, and telling them as one is what made this page unreadable:
 *
 *   inventory  — stock moved, arrived, left, or was corrected
 *   purchasing — orders placed, received, cancelled
 *   foundry    — work Foundry prepared or carried out
 *   exception  — differences opened and settled
 *   system     — routine checks that produced nothing, kept for the audit trail
 */

const STREAMS = ['inventory', 'sales', 'purchasing', 'foundry', 'exception', 'system'];

const STREAM_LABEL = {
  all: 'All activity',
  inventory: 'Inventory',
  sales: 'Sales orders',
  purchasing: 'Purchasing',
  foundry: 'Foundry actions',
  exception: 'Exceptions',
  system: 'System checks',
};

const iso = (value) => (value ? String(value) : '');

// The business timeline should read like sentences, not like a form. The count
// is known at every one of these call sites, so the word can simply be right.
const units = (n) => `${n} ${Number(n) === 1 ? 'unit' : 'units'}`;

/*
 * Who a movement should be credited to.
 *
 * A sale rung up on a connected till is recorded against the workspace owner,
 * because the ledger requires a real actor and the connector acts as them. On
 * this page that read "Issued 5 × Copper Elbow 15mm … Ruth Alvarez" for a sale
 * Ruth had nothing to do with — she was not in the shop. Activity answers "who
 * did it", and naming a person who did not is worse than naming nobody.
 *
 * The ingestion writes a reference namespaced "external:" and a note saying
 * which connection it came from, so the till can be named instead.
 */
function movementActor(group) {
  if (!/^external:/i.test(String(group.reference || ''))) return group.actorName;
  const named = /^Source:\s*([^;.]+)/i.exec(String(group.notes || ''));
  return named ? named[1].trim() : 'A connected system';
}

/** Stock that moved, in the words the ledger already produces. */
function inventoryEvents(db, workspaceId, filters) {
  const { groups } = activityService.listActivity(db, workspaceId, { ...filters, limit: 500, offset: 0 });
  return groups.map((group) => ({
    id: `movement:${group.groupId}`,
    stream: 'inventory',
    at: group.occurredAt,
    kind: group.operation,
    title: group.sentence || group.displayName,
    subject: group.displayName,
    who: movementActor(group),
    detail: [
      group.reasonLabel,
      // "external:" is the namespace the ingestion writes, not something the
      // reader needs, and the same identifier followed it in the note.
      group.reference ? `Ref ${String(group.reference).replace(/^external:/i, '')}` : '',
      group.notes || '',
    ].filter(Boolean).join(' · '),
    href: group.itemId ? `/inventory/${group.itemId}` : '/activity',
    group,
  }));
}

/** Orders placed, received and cancelled. */
function purchasingEvents(db, workspaceId) {
  const events = [];
  const orders = db
    .prepare(
      `SELECT po.id, po.po_number, po.status, po.created_at, po.ordered_at, po.cancelled_at,
              po.completed_at, po.cancel_reason, s.name AS supplier_name,
              u.name AS created_by, ua.name AS approved_by,
              COALESCE((SELECT SUM(pol.quantity_units) FROM purchase_order_lines pol
                         WHERE pol.purchase_order_id = po.id), 0) AS units
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         LEFT JOIN users u ON u.id = po.created_by_user_id
         LEFT JOIN users ua ON ua.id = po.approved_by_user_id
        WHERE po.workspace_id = ?
        ORDER BY po.created_at DESC
        LIMIT 200`
    )
    .all(workspaceId);

  for (const order of orders) {
    const supplier = order.supplier_name || 'a supplier';
    events.push({
      id: `po-created:${order.id}`,
      stream: 'purchasing',
      at: iso(order.created_at),
      kind: 'po_drafted',
      title: `${order.po_number} drafted for ${supplier}`,
      subject: order.po_number,
      who: order.created_by || 'Foundry',
      detail: `${units(order.units)}. Nothing sent to the supplier yet.`,
      href: `/purchasing/orders/${order.id}`,
    });
    if (order.ordered_at) {
      events.push({
        id: `po-ordered:${order.id}`,
        stream: 'purchasing',
        at: iso(order.ordered_at),
        kind: 'po_placed',
        title: `${order.po_number} placed with ${supplier}`,
        subject: order.po_number,
        who: order.approved_by || 'Foundry',
        detail: `${units(order.units)} now on order.`,
        href: `/purchasing/orders/${order.id}`,
      });
    }
    if (order.cancelled_at) {
      events.push({
        id: `po-cancelled:${order.id}`,
        stream: 'purchasing',
        at: iso(order.cancelled_at),
        kind: 'po_cancelled',
        title: `${order.po_number} cancelled`,
        subject: order.po_number,
        who: 'You',
        detail: order.cancel_reason || '',
        href: `/purchasing/orders/${order.id}`,
      });
    }
  }

  // Receipts are their own event: a delivery arriving is a thing that happened,
  // and a partial one is worth seeing as distinct from a complete one.
  for (const receipt of db
    .prepare(
      `SELECT r.id, r.purchase_order_id, r.received_at, r.reference, r.result,
              r.over_receipt_approved, po.po_number, s.name AS supplier_name, u.name AS received_by
         FROM purchase_order_receipts r
         JOIN purchase_orders po ON po.id = r.purchase_order_id
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         LEFT JOIN users u ON u.id = r.received_by_user_id
        WHERE r.workspace_id = ?
        ORDER BY r.received_at DESC
        LIMIT 200`
    )
    .all(workspaceId)) {
    let result = {};
    try { result = JSON.parse(receipt.result || '{}'); } catch { result = {}; }
    const complete = result.status === 'RECEIVED';
    events.push({
      id: `po-receipt:${receipt.id}`,
      stream: 'purchasing',
      at: iso(receipt.received_at),
      kind: complete ? 'po_received' : 'po_part_received',
      title: `${receipt.po_number} ${complete ? 'received in full' : 'partly received'}`
        + (receipt.supplier_name ? ` from ${receipt.supplier_name}` : ''),
      subject: receipt.po_number,
      who: receipt.received_by || 'You',
      detail: [
        `${units(result.unitsReceived || 0)} booked in`,
        result.outstandingAfter ? `${result.outstandingAfter} still outstanding` : '',
        receipt.over_receipt_approved ? 'more than ordered, accepted' : '',
        receipt.reference ? `Ref ${receipt.reference}` : '',
      ].filter(Boolean).join(' · '),
      href: `/purchasing/orders/${receipt.purchase_order_id}`,
    });
  }

  // Supplier correspondence belongs to the purchase order story. The detailed
  // extraction evidence remains in the PO audit, while Activity says only the
  // business consequence: what the supplier confirmed, changed, or received.
  for (const document of db.prepare(`SELECT d.id, d.document_type, d.status, d.processed_at,
      d.purchase_order_id, d.discrepancies, po.po_number, s.name AS supplier_name
    FROM supplier_documents d
    LEFT JOIN purchase_orders po ON po.id = d.purchase_order_id
    LEFT JOIN suppliers s ON s.id = d.supplier_id
    WHERE d.workspace_id = ? AND d.status IN ('MATCHED','NEEDS_REVIEW')
    ORDER BY d.processed_at DESC LIMIT 200`).all(workspaceId)) {
    let discrepancies = [];
    try { discrepancies = JSON.parse(document.discrepancies || '[]'); } catch { discrepancies = []; }
    const label = String(document.document_type || 'document').replaceAll('_', ' ');
    const matched = document.status === 'MATCHED' && !discrepancies.length;
    events.push({
      id: `supplier-document:${document.id}`,
      stream: 'purchasing',
      at: iso(document.processed_at),
      kind: `supplier_${document.document_type}`,
      title: matched
        ? `${document.supplier_name || 'Supplier'} ${label} matched${document.po_number ? ` ${document.po_number}` : ''}`
        : `${document.supplier_name || 'Supplier'} ${label} needs review`,
      subject: document.po_number || document.supplier_name || 'Supplier document',
      who: 'Foundry',
      detail: matched
        ? 'Foundry compared the supplier evidence with the purchase order; no action is needed.'
        : `${discrepancies.length || 1} difference${discrepancies.length === 1 ? '' : 's'} found. Nothing unsafe was applied.`,
      href: document.purchase_order_id ? `/purchasing/orders/${document.purchase_order_id}` : '/needs-you',
    });
  }

  for (const message of db.prepare(`SELECT sc.id, sc.message_kind, sc.recipient, sc.sent_at,
      sc.purchase_order_id, po.po_number, s.name AS supplier_name
    FROM supplier_communications sc
    LEFT JOIN purchase_orders po ON po.id = sc.purchase_order_id
    LEFT JOIN suppliers s ON s.id = sc.supplier_id
    WHERE sc.workspace_id = ? AND sc.status = 'SENT'
    ORDER BY sc.sent_at DESC LIMIT 200`).all(workspaceId)) {
    const followup = message.message_kind === 'follow_up';
    events.push({
      id: `supplier-message:${message.id}`,
      stream: 'purchasing',
      at: iso(message.sent_at),
      kind: followup ? 'supplier_follow_up_sent' : 'supplier_order_sent',
      title: `${followup ? 'Follow-up' : message.po_number || 'Purchase order'} sent to ${message.supplier_name || message.recipient || 'supplier'}`,
      subject: message.po_number || message.supplier_name || 'Supplier communication',
      who: 'Foundry',
      detail: message.recipient ? `Sent to ${message.recipient}.` : '',
      href: message.purchase_order_id ? `/purchasing/orders/${message.purchase_order_id}` : '/purchasing',
    });
  }

  return events;
}

/** Customer demand, commitments and fulfillment. */
function salesEvents(db, workspaceId) {
  return db.prepare(`SELECT soe.id, soe.event_type, soe.detail, soe.created_at,
      so.id AS order_id, so.order_number, c.name AS customer_name, u.name AS actor_name
    FROM sales_order_events soe JOIN sales_orders so ON so.id = soe.sales_order_id
    JOIN customers c ON c.id = so.customer_id LEFT JOIN users u ON u.id = soe.actor_user_id
    WHERE soe.workspace_id = ? ORDER BY soe.created_at DESC LIMIT 300`).all(workspaceId).map((row) => {
      let detail = {}; try { detail = JSON.parse(row.detail || '{}'); } catch { detail = {}; }
      const titles = {
        CREATED: `${row.order_number} drafted for ${row.customer_name}`,
        CONFIRMED: `${row.order_number} confirmed and stock allocated`,
        CHANGED: `${row.order_number} changed and allocation recalculated`,
        PARTIALLY_FULFILLED: `${row.order_number} partly fulfilled`,
        FULFILLED: `${row.order_number} fulfilled`,
        CANCELLED: `${row.order_number} cancelled and commitments released`,
      };
      const quantities = detail.allocations
        ? `${detail.allocations.reduce((n, line) => n + Number(line.allocated || 0), 0)} allocated · ${detail.allocations.reduce((n, line) => n + Number(line.backordered || 0), 0)} backordered`
        : detail.fulfilled ? `${detail.fulfilled.reduce((n, line) => n + Number(line.quantity || 0), 0)} fulfilled`
          : detail.released !== undefined ? `${detail.released} commitment(s) released` : '';
      return { id: `sales:${row.id}`, stream: 'sales', at: row.created_at,
        kind: row.event_type.toLowerCase(), title: titles[row.event_type] || `${row.order_number} updated`,
        subject: row.order_number, who: row.actor_name || 'Foundry', detail: quantities,
        href: `/sales/orders/${row.order_id}` };
    });
}

/** Differences opened, and how they were settled. */
function exceptionEvents(db, workspaceId) {
  const events = [];
  for (const row of db
    .prepare(
      `SELECT id, affected_entities, observed_difference, unexplained_amount, status,
              recommended_next_step, created_at, resolved_at
         FROM inventory_investigations
        WHERE workspace_id = ?
        ORDER BY created_at DESC
        LIMIT 200`
    )
    .all(workspaceId)) {
    let entities = {};
    let observed = {};
    try { entities = JSON.parse(row.affected_entities || '{}'); } catch { entities = {}; }
    try { observed = JSON.parse(row.observed_difference || '{}'); } catch { observed = {}; }
    const name = entities.displayName || 'Stock';

    events.push({
      id: `investigation:${row.id}`,
      stream: 'exception',
      at: iso(row.created_at),
      kind: 'investigation_opened',
      title: `${name} did not match the records`,
      subject: name,
      who: 'Foundry',
      detail: observed.statedAs
        ? `You said: “${observed.statedAs}”`
        : (row.recommended_next_step || ''),
      href: `/investigations/${row.id}`,
    });
    if (row.resolved_at) {
      events.push({
        id: `investigation-resolved:${row.id}`,
        stream: 'exception',
        at: iso(row.resolved_at),
        kind: 'investigation_resolved',
        title: `${name} difference settled`,
        subject: name,
        who: 'You',
        detail: row.status ? String(row.status).toLowerCase().replace(/_/g, ' ') : '',
        href: `/investigations/${row.id}`,
      });
    }
  }
  return events;
}

/** Work Foundry prepared or carried out — not what it merely looked at. */
function foundryEvents(db, workspaceId) {
  return db
    .prepare(
      `SELECT wi.id, wi.category, wi.execution_status, wi.affected_entities, wi.outcome,
              wi.purchase_order_id, wi.completed_at, wi.created_at, wi.approved_at
         FROM work_items wi
        WHERE wi.workspace_id = ? AND wi.execution_status IN ('COMPLETED', 'FAILED')
        ORDER BY COALESCE(wi.completed_at, wi.created_at) DESC
        LIMIT 200`
    )
    .all(workspaceId)
    .map((row) => {
      let entities = {};
      let outcome = {};
      try { entities = JSON.parse(row.affected_entities || '{}'); } catch { entities = {}; }
      try { outcome = JSON.parse(row.outcome || '{}'); } catch { outcome = {}; }
      const named = entities.displayName || entities.supplierName || 'inventory';
      const failed = row.execution_status === 'FAILED';
      return {
        id: `work:${row.id}`,
        stream: 'foundry',
        at: iso(row.completed_at || row.created_at),
        kind: row.category,
        title: failed
          ? `Foundry could not finish work on ${named}`
          : `Foundry ${outcome.nothingToDo ? 'reviewed' : 'handled'} ${named}`,
        subject: named,
        who: row.approved_at ? 'You approved it' : 'Foundry',
        detail: outcome.because || outcome.poNumber || '',
        href: `/autopilot/work/${row.id}`,
      };
    });
}

/**
 * Routine checks, as one line rather than fifty.
 *
 * A check that found nothing is evidence that Foundry looked, which is worth
 * keeping and worth being able to audit. It is not worth fifty rows above the
 * sale somebody came here to find, so it is counted rather than listed, and
 * the individual runs stay one click away.
 */
function systemChecks(db, workspaceId) {
  const rows = db
    .prepare(
      `SELECT id, trigger, items_planned, finished_at
         FROM work_plans
        WHERE workspace_id = ? AND finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 500`
    )
    .all(workspaceId);

  const quiet = rows.filter((row) => Number(row.items_planned || 0) === 0);
  if (!quiet.length) return { events: [], quietCount: 0 };

  return {
    quietCount: quiet.length,
    events: [{
      id: 'system:quiet-checks',
      stream: 'system',
      at: iso(quiet[0].finished_at),
      kind: 'routine_checks',
      title: `${quiet.length} routine inventory check${quiet.length === 1 ? '' : 's'} — no action needed`,
      subject: 'Foundry',
      who: 'Foundry',
      detail: 'Stock was checked against your levels and nothing needed doing. Kept for the audit trail.',
      href: '/autopilot/history',
      collapsed: quiet.length,
    }],
  };
}

/**
 * One timeline, newest first.
 *
 * @param {object} options
 *   stream — one of STREAMS, or 'all'. 'all' deliberately excludes the routine
 *            checks: they are the thing that made this page unreadable, and
 *            somebody who wants them can ask for them.
 */
function timeline(db, workspaceId, { stream = 'all', query = '', limit = 50, filters = {} } = {}) {
  const checks = systemChecks(db, workspaceId);

  // A filter that only makes sense for stock narrows the whole page to stock.
  // Filtering to issues and still being shown purchase orders would be the
  // page ignoring what was asked of it.
  const stockOnly = Boolean(filters.operation || filters.actorId || filters.itemId);
  const everything = [
    ...inventoryEvents(db, workspaceId, filters),
    ...(stockOnly ? [] : salesEvents(db, workspaceId)),
    ...(stockOnly ? [] : purchasingEvents(db, workspaceId)),
    ...(stockOnly ? [] : foundryEvents(db, workspaceId)),
    ...(stockOnly ? [] : exceptionEvents(db, workspaceId)),
  ];

  // Routine checks are not part of "what happened to my operation", so they do
  // not appear in it at all — not even as one collapsed row, which still put
  // them above the sale somebody came here to find. The page says how many
  // there were and links to them; asking for them shows them.
  const wanted = stream === 'system'
    ? checks.events
    : stream === 'all'
      ? everything
      : everything.filter((event) => event.stream === stream);

  const needle = String(query || '').trim().toLowerCase();
  const matched = needle
    ? wanted.filter((event) => `${event.title} ${event.subject} ${event.detail} ${event.who}`
      .toLowerCase().includes(needle))
    : wanted;

  const events = matched
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);

  const counts = { all: everything.length, system: checks.quietCount };
  for (const name of STREAMS) {
    if (name === 'system') continue;
    counts[name] = everything.filter((event) => event.stream === name).length;
  }

  return { events, counts, quietChecks: checks.quietCount, stream, query };
}

module.exports = { timeline, STREAMS, STREAM_LABEL };
