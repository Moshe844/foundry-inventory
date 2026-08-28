'use strict';

/**
 * Checking that what was supposed to happen actually did.
 *
 * Every check below re-reads Mission 1 truth after the engine has run and
 * compares it with what the proposal said it expected. This is deliberately not
 * "did the call return without throwing" — a successful call and a correct
 * result are different claims, and only the second one may be reported as done.
 *
 * A failed verification is never silent. It is stored, surfaced, and the person
 * is told plainly that the inventory needs looking at.
 */

const engine = require('../domain/inventory-engine');
const resolver = require('./resolver');

const check = (label, expected, observed) => ({
  label,
  expected,
  observed,
  passed: expected === observed,
});

/**
 * @returns {{ verified: boolean, checks: Array, problems: string[] }}
 */
function verify(db, workspaceId, proposal, { before, after, result }) {
  const checks = [];
  const problems = [];
  const expected = proposal.expectedAfterState || {};

  if (proposal.actionType === 'receive') {
    checks.push(
      check('Stock at destination', (before.destinationOnHand ?? 0) + proposal.quantity, after.destinationOnHand ?? 0),
      check('Total on hand', (before.total ?? 0) + proposal.quantity, after.total ?? 0)
    );
  }

  if (proposal.actionType === 'issue') {
    checks.push(
      check('Stock at source', (before.sourceOnHand ?? 0) - proposal.quantity, after.sourceOnHand ?? 0),
      check('Total on hand', (before.total ?? 0) - proposal.quantity, after.total ?? 0)
    );
  }

  if (proposal.actionType === 'transfer') {
    checks.push(
      check('Stock at source', (before.sourceOnHand ?? 0) - proposal.quantity, after.sourceOnHand ?? 0),
      check('Stock at destination', (before.destinationOnHand ?? 0) + proposal.quantity, after.destinationOnHand ?? 0),
      // The one that matters most: a transfer moves stock, it never makes any.
      check('Total unchanged', before.total ?? 0, after.total ?? 0)
    );
  }

  if (proposal.actionType === 'adjust') {
    checks.push(
      check('Counted balance', proposal.adjustmentTarget, after.sourceOnHand ?? 0),
      check('Total on hand', (before.total ?? 0) + (proposal.adjustmentTarget - (before.sourceOnHand ?? 0)), after.total ?? 0)
    );
  }

  // A serialized unit exists in exactly one place, and it must be the right one.
  if (proposal.serialUnitIds.length) {
    for (const unitId of proposal.serialUnitIds) {
      const unit = db
        .prepare(
          `SELECT su.serial, su.status, su.location_id, l.name AS location_name
             FROM serial_units su LEFT JOIN locations l ON l.id = su.location_id
            WHERE su.id = ? AND su.workspace_id = ?`
        )
        .get(unitId, workspaceId);
      if (!unit) {
        problems.push('A unit that should have moved can no longer be found.');
        continue;
      }
      if (proposal.actionType === 'transfer') {
        checks.push(check(`${unit.serial} location`, proposal.destinationLocationId, unit.location_id));
      }
      if (proposal.actionType === 'issue') {
        checks.push(check(`${unit.serial} status`, 'issued', unit.status));
      }
      const places = db
        .prepare('SELECT COUNT(*) AS n FROM serial_units WHERE workspace_id = ? AND serial = ? AND status = ?')
        .get(workspaceId, unit.serial, 'in_stock').n;
      if (places > 1) problems.push(`${unit.serial} is recorded in more than one place.`);
    }
  }

  // Lot identity is preserved: the named lot moved, not generic stock.
  if (proposal.lotId) {
    const lotTotal = resolver.lotTotal(db, workspaceId, proposal.lotId);
    if (proposal.actionType === 'transfer') {
      checks.push(check('Lot total unchanged', before.total ?? 0, lotTotal));
    }
    checks.push(
      check(
        'Lot balance at destination',
        proposal.actionType === 'transfer'
          ? (before.destinationOnHand ?? 0) + proposal.quantity
          : after.destinationOnHand ?? 0,
        proposal.destinationLocationId
          ? resolver.lotBalanceAt(db, workspaceId, proposal.lotId, proposal.destinationLocationId)
          : after.destinationOnHand ?? 0
      )
    );
  }

  if (proposal.actionType === 'create_item') {
    const item = db
      .prepare('SELECT id FROM items WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1')
      .get(workspaceId, proposal.settings.name);
    checks.push(check('Product exists', true, Boolean(item)));
    if (item) {
      const skus = db
        .prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ? AND item_id = ? AND is_active = 1')
        .get(workspaceId, item.id).n;
      const expectedSkus = (proposal.expectedAfterState && proposal.expectedAfterState.variants) || 1;
      checks.push(check('Variants created', expectedSkus, skus));
      if (proposal.settings.initialStock) {
        checks.push(
          check('Initial stock received', proposal.quantity, after.total ?? 0),
          check('Stock at receiving location', proposal.quantity, after.destinationOnHand ?? 0)
        );
      }
    }
  }

  if (proposal.actionType === 'archive_item') {
    const row = proposal.settings.archiveScope === 'item'
      ? db.prepare('SELECT is_active FROM items WHERE id = ? AND workspace_id = ?')
          .get(proposal.itemId, workspaceId)
      : db.prepare('SELECT is_active FROM skus WHERE id = ? AND workspace_id = ?')
          .get(proposal.skuId, workspaceId);
    checks.push(check('Catalogue record archived', false, Boolean(row && row.is_active)));
  }

  if (proposal.actionType === 'add_location') {
    const exists = db
      .prepare('SELECT 1 FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
      .get(workspaceId, proposal.settings.name);
    checks.push(check('Location exists', true, Boolean(exists)));
  }

  if (proposal.actionType === 'rename_terminology') {
    const row = db
      .prepare('SELECT terminology FROM workspace_configuration WHERE workspace_id = ?')
      .get(workspaceId);
    const terminology = row ? JSON.parse(row.terminology || '{}') : {};
    checks.push(check('Wording applied', proposal.settings.value, terminology[proposal.settings.key]));
  }

  // The movement ledger must actually contain what we think we wrote.
  if (result && Array.isArray(result.movementIds) && result.movementIds.length) {
    const found = db
      .prepare(
        `SELECT COUNT(*) AS n FROM movements
          WHERE workspace_id = ? AND id IN (${result.movementIds.map(() => '?').join(',')})`
      )
      .get(workspaceId, ...result.movementIds).n;
    checks.push(check('Movements recorded', result.movementIds.length, found));
  }

  // Finally, the engine's own arithmetic still has to agree with itself.
  const integrity = engine.verifyIntegrity(db, workspaceId);
  checks.push(check('Ledger agrees with balances', true, integrity.ok));
  if (!integrity.ok) problems.push('Balances no longer agree with the movement history.');

  for (const item of checks) {
    if (!item.passed) {
      problems.push(`${item.label}: expected ${format(item.expected)}, found ${format(item.observed)}.`);
    }
  }

  return { verified: problems.length === 0, checks, problems, expectedAfter: expected };
}

function format(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (value === null || value === undefined) return 'nothing';
  return String(value);
}

module.exports = { verify, check };
