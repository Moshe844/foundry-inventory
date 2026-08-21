'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const FOUNDRY_SCHEMA_PATH = path.join(__dirname, 'schema-foundry.sql');
const ATTENTION_SCHEMA_PATH = path.join(__dirname, 'schema-attention.sql');
const ACTIONS_SCHEMA_PATH = path.join(__dirname, 'schema-actions.sql');
const IMPORTS_SCHEMA_PATH = path.join(__dirname, 'schema-imports.sql');
const PURCHASING_SCHEMA_PATH = path.join(__dirname, 'schema-purchasing.sql');
const ONBOARDING_SCHEMA_PATH = path.join(__dirname, 'schema-onboarding.sql');
const AUTOPILOT_SCHEMA_PATH = path.join(__dirname, 'schema-autopilot.sql');
const MANAGER_SCHEMA_PATH = path.join(__dirname, 'schema-manager.sql');

/**
 * Opens (and initialises) a SQLite database.
 *
 * WAL + a generous busy timeout let several processes write concurrently
 * without corrupting each other; write transactions are opened IMMEDIATE by
 * the engine so that two writers never both read-then-write the same balance.
 */
function openDatabase(databasePath, options = {}) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath, { verbose: options.verbose });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  migrate(db);
  return db;
}

/**
 * Columns added to a table that already exists in databases in the field.
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a new column
 * needs an explicit ALTER — kept declarative here rather than as a numbered
 * migration chain, because every entry is additive and independently safe.
 */
const ADDED_COLUMNS = [
  {
    table: 'workspaces',
    column: 'source_of_truth_mode',
    definition: "TEXT NOT NULL DEFAULT 'FOUNDRY_NATIVE'",
  },
  { table: 'attention_items', column: 'item_id', definition: 'TEXT' },
  { table: 'attention_items', column: 'sku_id', definition: 'TEXT' },
  { table: 'accounts', column: 'last_workspace_id', definition: 'TEXT' },
  // Per-workspace action permissions, granted on top of the membership role.
  { table: 'users', column: 'permissions', definition: 'TEXT' },
  { table: 'physical_events', column: 'attachment_mime', definition: 'TEXT' },
  { table: 'physical_events', column: 'attachment_content', definition: 'BLOB' },
  { table: 'suppliers', column: 'item_code_label', definition: "TEXT NOT NULL DEFAULT 'Supplier code'" },
  { table: 'suppliers', column: 'item_code_aliases', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'setup_documents', column: 'supplier_code_label', definition: "TEXT NOT NULL DEFAULT 'Supplier code'" },
];

function addMissingColumns(db) {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    // No table yet: the CREATE below will build it with the column already in.
    if (info.length === 0) continue;
    if (info.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function hasColumn(db, table, column) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/**
 * Renames every remaining `org_id` to `workspace_id`, whatever the table.
 *
 * Discovered rather than listed on purpose: a hardcoded list of tables is a
 * thing that goes stale the moment a table is added, and a single missed table
 * leaves a column no query can find — which is exactly the bug this replaced.
 * Scanning is cheap and cannot drift. Safe to run repeatedly.
 */
function renameLegacyTenancyColumns(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);

  let renamed = 0;
  for (const table of tables) {
    if (!hasColumn(db, table, 'org_id')) continue;
    if (hasColumn(db, table, 'workspace_id')) continue; // already carries both; leave it
    db.exec(`ALTER TABLE ${table} RENAME COLUMN org_id TO workspace_id`);
    renamed += 1;
  }
  return renamed;
}

/**
 * Multi-workspace tenancy.
 *
 * Databases written before this release call the tenant an "organization" and
 * carry the login on the per-tenant user row, which makes one email reachable
 * from exactly one tenant. This lifts the login into `accounts` and turns
 * `users` into a membership, so one person can hold many inventories — without
 * touching a single movement. `actor_user_id` still points at the same rows.
 */
function migrateToWorkspaces(db) {
  if (!tableExists(db, 'organizations')) {
    // Not a pre-workspace database, but it may still be a half-migrated one.
    if (renameLegacyTenancyColumns(db) > 0) return true;
    return false;
  }

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');

    db.exec('ALTER TABLE organizations RENAME TO workspaces');
    if (tableExists(db, 'org_configuration') && !tableExists(db, 'workspace_configuration')) {
      db.exec('ALTER TABLE org_configuration RENAME TO workspace_configuration');
    }
    renameLegacyTenancyColumns(db);

    db.exec(`CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL)`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_email ON accounts(email)');

    if (!hasColumn(db, 'workspaces', 'owner_account_id')) {
      db.exec('ALTER TABLE workspaces ADD COLUMN owner_account_id TEXT');
    }
    if (!hasColumn(db, 'users', 'account_id')) {
      db.exec('ALTER TABLE users ADD COLUMN account_id TEXT');
    }

    // One account per distinct email; the earliest row wins the name and hash.
    // Skipped when the login has already been lifted out — a database can reach
    // here half-migrated, and re-running must be a no-op rather than an error.
    const legacy = hasColumn(db, 'users', 'email')
      ? db
          .prepare('SELECT id, workspace_id, email, name, password_hash, role, created_at FROM users ORDER BY created_at, id')
          .all()
      : [];
    const byEmail = new Map();
    for (const user of legacy) {
      const key = String(user.email || '').toLowerCase();
      if (!key) continue;
      if (!byEmail.has(key)) {
        const accountId = `acc_${user.id.replace(/^usr_/, '')}`;
        db.prepare(
          `INSERT INTO accounts (id, email, name, password_hash, plan, created_at)
           VALUES (?, ?, ?, ?, 'free', ?)`
        ).run(accountId, key, user.name, user.password_hash, user.created_at);
        byEmail.set(key, accountId);
      }
      db.prepare('UPDATE users SET account_id = ? WHERE id = ?').run(byEmail.get(key), user.id);
    }

    // The first owner of each workspace becomes its owning account.
    for (const row of db.prepare("SELECT workspace_id, account_id FROM users WHERE role = 'owner' ORDER BY created_at").all()) {
      db.prepare(
        'UPDATE workspaces SET owner_account_id = ? WHERE id = ? AND owner_account_id IS NULL'
      ).run(row.account_id, row.workspace_id);
    }

    db.exec('DROP INDEX IF EXISTS uq_users_email');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
}

/**
 * The old `users` table still carries email/password_hash columns after the
 * rename. They are dropped only once every row has an account, so a failed
 * upgrade never strands a login.
 */
function dropLegacyUserLogin(db) {
  if (!hasColumn(db, 'users', 'email')) return;
  const orphans = db.prepare('SELECT COUNT(*) AS n FROM users WHERE account_id IS NULL').get().n;
  if (orphans > 0) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('ALTER TABLE users DROP COLUMN email');
    if (hasColumn(db, 'users', 'password_hash')) db.exec('ALTER TABLE users DROP COLUMN password_hash');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Drops the CHECK that enumerated action types.
 *
 * SQLite cannot alter a constraint in place, so the table is rebuilt. The list
 * lives in application code, which is the only place it can be kept honest.
 */
/**
 * Drops a CHECK constraint from one column of an existing table.
 *
 * SQLite cannot alter a constraint in place, so the table is rebuilt. This is
 * needed wherever a list of allowed values lives in application code and is
 * expected to grow: an enum duplicated in SQL goes stale, and the failure it
 * produces is a constraint error at the far end of a feature rather than a
 * clear message.
 *
 * Called *before* the schema file that owns the table, so the CREATE INDEX
 * statements in that file put back the indexes the rebuild drops.
 */
function relaxColumnCheck(db, table, column) {
  if (!tableExists(db, table)) return false;
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row) return false;

  // The whole column definition up to its CHECK, whatever sits in between.
  //
  // A DEFAULT clause between the type and the CHECK used to mean no match, and
  // no match was indistinguishable from nothing to do. So the constraint stayed
  // and the first write of a newly allowed value failed at runtime — but only in
  // databases that already existed, because fresh ones are built from the schema
  // file and never needed the rebuild. That is what made the silence expensive:
  // every test passed and the customer's own database was the one that broke.
  const KEEP = `${column}\\s+TEXT NOT NULL(?:\\s+DEFAULT\\s+(?:'[^']*'|[^\\s(]+))?`;
  const stillChecked = (sql) => new RegExp(`${KEEP}\\s*CHECK`, 's').test(sql);
  if (!stillChecked(row.sql)) return false;

  const rebuilt = row.sql
    .replace(new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}`, 'i'), `CREATE TABLE ${table}_rebuilt`)
    .replace(new RegExp(`(${KEEP})\\s*CHECK\\s*\\([^)]*\\)\\)?,`, 's'), '$1,');

  // A rebuild that did not actually drop the constraint is worse than none: it
  // reports success and fails later, somewhere else.
  if (stillChecked(rebuilt)) {
    throw new Error(`relaxColumnCheck could not drop the CHECK on ${table}.${column}`);
  }


  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
    .join(', ');

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(rebuilt);
    db.exec(`INSERT INTO ${table}_rebuilt (${columns}) SELECT ${columns} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_rebuilt RENAME TO ${table}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
}

function migrate(db) {
  // Tenancy first: everything below assumes workspace_id exists.
  migrateToWorkspaces(db);

  // Inventory truth first, then configuration, then interpretation.
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(FOUNDRY_SCHEMA_PATH, 'utf8'));
  // Before the attention schema, not after: that file creates indexes over the
  // new columns, and CREATE INDEX on a column an older table does not have yet
  // fails outright. Widen the table first, then let the schema fill in the rest.
  addMissingColumns(db);

  // Enum CHECKs are relaxed before the schema files that own those tables, so
  // the CREATE INDEX statements in them restore the indexes a rebuild drops.
  relaxColumnCheck(db, 'attention_items', 'category');
  relaxColumnCheck(db, 'action_proposals', 'action_type');
  relaxColumnCheck(db, 'work_items', 'category');
  // Routing outcomes grow with the ways a request can end. REFUSED — understood
  // and declined by a rule — is one the enumerated list did not have.
  relaxColumnCheck(db, 'manager_intents', 'status');

  db.exec(fs.readFileSync(ATTENTION_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(ACTIONS_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(IMPORTS_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(PURCHASING_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(ONBOARDING_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(AUTOPILOT_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(MANAGER_SCHEMA_PATH, 'utf8'));
  dropLegacyUserLogin(db);
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', '11')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run();
}

/**
 * Runs `fn` inside an IMMEDIATE transaction, retrying if another process holds
 * the write lock for longer than the busy timeout.
 */
function inTransaction(db, fn) {
  const runner = db.transaction(fn);
  let attempt = 0;
  for (;;) {
    try {
      return runner.immediate();
    } catch (err) {
      const busy = err && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_BUSY_SNAPSHOT');
      if (!busy || attempt >= 8) throw err;
      attempt += 1;
      // Synchronous, jitter-free backoff: this process holds no locks here.
      const until = Date.now() + 10 * attempt;
      while (Date.now() < until) { /* spin briefly, then retry */ }
    }
  }
}

module.exports = {
  openDatabase,
  migrate,
  inTransaction,
  relaxColumnCheck,
  SCHEMA_PATH,
};
