'use strict';

const { ValidationError } = require('../domain/errors');
const { localDateKey } = require('../lib/calendar');

function period(input = {}, now = Date.now()) {
  const friday = new Date(now);
  friday.setDate(friday.getDate() - ((friday.getDay() + 2) % 7));
  const from = String(input.from || localDateKey(friday.getTime()));
  const to = String(input.to || localDateKey(now));
  for (const date of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw new ValidationError('Choose real calendar dates for the briefing.');
    }
  }
  if (from > to) throw new ValidationError('The briefing end date cannot precede its start date.');
  const since = new Date(`${from}T00:00:00`);
  const until = new Date(`${to}T00:00:00`);
  until.setDate(until.getDate() + 1);
  return { from, to, since: since.toISOString(), until: until.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

const SOURCES = [
  { name: 'Completed StockChief work', table: 'work_items', time: 'completed_at',
    condition: "execution_status = 'COMPLETED'", title: (row) => String(row.category).replaceAll('_', ' '),
    href: (row) => `/autopilot/work/${row.id}`,
    detail: (row) => row.verification_status === 'VERIFIED' ? 'Completed with recorded independent verification.' : 'Recorded completed but not independently verified.' },
  { name: 'Physical inventory ledger', table: 'movements', time: 'occurred_at',
    title: (row) => `${row.operation}: ${row.quantity_delta} ${Math.abs(Number(row.quantity_delta)) === 1 ? 'unit' : 'units'} at the recorded location`, href: () => '/activity',
    detail: () => 'Immutable ledger leg. Transfer legs are custody changes, not consumption. Related receipts and work outcomes are separate evidence, not additional units moved.' },
  { name: 'Purchase order history', table: 'purchase_order_events', time: 'created_at',
    title: (row) => row.event.replaceAll('_', ' ').toLowerCase(), href: (row) => `/purchasing/orders/${row.purchase_order_id}`,
    detail: () => 'Recorded purchasing event, not evidence of physical arrival or supplier payment.' },
  { name: 'Supplier receipt evidence', table: 'purchase_order_receipts', time: 'received_at',
    title: (row) => row.reference || 'Supplier delivery counted in', href: (row) => `/purchasing/orders/${row.purchase_order_id}/detail#receipts`,
    detail: () => 'Physical receipt record. Its stock movements may also appear in the inventory ledger.' },
  { name: 'Customer order history', table: 'sales_order_events', time: 'created_at',
    title: (row) => row.event_type.replaceAll('_', ' ').toLowerCase(), href: (row) => `/orders/${row.sales_order_id}/detail`,
    detail: () => 'Confirmation and reservation are not shipment or payment.' },
  { name: 'Internal transfer history', table: 'inventory_transfer_events', time: 'created_at',
    title: (row) => row.event_type.replaceAll('_', ' ').toLowerCase(), href: (row) => `/transfers/${row.transfer_id}`,
    detail: () => 'Preparation, approval, dispatch and accepted receipt are separate custody events.' },
  { name: 'Customer email outcomes', table: 'customer_communications', time: 'sent_at', condition: "status = 'SENT'",
    title: (row) => row.subject, href: (row) => row.sales_order_id ? `/orders/${row.sales_order_id}/detail#messages` : '/mail',
    detail: (row) => row.external_message_id ? 'Recorded sent with a provider message reference; this does not prove recipient receipt or reading.' : 'Recorded sent without a provider reference; delivery cannot be independently confirmed.' },
  { name: 'Shipping provider outcomes', table: 'shipping_label_transactions', time: 'completed_at', condition: "status = 'SUCCEEDED'",
    title: (row) => `${row.provider}: ${row.operation.toLowerCase()}`, href: (row) => `/fulfilment/${row.shipment_id}`,
    detail: (row) => row.provider_reference ? `Provider reference ${row.provider_reference}. A label does not prove physical delivery.` : 'No provider reference was retained; outcome cannot be independently confirmed.' },
  { name: 'Recorded payments', table: 'accounting_payments', time: 'payment_date', dateOnly: true, condition: "status = 'POSTED'",
    title: (row) => `${row.payment_number}: ${row.direction.replaceAll('_', ' ').toLowerCase()}`, href: () => '/accounting#cash',
    detail: () => 'Recorded payment evidence, not independent bank-settlement confirmation or a new money transfer by StockChief.' },
  { name: 'Posted accounting entries', table: 'accounting_journal_entries', time: 'posting_date', dateOnly: true, condition: "status = 'POSTED'",
    title: (row) => `Entry #${row.entry_number}: ${row.description}`, href: (row) => `/accounting/entries/${row.id}`,
    detail: () => 'Posted in StockChief, not evidence of export to QuickBooks or Xero.' },
];

function statement(source) {
  return `SELECT * FROM ${source.table} WHERE workspace_id = $1 AND ${source.time} >= $2
    AND ${source.time} ${source.dateOnly ? '<=' : '<'} $3${source.condition ? ` AND ${source.condition}` : ''}
    ORDER BY ${source.time}, id`;
}

function values(workspaceId, window, source) {
  return [workspaceId, source.dateOnly ? window.from : window.since, source.dateOnly ? window.to : window.until];
}

function project(source, rows) {
  return rows.map((row) => ({ domain: source.name, id: row.id,
    at: row[source.time] instanceof Date
      ? source.dateOnly ? localDateKey(row[source.time].getTime()) : row[source.time].toISOString()
      : row[source.time], dateOnly: Boolean(source.dateOnly),
    title: source.title(row), detail: source.detail(row), href: source.href(row),
    actorId: row.actor_user_id || row.received_by_user_id || row.created_by_user_id || null,
    verifiedWork: source.table === 'work_items' && row.verification_status === 'VERIFIED',
    amountMinor: row.amount_minor === undefined ? null : Number(row.amount_minor), currency: row.currency || null }));
}

function sqliteHistory(db, workspaceId, window) {
  return db.transaction(() => SOURCES.map((source) => {
    try {
      const query = statement(source).replace(/\$\d/g, '?');
      return { name: source.name, complete: true, events: project(source, db.prepare(query).all(...values(workspaceId, window, source))) };
    } catch { return { name: source.name, complete: false, events: [] }; }
  }))();
}

async function postgresHistory(database, workspaceId, window) {
  return database.transaction(async (client) => {
    const sources = [];
    for (const source of SOURCES) {
      await client.query('SAVEPOINT review_source');
      try {
        const result = await client.query(statement(source), values(workspaceId, window, source));
        sources.push({ name: source.name, complete: true, events: project(source, result.rows) });
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT review_source');
        sources.push({ name: source.name, complete: false, events: [] });
      }
      await client.query('RELEASE SAVEPOINT review_source');
    }
    return sources;
  }, { isolation: 'REPEATABLE READ', readOnly: true });
}

async function build(db, workspaceId, input = {}, options = {}) {
  const window = period(input, options.now || Date.now());
  const sources = options.database ? await postgresHistory(options.database, workspaceId, window) : sqliteHistory(db, workspaceId, window);
  const events = sources.flatMap((source) => source.events)
    .sort((first, second) => second.at.localeCompare(first.at) || first.id.localeCompare(second.id));
  const exceptions = require('./needs-you-inbox').inbox(db, workspaceId);
  const pending = db.prepare(`SELECT id, category, execution_status FROM work_items WHERE workspace_id = ?
    AND execution_status IN ('DETECTED','PLANNED','WAITING_FOR_APPROVAL','AUTHORIZED','EXECUTING','VERIFYING','FAILED','BLOCKED')
    ORDER BY created_at, id`).all(workspaceId);
  const coverageErrors = [...sources.filter((source) => !source.complete).map((source) => source.name), ...(exceptions.coverageErrors || [])];
  return { window, events, sources: sources.map((source) => ({ name: source.name, complete: source.complete, count: source.events.length })),
    pending, exceptions, coverageErrors, generatedAt: new Date(options.now || Date.now()).toISOString(),
    sourceNotice: options.database ? 'PostgreSQL migration verification history. Current exceptions and pending work still come from the operational SQLite store; this is not a completed business-storage migration.' : 'History and current exceptions are read from the business database. No action is executed by this report.' };
}

function briefingRequest(message) {
  const text = String(message || '').trim();
  if (!/\b(?:monday(?:[- ]morning)?|operations?|business|weekly)\s+brief(?:ing)?\b|\breview\s+(?:the\s+)?(?:entire\s+)?(?:business|operation)\b/i.test(text)
    || !/\bsince\s+(?:last\s+)?friday\b|\bmonday(?:[- ]morning)?\b/i.test(text)) return null;
  return { actionsRequested: /\b(?:handle|execute|send|pay|purchase|approve|prepare|move|order|reorder)\b/i.test(text) };
}

module.exports = { SOURCES, period, sqliteHistory, postgresHistory, build, briefingRequest };
