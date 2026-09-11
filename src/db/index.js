'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
const SALES_SCHEMA_PATH = path.join(__dirname, 'schema-sales.sql');
const CONNECTIONS_SCHEMA_PATH = path.join(__dirname, 'schema-connections.sql');
const ACCOUNTING_SCHEMA_PATH = path.join(__dirname, 'schema-accounting.sql');
const FORECASTING_SCHEMA_PATH = path.join(__dirname, 'schema-forecasting.sql');
const SHIPPING_SCHEMA_PATH = path.join(__dirname, 'schema-shipping.sql');
const PROVENANCE_SCHEMA_PATH = path.join(__dirname, 'schema-provenance.sql');
const REPAIRS_SCHEMA_PATH = path.join(__dirname, 'schema-repairs.sql');
const RUNTIME_SCHEMA_PATH = path.join(__dirname, 'schema-runtime.sql');
const WAREHOUSE_SCHEMA_PATH = path.join(__dirname, 'schema-warehouse.sql');
const TRANSFERS_SCHEMA_PATH = path.join(__dirname, 'schema-transfers.sql');
const UOM_COSTING_SCHEMA_PATH = path.join(__dirname, 'schema-uom-costing.sql');
const OPERATIONS_SCHEMA_PATH = path.join(__dirname, 'schema-operations.sql');
const ACCOUNTING_INTEGRATIONS_SCHEMA_PATH = path.join(__dirname, 'schema-accounting-integrations.sql');
const SCHEMA_PATHS = [SCHEMA_PATH, FOUNDRY_SCHEMA_PATH, ATTENTION_SCHEMA_PATH,
  ACTIONS_SCHEMA_PATH, IMPORTS_SCHEMA_PATH, PURCHASING_SCHEMA_PATH,
  ONBOARDING_SCHEMA_PATH, AUTOPILOT_SCHEMA_PATH, MANAGER_SCHEMA_PATH,
  SALES_SCHEMA_PATH, CONNECTIONS_SCHEMA_PATH, ACCOUNTING_SCHEMA_PATH,
  FORECASTING_SCHEMA_PATH, SHIPPING_SCHEMA_PATH, PROVENANCE_SCHEMA_PATH,
  REPAIRS_SCHEMA_PATH, RUNTIME_SCHEMA_PATH, WAREHOUSE_SCHEMA_PATH, TRANSFERS_SCHEMA_PATH,
  UOM_COSTING_SCHEMA_PATH, OPERATIONS_SCHEMA_PATH, ACCOUNTING_INTEGRATIONS_SCHEMA_PATH];

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
  // Historical links are added only when an existing foreign key or immutable
  // event payload proves them. This is idempotent and never manufactures a
  // relationship merely because timestamps or amounts happen to resemble one
  // another.
  require('../provenance/backfill').backfillAll(db);
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
  {
    // This is an operating boundary, not a phrase classifier. A workspace
    // deliberately created for synthetic data stays synthetic until its owner
    // explicitly changes it; words such as "realistic" never change the row.
    table: 'workspaces',
    column: 'data_mode',
    definition: "TEXT NOT NULL DEFAULT 'production' CHECK (data_mode IN ('production','synthetic'))",
  },
  { table: 'attention_items', column: 'item_id', definition: 'TEXT' },
  { table: 'attention_items', column: 'sku_id', definition: 'TEXT' },
  { table: 'accounts', column: 'last_workspace_id', definition: 'TEXT' },
  // The scanned code on the product itself — GTIN, UPC, EAN. Distinct from
  // the SKU: one is what the business calls the product, the other is what a
  // scanner reads off the box, and a file usually carries both in separate
  // columns. Nullable, because most inventories never have one.
  { table: 'skus', column: 'barcode', definition: 'TEXT' },
  { table: 'locations', column: 'parent_location_id', definition: 'TEXT REFERENCES locations(id) ON DELETE RESTRICT' },
  { table: 'locations', column: 'barcode', definition: 'TEXT' },
  { table: 'locations', column: 'pick_sequence', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // Per-workspace action permissions, granted on top of the membership role.
  { table: 'users', column: 'permissions', definition: 'TEXT' },
  { table: 'physical_events', column: 'attachment_mime', definition: 'TEXT' },
  { table: 'physical_events', column: 'attachment_content', definition: 'BLOB' },
  { table: 'suppliers', column: 'item_code_label', definition: "TEXT NOT NULL DEFAULT 'Supplier code'" },
  { table: 'suppliers', column: 'item_code_aliases', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'suppliers', column: 'preferred_ordering_method', definition: "TEXT NOT NULL DEFAULT 'email'" },
  { table: 'suppliers', column: 'watched_connector_id', definition: 'TEXT' },
  { table: 'suppliers', column: 'prepare_communications', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'suppliers', column: 'auto_send_enabled', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'suppliers', column: 'auto_send_limit_minor', definition: 'INTEGER' },
  { table: 'suppliers', column: 'price_tolerance_percent', definition: 'REAL NOT NULL DEFAULT 5' },
  { table: 'suppliers', column: 'quantity_tolerance_percent', definition: 'REAL NOT NULL DEFAULT 0' },
  { table: 'suppliers', column: 'trusted_delivery_receipt', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'suppliers', column: 'follow_up_days', definition: 'INTEGER NOT NULL DEFAULT 2' },
  { table: 'setup_documents', column: 'supplier_code_label', definition: "TEXT NOT NULL DEFAULT 'Supplier code'" },
  { table: 'setup_documents', column: 'scope_confirmed_at', definition: 'TEXT' },
  { table: 'import_plans', column: 'scope_confirmed_at', definition: 'TEXT' },
  { table: 'work_plans', column: 'trigger_event_id', definition: 'TEXT' },
  { table: 'work_items', column: 'trigger_event_id', definition: 'TEXT' },
  { table: 'operating_instruction_proposals', column: 'source', definition: "TEXT NOT NULL DEFAULT 'owner_instruction'" },
  { table: 'operating_guards', column: 'enforcement_mode', definition: "TEXT NOT NULL DEFAULT 'block' CHECK (enforcement_mode IN ('block','warn'))" },
  { table: 'sales_orders', column: 'currency', definition: "TEXT NOT NULL DEFAULT 'USD'" },
  { table: 'sales_orders', column: 'discount_minor', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'sales_orders', column: 'tax_minor', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // Lower numbers are served first. Existing orders retain ordinary priority;
  // an owner can elevate a genuine customer commitment without changing dates.
  { table: 'sales_orders', column: 'allocation_priority', definition: 'INTEGER NOT NULL DEFAULT 100' },
  // A Sales Order owns the address agreed for that order. Customer addresses
  // are defaults only; they are not mutable pointers for parcels already sold.
  { table: 'sales_orders', column: 'delivery_method', definition: "TEXT NOT NULL DEFAULT 'SHIP'" },
  { table: 'sales_orders', column: 'ship_to_address', definition: 'TEXT' },
  { table: 'sales_orders', column: 'ship_to_source', definition: 'TEXT' },
  { table: 'customers', column: 'record_state', definition: "TEXT NOT NULL DEFAULT 'ACTIVE'" },
  { table: 'sales_orders', column: 'customer_decision_required', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'sales_orders', column: 'delivery_decision_required', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'sales_order_lines', column: 'unit_price_minor', definition: 'INTEGER' },
  { table: 'sales_order_lines', column: 'price_source_id', definition: 'TEXT' },
  { table: 'workspace_connectors', column: 'provider_type', definition: "TEXT NOT NULL DEFAULT 'reference_webhook'" },
  { table: 'workspace_connectors', column: 'provides', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'workspace_connectors', column: 'config', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'workspace_connectors', column: 'last_activity_at', definition: 'TEXT' },
  { table: 'workspace_connectors', column: 'expected_interval_minutes', definition: 'INTEGER NOT NULL DEFAULT 360' },
  { table: 'workspace_connectors', column: 'paused_at', definition: 'TEXT' },
  { table: 'workspace_connectors', column: 'setup_status', definition: "TEXT NOT NULL DEFAULT 'CONNECTED'" },
  { table: 'workspace_connectors', column: 'authorized_by_user_id', definition: 'TEXT' },
  { table: 'workspace_connectors', column: 'provider_account_id', definition: 'TEXT' },
  { table: 'workspace_connectors', column: 'provider_account_name', definition: 'TEXT' },
  { table: 'connector_feed_events', column: 'external_version', definition: 'TEXT' },
  { table: 'connector_feed_events', column: 'payload_hash', definition: 'TEXT' },
  { table: 'connector_feed_events', column: 'normalized_payload', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'connector_feed_events', column: 'attempt_count', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'connector_feed_events', column: 'action_type', definition: 'TEXT' },
  { table: 'connector_feed_events', column: 'action_record_id', definition: 'TEXT' },
  { table: 'connector_feed_events', column: 'aggregate_key', definition: 'TEXT' },
  { table: 'connector_feed_events', column: 'last_attempt_at', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'external_thread_id', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'internet_message_id', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'content_hash', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'processing_status', definition: "TEXT NOT NULL DEFAULT 'CAPTURED'" },
  { table: 'connection_email_messages', column: 'processed_at', definition: 'TEXT' },
  // Why a customer's order email produced no draft order. NULL until a
  // draft has been attempted; the owner sees this rather than silence.
  { table: 'connection_email_messages', column: 'order_draft_reason', definition: 'TEXT' },
  // When Foundry last asked the provider what happened to this request,
  // so an order can be right about money without an inbound webhook.
  { table: 'payment_requests', column: 'checked_at', definition: 'TEXT' },
  { table: 'connection_email_attachments', column: 'extracted_text', definition: 'TEXT' },
  { table: 'connection_email_attachments', column: 'setup_document_id', definition: 'TEXT' },
  { table: 'connection_email_rules', column: 'document_mode', definition: "TEXT NOT NULL DEFAULT 'review_each'" },
  { table: 'supplier_communications', column: 'message_kind', definition: "TEXT NOT NULL DEFAULT 'purchase_order'" },
  { table: 'supplier_communications', column: 'connector_id', definition: 'TEXT' },
  { table: 'supplier_communications', column: 'external_thread_id', definition: 'TEXT' },
  { table: 'supplier_communications', column: 'approved_by_user_id', definition: 'TEXT' },
  { table: 'supplier_communications', column: 'approved_at', definition: 'TEXT' },
  { table: 'accounting_customer_invoices', column: 'payment_status_confirmed_at', definition: 'TEXT' },
  /*
   * Mail already captured predates any judgement about replies, so it arrives
   * as HANDLED. Defaulting the other way would greet an existing workspace
   * with a year of unanswered email it had in fact already dealt with, which
   * is the fastest way to make somebody stop trusting an inbox.
   *
   * The CHECK is repeated from the CREATE deliberately. Without it a migrated
   * database would accept any string in this column while a fresh one refused
   * it — two schemas wearing the same name, which is the kind of difference
   * that only shows up on somebody else's machine.
   */
  { table: 'connection_email_messages',
    column: 'reply_state',
    definition: "TEXT NOT NULL DEFAULT 'HANDLED' CHECK (reply_state IN ('NEEDS_REPLY','WAITING','HANDLED'))" },
  { table: 'connection_email_messages', column: 'reply_reason', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'reply_state_by_user_id', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'reply_state_at', definition: 'TEXT' },
  /*
   * The email a draft order was read out of.
   *
   * It is a link, not a note. The order's own `reference` field is where a
   * person writes "phoned Tuesday", so putting a message id there would
   * overwrite what they typed — a mistake already made once with payments.
   * It also makes the draft idempotent: a mailbox re-polled is not a second
   * order for the same request.
   */
  { table: 'sales_orders', column: 'source_email_message_id', definition: 'TEXT' },
  /*
   * How the goods left: by carrier, collected, or taken round by us.
   *
   * No CHECK here, unlike the fresh schema. Shipments that predate the
   * question have no answer to it, and a constraint that rejects NULL would
   * refuse to migrate a database that is telling the truth about not knowing.
   */
  { table: 'sales_shipments', column: 'handover', definition: 'TEXT' },
  /*
   * Whether Foundry may ask this customer for money without being told to.
   *
   * Off for every existing customer, deliberately. Automation that arrives
   * switched on for people who never agreed to it is how an upgrade sends
   * invoices nobody authorised.
   */
  { table: 'customer_payment_terms', column: 'auto_request_enabled', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'customer_payment_terms', column: 'auto_request_limit_minor', definition: 'INTEGER' },
  /*
   * Which order a receipt was taken against.
   *
   * A deposit paid before the goods ship has no invoice to be allocated to, so
   * the order it belongs to has to be recorded somewhere of its own. Without
   * it, a customer who had paid their deposit through Stripe still showed as
   * owing the whole order, and Foundry went on holding their goods.
   *
   * Not the reference field, which is where a person writes "cheque 4021", and
   * not the source key, which has to stay unique per provider event.
   */
  { table: 'accounting_payments', column: 'sales_order_id', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'draft_subject', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'draft_body', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'draft_source', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'draft_rejected_because', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'draft_at', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'reply_sent_at', definition: 'TEXT' },
  { table: 'connection_email_messages', column: 'reply_external_message_id', definition: 'TEXT' },

  /*
   * Shipping through a real carrier.
   *
   * A shipment already recorded which goods went where and that they left.
   * These are the facts a carrier owns: what it charged, which label it sold,
   * and where the parcel is now. `tracking_status` is the carrier's word, kept
   * apart from `status`, which stays Foundry's own account of the box — a
   * parcel can be "in transit" for a week while the shipment is simply shipped.
   */
  { table: 'sales_shipments', column: 'provider', definition: 'TEXT' },
  { table: 'sales_shipments', column: 'provider_shipment_id', definition: 'TEXT' },
  { table: 'sales_shipments', column: 'provider_rate_id', definition: 'TEXT' },
  { table: 'sales_shipments', column: 'label_url', definition: 'TEXT' },
  { table: 'sales_shipments', column: 'label_format', definition: 'TEXT' },
  { table: 'sales_shipments', column: 'tracking_status', definition: 'TEXT' },
  { table: 'sales_shipments', column: 'tracking_status_detail', definition: 'TEXT' },
  { table: 'sales_shipments', column: 'tracked_at', definition: 'TEXT' },
  { table: 'sales_shipments', column: 'exception_reason', definition: 'TEXT' },
  // What the customer was told to expect, kept on the shipment so a rate can
  // be judged against it after the fact and not only while choosing.
  { table: 'sales_shipments', column: 'promised_date', definition: 'TEXT' },
  { table: 'sales_shipments', column: 'bought_by_rule_id', definition: 'TEXT' },

  // A parcel's weight comes from what is in it. Nullable, and a shipment says
  // when it had to guess rather than quietly pricing on a number nobody knows.
  { table: 'skus', column: 'weight_grams', definition: 'INTEGER' },

  // Where a parcel leaves from. A carrier cannot quote a rate without it, and
  // Foundry cannot invent it — so it is asked for once, per location.
  { table: 'locations', column: 'address', definition: 'TEXT' },
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

/**
 * Email orders created before customer and delivery review were first-class
 * states looked complete even when the sender was new or the destination was
 * unknown. Recover those facts from their immutable source message.
 */
function backfillEmailOrderSetup(db) {
  if (!hasColumn(db, 'sales_orders', 'customer_decision_required')
      || !hasColumn(db, 'customers', 'record_state')) return;
  db.exec(`
    UPDATE sales_orders
       SET customer_decision_required = 0,
           delivery_decision_required = 0
     WHERE status IN ('PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED');

    UPDATE sales_orders
       SET delivery_decision_required = 1
     WHERE source_email_message_id IS NOT NULL
       AND status IN ('DRAFT', 'CONFIRMED', 'BACKORDERED')
       AND delivery_method = 'SHIP'
       AND (ship_to_address IS NULL OR TRIM(ship_to_address) = '');

    UPDATE sales_orders
       SET customer_decision_required = 1
     WHERE source_email_message_id IS NOT NULL
       AND status IN ('DRAFT', 'CONFIRMED', 'BACKORDERED')
       AND customer_id IN (
         SELECT c.id
           FROM customers c
           JOIN connection_email_messages m
             ON m.id = sales_orders.source_email_message_id
            AND m.workspace_id = sales_orders.workspace_id
          WHERE c.id = sales_orders.customer_id
            AND LOWER(COALESCE(c.email, '')) = LOWER(COALESCE(m.sender, ''))
            AND c.created_at >= m.received_at
       );

    UPDATE customers
       SET record_state = 'PROVISIONAL'
     WHERE id IN (SELECT customer_id FROM sales_orders WHERE customer_decision_required = 1)
       AND NOT EXISTS (
         SELECT 1 FROM sales_orders accepted
          WHERE accepted.customer_id = customers.id
            AND accepted.customer_decision_required = 0
            AND accepted.status <> 'CANCELLED'
       );

    UPDATE customers
       SET record_state = 'ACTIVE'
     WHERE record_state = 'PROVISIONAL'
       AND EXISTS (
         SELECT 1 FROM sales_orders accepted
          WHERE accepted.customer_id = customers.id
            AND accepted.customer_decision_required = 0
            AND accepted.status <> 'CANCELLED'
       );
  `);
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
 * Charges kept against a document, whichever kind of document it was.
 *
 * The table was built for PDFs and named its owner setup_document_id, with a
 * foreign key to prove it. A spreadsheet invoice carries exactly the same
 * freight and duty, and has no setup document to point at — so the column
 * becomes a kind and an id, and the rows already stored are simply labelled
 * with the kind they always were.
 */
/*
 * Letting a customer be retired.
 *
 * `record_state` was constrained to ACTIVE or PROVISIONAL, so there was no way
 * to take a customer out of circulation — archiving was refused by the database
 * itself. Widening the constraint needs a table rebuild, because SQLite cannot
 * alter a CHECK in place.
 *
 * Nothing else changes: every column, every row and both indexes come across as
 * they were, and the whole thing is one transaction so a failure leaves the
 * original table untouched. It is skipped entirely once the constraint already
 * admits ARCHIVED, so it runs exactly once.
 */
function migrateCustomerArchiving(db) {
  if (!tableExists(db, 'customers')) return;
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='customers'").get();
  if (!ddl || /ARCHIVED/.test(ddl.sql)) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ALTER TABLE customers RENAME TO customers_old');
    db.exec(`CREATE TABLE customers (
      id                  TEXT PRIMARY KEY,
      workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name                TEXT NOT NULL,
      company             TEXT,
      email               TEXT,
      phone               TEXT,
      shipping_address    TEXT,
      record_state        TEXT NOT NULL DEFAULT 'ACTIVE'
                            CHECK (record_state IN ('ACTIVE','PROVISIONAL','ARCHIVED')),
      notes               TEXT,
      created_by_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO customers
      (id, workspace_id, name, company, email, phone, shipping_address, record_state,
       notes, created_by_user_id, created_at, updated_at)
      SELECT id, workspace_id, name, company, email, phone, shipping_address, record_state,
             notes, created_by_user_id, created_at, updated_at
        FROM customers_old`);
    db.exec('DROP TABLE customers_old');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_workspace_name
      ON customers(workspace_id, name COLLATE NOCASE)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_customers_workspace
      ON customers(workspace_id, name COLLATE NOCASE)`);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function migrateDocumentCharges(db) {
  if (!tableExists(db, 'document_charges')) return;
  if (!hasColumn(db, 'document_charges', 'setup_document_id')) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ALTER TABLE document_charges RENAME TO document_charges_old');
    db.exec(`CREATE TABLE document_charges (
      id                   TEXT PRIMARY KEY,
      workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source_kind          TEXT NOT NULL DEFAULT 'setup_document'
                             CHECK (source_kind IN ('setup_document','import_plan')),
      source_id            TEXT NOT NULL,
      purchase_order_id    TEXT,
      document_number      TEXT,
      supplier_name        TEXT,
      label                TEXT NOT NULL,
      kind                 TEXT NOT NULL
                             CHECK (kind IN ('freight','insurance','duty','tax','discount','deposit','other')),
      amount_minor         INTEGER NOT NULL,
      currency             TEXT NOT NULL DEFAULT 'USD',
      goods_minor          INTEGER NOT NULL DEFAULT 0,
      document_total_minor INTEGER,
      opened_books         INTEGER NOT NULL DEFAULT 0,
      status               TEXT NOT NULL DEFAULT 'UNRECORDED'
                             CHECK (status IN ('UNRECORDED','IN_STOCK_VALUE','EXPENSED')),
      journal_entry_id     TEXT,
      decided_at           TEXT,
      created_at           TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO document_charges
      (id, workspace_id, source_kind, source_id, purchase_order_id, document_number, supplier_name,
       label, kind, amount_minor, currency, goods_minor, document_total_minor, opened_books,
       status, journal_entry_id, decided_at, created_at)
      SELECT id, workspace_id, 'setup_document', setup_document_id, purchase_order_id,
        document_number, supplier_name, label, kind, amount_minor, currency, goods_minor,
        document_total_minor, opened_books, status, journal_entry_id, decided_at, created_at
      FROM document_charges_old`);
    db.exec('DROP TABLE document_charges_old');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_document_charges
      ON document_charges(workspace_id, source_kind, source_id, label, amount_minor)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_document_charges_status
      ON document_charges(workspace_id, status)`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function migrateMailboxDocumentPurpose(db) {
  if (!tableExists(db, 'connection_email_rules') || !tableExists(db, 'schema_meta')) return;
  const now = new Date().toISOString();
  const migrated = db.prepare("SELECT 1 FROM schema_meta WHERE key = 'mailbox_document_purpose_v1'").get();
  if (!migrated) {
    // Before purpose selection existed every watched sender was silently
    // treated as purchasing evidence. Move those legacy rules to the neutral
    // state once; future choices are always explicit.
    db.prepare("UPDATE connection_email_rules SET document_mode = 'review_each'").run();
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('mailbox_document_purpose_v1', ?)").run(now);
  }
  // Push delivery is optional; every real mailbox has scheduled OAuth polling.
  // Old builds surfaced a failed push registration as an urgent owner task.
  db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
    WHERE issue_type = 'MAILBOX_WATCH_RENEWAL_FAILED' AND status = 'OPEN'`).run(now, now);
}

// A role default does not apply when a membership has an explicit grant list.
// Existing owners/accountants would otherwise miss a new financial authority
// solely because their list predates Mission 7. Staff never receive it, and
// an owner can still remove it explicitly afterwards.
function migrateLandedCostPermission(db) {
  if (!tableExists(db, 'users') || !hasColumn(db, 'users', 'permissions')) return;
  for (const row of db.prepare(`SELECT id, permissions FROM users
    WHERE role IN ('owner','accountant') AND permissions IS NOT NULL`).all()) {
    try {
      const values = JSON.parse(row.permissions);
      if (!Array.isArray(values) || values.includes('ALLOCATE_LANDED_COST')) continue;
      values.push('ALLOCATE_LANDED_COST');
      db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(values), row.id);
    } catch { /* malformed grants already use role defaults */ }
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
/** A table name as SQLite may have stored it: bare, or quoted after a rename. */
const QUOTED_NAME = (table) =>
  "CREATE TABLE (IF NOT EXISTS )?[\"'`\\[]?" + table + "[\"'`\\]]?";

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
    // The stored name may be quoted. SQLite rewrites a table's own DDL when a
    // column is renamed, writing the name back as "work_items" — so a pattern
    // matching only the bare word silently failed to rename the copy, and the
    // rebuild then tried to create a table that already existed.
    .replace(
      new RegExp(QUOTED_NAME(table), 'i'),
      `CREATE TABLE ${table}_rebuilt`
    )
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
  // Older databases enumerated only building-level location types. Warehouse
  // structure is still stored in the same canonical location table, so widen
  // the storage rule before a bin or dock is created.
  relaxColumnCheck(db, 'locations', 'kind');
  backfillEmailOrderSetup(db);

  // Enum CHECKs are relaxed before the schema files that own those tables, so
  // the CREATE INDEX statements in them restore the indexes a rebuild drops.
  relaxColumnCheck(db, 'attention_items', 'category');
  relaxColumnCheck(db, 'action_proposals', 'action_type');
  relaxColumnCheck(db, 'work_items', 'category');
  // Routing outcomes grow with the ways a request can end. REFUSED — understood
  // and declined by a rule — is one the enumerated list did not have.
  relaxColumnCheck(db, 'manager_intents', 'status');
  // SUPERSEDED — work a later, better decision has taken over — is a state the
  // enumerated list did not have.
  relaxColumnCheck(db, 'work_items', 'execution_status');
  relaxColumnCheck(db, 'connector_feed_events', 'status');
  // The evidence graph grows by registering new record types and relation
  // semantics. Existing SQLite CHECK constraints need widening before the
  // canonical provenance schema can be applied.
  relaxColumnCheck(db, 'business_relations', 'relation_type');
  relaxColumnCheck(db, 'business_relations', 'from_type');
  relaxColumnCheck(db, 'business_relations', 'to_type');

  db.exec(fs.readFileSync(ATTENTION_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(ACTIONS_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(IMPORTS_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(PURCHASING_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(ONBOARDING_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(AUTOPILOT_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(MANAGER_SCHEMA_PATH, 'utf8'));
  db.exec(fs.readFileSync(SALES_SCHEMA_PATH, 'utf8'));
  // Accounting consumes durable sales, purchasing, inventory, and manager
  // events. It is additive and never becomes the physical stock authority.
  db.exec(fs.readFileSync(ACCOUNTING_SCHEMA_PATH, 'utf8'));
  // Recover only explicit owner purchase-cost instructions that the obsolete
  // UI mistakenly stored as opening valuation. Ordinary valuations are never
  // promoted to current supplier cost.
  require('../pricing/backfill-purchase-costs').backfillPurchaseCosts(db);
  // Forecasting reads everything above it and writes to none of it. Last on
  // purpose: its tables reference skus, locations and suppliers, and it must
  // never be something the operational schema depends on.
  db.exec(fs.readFileSync(FORECASTING_SCHEMA_PATH, 'utf8'));
  // Shipping hangs off sales_shipments, so it follows sales. It holds what a
  // carrier said — rates, labels, scans — and never what Foundry decided.
  db.exec(fs.readFileSync(SHIPPING_SCHEMA_PATH, 'utf8'));
  // The graph indexes records owned by every domain above it, so its schema is
  // intentionally last and no operational table depends on it.
  db.exec(fs.readFileSync(PROVENANCE_SCHEMA_PATH, 'utf8'));
  // Repairs refer to records across every operational domain and therefore
  // sit above them. They never become an alternate source of business truth.
  db.exec(fs.readFileSync(REPAIRS_SCHEMA_PATH, 'utf8'));
  // Production runtime state is last: jobs, inbox/outbox and certification
  // evidence may refer to workspaces, but business truth never depends on
  // operational bookkeeping.
  db.exec(fs.readFileSync(RUNTIME_SCHEMA_PATH, 'utf8'));
  // Warehouse tasks orchestrate calls into the canonical inventory engine;
  // no operational domain depends on them, so they are safely additive last.
  db.exec(fs.readFileSync(WAREHOUSE_SCHEMA_PATH, 'utf8'));
  // Transfer documents depend on sales-order lines for optional demand pegs,
  // warehouse locations for custody and the canonical movement ledger.
  db.exec(fs.readFileSync(TRANSFERS_SCHEMA_PATH, 'utf8'));
  require('../transfers/backfill').backfillLegacyTransfers(db);
  // Unit conversions and landed costs build on supplier bills, receipts and
  // the accounting cost balance, so they are intentionally last among the
  // business schemas.  They never become a second stock ledger.
  db.exec(fs.readFileSync(UOM_COSTING_SCHEMA_PATH, 'utf8'));
  // Count campaigns, returns and fulfillment waves coordinate records owned
  // by inventory, sales, purchasing, accounting and warehouse domains. Their
  // physical and financial effects still post through those domain engines.
  db.exec(fs.readFileSync(OPERATIONS_SCHEMA_PATH, 'utf8'));

  /*
   * Orders that shipped before shipments existed have no record of where the
   * goods went. Rebuild one from each order's own fulfilment history, once.
   */
  // The charge table has to be its current shape before anything repairs
  // into it, or the repair writes into a table that no longer matches and the
  // failure is swallowed as "this file had no charges".
  migrateCustomerArchiving(db);
  migrateDocumentCharges(db);

  require('./backfill-shipments').backfillShipments(db);

  /*
   * Stock imported from a file that carried its cost, and stored worth zero.
   *
   * Imports used to discard the supplier's cost column, so a spreadsheet
   * invoice created inventory the books could not value — and the first sale
   * of any of it would stop on "no recorded cost". The import path now
   * attaches the cost as it creates the stock; this gives the same value to
   * everything that came in before it did, from the figure still stored on the
   * row it was read from. Idempotent: stock that already has a cost is left
   * exactly as it is.
   */
  require('../imports/backfill-costs').backfillImportCosts(db);
  // The connection/feed tables are created by onboarding on a fresh database,
  // so a second additive pass keeps fresh and upgraded databases identical.
  addMissingColumns(db);

  // Mission 14 adds an accountant membership. Existing databases carried the
  // original owner/staff CHECK, so widen that storage rule before a membership
  // can be granted. Fresh databases already use the current schema.
  relaxColumnCheck(db, 'users', 'role');
  db.exec(fs.readFileSync(CONNECTIONS_SCHEMA_PATH, 'utf8'));
  // Accounting providers and public webhooks build on both the canonical
  // accounting ledger and the shared connection/runtime delivery machinery.
  db.exec(fs.readFileSync(ACCOUNTING_INTEGRATIONS_SCHEMA_PATH, 'utf8'));
  migrateMailboxDocumentPurpose(db);
  migrateLandedCostPermission(db);
  dropLegacyUserLogin(db);
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', '20')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run();
  const schemaFingerprint = crypto.createHash('sha256');
  for (const schemaPath of SCHEMA_PATHS) schemaFingerprint.update(fs.readFileSync(schemaPath));
  db.prepare(`INSERT OR IGNORE INTO database_releases
    (release_ref, schema_version, schema_fingerprint, applied_at) VALUES (?, 20, ?, ?)`)
    .run(process.env.FOUNDRY_RELEASE_REF || process.env.GIT_COMMIT || 'development',
      schemaFingerprint.digest('hex'), new Date().toISOString());
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
