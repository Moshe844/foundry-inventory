'use strict';

/**
 * Domain-owned repair adapters.
 *
 * An adapter may inspect records, but execution must go through the owning
 * domain service. This file intentionally contains no UPDATE/DELETE statement
 * against inventory, order, connection or accounting truth.
 */
const permissions = require('../actions/permissions');

const json = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

function duplicateEvent() {
  return {
    id: 'duplicate-event', version: 1, requiredPermissions: [permissions.VIEW],
    diagnose({ db, repairCase }) {
      const ref = repairCase.affectedRecords;
      const event = ref.eventId
        ? require('../manager/events').get(db, repairCase.workspaceId, ref.eventId)
        : db.prepare('SELECT * FROM domain_events WHERE workspace_id = ? AND idempotency_key = ?')
          .get(repairCase.workspaceId, ref.idempotencyKey);
      const hydrated = event && event.event_type
        ? require('../manager/events').hydrate(event) : event;
      return {
        confidence: hydrated ? 'high' : 'low', materiality: 'low', requiresApproval: false,
        evidence: hydrated ? [{ source: 'domain_event', id: hydrated.id,
          idempotencyKey: hydrated.idempotencyKey, attempts: hydrated.attempts }] : [],
        timeline: hydrated ? [{ at: hydrated.createdAt, event: 'event accepted' },
          ...(hydrated.processedAt ? [{ at: hydrated.processedAt, event: 'event processed' }] : [])] : [],
        proposedRepair: { eventId: hydrated && hydrated.id, action: 'verify_single_effect' },
      };
    },
    simulate({ repairCase }) {
      return { summary: 'Keep the one accepted event and create no second business action.',
        before: repairCase.evidence, after: { acceptedEvents: 1 },
        consequences: ['No inventory, accounting, order or external record is changed.'], externalEffects: [] };
    },
    execute() { return { action: 'no_op', reason: 'The event contract already absorbed the replay.' }; },
    verify({ db, repairCase }) {
      const eventId = repairCase.proposedRepair.eventId || repairCase.affectedRecords.eventId;
      const row = db.prepare('SELECT idempotency_key FROM domain_events WHERE id = ? AND workspace_id = ?')
        .get(eventId, repairCase.workspaceId);
      if (!row) return { passed: false, checks: [{ name: 'Accepted event exists', passed: false }] };
      const copies = db.prepare('SELECT COUNT(*) AS n FROM domain_events WHERE workspace_id = ? AND idempotency_key = ?')
        .get(repairCase.workspaceId, row.idempotency_key).n;
      return { passed: copies === 1, checks: [{ name: 'Exactly one durable event', passed: copies === 1,
        observed: copies }] };
    },
  };
}

function stuckJob() {
  return {
    id: 'stuck-job', version: 1, requiredPermissions: [permissions.OPERATE],
    diagnose({ db, repairCase }) {
      const id = repairCase.affectedRecords.workItemId;
      const item = id && db.prepare('SELECT * FROM work_items WHERE id = ? AND workspace_id = ?')
        .get(id, repairCase.workspaceId);
      const execution = id && db.prepare(`SELECT * FROM action_executions
        WHERE workspace_id = ? AND idempotency_key = ? LIMIT 1`)
        .get(repairCase.workspaceId, `autopilot:${id}`);
      const history = id ? db.prepare(`SELECT event, detail, created_at FROM work_item_events
        WHERE workspace_id = ? AND work_item_id = ? ORDER BY created_at, rowid`)
        .all(repairCase.workspaceId, id).map((row) => ({ at: row.created_at, event: row.event,
          detail: json(row.detail, {}) })) : [];
      const provenSucceeded = Boolean(execution && execution.status === 'SUCCEEDED');
      return { confidence: item ? 'high' : 'low', materiality: provenSucceeded ? 'low' : 'medium',
        requiresApproval: !provenSucceeded,
        evidence: item ? [{ source: 'work_item', id, executionStatus: item.execution_status,
          verificationStatus: item.verification_status }, ...(execution ? [{ source: 'action_execution',
            id: execution.id, status: execution.status }] : [])] : [], timeline: history,
        proposedRepair: { workItemId: id, action: 'reconcile_interrupted_work' } };
    },
    simulate({ db, repairCase }) {
      const item = db.prepare('SELECT execution_status, verification_status FROM work_items WHERE id = ? AND workspace_id = ?')
        .get(repairCase.affectedRecords.workItemId, repairCase.workspaceId);
      return { summary: 'Reconcile the interrupted job against its idempotent execution record before deciding whether any work remains.',
        before: item || {}, after: { outcome: 'completed only if an existing successful effect is verified; otherwise blocked for review' },
        consequences: ['A successful prior effect is never repeated.', 'Work with no proven effect remains blocked.'], externalEffects: [] };
    },
    execute({ db, ctx, membership, repairCase }) {
      const recovered = require('../autopilot/runner').recover(db, ctx, membership);
      return { recovered: recovered.map((entry) => entry.id), workItemId: repairCase.affectedRecords.workItemId };
    },
    verify({ db, repairCase }) {
      const item = db.prepare('SELECT execution_status, verification_status FROM work_items WHERE id = ? AND workspace_id = ?')
        .get(repairCase.affectedRecords.workItemId, repairCase.workspaceId);
      const passed = Boolean(item && item.execution_status === 'COMPLETED' && item.verification_status === 'VERIFIED');
      return { passed, checks: [{ name: 'Interrupted work has one verified outcome', passed,
        observed: item || null }], needsHuman: Boolean(item && item.execution_status === 'BLOCKED') };
    },
  };
}

function wrongMapping() {
  return {
    id: 'wrong-mapping', version: 1, requiredPermissions: [permissions.ADMIN],
    diagnose({ db, repairCase }) {
      const r = repairCase.affectedRecords;
      const current = r.connectorId && r.entityType && r.externalId
        ? require('../connections/service').mapping(db, repairCase.workspaceId, r.connectorId, r.entityType, r.externalId)
        : null;
      return { confidence: r.foundryRecordId ? 'high' : 'low', materiality: 'high', requiresApproval: true,
        evidence: [{ source: 'connection_mapping', connectorId: r.connectorId,
          entityType: r.entityType, externalId: r.externalId,
          currentFoundryRecordId: current && current.foundry_record_id }],
        timeline: current ? [{ at: current.updated_at || current.created_at, event: 'current mapping recorded' }] : [],
        proposedRepair: { connectorId: r.connectorId, entityType: r.entityType,
          externalId: r.externalId, foundryRecordId: r.foundryRecordId } };
    },
    simulate({ repairCase }) {
      const p = repairCase.proposedRepair;
      const recordLabel = p.entityType === 'sku' ? 'product/SKU' : (p.entityType || 'record');
      return { summary: `Future imported activity for ${p.externalId || 'this external record'} will use the approved Foundry ${recordLabel}.`,
        before: repairCase.evidence[0] || {}, after: { foundryRecordId: p.foundryRecordId },
        consequences: ['Historical business records are not rewritten.', 'Future imported activity uses the corrected mapping.'],
        externalEffects: [] };
    },
    execute({ db, ctx, repairCase }) {
      const p = repairCase.proposedRepair;
      const mapping = require('../connections/service').mapExternal(db, ctx, p.connectorId, p);
      return { mappingId: mapping.id, foundryRecordId: mapping.foundry_record_id };
    },
    verify({ db, repairCase }) {
      const p = repairCase.proposedRepair;
      const mapping = require('../connections/service').mapping(db, repairCase.workspaceId,
        p.connectorId, p.entityType, p.externalId);
      const passed = Boolean(mapping && mapping.foundry_record_id === p.foundryRecordId);
      return { passed, checks: [{ name: 'Future external activity resolves to the approved record',
        passed, observed: mapping && mapping.foundry_record_id }] };
    },
  };
}

function overpayment() {
  return {
    id: 'overpayment', version: 1, requiredPermissions: [permissions.RECORD_PAYMENTS],
    diagnose({ db, repairCase }) {
      const payment = require('../accounting/payments').requirePayment(db, repairCase.workspaceId,
        repairCase.affectedRecords.paymentId);
      return { confidence: 'high', materiality: 'high', requiresApproval: true,
        evidence: [{ source: 'payment', id: payment.id, paymentNumber: payment.payment_number,
          amountMinor: payment.amount_minor, status: payment.status, allocations: payment.allocations }],
        timeline: [{ at: payment.created_at, event: 'payment recorded' }],
        proposedRepair: { paymentId: payment.id,
          allocations: repairCase.affectedRecords.correctAllocations || [],
          action: 'reverse_and_rerecord_payment' } };
    },
    simulate({ repairCase }) {
      const payment = repairCase.evidence[0] || {};
      const allocated = (repairCase.proposedRepair.allocations || [])
        .reduce((sum, row) => sum + Number(row.amountMinor || 0), 0);
      return { summary: 'Reverse the incorrect payment posting, then re-record the same cash evidence with corrected allocations.',
        before: payment, after: { amountMinor: payment.amountMinor, allocatedMinor: allocated,
          unappliedMinor: Number(payment.amountMinor || 0) - allocated },
        consequences: ['The original journal is reversed, never edited.', 'Any genuine excess remains a customer deposit or supplier advance.'],
        externalEffects: [] };
    },
    execute({ db, ctx, membership, repairCase }) {
      const service = require('../accounting/payments');
      const original = service.requirePayment(db, repairCase.workspaceId, repairCase.proposedRepair.paymentId);
      if (original.status !== 'VOID') service.voidPayment(db, ctx, membership, original.id,
        { reason: `Repair ${repairCase.id}: correct payment allocation` });
      const allocations = (repairCase.proposedRepair.allocations || []).map((row) => ({
        invoiceId: row.invoiceId, billId: row.billId, amountMinor: Number(row.amountMinor),
      }));
      const replacement = service.record(db, ctx, membership, {
        direction: original.direction, customerId: original.customer_id, supplierId: original.supplier_id,
        amountMinor: Number(original.amount_minor), paymentDate: original.payment_date,
        cashAccountId: original.cash_account_id, method: original.method,
        reference: original.reference, salesOrderId: original.sales_order_id,
        allocations, sourceKey: `repair:${repairCase.id}`,
      });
      return { reversedPaymentId: original.id, replacementPaymentId: replacement.payment.id,
        replayed: replacement.replayed };
    },
    verify({ db, repairCase }) {
      const original = require('../accounting/payments').requirePayment(db, repairCase.workspaceId,
        repairCase.proposedRepair.paymentId);
      const replacement = db.prepare(`SELECT * FROM accounting_payments
        WHERE workspace_id = ? AND source_key = ?`).get(repairCase.workspaceId, `repair:${repairCase.id}`);
      const journalBalanced = replacement ? db.prepare(`SELECT
        SUM(debit_minor) AS debits, SUM(credit_minor) AS credits
        FROM accounting_journal_lines WHERE entry_id = ?`).get(replacement.journal_entry_id) : null;
      const passed = Boolean(original.status === 'VOID' && replacement && replacement.status === 'POSTED'
        && Number(journalBalanced.debits) === Number(journalBalanced.credits));
      return { passed, checks: [
        { name: 'Original payment is reversed immutably', passed: original.status === 'VOID' },
        { name: 'Corrected payment is posted once', passed: Boolean(replacement) },
        { name: 'Corrected journal balances', passed: Boolean(journalBalanced)
          && Number(journalBalanced.debits) === Number(journalBalanced.credits) },
      ] };
    },
  };
}

function inventoryAccountingMismatch() {
  return {
    id: 'inventory-accounting-mismatch', version: 1,
    requiredPermissions: [permissions.MANAGE_ACCOUNTING],
    diagnose({ db, repairCase }) {
      const eventId = repairCase.affectedRecords.eventId;
      const inbox = eventId && require('../accounting/operational-adapter')
        .inbox(db, repairCase.workspaceId, eventId);
      const reconciliation = require('../accounting/reports').inventoryReconciliation(db, repairCase.workspaceId);
      return { confidence: inbox ? 'high' : 'medium', materiality: 'high', requiresApproval: true,
        evidence: [{ source: 'inventory_reconciliation', ...reconciliation },
          ...(inbox ? [{ source: 'accounting_event_inbox', id: inbox.id, status: inbox.status,
            eventId }] : [])],
        timeline: inbox ? [{ at: inbox.created_at, event: 'operational accounting event captured' },
          ...(inbox.processed_at ? [{ at: inbox.processed_at, event: `accounting ${inbox.status.toLowerCase()}` }] : [])] : [],
        proposedRepair: { eventId: eventId || null, action: eventId ? 'retry_domain_accounting_adapter' : null,
          blockedReason: eventId ? null : 'No exact failed operational event proves which correction belongs in the books.' } };
    },
    simulate({ repairCase }) {
      const blocked = repairCase.proposedRepair.blockedReason;
      return { summary: blocked || 'Replay the exact failed operational event through Accounting, using its original idempotency key.',
        before: repairCase.evidence[0] || {}, after: blocked ? { unknown: true } : { inventoryAndLedgerReconciled: true },
        consequences: blocked
          ? ['No automatic correction will run until an exact operational source is identified.']
          : ['Accounting may post one immutable journal entry.', 'Inventory quantities are not changed.'],
        externalEffects: [], executable: !blocked };
    },
    execute({ db, repairCase }) {
      if (!repairCase.proposedRepair.eventId) throw new Error(repairCase.proposedRepair.blockedReason);
      const result = require('../accounting/operational-adapter').retry(db, repairCase.workspaceId,
        repairCase.proposedRepair.eventId);
      return { accountingInboxId: result.id, status: result.status, outcome: result.outcome };
    },
    verify({ db, repairCase }) {
      const eventId = repairCase.proposedRepair.eventId;
      const inbox = eventId && require('../accounting/operational-adapter').inbox(db, repairCase.workspaceId, eventId);
      const reconciliation = require('../accounting/reports').inventoryReconciliation(db, repairCase.workspaceId);
      const passed = Boolean(inbox && inbox.status === 'POSTED' && reconciliation.reconciled);
      return { passed, checks: [
        { name: 'Operational event posted through Accounting', passed: Boolean(inbox && inbox.status === 'POSTED'),
          observed: inbox && inbox.status },
        { name: 'Inventory value agrees with the ledger', passed: reconciliation.reconciled,
          observed: reconciliation.differenceMinor },
      ] };
    },
  };
}

const adapters = new Map([
  ['duplicate_event', duplicateEvent()],
  ['stuck_job', stuckJob()],
  ['wrong_mapping', wrongMapping()],
  ['overpayment', overpayment()],
  ['inventory_accounting_mismatch', inventoryAccountingMismatch()],
]);

function get(kind) { return adapters.get(kind) || null; }
function list() { return [...adapters.entries()].map(([kind, adapter]) => ({ kind, id: adapter.id, version: adapter.version })); }

module.exports = { get, list };
