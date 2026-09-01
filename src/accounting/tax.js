'use strict';

const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const { newId, nowIso, requireText } = require('../lib/util');
const ledger = require('./ledger');

function list(db, workspaceId, options = {}) {
  const where = ['workspace_id = ?']; const params = [workspaceId];
  if (options.activeOnly) where.push('active = 1');
  if (options.appliesTo) { where.push("applies_to IN (?, 'BOTH')"); params.push(String(options.appliesTo).toUpperCase()); }
  return db.prepare(`SELECT * FROM accounting_tax_rates WHERE ${where.join(' AND ')}
    ORDER BY active DESC, jurisdiction, name, effective_from DESC`).all(...params);
}

function create(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_ACCOUNTING, 'configure tax rates');
  const name = requireText(input.name, 'Tax rate name', { max: 120 });
  const jurisdiction = requireText(input.jurisdiction, 'Tax jurisdiction', { max: 160 });
  const percent = Number(input.ratePercent);
  const millionths = Math.round(percent * 10000);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100 || Math.abs(millionths / 10000 - percent) > 0.000001) {
    throw new ValidationError('Tax rate must be between 0 and 100 with no more than four decimal places.');
  }
  const appliesTo = String(input.appliesTo || 'SALES').toUpperCase();
  if (!['SALES', 'PURCHASES', 'BOTH'].includes(appliesTo)) throw new ValidationError('Choose sales, purchases, or both.');
  const effectiveFrom = ledger.dateOnly(input.effectiveFrom, 'Effective-from date');
  const effectiveTo = input.effectiveTo ? ledger.dateOnly(input.effectiveTo, 'Effective-to date') : null;
  if (effectiveTo && effectiveTo < effectiveFrom) throw new ValidationError('Tax rate end date cannot precede its start date.');
  const id = newId('taxrate'); const now = nowIso();
  db.prepare(`INSERT INTO accounting_tax_rates
    (id, workspace_id, name, jurisdiction, rate_millionths, applies_to,
     effective_from, effective_to, active, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(id, ctx.workspaceId, name, jurisdiction, millionths, appliesTo,
      effectiveFrom, effectiveTo, ctx.actorId, now, now);
  return db.prepare('SELECT * FROM accounting_tax_rates WHERE id = ?').get(id);
}

function calculate(db, workspaceId, rateId, taxableMinor, date, appliesTo) {
  const amount = Number(taxableMinor);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new ValidationError('Taxable amount must use non-negative minor units.');
  const postingDate = ledger.dateOnly(date, 'Tax date');
  const rate = db.prepare(`SELECT * FROM accounting_tax_rates WHERE id = ? AND workspace_id = ? AND active = 1`)
    .get(rateId, workspaceId);
  if (!rate) throw new NotFoundError('That tax rate is not active in this inventory.');
  const use = String(appliesTo || 'SALES').toUpperCase();
  if (![use, 'BOTH'].includes(rate.applies_to)) throw new ValidationError('That tax rate does not apply to this transaction type.');
  if (postingDate < rate.effective_from || (rate.effective_to && postingDate > rate.effective_to)) {
    throw new ValidationError('That tax rate is not effective on this transaction date.');
  }
  return Math.round(amount * Number(rate.rate_millionths) / 1000000);
}

module.exports = { list, create, calculate };
