'use strict';

const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { newId } = require('../lib/util');

const EXCLUDED_TABLES = new Set(['sqlite_sequence']);
const DERIVED_TABLES = new Set(['item_catalog_rollups', 'item_location_balances', 'search_documents']);
const DERIVED_COUNTS = Object.freeze({
  item_catalog_rollups: 'SELECT COUNT(*) FROM items',
  item_location_balances: `SELECT COUNT(*) FROM (
    SELECT b.workspace_id,s.item_id,b.location_id
    FROM balances b JOIN skus s ON s.id=b.sku_id
    GROUP BY b.workspace_id,s.item_id,b.location_id
  ) expected`,
  search_documents: `SELECT
    (SELECT COUNT(*) FROM items) +
    (SELECT COUNT(*) FROM skus) +
    (SELECT COUNT(*) FROM supplier_items) +
    (SELECT COUNT(*) FROM catalog_attributes)`,
});

function quote(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function sourceTables(database) {
  return database.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND sql IS NOT NULL ORDER BY rowid`).all()
    .filter((row) => !EXCLUDED_TABLES.has(row.name) && !row.name.startsWith('search_documents_fts'));
}

function columns(database, table) {
  return database.prepare(`PRAGMA table_xinfo(${quote(table)})`).all()
    .filter((column) => column.hidden === 0)
    .sort((first, second) => first.cid - second.cid);
}

function orderedRows(database, table, tableColumns) {
  const primary = tableColumns.filter((column) => column.pk).sort((first, second) => first.pk - second.pk);
  const ordering = primary.length ? primary.map((column) => quote(column.name)).join(', ') : 'rowid';
  return database.prepare(`SELECT * FROM ${quote(table)} ORDER BY ${ordering}`).iterate();
}

function updateHash(hash, value) {
  if (value === null || value === undefined) hash.update('null\0');
  else if (Buffer.isBuffer(value)) {
    hash.update('buffer:');
    hash.update(value);
    hash.update('\0');
  }
  else hash.update(`${typeof value}:${String(value)}\0`);
}

function fingerprint(database, tables) {
  const schema = crypto.createHash('sha256');
  const data = crypto.createHash('sha256');
  for (const table of tables) {
    const tableColumns = columns(database, table.name);
    schema.update(`${table.name}\0${table.sql}\0${tableColumns.map((column) => JSON.stringify(column)).join('\0')}\0`);
    data.update(`${table.name}\0`);
    for (const row of orderedRows(database, table.name, tableColumns)) {
      for (const column of tableColumns) updateHash(data, row[column.name]);
    }
  }
  return { schema: schema.digest('hex'), data: data.digest('hex') };
}

function sqliteScalar(database, statement) {
  const row = database.prepare(statement).get();
  const value = row ? Object.values(row)[0] : 0;
  return String(value ?? 0);
}

async function postgresScalar(client, statement) {
  const result = await client.query(statement);
  const value = result.rows[0] ? Object.values(result.rows[0])[0] : 0;
  return String(value ?? 0);
}

const RECONCILIATIONS = Object.freeze([
  ['workspace_count', 'SELECT COUNT(*) FROM workspaces'],
  ['item_count', 'SELECT COUNT(*) FROM items'],
  ['sku_count', 'SELECT COUNT(*) FROM skus'],
  ['location_count', 'SELECT COUNT(*) FROM locations'],
  ['movement_count', 'SELECT COUNT(*) FROM movements'],
  ['movement_quantity', 'SELECT COALESCE(SUM(quantity_delta), 0) FROM movements'],
  ['on_hand', 'SELECT COALESCE(SUM(on_hand), 0) FROM balances'],
  ['purchase_order_count', 'SELECT COUNT(*) FROM purchase_orders'],
  ['sales_order_count', 'SELECT COUNT(*) FROM sales_orders'],
  ['journal_entry_count', 'SELECT COUNT(*) FROM accounting_journal_entries'],
  ['journal_debits', 'SELECT COALESCE(SUM(debit_minor), 0) FROM accounting_journal_lines'],
  ['journal_credits', 'SELECT COALESCE(SUM(credit_minor), 0) FROM accounting_journal_lines'],
]);

async function reconcile(source, client, tables) {
  const report = { tables: {}, business: {} };
  for (const table of tables) {
    const storedSourceCount = sqliteScalar(source, `SELECT COUNT(*) FROM ${quote(table.name)}`);
    const sourceCount = DERIVED_COUNTS[table.name]
      ? sqliteScalar(source, DERIVED_COUNTS[table.name]) : storedSourceCount;
    const targetCount = await postgresScalar(client, `SELECT COUNT(*) FROM ${quote(table.name)}`);
    report.tables[table.name] = { source: sourceCount, target: targetCount, match: sourceCount === targetCount };
    if (DERIVED_COUNTS[table.name]) {
      report.tables[table.name].sourceStored = storedSourceCount;
      report.tables[table.name].sourceMeaning = 'canonical expected projection';
    }
  }
  for (const [name, statement] of RECONCILIATIONS) {
    const sourceValue = sqliteScalar(source, statement);
    const targetValue = await postgresScalar(client, statement);
    report.business[name] = { source: sourceValue, target: targetValue, match: sourceValue === targetValue };
  }
  report.balancedJournal = report.business.journal_debits.target === report.business.journal_credits.target;
  report.matches = Object.values(report.tables).every((entry) => entry.match)
    && Object.values(report.business).every((entry) => entry.match)
    && report.balancedJournal;
  return report;
}

function summarizeReconciliation(report) {
  const tableMismatches = Object.entries(report?.tables || {})
    .filter(([, result]) => !result.match)
    .map(([name, result]) => `${name}(${result.source}->${result.target})`);
  const businessMismatches = Object.entries(report?.business || {})
    .filter(([, result]) => !result.match)
    .map(([name, result]) => `${name}(${result.source}->${result.target})`);
  if (report && !report.balancedJournal) businessMismatches.push('balancedJournal(false)');
  return [...tableMismatches, ...businessMismatches].join(', ') || 'unknown mismatch';
}

async function targetHasBusinessData(postgres) {
  const result = await postgres.query(`SELECT
    (SELECT COUNT(*) FROM accounts) +
    (SELECT COUNT(*) FROM workspaces) +
    (SELECT COUNT(*) FROM movements) +
    (SELECT COUNT(*) FROM accounting_journal_entries) AS count`);
  return BigInt(result.rows[0].count) > 0n;
}

function valueBytes(value) {
  if (value === null || value === undefined) return 4;
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return Buffer.byteLength(value);
  return 16;
}

async function copyTable(source, client, table) {
  const tableColumns = columns(source, table.name);
  if (!tableColumns.length) return;
  const names = tableColumns.map((column) => column.name);
  const batchSize = Math.max(1, Math.floor(10000 / names.length));
  const batchByteLimit = 2 * 1024 * 1024;
  let batch = [];
  let batchBytes = 0;
  async function flush() {
    if (!batch.length) return;
    const values = [];
    const rows = batch.map((row) => `(${names.map((name) => {
      values.push(row[name] === undefined ? null : row[name]);
      return `$${values.length}`;
    }).join(', ')})`);
    await client.query(`INSERT INTO ${quote(table.name)} (${names.map(quote).join(', ')}) VALUES ${rows.join(', ')}`, values);
    batch = [];
    batchBytes = 0;
  }
  try {
    for (const row of orderedRows(source, table.name, tableColumns)) {
      const rowBytes = names.reduce((total, name) => total + valueBytes(row[name]), 0);
      if (batch.length && (batch.length >= batchSize || batchBytes + rowBytes > batchByteLimit)) await flush();
      batch.push(row);
      batchBytes += rowBytes;
      if (batch.length >= batchSize || batchBytes >= batchByteLimit) await flush();
    }
    await flush();
  } catch (error) {
    error.message = `Could not migrate ${table.name}: ${error.message || error.code || 'unknown database error'}`;
    throw error;
  }
}

async function rebuildDerivedData(client) {
  await client.query('DELETE FROM item_catalog_rollups');
  await client.query('DELETE FROM item_location_balances');
  await client.query('DELETE FROM search_documents');
  await client.query(`INSERT INTO item_catalog_rollups
      (workspace_id,item_id,sku_count,first_sku_id,first_sku_code,first_sku_position,updated_at)
    SELECT i.workspace_id,i.id,COUNT(s.id),
      (SELECT id FROM skus WHERE item_id=i.id ORDER BY position,id LIMIT 1),
      (SELECT code FROM skus WHERE item_id=i.id ORDER BY position,id LIMIT 1),
      (SELECT position FROM skus WHERE item_id=i.id ORDER BY position,id LIMIT 1),i.updated_at
    FROM items i LEFT JOIN skus s ON s.item_id=i.id GROUP BY i.id`);
  await client.query(`INSERT INTO item_location_balances(workspace_id,item_id,location_id,on_hand,updated_at)
    SELECT b.workspace_id,s.item_id,b.location_id,SUM(b.on_hand),MAX(b.updated_at)
    FROM balances b JOIN skus s ON s.id=b.sku_id
    GROUP BY b.workspace_id,s.item_id,b.location_id`);
  await client.query(`INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
    SELECT workspace_id,'item',id,name,COALESCE(base_code,''),COALESCE(description,'') || ' ' || COALESCE(unit_label,''),updated_at FROM items
    UNION ALL
    SELECT s.workspace_id,'sku',s.id,i.name || ' ' || COALESCE(s.variant_label,''),s.code || ' ' || COALESCE(s.barcode,''),
      COALESCE(i.description,''),s.created_at FROM skus s JOIN items i ON i.id=s.item_id
    UNION ALL
    SELECT si.workspace_id,'supplier_item',si.id,COALESCE(si.supplier_description,i.name),COALESCE(si.supplier_sku,''),
      sp.name || ' ' || s.code || ' ' || i.name,si.updated_at FROM supplier_items si
      JOIN suppliers sp ON sp.id=si.supplier_id JOIN skus s ON s.id=si.sku_id JOIN items i ON i.id=s.item_id
    UNION ALL
    SELECT workspace_id,'attribute',id,attribute_value,attribute_key,subject_type || ' ' || subject_id,updated_at FROM catalog_attributes`);
}

async function resetIdentities(client) {
  const result = await client.query(`SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND is_identity = 'YES'
    ORDER BY table_name, ordinal_position`);
  for (const row of result.rows) {
    const maximum = await client.query(`SELECT COALESCE(MAX(${quote(row.column_name)}), 0) AS value FROM ${quote(row.table_name)}`);
    const value = BigInt(maximum.rows[0].value || 0);
    const sequence = await client.query('SELECT pg_get_serial_sequence($1, $2) AS name', [row.table_name, row.column_name]);
    if (sequence.rows[0].name) await client.query('SELECT setval($1, $2, $3)', [sequence.rows[0].name, String(value || 1n), value > 0n]);
  }
}

async function recordFailure(postgres, input, error) {
  await postgres.query(`INSERT INTO stockchief_migration_runs
      (id, source_fingerprint, source_schema_fingerprint, status, reconciliation, started_at)
    VALUES ($1, $2, $3, 'FAILED', $4::jsonb, now())
    ON CONFLICT (source_fingerprint) DO UPDATE SET status = 'FAILED', reconciliation = EXCLUDED.reconciliation,
      started_at = now(), completed_at = NULL`,
  [input.id, input.sourceFingerprint, input.schemaFingerprint, JSON.stringify({
    error: String(error.message || error),
    ...(error.reconciliation ? { reconciliation: error.reconciliation } : {}),
  })]);
}

function openCutoverSource(sqlitePath) {
  const source = new Database(sqlitePath, { fileMustExist: true });
  source.pragma('busy_timeout = 1000');
  try {
    source.exec('BEGIN IMMEDIATE');
    source.pragma('query_only = ON');
    return source;
  } catch (error) {
    source.close();
    if (error.code === 'SQLITE_BUSY') {
      throw new Error('SQLite is still accepting writes. Stop the StockChief web and worker processes before cutover.');
    }
    throw error;
  }
}

async function migrateSqliteToPostgres({ sqlitePath, postgres, migrationId = newId('pgcutover'), onProgress = null }) {
  if (!sqlitePath || sqlitePath === ':memory:') throw new Error('A file-backed SQLite database is required for PostgreSQL cutover.');
  const source = openCutoverSource(sqlitePath);
  try {
    const tables = sourceTables(source);
    let identity;
    try {
      identity = fingerprint(source, tables);
    } catch (error) {
      error.message = `Could not fingerprint the SQLite source: ${error.message || error.code || 'unknown database error'}`;
      throw error;
    }
    const prior = await postgres.query(`SELECT id, status, reconciliation FROM stockchief_migration_runs
      WHERE source_fingerprint = $1`, [identity.data]);
    if (prior.rows[0]?.status === 'COMPLETED') {
      return { id: prior.rows[0].id, reused: true, reconciliation: prior.rows[0].reconciliation };
    }
    if (await targetHasBusinessData(postgres)) {
      throw new Error('PostgreSQL already contains business data. Cutover requires an empty target or the exact completed migration.');
    }
    const input = { id: migrationId, sourceFingerprint: identity.data, schemaFingerprint: identity.schema };
    try {
      const reconciliation = await postgres.transaction(async (client) => {
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        await client.query(`INSERT INTO stockchief_migration_runs
            (id, source_fingerprint, source_schema_fingerprint, status, started_at)
          VALUES ($1, $2, $3, 'RUNNING', now())
          ON CONFLICT (source_fingerprint) DO UPDATE SET id = EXCLUDED.id, status = 'RUNNING',
            source_schema_fingerprint = EXCLUDED.source_schema_fingerprint, reconciliation = NULL,
            started_at = now(), completed_at = NULL`,
        [input.id, input.sourceFingerprint, input.schemaFingerprint]);
        for (const table of tables) {
          if (DERIVED_TABLES.has(table.name)) continue;
          if (onProgress) onProgress({ phase: 'copy', table: table.name });
          await copyTable(source, client, table);
        }
        await rebuildDerivedData(client);
        await resetIdentities(client);
        const report = await reconcile(source, client, tables);
        if (!report.matches) {
          const error = new Error(`PostgreSQL reconciliation did not match canonical SQLite truth: ${summarizeReconciliation(report)}`);
          error.reconciliation = report;
          throw error;
        }
        await client.query(`UPDATE stockchief_migration_runs SET status = 'COMPLETED', reconciliation = $2::jsonb,
          completed_at = now() WHERE id = $1`, [input.id, JSON.stringify(report)]);
        return report;
      }, { isolation: 'SERIALIZABLE', statementTimeoutMs: 30 * 60 * 1000, lockTimeoutMs: 30000 });
      return { id: input.id, reused: false, sourceFingerprint: identity.data, schemaFingerprint: identity.schema, reconciliation };
    } catch (error) {
      await recordFailure(postgres, input, error);
      throw error;
    }
  } finally {
    if (source.inTransaction) source.exec('ROLLBACK');
    source.close();
  }
}

module.exports = { migrateSqliteToPostgres, reconcile, fingerprint, sourceTables, openCutoverSource,
  rebuildDerivedData, summarizeReconciliation };
