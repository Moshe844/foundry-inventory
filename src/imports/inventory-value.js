'use strict';

/**
 * Telling the books about inventory a file brought in.
 *
 * Giving imported stock a cost is only half an entry. The costing engine
 * records what each unit is worth; the ledger has to be told the same thing,
 * or the two disagree and StockChief's own reconciliation reports it as a
 * difference nobody can explain — inventory worth $31,774.50 on one screen and
 * $21,390.00 on another.
 *
 * The other side is opening balance equity, and it has to be. A file is not a
 * purchase: no supplier was billed, no money left an account, nothing is owed
 * to anybody. It is stock the business already had, arriving in StockChief for
 * the first time — which is exactly what opening balance equity is for, and
 * what the same value coming in from a PDF is already posted against.
 */

const ledger = require('../accounting/ledger');

/**
 * Post the value of imported stock, once.
 *
 * Idempotent on the source key, so a retried import or a repeated repair
 * cannot double the inventory on the balance sheet. Returns null when there is
 * nothing to say — no value, or a workspace whose books are not open.
 */
function post(db, workspaceId, input = {}) {
  const totalCostMinor = Math.round(Number(input.totalCostMinor || 0));
  if (!totalCostMinor) return null;

  const settings = ledger.settings(db, workspaceId);
  // Not every workspace keeps books. Stock still arrives; there is simply
  // nowhere to post it, and inventing an entry would be worse than silence.
  if (!settings.enabled || !settings.startDate) return null;

  /*
   * Dated to the day the books open when the file is older than they are.
   * Refusing to post because a supplier's invoice predates the start date
   * would leave the stock valued and the ledger silent — the exact disagreement
   * this exists to prevent.
   */
  const wanted = String(input.postingDate || '').slice(0, 10);
  const postingDate = wanted && wanted >= settings.startDate ? wanted : settings.startDate;

  const inventory = ledger.accountBySystemKey(db, workspaceId, 'INVENTORY_ASSET');
  const equity = ledger.accountBySystemKey(db, workspaceId, 'OPENING_BALANCE_EQUITY');

  return ledger.post(db, { workspaceId, actorId: input.actorId || null }, {
    postingDate,
    description: input.description || 'Inventory brought in from a file',
    sourceType: 'import',
    sourceRecordType: 'import_plan',
    sourceRecordId: input.sourceRecordId || null,
    sourceKey: input.sourceKey,
    createdByType: input.actorId ? 'USER' : 'SYSTEM',
    approvedByUserId: input.actorId || null,
    lines: [
      { accountId: inventory.id, debitMinor: totalCostMinor, creditMinor: 0,
        memo: 'Stock brought in from a file' },
      { accountId: equity.id, debitMinor: 0, creditMinor: totalCostMinor,
        memo: 'What that stock was already worth' },
    ],
  });
}

module.exports = { post };
