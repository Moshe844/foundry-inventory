'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const reports = require('./reports');
const connections = require('../connections/service');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso } = require('../lib/util');

const stable = (value) => JSON.stringify(value, Object.keys(value || {}).sort());
const hash = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const json = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

function policy(db, workspaceId, connectorId) {
  const row = db.prepare(`SELECT * FROM accounting_sync_policies
    WHERE workspace_id = ? AND connector_id = ?`).get(workspaceId, connectorId);
  if (!row) throw new NotFoundError('Accounting synchronization policy not found. Reconnect this accounting system.');
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
    throw new ValidationError('Foundry cannot post outward while the external system is declared the accounting source of truth.');
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
    title: 'Accounting systems disagree and Foundry stopped',
    detail: input.detail || 'The same accounting identity changed differently in Foundry and the external books.',
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
    if (!other) differences.push({ kind: 'MISSING_EXTERNAL_ACCOUNT', code: account.code,
      foundryMinor: account.balanceMinor, externalMinor: null });
    else if (Number(other.balanceMinor) !== Number(account.balanceMinor)) differences.push({
      kind: 'BALANCE_MISMATCH', code: account.code, foundryMinor: account.balanceMinor,
      externalMinor: Number(other.balanceMinor), differenceMinor: Number(other.balanceMinor) - Number(account.balanceMinor),
    });
  }
  for (const account of external.accounts || []) {
    if (!account.code || !local.accounts.some((row) => String(row.code).toLowerCase() === String(account.code).toLowerCase())) {
      differences.push({ kind: 'UNMAPPED_EXTERNAL_ACCOUNT', externalId: account.externalId || null,
        code: account.code || null, externalName: account.name || null, externalMinor: Number(account.balanceMinor || 0) });
    }
  }
  if (external.currency && local.currency && external.currency !== local.currency) {
    differences.push({ kind: 'CURRENCY_MISMATCH', foundry: local.currency, external: external.currency });
  }
  return differences;
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
        detail: `The provider returned an accounting snapshot from ${external.asOf}, older than the accepted checkpoint ${checkpoint.watermark_at}. Foundry ignored it.` });
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
        .run(runId, status === 'MATCHED' && current.requested_authority === 'POST' ? 'WRITE_READY' : 'SHADOW',
          done, ctx.workspaceId, connectorId);
      db.prepare(`UPDATE workspace_connectors SET setup_status = ?, last_synced_at = ?,
        last_activity_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
        .run(status === 'MATCHED' ? (current.requested_authority === 'POST' ? 'WRITE_READY' : 'SHADOW_MATCHED') : 'ACCOUNTING_CONFLICT',
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
  if (!account) throw new ValidationError('Choose an active Foundry account.');
  const current = state(db, ctx.workspaceId, connectorId);
  const external = current?.latestShadow?.externalSnapshot?.accounts?.find((row) => String(row.externalId) === externalId);
  if (!external) throw new ValidationError('That external account is not present in the latest verified snapshot.');
  const occupied = db.prepare(`SELECT foundry_record_id FROM accounting_external_identities
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'account' AND external_id = ?`)
    .get(ctx.workspaceId, connectorId, externalId);
  if (occupied && occupied.foundry_record_id !== account.id) {
    throw new ValidationError('That external account is already mapped to a different Foundry account.');
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
    throw new ValidationError('Choose Foundry as accounting source and request posting authority first.');
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

async function syncPending(db, ctx, connectorId, adapter, credentials) {
  const current = policy(db, ctx.workspaceId, connectorId);
  if (current.stage !== 'WRITE_ENABLED') throw new ValidationError('Posting is not enabled for this accounting connection.');
  if (!adapter?.postJournalEntry) throw new ValidationError('This provider does not support governed journal posting.');
  const entries = db.prepare(`SELECT e.* FROM accounting_journal_entries e
    WHERE e.workspace_id = ? AND e.status = 'POSTED'
      AND NOT EXISTS (SELECT 1 FROM accounting_external_identities x
        WHERE x.workspace_id = e.workspace_id AND x.connector_id = ?
          AND x.entity_type = 'journal_entry' AND x.foundry_record_id = e.id)
    ORDER BY e.entry_number LIMIT 100`).all(ctx.workspaceId, connectorId);
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
        detail: `Journal ${entry.entry_number} uses ${missing.length} account${missing.length === 1 ? '' : 's'} without an exact external identity. Foundry did not post it.` });
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

function state(db, workspaceId, connectorId) {
  let current = null; try { current = policy(db, workspaceId, connectorId); } catch { return null; }
  const latest = db.prepare(`SELECT * FROM accounting_shadow_runs WHERE workspace_id = ? AND connector_id = ?
      ORDER BY started_at DESC LIMIT 1`).get(workspaceId, connectorId) || null;
  return { policy: current,
    latestShadow: latest ? { ...latest, differences: json(latest.differences, []),
      localSnapshot: json(latest.local_snapshot, {}), externalSnapshot: json(latest.external_snapshot, {}) } : null,
    conflicts: db.prepare(`SELECT * FROM accounting_sync_conflicts WHERE workspace_id = ? AND connector_id = ?
      ORDER BY created_at DESC LIMIT 20`).all(workspaceId, connectorId),
    identities: db.prepare(`SELECT * FROM accounting_external_identities WHERE workspace_id = ? AND connector_id = ?
      ORDER BY entity_type, foundry_record_id`).all(workspaceId, connectorId),
  };
}

module.exports = { policy, initialize, chooseAuthority, localSnapshot, compare, shadow, mapAccount, enableWrites, syncPending,
  conflict, state, rememberExactAccounts, hash, stable };
