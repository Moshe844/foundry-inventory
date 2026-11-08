CREATE TABLE stockchief_runtime.supplier_order_links (
 token_hash text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
 recipient text NOT NULL, expires_at timestamptz NOT NULL,
 UNIQUE (workspace_id,token_hash)
);
CREATE INDEX supplier_order_links_po ON stockchief_runtime.supplier_order_links(workspace_id,purchase_order_id);
CREATE TABLE stockchief_runtime.supplier_link_submissions (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, token_hash text NOT NULL,
 FOREIGN KEY(workspace_id,token_hash) REFERENCES stockchief_runtime.supplier_order_links(workspace_id,token_hash) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('confirm','date','invoice','ship-notice')),
 expected_date date, contents bytea, fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(token_hash,fingerprint)
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
VALUES('stockchief_runtime.supplier_link_submissions'::regclass,'octet_length((to_jsonb(t)-''contents'')::text)+coalesce(octet_length(t.contents),0)');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT id,'stockchief_runtime.supplier_link_submissions'::regclass,true FROM workspaces;
