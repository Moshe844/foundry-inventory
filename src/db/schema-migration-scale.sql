PRAGMA foreign_keys = ON;

/*
 * A provider-neutral cutover package.  Connectors and files stage the same
 * typed records here; no source system is allowed to mutate business tables.
 */
CREATE TABLE IF NOT EXISTS migration_packages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_namespace TEXT NOT NULL,
  source_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'STAGING','VALIDATING','NEEDS_ATTENTION','READY','APPROVED','APPLYING',
    'RECONCILING','VERIFIED','CUTOVER_ACTIVE','FAILED','CANCELLED'
  )),
  manifest_json TEXT NOT NULL DEFAULT '{}',
  source_snapshot_hash TEXT,
  cutover_mode TEXT NOT NULL DEFAULT 'STATIC'
    CHECK (cutover_mode IN ('STATIC','SNAPSHOT_DELTA')),
  source_snapshot_at TEXT,
  source_checkpoint TEXT,
  delta_started_at TEXT,
  final_checkpoint TEXT,
  source_frozen_at TEXT,
  staged_count INTEGER NOT NULL DEFAULT 0,
  applied_count INTEGER NOT NULL DEFAULT 0,
  problem_count INTEGER NOT NULL DEFAULT 0,
  preparation_status TEXT NOT NULL DEFAULT 'IDLE',
  preparation_stage TEXT,
  preparation_completed INTEGER NOT NULL DEFAULT 0,
  preparation_total INTEGER NOT NULL DEFAULT 0,
  preparation_detail TEXT,
  preparation_error TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  verified_at TEXT,
  cutover_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_namespace, source_snapshot_hash)
);
CREATE INDEX IF NOT EXISTS idx_migration_packages_workspace_status
  ON migration_packages(workspace_id, status, created_at DESC);

/*
 * Immutable proof of the source boundary used by a cutover. STATIC packages
 * point at one immutable file/API snapshot. SNAPSHOT_DELTA packages record the
 * cursor before collection, every captured change, and the final frozen cursor.
 */
CREATE TABLE IF NOT EXISTS migration_cutover_checkpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES migration_packages(id) ON DELETE CASCADE,
  checkpoint_kind TEXT NOT NULL CHECK (checkpoint_kind IN
    ('SNAPSHOT','DELTA_START','SOURCE_FROZEN','FINAL')),
  source_cursor TEXT,
  evidence_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  recorded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (package_id, checkpoint_kind)
);
CREATE INDEX IF NOT EXISTS idx_migration_cutover_checkpoints_package
  ON migration_cutover_checkpoints(package_id, checkpoint_kind);

CREATE TABLE IF NOT EXISTS migration_source_changes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES migration_packages(id) ON DELETE CASCADE,
  source_cursor TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('UPSERT','DELETE')),
  source_version TEXT,
  payload_json TEXT,
  payload_hash TEXT,
  change_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (package_id, source_cursor, entity_type, source_key, operation)
);
CREATE INDEX IF NOT EXISTS idx_migration_source_changes_package
  ON migration_source_changes(package_id, ordinal, id);

/* One reviewed mapping profile per source dataset. No vendor vocabulary lives
 * here: adapters describe columns, and users approve only uncertain meanings. */
CREATE TABLE IF NOT EXISTS migration_mapping_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES migration_packages(id) ON DELETE CASCADE,
  source_dataset TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PROPOSED','NEEDS_ATTENTION','APPROVED')),
  columns_json TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, source_dataset)
);

CREATE TABLE IF NOT EXISTS migration_field_mappings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES migration_mapping_profiles(id) ON DELETE CASCADE,
  source_field TEXT NOT NULL,
  target_field TEXT,
  disposition TEXT NOT NULL CHECK (disposition IN ('MAPPED','IGNORED','UNRESOLVED')),
  confidence TEXT NOT NULL CHECK (confidence IN ('EXACT','HIGH','PROPOSED','OWNER')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (profile_id, source_field)
);
CREATE INDEX IF NOT EXISTS idx_migration_field_mappings_profile
  ON migration_field_mappings(profile_id, disposition);

/*
 * The immutable upload behind an owner-started migration dataset.  Mapping
 * profiles intentionally store only meanings, not source bytes; this join is
 * what lets the browser stage the exact sheet the owner reviewed without a
 * connector, fixture, or a second copy of the file.
 */
CREATE TABLE IF NOT EXISTS migration_source_datasets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES migration_packages(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES migration_sources(id) ON DELETE RESTRICT,
  sheet_index INTEGER NOT NULL,
  sheet_name TEXT NOT NULL,
  entity_type TEXT,
  mapping_profile_id TEXT REFERENCES migration_mapping_profiles(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN
    ('NEEDS_CLASSIFICATION','NEEDS_MAPPING','READY_TO_STAGE','STAGED','BLOCKED')),
  source_row_count INTEGER NOT NULL DEFAULT 0,
  staged_record_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, source_id, sheet_index),
  UNIQUE (mapping_profile_id)
);
CREATE INDEX IF NOT EXISTS idx_migration_source_datasets_package
  ON migration_source_datasets(package_id, status, created_at, id);

/* One owner-facing decision can settle a workbook-level contradiction.  The
 * exact source bytes and the calculated evidence remain immutable; this row
 * records only which proven source was chosen as operational truth. */
CREATE TABLE IF NOT EXISTS migration_source_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES migration_packages(id) ON DELETE CASCADE,
  decision_key TEXT NOT NULL,
  choice TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT NOT NULL,
  UNIQUE (package_id, decision_key)
);

/* Imported reservations and damaged custody are physical stock, but not free
 * stock.  They must not be turned into invented customer orders or silently
 * offered for allocation. */
CREATE TABLE IF NOT EXISTS inventory_availability_holds (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('legacy_reserved','damaged')),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0 AND remaining_quantity <= quantity),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RELEASED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_type, source_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_inventory_availability_holds_position
  ON inventory_availability_holds(workspace_id, sku_id, location_id, status);

/* Expensive cross-sheet analysis is calculated when staging changes, never
 * while drawing navigation or inventory lists. */
CREATE TABLE IF NOT EXISTS migration_source_reviews (
  package_id TEXT PRIMARY KEY REFERENCES migration_packages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  review_json TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_migration_source_reviews_workspace
  ON migration_source_reviews(workspace_id,computed_at DESC);

CREATE TABLE IF NOT EXISTS migration_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES migration_packages(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_version TEXT,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'STAGED','VALID','BLOCKED','APPLIED','VERIFIED','SKIPPED','FAILED'
  )),
  target_type TEXT,
  target_id TEXT,
  issue_code TEXT,
  issue_detail TEXT,
  ordinal INTEGER NOT NULL,
  applied_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (package_id, entity_type, source_key)
);
CREATE INDEX IF NOT EXISTS idx_migration_records_work
  ON migration_records(package_id, status, ordinal, id);
CREATE INDEX IF NOT EXISTS idx_migration_records_target
  ON migration_records(workspace_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS external_identity_maps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_namespace TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  external_key TEXT NOT NULL,
  external_version TEXT,
  local_type TEXT NOT NULL,
  local_id TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  first_package_id TEXT REFERENCES migration_packages(id) ON DELETE SET NULL,
  last_package_id TEXT REFERENCES migration_packages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_namespace, entity_type, external_key)
);
CREATE INDEX IF NOT EXISTS idx_external_identity_local
  ON external_identity_maps(workspace_id, local_type, local_id);

CREATE TABLE IF NOT EXISTS migration_reconciliation_checks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES migration_packages(id) ON DELETE CASCADE,
  check_key TEXT NOT NULL,
  label TEXT NOT NULL,
  material INTEGER NOT NULL DEFAULT 1 CHECK (material IN (0,1)),
  source_value TEXT,
  foundry_value TEXT,
  status TEXT NOT NULL CHECK (status IN ('MATCHED','MISMATCHED','UNKNOWN','NOT_APPLICABLE')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL,
  UNIQUE (package_id, check_key)
);
CREATE INDEX IF NOT EXISTS idx_migration_reconciliation_package
  ON migration_reconciliation_checks(package_id, status, material);

CREATE TABLE IF NOT EXISTS migration_history_facts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES migration_packages(id) ON DELETE CASCADE,
  source_namespace TEXT NOT NULL,
  external_key TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  occurred_at TEXT,
  payload_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, source_namespace, fact_type, external_key)
);

/* Searchable grouping is data, not a per-SKU configuration burden. */
CREATE TABLE IF NOT EXISTS catalog_attributes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('item','sku','supplier','location')),
  subject_id TEXT NOT NULL,
  attribute_key TEXT NOT NULL,
  attribute_value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, subject_type, subject_id, attribute_key, attribute_value)
);
CREATE INDEX IF NOT EXISTS idx_catalog_attributes_selector
  ON catalog_attributes(workspace_id, attribute_key, attribute_value, subject_type, subject_id);

/* A durable cursor prevents a fixed LIMIT from permanently ignoring the tail. */
CREATE TABLE IF NOT EXISTS manager_scan_cursors (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scan_name TEXT NOT NULL,
  last_key TEXT,
  completed_cycles INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, scan_name)
);

/* Additional covering indexes used by catalog, orders, planning and ledger. */
CREATE INDEX IF NOT EXISTS idx_skus_workspace_active_code
  ON skus(workspace_id, is_active, code COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_items_workspace_active_name
  ON items(workspace_id, is_active, name COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_movements_workspace_sku_location_time
ON movements(workspace_id, sku_id, location_id, occurred_at DESC, id);

-- Forecasting reads one SKU across every location in chronological order.
-- Keeping location between SKU and time makes that query fall back to the
-- workspace-wide time index, which becomes a million-row scan at launch scale.
CREATE INDEX IF NOT EXISTS idx_movements_workspace_sku_time
ON movements(workspace_id, sku_id, occurred_at, seq);
-- Migration reconciliation resolves immutable source evidence by its exact
-- movement reference. Without this tenant-scoped index, a large migration
-- repeats a full ledger scan for every valued opening position.
CREATE INDEX IF NOT EXISTS idx_movements_workspace_reference
ON movements(workspace_id, reference) WHERE reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_po_workspace_status_date
  ON purchase_orders(workspace_id, status, order_date DESC, id);
CREATE INDEX IF NOT EXISTS idx_so_workspace_status_date
  ON sales_orders(workspace_id, status, order_date DESC, id);

/*
 * Production-search contract. The normal table provides tenant ownership and
 * stable entity identity; FTS5 provides token/prefix retrieval without a
 * leading-wildcard scan of a 250k-SKU catalogue.
 */
CREATE TABLE IF NOT EXISTS search_documents (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('item','sku','supplier_item','attribute')),
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  identifiers TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id,entity_type,entity_id)
);
CREATE INDEX IF NOT EXISTS idx_search_documents_entity
  ON search_documents(workspace_id,entity_type,entity_id);
CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
  title,identifiers,body,content='search_documents',content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS search_documents_ai AFTER INSERT ON search_documents BEGIN
  INSERT INTO search_documents_fts(rowid,title,identifiers,body)
  VALUES (new.rowid,new.title,new.identifiers,new.body);
END;
CREATE TRIGGER IF NOT EXISTS search_documents_ad AFTER DELETE ON search_documents BEGIN
  INSERT INTO search_documents_fts(search_documents_fts,rowid,title,identifiers,body)
  VALUES ('delete',old.rowid,old.title,old.identifiers,old.body);
END;
CREATE TRIGGER IF NOT EXISTS search_documents_au AFTER UPDATE ON search_documents BEGIN
  INSERT INTO search_documents_fts(search_documents_fts,rowid,title,identifiers,body)
  VALUES ('delete',old.rowid,old.title,old.identifiers,old.body);
  INSERT INTO search_documents_fts(rowid,title,identifiers,body)
  VALUES (new.rowid,new.title,new.identifiers,new.body);
END;

CREATE TRIGGER IF NOT EXISTS search_items_ai AFTER INSERT ON items BEGIN
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  VALUES (new.workspace_id,'item',new.id,new.name,COALESCE(new.base_code,''),
    COALESCE(new.description,'') || ' ' || COALESCE(new.unit_label,''),new.updated_at)
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=excluded.title,
    identifiers=excluded.identifiers,body=excluded.body,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS search_items_au AFTER UPDATE ON items BEGIN
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  VALUES (new.workspace_id,'item',new.id,new.name,COALESCE(new.base_code,''),
    COALESCE(new.description,'') || ' ' || COALESCE(new.unit_label,''),new.updated_at)
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=excluded.title,
    identifiers=excluded.identifiers,body=excluded.body,updated_at=excluded.updated_at;
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  SELECT s.workspace_id,'sku',s.id,new.name || ' ' || COALESCE(s.variant_label,''),
    s.code || ' ' || COALESCE(s.barcode,''),COALESCE(new.description,''),new.updated_at
  FROM skus s WHERE s.item_id=new.id
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=excluded.title,
    identifiers=excluded.identifiers,body=excluded.body,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS search_items_ad AFTER DELETE ON items BEGIN
  DELETE FROM search_documents WHERE workspace_id=old.workspace_id AND
    ((entity_type='item' AND entity_id=old.id) OR (entity_type='sku' AND entity_id IN
      (SELECT id FROM skus WHERE item_id=old.id)));
END;

CREATE TRIGGER IF NOT EXISTS search_skus_ai AFTER INSERT ON skus BEGIN
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  SELECT new.workspace_id,'sku',new.id,i.name || ' ' || COALESCE(new.variant_label,''),
    new.code || ' ' || COALESCE(new.barcode,''),COALESCE(i.description,''),new.created_at
  FROM items i WHERE i.id=new.item_id
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=excluded.title,
    identifiers=excluded.identifiers,body=excluded.body,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS search_skus_au AFTER UPDATE ON skus BEGIN
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  SELECT new.workspace_id,'sku',new.id,i.name || ' ' || COALESCE(new.variant_label,''),
    new.code || ' ' || COALESCE(new.barcode,''),COALESCE(i.description,''),new.created_at
  FROM items i WHERE i.id=new.item_id
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=excluded.title,
    identifiers=excluded.identifiers,body=excluded.body,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS search_skus_ad AFTER DELETE ON skus BEGIN
  DELETE FROM search_documents WHERE workspace_id=old.workspace_id AND entity_type='sku' AND entity_id=old.id;
END;

CREATE TRIGGER IF NOT EXISTS search_supplier_items_ai AFTER INSERT ON supplier_items BEGIN
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  SELECT new.workspace_id,'supplier_item',new.id,COALESCE(new.supplier_description,i.name),
    COALESCE(new.supplier_sku,''),sp.name || ' ' || s.code || ' ' || i.name,new.updated_at
  FROM suppliers sp JOIN skus s ON s.id=new.sku_id JOIN items i ON i.id=s.item_id WHERE sp.id=new.supplier_id
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=excluded.title,
    identifiers=excluded.identifiers,body=excluded.body,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS search_supplier_items_au AFTER UPDATE ON supplier_items BEGIN
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  SELECT new.workspace_id,'supplier_item',new.id,COALESCE(new.supplier_description,i.name),
    COALESCE(new.supplier_sku,''),sp.name || ' ' || s.code || ' ' || i.name,new.updated_at
  FROM suppliers sp JOIN skus s ON s.id=new.sku_id JOIN items i ON i.id=s.item_id WHERE sp.id=new.supplier_id
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=excluded.title,
    identifiers=excluded.identifiers,body=excluded.body,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS search_supplier_items_ad AFTER DELETE ON supplier_items BEGIN
  DELETE FROM search_documents WHERE workspace_id=old.workspace_id AND entity_type='supplier_item' AND entity_id=old.id;
END;

CREATE TRIGGER IF NOT EXISTS search_attributes_ai AFTER INSERT ON catalog_attributes BEGIN
  INSERT INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
  VALUES (new.workspace_id,'attribute',new.id,new.attribute_value,new.attribute_key,
    new.subject_type || ' ' || new.subject_id,new.updated_at)
  ON CONFLICT(workspace_id,entity_type,entity_id) DO UPDATE SET title=excluded.title,
    identifiers=excluded.identifiers,body=excluded.body,updated_at=excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS search_attributes_au AFTER UPDATE ON catalog_attributes BEGIN
  UPDATE search_documents SET title=new.attribute_value,identifiers=new.attribute_key,
    body=new.subject_type || ' ' || new.subject_id,updated_at=new.updated_at
  WHERE workspace_id=new.workspace_id AND entity_type='attribute' AND entity_id=new.id;
END;
CREATE TRIGGER IF NOT EXISTS search_attributes_ad AFTER DELETE ON catalog_attributes BEGIN
  DELETE FROM search_documents WHERE workspace_id=old.workspace_id AND entity_type='attribute' AND entity_id=old.id;
END;

/* Upgrade/backfill. INSERT OR IGNORE makes opening an existing database safe. */
INSERT OR IGNORE INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
SELECT workspace_id,'item',id,name,COALESCE(base_code,''),COALESCE(description,'') || ' ' || COALESCE(unit_label,''),updated_at FROM items
WHERE NOT EXISTS (SELECT 1 FROM schema_meta WHERE key='search_index_backfill_v1');
INSERT OR IGNORE INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
SELECT s.workspace_id,'sku',s.id,i.name || ' ' || COALESCE(s.variant_label,''),s.code || ' ' || COALESCE(s.barcode,''),
  COALESCE(i.description,''),s.created_at FROM skus s JOIN items i ON i.id=s.item_id
  WHERE NOT EXISTS (SELECT 1 FROM schema_meta WHERE key='search_index_backfill_v1');
INSERT OR IGNORE INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
SELECT si.workspace_id,'supplier_item',si.id,COALESCE(si.supplier_description,i.name),COALESCE(si.supplier_sku,''),
  sp.name || ' ' || s.code || ' ' || i.name,si.updated_at FROM supplier_items si JOIN suppliers sp ON sp.id=si.supplier_id
  JOIN skus s ON s.id=si.sku_id JOIN items i ON i.id=s.item_id
  WHERE NOT EXISTS (SELECT 1 FROM schema_meta WHERE key='search_index_backfill_v1');
INSERT OR IGNORE INTO search_documents(workspace_id,entity_type,entity_id,title,identifiers,body,updated_at)
SELECT workspace_id,'attribute',id,attribute_value,attribute_key,subject_type || ' ' || subject_id,updated_at FROM catalog_attributes
WHERE NOT EXISTS (SELECT 1 FROM schema_meta WHERE key='search_index_backfill_v1');
INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('search_index_backfill_v1','complete');
