-- Literal facts supplied with a structured catalogue record.  Core operating
-- fields still live in their domain tables; this preserves every additional
-- owner-supplied field without pretending it is a built-in dimension.
CREATE TABLE IF NOT EXISTS catalogue_item_facts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  category     TEXT,
  facts        TEXT NOT NULL DEFAULT '{}',
  source_text  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, item_id)
);

CREATE TABLE IF NOT EXISTS catalogue_sku_facts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id       TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  source_key   TEXT,
  facts        TEXT NOT NULL DEFAULT '{}',
  source_text  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, sku_id)
);

CREATE INDEX IF NOT EXISTS catalogue_sku_facts_source_idx
  ON catalogue_sku_facts(workspace_id, source_key);
