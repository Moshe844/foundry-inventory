'use strict';

/**
 * Accounting is part of every Foundry workspace, not an optional module.
 * This boundary gives legacy workspaces the same deterministic configuration
 * new workspaces receive and carries forward only costs proven by immutable
 * purchase-receipt evidence. Nothing here invents a price or cost.
 */

const ledger = require('./ledger');
const openingCostEvidence = require('./opening-cost-evidence');
const supplierOpeningRecovery = require('./supplier-opening-recovery');

function today() {
  const date = new Date();
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

function accountingActor(db, workspaceId, preferredActorId = null) {
  if (preferredActorId) {
    const preferred = db.prepare(`SELECT id, role FROM users
      WHERE id = ? AND workspace_id = ?`).get(preferredActorId, workspaceId);
    if (preferred && ['owner', 'accountant'].includes(preferred.role)) return preferred;
  }
  return db.prepare(`SELECT id, role FROM users WHERE workspace_id = ?
    AND role IN ('owner','accountant')
    ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at LIMIT 1`).get(workspaceId);
}

function ensure(db, workspaceId, options = {}) {
  let configured = ledger.settings(db, workspaceId);
  const actor = accountingActor(db, workspaceId, options.actorId);
  if (!actor) return { configured, activated: false, seeded: [], unknown: [] };

  let activated = false;
  if (!configured.enabled || !configured.startDate) {
    configured = ledger.configure(db, { workspaceId, actorId: actor.id }, actor, {
      startDate: options.startDate || today(),
      currency: options.currency || 'USD',
      costingMethod: 'WEIGHTED_AVERAGE',
    });
    activated = true;
  }

  // Accounting grows by adding deterministic control accounts, never by
  // asking an existing business to "start accounting" again. This also makes
  // the receipt/invoice separation available to workspaces created before
  // those control accounts existed.
  ledger.ensureDefaultChart(db, workspaceId);

  // The owner-facing Accounting page may be opened long after a legacy
  // workspace started operating. Reconstruct every still-on-hand position up
  // to now from immutable PO receipts and movements, rather than forcing the
  // owner to re-enter costs Foundry already possesses. Event processing keeps
  // the historical boundary so its current movement is never consumed twice.
  const inference = openingCostEvidence.infer(db, workspaceId, configured.startDate, null,
    options.recoverCurrent ? { boundary: options.boundary || new Date(Date.now() + 1000).toISOString() } : {});
  const result = openingCostEvidence.apply(db, { workspaceId, actorId: actor.id }, inference);
  const supplierOpening = supplierOpeningRecovery.recover(db, {
    workspaceId, actorId: actor.id,
  });
  return {
    configured,
    activated,
    seeded: result.applied,
    unknown: inference.unknown,
    journalEntryId: result.journalEntryId,
    supplierOpening,
  };
}

module.exports = { ensure, accountingActor };
