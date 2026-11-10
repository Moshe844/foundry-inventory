CREATE TABLE stockchief_runtime.agent_preorder_sources (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id text NOT NULL REFERENCES stockchief_runtime.agent_customer_order_pages(id) ON DELETE CASCADE,
  sku_id text NOT NULL,
  purchase_order_line_id text NOT NULL,
  PRIMARY KEY (workspace_id,page_id,sku_id)
);

CREATE TABLE stockchief_runtime.agent_preorder_claims (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id text NOT NULL REFERENCES stockchief_runtime.agent_customer_page_requests(id) ON DELETE CASCADE,
  purchase_order_line_id text NOT NULL,
  sku_id text NOT NULL,
  location_id text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,request_id,sku_id)
);

CREATE INDEX agent_preorder_claim_capacity ON stockchief_runtime.agent_preorder_claims(workspace_id,purchase_order_line_id,created_at);

ALTER TABLE stockchief_runtime.agent_customer_order_pages ADD COLUMN preorder_enabled boolean NOT NULL DEFAULT false;

CREATE INDEX agent_preorder_native_receipt_lines ON purchase_order_receipt_lines(workspace_id,purchase_order_line_id,location_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_preorder_sources'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_preorder_claims'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_preorder_sources'::regclass,
  'stockchief_runtime.agent_preorder_claims'::regclass])r;
