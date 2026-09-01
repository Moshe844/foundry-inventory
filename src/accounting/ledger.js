'use strict';

const { inTransaction } = require('../db');
const { ValidationError, NotFoundError, AuthorizationError } = require('../domain/errors');
const { newId, nowIso, requireText } = require('../lib/util');
const { DEFAULT_ACCOUNTS } = require('./chart');

const ENGINE_VERSION = 'accounting-v1';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COGS', 'EXPENSE']);

function dateOnly(value, field = 'Posting date') {
  const text = String(value || '').trim();
  if (!DATE.test(text) || Number.isNaN(new Date(`${text}T00:00:00.000Z`).getTime())) {
    throw new ValidationError(`${field} must be a valid date in YYYY-MM-DD format.`);
  }
  return text;
}

function currencyCode(value) {
  const code = String(value || 'USD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new ValidationError('Currency must be a three-letter code.');
  return code;
}

function assertAccountingRole(membership, action) {
  if (!membership || !['owner', 'accountant'].includes(membership.role)) {
    throw new AuthorizationError(`Only an owner or accountant can ${action}.`);
  }
}

function settings(db, workspaceId) {
  const row = db.prepare('SELECT * FROM accounting_settings WHERE workspace_id = ?').get(workspaceId);
  return row ? {
    workspaceId: row.workspace_id,
    enabled: Boolean(row.enabled),
    startDate: row.accounting_start_date,
    currency: row.base_currency,
    costingMethod: row.costing_method,
    configuredByUserId: row.configured_by_user_id,
    configuredAt: row.configured_at,
  } : {
    workspaceId, enabled: false, startDate: null, currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  };
}

function configure(db, ctx, membership, input) {
  assertAccountingRole(membership, 'configure accounting');
  const startDate = dateOnly(input.startDate, 'Accounting start date');
  const currency = currencyCode(input.currency);
  const costingMethod = String(input.costingMethod || 'WEIGHTED_AVERAGE').toUpperCase();
  if (costingMethod !== 'WEIGHTED_AVERAGE') {
    throw new ValidationError('Moving weighted average is the supported inventory costing method. FIFO and specific identification are not available yet.');
  }
  const now = nowIso();
  return inTransaction(db, () => {
    db.prepare(`INSERT INTO accounting_settings
      (workspace_id, enabled, accounting_start_date, base_currency, costing_method,
       configured_by_user_id, configured_at, updated_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET enabled = 1,
        accounting_start_date = excluded.accounting_start_date,
        base_currency = excluded.base_currency,
        costing_method = excluded.costing_method,
        configured_by_user_id = excluded.configured_by_user_id,
        configured_at = COALESCE(accounting_settings.configured_at, excluded.configured_at),
        updated_at = excluded.updated_at`)
      .run(ctx.workspaceId, startDate, currency, costingMethod, ctx.actorId, now, now);
    ensureDefaultChart(db, ctx.workspaceId);
    ensurePeriod(db, ctx.workspaceId, startDate);
    return settings(db, ctx.workspaceId);
  });
}

function ensureDefaultChart(db, workspaceId) {
  const now = nowIso();
  const insert = db.prepare(`INSERT OR IGNORE INTO accounting_accounts
    (id, workspace_id, code, name, account_type, subtype, normal_balance,
     system_key, is_control, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  for (const account of DEFAULT_ACCOUNTS) {
    insert.run(newId('acct'), workspaceId, account.code, account.name, account.type,
      account.subtype, account.normal, account.systemKey, account.control ? 1 : 0, now, now);
  }
  return listAccounts(db, workspaceId);
}

function listAccounts(db, workspaceId, { activeOnly = false } = {}) {
  return db.prepare(`SELECT * FROM accounting_accounts WHERE workspace_id = ?
    ${activeOnly ? 'AND active = 1' : ''} ORDER BY code, rowid`).all(workspaceId);
}

function accountBySystemKey(db, workspaceId, key) {
  const account = db.prepare(`SELECT * FROM accounting_accounts
    WHERE workspace_id = ? AND system_key = ? AND active = 1`).get(workspaceId, key);
  if (!account) throw new NotFoundError(`The accounting account for ${key} is not configured.`);
  return account;
}

function createAccount(db, ctx, membership, input) {
  assertAccountingRole(membership, 'change the chart of accounts');
  const code = requireText(input.code, 'Account code', { max: 30 });
  const name = requireText(input.name, 'Account name', { max: 120 });
  const type = String(input.type || '').toUpperCase();
  if (!ACCOUNT_TYPES.has(type)) throw new ValidationError('Choose a valid account type.');
  const normal = String(input.normalBalance || (['ASSET', 'COGS', 'EXPENSE'].includes(type) ? 'DEBIT' : 'CREDIT')).toUpperCase();
  if (!['DEBIT', 'CREDIT'].includes(normal)) throw new ValidationError('Normal balance must be debit or credit.');
  const now = nowIso();
  const id = newId('acct');
  try {
    db.prepare(`INSERT INTO accounting_accounts
      (id, workspace_id, code, name, account_type, subtype, normal_balance,
       system_key, is_control, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, ?, ?)`)
      .run(id, ctx.workspaceId, code, name, type, input.subtype || null, normal, now, now);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ValidationError('That account code is already in use.');
    throw error;
  }
  return db.prepare('SELECT * FROM accounting_accounts WHERE id = ?').get(id);
}

function monthBounds(postingDate) {
  const [year, month] = postingDate.split('-').map(Number);
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start: `${postingDate.slice(0, 7)}-01`, end };
}

function ensurePeriod(db, workspaceId, postingDate) {
  const date = dateOnly(postingDate);
  const existing = db.prepare(`SELECT * FROM accounting_periods
    WHERE workspace_id = ? AND starts_on <= ? AND ends_on >= ?
    ORDER BY starts_on DESC LIMIT 1`).get(workspaceId, date, date);
  if (existing) return existing;
  const bounds = monthBounds(date);
  const id = newId('period');
  db.prepare(`INSERT INTO accounting_periods
    (id, workspace_id, starts_on, ends_on, status, created_at)
    VALUES (?, ?, ?, ?, 'OPEN', ?)`)
    .run(id, workspaceId, bounds.start, bounds.end, nowIso());
  return db.prepare('SELECT * FROM accounting_periods WHERE id = ?').get(id);
}

function closePeriod(db, ctx, membership, periodId, note = null) {
  assertAccountingRole(membership, 'close an accounting period');
  const period = db.prepare('SELECT * FROM accounting_periods WHERE id = ? AND workspace_id = ?')
    .get(periodId, ctx.workspaceId);
  if (!period) throw new NotFoundError('That accounting period could not be found.');
  if (period.status === 'CLOSED') return period;
  db.prepare(`UPDATE accounting_periods SET status = 'CLOSED', closed_by_user_id = ?,
    closed_at = ?, close_note = ? WHERE id = ? AND workspace_id = ? AND status = 'OPEN'`)
    .run(ctx.actorId, nowIso(), note || null, periodId, ctx.workspaceId);
  return db.prepare('SELECT * FROM accounting_periods WHERE id = ?').get(periodId);
}

function listPeriods(db, workspaceId) {
  return db.prepare(`SELECT * FROM accounting_periods WHERE workspace_id = ?
    ORDER BY starts_on DESC`).all(workspaceId);
}

function getEntry(db, workspaceId, entryId) {
  const entry = db.prepare(`SELECT * FROM accounting_journal_entries
    WHERE id = ? AND workspace_id = ?`).get(entryId, workspaceId);
  if (!entry) return null;
  return {
    ...entry,
    metadata: JSON.parse(entry.metadata || '{}'),
    lines: db.prepare(`SELECT l.*, a.code AS account_code, a.name AS account_name,
      a.account_type, a.normal_balance FROM accounting_journal_lines l
      JOIN accounting_accounts a ON a.id = l.account_id
      WHERE l.entry_id = ? ORDER BY l.line_number`).all(entryId)
      .map((line) => ({ ...line, metadata: JSON.parse(line.metadata || '{}') })),
  };
}

function normalizeLines(db, workspaceId, lines, currency) {
  if (!Array.isArray(lines) || lines.length < 2) throw new ValidationError('A journal entry needs at least two lines.');
  let debits = 0;
  let credits = 0;
  const normalized = lines.map((line, index) => {
    const account = line.accountId
      ? db.prepare('SELECT * FROM accounting_accounts WHERE id = ? AND workspace_id = ? AND active = 1')
        .get(line.accountId, workspaceId)
      : accountBySystemKey(db, workspaceId, line.accountKey);
    if (!account) throw new ValidationError(`Journal line ${index + 1} uses an unavailable account.`);
    const debit = Number(line.debitMinor || 0);
    const credit = Number(line.creditMinor || 0);
    if (!Number.isSafeInteger(debit) || debit < 0 || !Number.isSafeInteger(credit) || credit < 0
      || (debit > 0) === (credit > 0)) {
      throw new ValidationError(`Journal line ${index + 1} must contain one positive debit or credit in minor units.`);
    }
    debits += debit;
    credits += credit;
    return { ...line, account, debit, credit, currency };
  });
  if (debits !== credits) throw new ValidationError(`Journal entry is out of balance by ${Math.abs(debits - credits)} minor units.`);
  if (debits === 0) throw new ValidationError('A journal entry cannot have a zero total.');
  return { lines: normalized, debits, credits };
}

function post(db, ctx, input) {
  const configured = settings(db, ctx.workspaceId);
  if (!configured.enabled || !configured.startDate) {
    throw new ValidationError('Set an accounting start date before posting financial activity.');
  }
  const postingDate = dateOnly(input.postingDate || nowIso().slice(0, 10));
  if (postingDate < configured.startDate) {
    throw new ValidationError(`This activity is before the accounting start date of ${configured.startDate}.`);
  }
  const sourceKey = requireText(input.sourceKey, 'Posting source key', { max: 250 });
  const description = requireText(input.description, 'Journal description', { max: 500 });
  const existing = db.prepare(`SELECT id FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_key = ?`).get(ctx.workspaceId, sourceKey);
  if (existing) return { entry: getEntry(db, ctx.workspaceId, existing.id), replayed: true };

  return inTransaction(db, () => {
    const replay = db.prepare(`SELECT id FROM accounting_journal_entries
      WHERE workspace_id = ? AND source_key = ?`).get(ctx.workspaceId, sourceKey);
    if (replay) return { entry: getEntry(db, ctx.workspaceId, replay.id), replayed: true };
    const period = ensurePeriod(db, ctx.workspaceId, postingDate);
    if (period.status !== 'OPEN') throw new ValidationError(`The accounting period ending ${period.ends_on} is closed.`);
    const normalized = normalizeLines(db, ctx.workspaceId, input.lines, configured.currency);
    const next = db.prepare(`SELECT COALESCE(MAX(entry_number), 0) + 1 AS n
      FROM accounting_journal_entries WHERE workspace_id = ?`).get(ctx.workspaceId).n;
    const id = newId('je');
    const now = nowIso();
    db.prepare(`INSERT INTO accounting_journal_entries
      (id, workspace_id, entry_number, posting_date, period_id, description, status,
       source_type, source_record_type, source_record_id, source_event_id, source_key,
       reversal_of_entry_id, created_by_type, created_by_user_id, approved_by_user_id,
       engine_version, metadata, created_at, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(id, ctx.workspaceId, next, postingDate, period.id, description,
        input.sourceType || 'manual', input.sourceRecordType || null, input.sourceRecordId || null,
        input.sourceEventId || null, sourceKey, input.reversalOfEntryId || null,
        input.createdByType || 'SYSTEM', ctx.actorId || null, input.approvedByUserId || null,
        ENGINE_VERSION, JSON.stringify(input.metadata || {}), now);
    const insert = db.prepare(`INSERT INTO accounting_journal_lines
      (id, workspace_id, entry_id, line_number, account_id, debit_minor, credit_minor,
       currency, customer_id, supplier_id, item_id, sku_id, location_id, memo, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    normalized.lines.forEach((line, index) => insert.run(
      newId('jl'), ctx.workspaceId, id, index + 1, line.account.id, line.debit, line.credit,
      configured.currency, line.customerId || null, line.supplierId || null, line.itemId || null,
      line.skuId || null, line.locationId || null, line.memo || null,
      JSON.stringify(line.metadata || {}), now
    ));
    const totals = db.prepare(`SELECT COALESCE(SUM(debit_minor),0) AS debits,
      COALESCE(SUM(credit_minor),0) AS credits FROM accounting_journal_lines WHERE entry_id = ?`).get(id);
    if (totals.debits !== totals.credits || totals.debits !== normalized.debits) {
      throw new Error('Deterministic journal validation failed before posting.');
    }
    db.prepare(`UPDATE accounting_journal_entries SET status = 'POSTED', posted_at = ?
      WHERE id = ? AND status = 'DRAFT'`).run(now, id);
    return { entry: getEntry(db, ctx.workspaceId, id), replayed: false };
  });
}

function reverse(db, ctx, membership, entryId, input = {}) {
  assertAccountingRole(membership, 'reverse a journal entry');
  const original = getEntry(db, ctx.workspaceId, entryId);
  if (!original || original.status !== 'POSTED') throw new NotFoundError('That posted journal entry could not be found.');
  const existing = db.prepare(`SELECT id FROM accounting_journal_entries
    WHERE workspace_id = ? AND reversal_of_entry_id = ?`).get(ctx.workspaceId, original.id);
  if (existing) return { entry: getEntry(db, ctx.workspaceId, existing.id), replayed: true };
  return post(db, ctx, {
    postingDate: input.postingDate || nowIso().slice(0, 10),
    description: input.description || `Reversal of entry ${original.entry_number}: ${original.description}`,
    sourceType: 'reversal', sourceRecordType: 'journal_entry', sourceRecordId: original.id,
    sourceKey: `reversal:${original.id}`, reversalOfEntryId: original.id,
    createdByType: 'USER', approvedByUserId: ctx.actorId,
    metadata: { reason: input.reason || null, reversesEntryNumber: original.entry_number },
    lines: original.lines.map((line) => ({
      accountId: line.account_id,
      debitMinor: line.credit_minor,
      creditMinor: line.debit_minor,
      customerId: line.customer_id, supplierId: line.supplier_id,
      itemId: line.item_id, skuId: line.sku_id, locationId: line.location_id,
      memo: line.memo ? `Reversal: ${line.memo}` : null,
    })),
  });
}

module.exports = {
  ENGINE_VERSION, settings, configure, ensureDefaultChart, listAccounts,
  accountBySystemKey, createAccount, ensurePeriod, closePeriod, listPeriods, getEntry,
  post, reverse, dateOnly, currencyCode,
};
