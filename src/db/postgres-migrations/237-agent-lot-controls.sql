ALTER TABLE lots ADD COLUMN recalled_at timestamptz;
ALTER TABLE lots ADD COLUMN recall_revision integer NOT NULL DEFAULT 0;
CREATE TABLE stockchief_runtime.lot_recall_events (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lot_id text NOT NULL REFERENCES lots(id), actor_id text NOT NULL REFERENCES users(id),
  revision integer NOT NULL, held boolean NOT NULL, reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(), UNIQUE(lot_id,revision)
);
CREATE INDEX recall_events_workspace ON stockchief_runtime.lot_recall_events(workspace_id,lot_id);
CREATE TABLE stockchief_runtime.lot_certificate_requirements (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, sku_id text NOT NULL REFERENCES skus(id),
  kind text NOT NULL CHECK(kind IN ('CoA','Safety sheet')), PRIMARY KEY(workspace_id,sku_id,kind)
);
CREATE TABLE stockchief_runtime.lot_certificates (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, lot_id text NOT NULL REFERENCES lots(id),
  kind text NOT NULL CHECK(kind IN ('CoA','Safety sheet')), document_url text NOT NULL, expires_on date,
  recorded_by text NOT NULL REFERENCES users(id), recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,lot_id,kind)
);
