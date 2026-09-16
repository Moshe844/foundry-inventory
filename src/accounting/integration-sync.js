'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const reports = require('./reports');
const ledger = require('./ledger');
const connections = require('../connections/service');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso } = require('../lib/util');

const stable = (value) => JSON.stringify(value, Object.keys(value || {}).sort());
const hash = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const json = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

function policy(db, workspaceId, connectorId) {
  let row = db.prepare(`SELECT * FROM accounting_sync_policies
    WHERE workspace_id = ? AND connector_id = ?`).get(workspaceId, connectorId);
  if (!row) throw new NotFoundError('Accounting synchronization policy not found. Reconnect this accounting system.');
  // Repair the old shadow-reread regression: a successful comparison used to
  // demote an already enabled policy back to WRITE_READY even though its
  // durable owner approval remained recorded.
  if (row.stage === 'WRITE_READY' && row.write_enabled_at) {
    db.prepare(`UPDATE accounting_sync_policies SET stage = 'WRITE_ENABLED', updated_at = ?
      WHERE workspace_id = ? AND connector_id = ? AND stage = 'WRITE_READY'`)
      .run(nowIso(), workspaceId, connectorId);
    db.prepare(`UPDATE workspace_connectors SET setup_status = 'ACCOUNTING_WRITE_ENABLED', updated_at = ?
      WHERE workspace_id = ? AND id = ?`).run(nowIso(), workspaceId, connectorId);
    row = { ...row, stage: 'WRITE_ENABLED' };
  }
  return { ...row, verifiedFact: json(row.verified_fact, {}) };
}

function initialize(db, connection, actorId, fact) {
  if (!fact || !fact.label || fact.value === undefined || fact.value === null) {
    throw new ValidationError('The accounting connection did not return a verifiable read-only fact. Nothing was enabled.');
  }
  const now = nowIso();
  db.prepare(`INSERT INTO accounting_sync_policies
    (id, workspace_id, connector_id, provider_type, verified_fact, verified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, connector_id) DO UPDATE SET
      verified_fact = excluded.verified_fact, verified_at = excluded.verified_at,
      stage = 'READ_ONLY_VERIFIED', posting_direction = 'READ_ONLY', requested_authority = 'OBSERVE',
      write_enabled_by_user_id = NULL, write_enabled_at = NULL, updated_at = excluded.updated_at`)
    .run(newId('acpol'), connection.workspace_id, connection.id, connection.provider_type,
      JSON.stringify(fact), now, now, now);
  db.prepare(`UPDATE workspace_connectors SET setup_status = 'AUTHORITY_REQUIRED', last_synced_at = ?,
    last_activity_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
    .run(now, now, now, connection.workspace_id, connection.id);
  return policy(db, connection.workspace_id, connection.id);
}

function chooseAuthority(db, ctx, connectorId, input = {}) {
  const current = policy(db, ctx.workspaceId, connectorId);
  const requested = String(input.authority || 'OBSERVE').toUpperCase();
  if (!['OBSERVE', 'SHADOW', 'POST'].includes(requested)) throw new ValidationError('Choose observe, shadow, or post authority.');
  const accountingSource = String(input.accountingSource || 'FOUNDRY').toUpperCase();
  if (!['FOUNDRY', 'EXTERNAL'].includes(accountingSource)) throw new ValidationError('Choose which system owns accounting truth.');
  if (requested === 'POST' && accountingSource !== 'FOUNDRY') {
    throw new ValidationError('StockChief cannot post outward while the external system is declared the accounting source of truth.');
  }
  const direction = requested === 'POST' ? 'FOUNDRY_TO_EXTERNAL'
    : accountingSource === 'EXTERNAL' ? 'EXTERNAL_TO_FOUNDRY' : 'READ_ONLY';
  const stage = requested === 'OBSERVE' ? 'READ_ONLY_VERIFIED' : 'SHADOW';
  db.prepare(`UPDATE accounting_sync_policies SET accounting_source = ?, posting_direction = ?,
    requested_authority = ?, stage = ?, write_enabled_by_user_id = NULL, write_enabled_at = NULL,
    updated_at = ? WHERE workspace_id = ? AND connector_id = ?`)
    .run(accountingSource, direction, requested, stage, nowIso(), ctx.workspaceId, connectorId);
  db.prepare(`UPDATE workspace_connectors SET setup_status = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(requested === 'OBSERVE' ? 'READ_ONLY_ACTIVE' : 'SHADOW_PENDING',
    nowIso(), ctx.workspaceId, connectorId);
  return { previous: current, current: policy(db, ctx.workspaceId, connectorId) };
}

function localSnapshot(db, workspaceId, asOf) {
  const trial = reports.trialBalance(db, workspaceId, { to: asOf, includeZero: true });
  return { asOf, currency: trial.currency, balanced: trial.balanced,
    accounts: trial.accounts.map((row) => ({ code: row.code, name: row.name,
      balanceMinor: Number(row.ending_debit_minor) - Number(row.ending_credit_minor) })) };
}

function conflict(db, workspaceId, connectorId, input) {
  const now = nowIso();
  const id = newId('acconf');
  db.prepare(`INSERT INTO accounting_sync_conflicts
    (id, workspace_id, connector_id, conflict_key, conflict_type, entity_type,
     foundry_record_id, external_id, foundry_version, external_version,
     foundry_payload, external_payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, connector_id, conflict_key) DO UPDATE SET
      foundry_version = excluded.foundry_version, external_version = excluded.external_version,
      foundry_payload = excluded.foundry_payload, external_payload = excluded.external_payload,
      status = 'OPEN', resolution = NULL, resolved_at = NULL`)
    .run(id, workspaceId, connectorId, input.key, input.type, input.entityType || null,
      input.foundryRecordId || null, input.externalId || null, input.foundryVersion || null,
      input.externalVersion || null, JSON.stringify(input.foundryPayload || {}),
      JSON.stringify(input.externalPayload || {}), now);
  db.prepare(`UPDATE accounting_sync_policies SET stage = 'CONFLICT', updated_at = ?
    WHERE workspace_id = ? AND connector_id = ?`).run(now, workspaceId, connectorId);
  db.prepare(`UPDATE workspace_connectors SET setup_status = 'ACCOUNTING_CONFLICT', updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(now, workspaceId, connectorId);
  connections.issue(db, { workspaceId, connectorId, issueType: 'ACCOUNTING_SYNC_CONFLICT',
    fingerprint: `accounting-sync:${connectorId}:${input.key}`,
    title: 'Accounting systems disagree and StockChief stopped',
    detail: input.detail || 'The same accounting identity changed differently in StockChief and the external books.',
    resolutionHint: 'Review the exact versions and choose which recorded fact is authoritative. No balance was overwritten.' });
  return db.prepare(`SELECT * FROM accounting_sync_conflicts WHERE workspace_id = ? AND connector_id = ? AND conflict_key = ?`)
    .get(workspaceId, connectorId, input.key);
}

function rememberExactAccounts(db, connection, external) {
  const local = db.prepare(`SELECT id, code, name FROM accounting_accounts WHERE workspace_id = ?`)
    .all(connection.workspace_id);
  const byCode = new Map(local.map((row) => [String(row.code).toLowerCase(), row]));
  const now = nowIso();
  for (const row of external.accounts || []) {
    const code = String(row.code || '').trim().toLowerCase();
    const match = code && byCode.get(code);
    if (!match || !row.externalId) continue;
    db.prepare(`INSERT INTO accounting_external_identities
      (id, workspace_id, connector_id, entity_type, foundry_record_id, external_id,
       external_version, payload_hash, last_direction, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, 'account', ?, ?, ?, ?, 'READ', ?, ?, ?)
      ON CONFLICT(workspace_id, connector_id, entity_type, foundry_record_id) DO UPDATE SET
        external_id = excluded.external_id, external_version = excluded.external_version,
        payload_hash = excluded.payload_hash, last_direction = 'READ', last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at`)
      .run(newId('acident'), connection.workspace_id, connection.id, match.id, String(row.externalId),
        row.version == null ? null : String(row.version), hash(row), now, now, now);
  }
}

function compare(local, external) {
  const externalByCode = new Map((external.accounts || []).filter((row) => row.code)
    .map((row) => [String(row.code).trim().toLowerCase(), row]));
  const differences = [];
  for (const account of local.accounts) {
    const other = externalByCode.get(String(account.code).toLowerCase());
    // A zero-balance account absent from the provider's Trial Balance has no
    // financial difference. Providers commonly omit these rows. Posting still
    // requires an exact external identity for every account a journal uses.
    if (!other) {
      if (Number(account.balanceMinor) !== 0) differences.push({ kind: 'MISSING_EXTERNAL_ACCOUNT', code: account.code,
        foundryMinor: account.balanceMinor, externalMinor: null });
      continue;
    }
    if (Number(other.balanceMinor) !== Number(account.balanceMinor)) differences.push({
      kind: 'BALANCE_MISMATCH', code: account.code, foundryMinor: account.balanceMinor,
      externalMinor: Number(other.balanceMinor), differenceMinor: Number(other.balanceMinor) - Number(account.balanceMinor),
    });
  }
  for (const account of external.accounts || []) {
    if ((!account.code || !local.accounts.some((row) => String(row.code).toLowerCase() === String(account.code).toLowerCase()))
        && Number(account.balanceMinor || 0) !== 0) {
      differences.push({ kind: 'UNMAPPED_EXTERNAL_ACCOUNT', externalId: account.externalId || null,
        code: account.code || null, externalName: account.name || null, externalMinor: Number(account.balanceMinor || 0) });
    }
  }
  if (external.currency && local.currency && external.currency !== local.currency) {
    differences.push({ kind: 'CURRENCY_MISMATCH', foundry: local.currency, external: external.currency });
  }
  return differences;
}

function importedAccountShape(providerType, row) {
  const provider = String(providerType || 'external').toUpperCase();
  const rawType = `${row.accountType || ''} ${row.accountSubType || ''} ${row.classification || ''}`.toUpperCase();
  let type = 'EXPENSE';
  if (/COST OF GOODS|DIRECTCOST|COGS/.test(rawType)) type = 'COGS';
  else if (/REVENUE|INCOME|SALES/.test(rawType)) type = 'INCOME';
  else if (/EQUITY/.test(rawType)) type = 'EQUITY';
  else if (/LIABILITY|PAYABLE|CREDIT CARD|CURRLIAB|TERMLIAB/.test(rawType)) type = 'LIABILITY';
  else if (/ASSET|BANK|RECEIVABLE|CURRENT|FIXED|INVENTORY|PREPAYMENT/.test(rawType)) type = 'ASSET';
  const safeExternal = String(row.externalId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
  const prefix = provider === 'QUICKBOOKS' ? 'QB' : provider === 'XERO' ? 'XE' : 'EXT';
  const code = safeExternal && `${prefix}-${safeExternal}`.length <= 30
    ? `${prefix}-${safeExternal}` : `${prefix}-${hash(String(row.externalId)).slice(0, 16).toUpperCase()}`;
  return { code, name: String(row.name || 'Imported account').slice(0, 120), type,
    normalBalance: ['ASSET', 'COGS', 'EXPENSE'].includes(type) ? 'DEBIT' : 'CREDIT',
    subtype: row.accountSubType || row.accountType || null };
}

function openingBooksPreview(db, workspaceId, connectorId) {
  const latest = db.prepare(`SELECT external_snapshot FROM accounting_shadow_runs
    WHERE workspace_id = ? AND connector_id = ? ORDER BY started_at DESC LIMIT 1`)
    .get(workspaceId, connectorId);
  const snapshot = latest ? json(latest.external_snapshot, null) : null;
  if (!snapshot?.accounts?.length) return null;
  const accounts = snapshot.accounts.filter((row) => row.externalId);
  const nonzero = accounts.filter((row) => Number(row.balanceMinor || 0) !== 0);
  return { asOf: snapshot.asOf, currency: snapshot.currency || 'USD', accountCount: accounts.length,
    nonzeroCount: nonzero.length, debitMinor: nonzero.filter((row) => Number(row.balanceMinor) > 0)
      .reduce((sum, row) => sum + Number(row.balanceMinor), 0),
    creditMinor: nonzero.filter((row) => Number(row.balanceMinor) < 0)
      .reduce((sum, row) => sum - Number(row.balanceMinor), 0),
    balanced: nonzero.reduce((sum, row) => sum + Number(row.balanceMinor), 0) === 0,
    alreadyImported: Boolean(db.prepare(`SELECT 1 FROM accounting_journal_entries
      WHERE workspace_id = ? AND source_record_type = 'accounting_connection_opening'
        AND source_record_id = ? AND status = 'POSTED'`).get(workspaceId, connectorId)),
    canImport: nonzero.length >= 2 && nonzero.reduce((sum, row) => sum + Number(row.balanceMinor), 0) === 0
      && !db.prepare(`SELECT 1 FROM accounting_journal_entries WHERE workspace_id = ? AND status = 'POSTED'
        LIMIT 1`).get(workspaceId),
  };
}

function importOpeningBooks(db, ctx, membership, connectorId) {
  const connection = connections.get(db, ctx.workspaceId, connectorId);
  const current = state(db, ctx.workspaceId, connectorId);
  const snapshot = current?.latestShadow?.externalSnapshot;
  const preview = openingBooksPreview(db, ctx.workspaceId, connectorId);
  if (!snapshot || !preview) throw new ValidationError('Run a read-only comparison before importing starting books.');
  if (preview.alreadyImported) {
    const entry = db.prepare(`SELECT * FROM accounting_journal_entries WHERE workspace_id = ?
      AND source_record_type = 'accounting_connection_opening' AND source_record_id = ? AND status = 'POSTED'`)
      .get(ctx.workspaceId, connectorId);
    return { entry, replayed: true, preview };
  }
  if (!preview.canImport) {
    throw new ValidationError(preview.balanced
      ? 'This inventory already has posted accounting activity. Starting books can only initialize empty StockChief books.'
      : 'The provider trial balance is not balanced, so StockChief stopped before importing it.');
  }
  const accounts = snapshot.accounts.filter((row) => row.externalId);
  const byExternal = new Map();
  return inTransaction(db, () => {
    ledger.configure(db, ctx, membership, { startDate: snapshot.asOf,
      currency: snapshot.currency || 'USD', costingMethod: 'WEIGHTED_AVERAGE' });
    for (const row of accounts) {
      let identity = db.prepare(`SELECT foundry_record_id FROM accounting_external_identities
        WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'account' AND external_id = ?`)
        .get(ctx.workspaceId, connectorId, String(row.externalId));
      let account = identity && db.prepare('SELECT * FROM accounting_accounts WHERE id = ? AND workspace_id = ?')
        .get(identity.foundry_record_id, ctx.workspaceId);
      if (!account) account = ledger.createAccount(db, ctx, membership,
        importedAccountShape(connection.provider_type, row));
      mapAccount(db, ctx, connectorId, { externalId: String(row.externalId), accountId: account.id });
      byExternal.set(String(row.externalId), account);
    }
    const result = ledger.post(db, ctx, { postingDate: snapshot.asOf,
      description: `Opening books imported from ${connection.display_name}`,
      sourceType: 'accounting_connection', sourceRecordType: 'accounting_connection_opening',
      sourceRecordId: connectorId, sourceKey: `accounting-opening:${connectorId}`,
      createdByType: 'CONNECTOR', approvedByUserId: ctx.actorId,
      metadata: { providerType: connection.provider_type, providerAccountId: connection.provider_account_id,
        providerAccountName: connection.provider_account_name, snapshotVersion: snapshot.version,
        snapshotHash: hash(snapshot) },
      lines: accounts.filter((row) => Number(row.balanceMinor || 0) !== 0).map((row) => ({
        accountId: byExternal.get(String(row.externalId)).id,
        debitMinor: Number(row.balanceMinor) > 0 ? Number(row.balanceMinor) : 0,
        creditMinor: Number(row.balanceMinor) < 0 ? -Number(row.balanceMinor) : 0,
        memo: `${connection.display_name}: ${row.name}`,
      })),
    });
    chooseAuthority(db, ctx, connectorId, { authority: 'POST', accountingSource: 'FOUNDRY' });
    return { ...result, preview };
  });
}

async function shadow(db, ctx, connectorId, adapter, credentials, input = {}) {
  const connection = connections.get(db, ctx.workspaceId, connectorId);
  const current = policy(db, ctx.workspaceId, connectorId);
  if (current.requested_authority === 'OBSERVE') throw new ValidationError('Choose shadow comparison authority first.');
  if (!adapter?.readAccountingSnapshot) throw new ValidationError('This provider cannot supply a certified accounting snapshot.');
  const asOf = input.asOf || new Date().toISOString().slice(0, 10);
  const runId = newId('acshadow'); const started = nowIso();
  db.prepare(`INSERT INTO accounting_shadow_runs
    (id, workspace_id, connector_id, status, as_of, local_snapshot, external_snapshot, started_at)
    VALUES (?, ?, ?, 'RUNNING', ?, '{}', '{}', ?)`)
    .run(runId, ctx.workspaceId, connectorId, asOf, started);
  try {
    const local = localSnapshot(db, ctx.workspaceId, asOf);
    const external = await adapter.readAccountingSnapshot({ credentials, connection, asOf });
    const checkpoint = db.prepare(`SELECT * FROM accounting_sync_checkpoints
      WHERE workspace_id = ? AND connector_id = ? AND stream = 'trial_balance'`)
      .get(ctx.workspaceId, connectorId);
    if (checkpoint?.watermark_at && external.asOf && external.asOf < checkpoint.watermark_at) {
      conflict(db, ctx.workspaceId, connectorId, { key: `out-of-order:${external.asOf}`, type: 'OUT_OF_ORDER_SNAPSHOT',
        externalVersion: external.version || null, externalPayload: external,
        detail: `The provider returned an accounting snapshot from ${external.asOf}, older than the accepted checkpoint ${checkpoint.watermark_at}. StockChief ignored it.` });
      throw new ValidationError('The provider returned an out-of-order accounting snapshot. Nothing was changed.');
    }
    const approved = db.prepare(`SELECT x.external_id, a.code FROM accounting_external_identities x
      JOIN accounting_accounts a ON a.id = x.foundry_record_id
      WHERE x.workspace_id = ? AND x.connector_id = ? AND x.entity_type = 'account'`)
      .all(ctx.workspaceId, connectorId);
    const approvedCodes = new Map(approved.map((row) => [String(row.external_id), row.code]));
    const normalizedExternal = { ...external, accounts: (external.accounts || []).map((row) => ({ ...row,
      code: approvedCodes.get(String(row.externalId)) || row.code })) };
    const differences = compare(local, normalizedExternal);
    const status = differences.length ? 'MISMATCH' : 'MATCHED'; const done = nowIso();
    inTransaction(db, () => {
      rememberExactAccounts(db, connection, external);
      db.prepare(`UPDATE accounting_shadow_runs SET status = ?, local_snapshot = ?, external_snapshot = ?,
        differences = ?, completed_at = ? WHERE id = ?`)
        .run(status, JSON.stringify(local), JSON.stringify(external), JSON.stringify(differences), done, runId);
      db.prepare(`UPDATE accounting_sync_policies SET last_shadow_run_id = ?, stage = ?, updated_at = ?
        WHERE workspace_id = ? AND connector_id = ?`)
        .run(runId, status === 'MATCHED' && current.requested_authority === 'POST'
          ? (current.stage === 'WRITE_ENABLED' ? 'WRITE_ENABLED' : 'WRITE_READY') : 'SHADOW',
          done, ctx.workspaceId, connectorId);
      db.prepare(`UPDATE workspace_connectors SET setup_status = ?, last_synced_at = ?,
        last_activity_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
        .run(status === 'MATCHED' ? (current.requested_authority === 'POST'
          ? (current.stage === 'WRITE_ENABLED' ? 'ACCOUNTING_WRITE_ENABLED' : 'WRITE_READY') : 'SHADOW_MATCHED') : 'ACCOUNTING_CONFLICT',
          done, done, done, ctx.workspaceId, connectorId);
      db.prepare(`INSERT INTO accounting_sync_checkpoints
        (id, workspace_id, connector_id, stream, cursor, external_version, watermark_at, updated_at)
        VALUES (?, ?, ?, 'trial_balance', ?, ?, ?, ?)
        ON CONFLICT(workspace_id, connector_id, stream) DO UPDATE SET cursor = excluded.cursor,
          external_version = excluded.external_version, watermark_at = excluded.watermark_at,
          updated_at = excluded.updated_at`)
        .run(newId('accheck'), ctx.workspaceId, connectorId, external.asOf || asOf,
          external.version == null ? null : String(external.version), external.asOf || asOf, done);
      if (status === 'MATCHED') {
        db.prepare(`UPDATE accounting_sync_conflicts SET status = 'RESOLVED',
          resolution = 'A later certified shadow comparison matched.', resolved_at = ?
          WHERE workspace_id = ? AND connector_id = ? AND status = 'OPEN'`)
          .run(done, ctx.workspaceId, connectorId);
        connections.resolveIssues(db, ctx.workspaceId, connectorId, 'ACCOUNTING_SYNC_CONFLICT');
      }
    });
    if (differences.length) {
      conflict(db, ctx.workspaceId, connectorId, { key: `shadow:${runId}`, type: 'SHADOW_MISMATCH',
        foundryVersion: asOf, externalVersion: external.version || external.asOf || asOf,
        foundryPayload: local, externalPayload: external,
        detail: `Shadow comparison found ${differences.length} difference${differences.length === 1 ? '' : 's'}. No external write was attempted.` });
    }
    return { id: runId, status, differences, local, external };
  } catch (error) {
    db.prepare(`UPDATE accounting_shadow_runs SET status = 'FAILED', error_message = ?, completed_at = ? WHERE id = ?`)
      .run(String(error.message).slice(0, 500), nowIso(), runId);
    throw error;
  }
}

function mapAccount(db, ctx, connectorId, input = {}) {
  const externalId = String(input.externalId || '').trim();
  if (!externalId) throw new ValidationError('Choose the external account to map.');
  const account = db.prepare(`SELECT * FROM accounting_accounts WHERE workspace_id = ? AND id = ? AND active = 1`)
    .get(ctx.workspaceId, input.accountId);
  if (!account) throw new ValidationError('Choose an active StockChief account.');
  const current = state(db, ctx.workspaceId, connectorId);
  const external = current?.latestShadow?.externalSnapshot?.accounts?.find((row) => String(row.externalId) === externalId);
  if (!external) throw new ValidationError('That external account is not present in the latest verified snapshot.');
  const occupied = db.prepare(`SELECT foundry_record_id FROM accounting_external_identities
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'account' AND external_id = ?`)
    .get(ctx.workspaceId, connectorId, externalId);
  if (occupied && occupied.foundry_record_id !== account.id) {
    throw new ValidationError('That external account is already mapped to a different StockChief account.');
  }
  const now = nowIso();
  db.prepare(`INSERT INTO accounting_external_identities
    (id, workspace_id, connector_id, entity_type, foundry_record_id, external_id,
     external_version, payload_hash, last_direction, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, 'account', ?, ?, ?, ?, 'READ', ?, ?, ?)
    ON CONFLICT(workspace_id, connector_id, entity_type, foundry_record_id) DO UPDATE SET
      external_id = excluded.external_id, external_version = excluded.external_version,
      payload_hash = excluded.payload_hash, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`)
    .run(newId('acident'), ctx.workspaceId, connectorId, account.id, externalId,
      external.version == null ? null : String(external.version), hash(external), now, now, now);
  return { account, external };
}

function enableWrites(db, ctx, connectorId) {
  const current = policy(db, ctx.workspaceId, connectorId);
  const connection = connections.get(db, ctx.workspaceId, connectorId);
  if (current.posting_direction !== 'FOUNDRY_TO_EXTERNAL' || current.requested_authority !== 'POST') {
    throw new ValidationError('Choose StockChief as accounting source and request posting authority first.');
  }
  const run = current.last_shadow_run_id && db.prepare(`SELECT status FROM accounting_shadow_runs
    WHERE id = ? AND workspace_id = ? AND connector_id = ?`).get(current.last_shadow_run_id, ctx.workspaceId, connectorId);
  if (!run || run.status !== 'MATCHED') throw new ValidationError('A matching shadow reconciliation is required before writes can be enabled.');
  if (!connection.capabilities.includes('accounting:post')) {
    throw new ValidationError(`This ${connection.display_name} authorization is read-only. Reconnect and explicitly grant its posting scope first.`);
  }
  const now = nowIso();
  db.prepare(`UPDATE accounting_sync_policies SET stage = 'WRITE_ENABLED', write_enabled_by_user_id = ?,
    write_enabled_at = ?, updated_at = ? WHERE workspace_id = ? AND connector_id = ?`)
    .run(ctx.actorId, now, now, ctx.workspaceId, connectorId);
  db.prepare(`UPDATE workspace_connectors SET setup_status = 'ACCOUNTING_WRITE_ENABLED', updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(now, ctx.workspaceId, connectorId);
  return policy(db, ctx.workspaceId, connectorId);
}

async function syncPending(db, ctx, connectorId, adapter, credentials, options = {}) {
  const current = policy(db, ctx.workspaceId, connectorId);
  if (current.stage !== 'WRITE_ENABLED') throw new ValidationError('Posting is not enabled for this accounting connection.');
  if (!adapter?.postJournalEntry) throw new ValidationError('This provider does not support governed journal posting.');
  let entries = db.prepare(`SELECT e.* FROM accounting_journal_entries e
    WHERE e.workspace_id = ? AND e.status = 'POSTED'
      AND (e.source_record_type IS NULL OR e.source_record_type <> 'accounting_connection_opening')
      AND NOT EXISTS (SELECT 1 FROM accounting_external_identities x
        WHERE x.workspace_id = e.workspace_id AND x.connector_id = ?
          AND x.entity_type = 'journal_entry' AND x.foundry_record_id = e.id)
    ORDER BY e.entry_number LIMIT 100`).all(ctx.workspaceId, connectorId);
  if (Array.isArray(options.entryIds)) {
    const selected = new Set(options.entryIds.map(String));
    entries = entries.filter((entry) => selected.has(String(entry.id)));
  }
  let posted = 0;
  for (const entry of entries) {
    const lines = db.prepare(`SELECT l.*, a.code AS account_code, a.name AS account_name,
      x.external_id AS external_account_id FROM accounting_journal_lines l
      JOIN accounting_accounts a ON a.id = l.account_id
      LEFT JOIN accounting_external_identities x ON x.workspace_id = l.workspace_id
        AND x.connector_id = ? AND x.entity_type = 'account' AND x.foundry_record_id = l.account_id
      WHERE l.entry_id = ? ORDER BY l.line_number`).all(connectorId, entry.id);
    const missing = lines.filter((line) => !line.external_account_id);
    if (missing.length) {
      conflict(db, ctx.workspaceId, connectorId, { key: `entry-account:${entry.id}`, type: 'UNCERTAIN_ACCOUNT_IDENTITY',
        entityType: 'journal_entry', foundryRecordId: entry.id, foundryVersion: String(entry.entry_number),
        foundryPayload: { entry, missingAccounts: missing.map((line) => ({ code: line.account_code, name: line.account_name })) },
        detail: `Journal ${entry.entry_number} uses ${missing.length} account${missing.length === 1 ? '' : 's'} without an exact external identity. StockChief did not post it.` });
      break;
    }
    const result = await adapter.postJournalEntry({ credentials, entry: { ...entry, lines },
      idempotencyKey: `foundry-${ctx.workspaceId}-${entry.id}` });
    if (!result?.externalId) throw new ValidationError('The accounting provider did not confirm an external journal identity.');
    const now = nowIso();
    db.prepare(`INSERT INTO accounting_external_identities
      (id, workspace_id, connector_id, entity_type, foundry_record_id, external_id,
       external_version, payload_hash, last_direction, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, 'journal_entry', ?, ?, ?, ?, 'WRITE', ?, ?, ?)
      ON CONFLICT(workspace_id, connector_id, entity_type, foundry_record_id) DO NOTHING`)
      .run(newId('acident'), ctx.workspaceId, connectorId, entry.id, String(result.externalId),
        result.version == null ? null : String(result.version), hash({ entry, lines }), now, now, now);
    posted += 1;
  }
  const now = nowIso();
  db.prepare(`INSERT INTO accounting_sync_checkpoints
    (id, workspace_id, connector_id, stream, cursor, watermark_at, updated_at)
    VALUES (?, ?, ?, 'journal_entries', ?, ?, ?)
    ON CONFLICT(workspace_id, connector_id, stream) DO UPDATE SET cursor = excluded.cursor,
      watermark_at = excluded.watermark_at, updated_at = excluded.updated_at`)
    .run(newId('accheck'), ctx.workspaceId, connectorId,
      entries.length ? String(entries[Math.max(0, posted - 1)]?.entry_number || '') : null, now, now);
  return { posted, remaining: Math.max(0, entries.length - posted) };
}

function createSandboxProof(db, ctx, connectorId) {
  const current = policy(db, ctx.workspaceId, connectorId);
  if (current.stage !== 'WRITE_ENABLED') {
    throw new ValidationError('Enable verified posting before running the sandbox proof.');
  }
  const mapped = db.prepare(`SELECT a.*, x.external_id FROM accounting_accounts a
    JOIN accounting_external_identities x ON x.workspace_id = a.workspace_id
      AND x.connector_id = ? AND x.entity_type = 'account' AND x.foundry_record_id = a.id
    WHERE a.workspace_id = ? AND a.active = 1 ORDER BY a.code`).all(connectorId, ctx.workspaceId);
  const cash = mapped.find((row) => row.account_type === 'ASSET' && /checking|cash|bank/i.test(row.name))
    || mapped.find((row) => row.account_type === 'ASSET');
  const expense = mapped.find((row) => row.account_type === 'EXPENSE' && /misc|other business|office/i.test(row.name))
    || mapped.find((row) => row.account_type === 'EXPENSE');
  if (!cash || !expense) throw new ValidationError('The sandbox proof needs one exactly linked cash account and one expense account.');
  const date = new Date().toISOString().slice(0, 10);
  const charge = ledger.post(db, ctx, { postingDate: date,
    description: 'StockChief sandbox integration proof — $1 test',
    sourceType: 'accounting_connection_test', sourceRecordType: 'accounting_connection_test',
    sourceRecordId: connectorId, sourceKey: `accounting-sandbox-proof:${connectorId}:charge`,
    createdByType: 'USER', approvedByUserId: ctx.actorId,
    metadata: { connectorId, automaticallyReversed: true }, lines: [
      { accountId: expense.id, debitMinor: 100, memo: 'StockChief sandbox proof' },
      { accountId: cash.id, creditMinor: 100, memo: 'StockChief sandbox proof' },
    ] });
  const reversal = ledger.post(db, ctx, { postingDate: date,
    description: 'Reverse StockChief sandbox integration proof',
    sourceType: 'accounting_connection_test', sourceRecordType: 'accounting_connection_test',
    sourceRecordId: connectorId, sourceKey: `accounting-sandbox-proof:${connectorId}:reversal`,
    createdByType: 'USER', approvedByUserId: ctx.actorId,
    metadata: { connectorId, reversesProofEntryId: charge.entry.id }, lines: [
      { accountId: cash.id, debitMinor: 100, memo: 'Reverse StockChief sandbox proof' },
      { accountId: expense.id, creditMinor: 100, memo: 'Reverse StockChief sandbox proof' },
    ] });
  return { entries: [charge.entry, reversal.entry], cash, expense };
}

function state(db, workspaceId, connectorId) {
  let current = null; try { current = policy(db, workspaceId, connectorId); } catch { return null; }
  const latest = db.prepare(`SELECT * FROM accounting_shadow_runs WHERE workspace_id = ? AND connector_id = ?
      ORDER BY started_at DESC LIMIT 1`).get(workspaceId, connectorId) || null;
  const proofEntries = db.prepare(`SELECT e.id, e.entry_number, e.description, e.posting_date,
      x.external_id, x.external_version, x.last_seen_at
    FROM accounting_journal_entries e
    LEFT JOIN accounting_external_identities x ON x.workspace_id = e.workspace_id
      AND x.connector_id = ? AND x.entity_type = 'journal_entry' AND x.foundry_record_id = e.id
    WHERE e.workspace_id = ? AND e.source_record_type = 'accounting_connection_test'
      AND e.source_record_id = ? AND e.status = 'POSTED' ORDER BY e.entry_number`)
    .all(connectorId, workspaceId, connectorId);
  const proofConfirmedAt = proofEntries.reduce((latestAt, entry) => entry.last_seen_at > latestAt ? entry.last_seen_at : latestAt, '');
  const sandboxProof = proofEntries.length ? { entries: proofEntries,
    passed: proofEntries.length === 2 && proofEntries.every((entry) => entry.external_id)
      && latest?.status === 'MATCHED' && Boolean(latest.completed_at)
      && latest.completed_at >= proofConfirmedAt,
  } : null;
  return { policy: current,
    latestShadow: latest ? { ...latest, differences: json(latest.differences, []),
      localSnapshot: json(latest.local_snapshot, {}), externalSnapshot: json(latest.external_snapshot, {}) } : null,
    conflicts: db.prepare(`SELECT * FROM accounting_sync_conflicts WHERE workspace_id = ? AND connector_id = ?
      ORDER BY created_at DESC LIMIT 20`).all(workspaceId, connectorId),
    identities: db.prepare(`SELECT * FROM accounting_external_identities WHERE workspace_id = ? AND connector_id = ?
      ORDER BY entity_type, foundry_record_id`).all(workspaceId, connectorId),
    openingBooks: openingBooksPreview(db, workspaceId, connectorId),
    sandboxProof,
  };
}

module.exports = { policy, initialize, chooseAuthority, localSnapshot, compare, shadow, mapAccount, enableWrites, syncPending,
  createSandboxProof, conflict, state, rememberExactAccounts, openingBooksPreview, importOpeningBooks,
  importedAccountShape, hash, stable };
