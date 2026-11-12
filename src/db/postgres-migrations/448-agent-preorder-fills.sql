-- Job 68: what happens to an accepted preorder once its incoming stock moves.
-- Each fill StockChief prepared or made (reserve the order, then send it to
-- picking), and each preorder flagged because less stock will now arrive than
-- it was promised, with whether the customer was told.
CREATE TABLE stockchief_runtime.agent_preorder_fills (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 request_id text NOT NULL REFERENCES stockchief_runtime.agent_customer_page_requests(id) ON DELETE CASCADE,
 sales_order_id text NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('DRAFT','FILLED','UNDONE','DISCARDED','STALE')),
 authorization_kind text CHECK(authorization_kind IN ('INDIVIDUAL','AUTOMATIC')),
 reason text,
 shipment_id text REFERENCES sales_shipments(id) ON DELETE SET NULL,
 release_note text,
 request_key text NOT NULL,
 prepared_by text REFERENCES users(id) ON DELETE SET NULL,
 approved_by text REFERENCES users(id) ON DELETE SET NULL,
 filled_at timestamptz,
 undone_by text REFERENCES users(id) ON DELETE SET NULL,
 undone_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_key),
 CHECK((status IN ('FILLED','UNDONE'))=(filled_at IS NOT NULL AND authorization_kind IS NOT NULL)),
 CHECK((status='UNDONE')=(undone_at IS NOT NULL))
);
-- One fill waiting or done per preorder.
CREATE UNIQUE INDEX agent_preorder_fill_open ON stockchief_runtime.agent_preorder_fills(workspace_id,request_id) WHERE status IN ('DRAFT','FILLED');
CREATE INDEX agent_preorder_fill_request ON stockchief_runtime.agent_preorder_fills(request_id);
CREATE INDEX agent_preorder_fill_order ON stockchief_runtime.agent_preorder_fills(sales_order_id);
CREATE INDEX agent_preorder_fill_recent ON stockchief_runtime.agent_preorder_fills(workspace_id,created_at DESC,id);
CREATE INDEX agent_preorder_fill_shipment ON stockchief_runtime.agent_preorder_fills(shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX agent_preorder_fill_preparer ON stockchief_runtime.agent_preorder_fills(prepared_by) WHERE prepared_by IS NOT NULL;
CREATE INDEX agent_preorder_fill_approver ON stockchief_runtime.agent_preorder_fills(approved_by) WHERE approved_by IS NOT NULL;
CREATE INDEX agent_preorder_fill_undoer ON stockchief_runtime.agent_preorder_fills(undone_by) WHERE undone_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_preorder_shortfalls (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 request_id text NOT NULL REFERENCES stockchief_runtime.agent_customer_page_requests(id) ON DELETE CASCADE,
 lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),
 short_quantity numeric NOT NULL CHECK(short_quantity>0),
 cause text NOT NULL,
 flagged_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 notice_id text,
 notified_by text REFERENCES users(id) ON DELETE SET NULL,
 notified_at timestamptz,
 PRIMARY KEY(workspace_id,request_id),
 CHECK((notice_id IS NULL)=(notified_at IS NULL))
);
CREATE INDEX agent_preorder_shortfall_request ON stockchief_runtime.agent_preorder_shortfalls(request_id);
CREATE INDEX agent_preorder_shortfall_open ON stockchief_runtime.agent_preorder_shortfalls(workspace_id,flagged_at) WHERE resolved_at IS NULL;
CREATE INDEX agent_preorder_shortfall_notifier ON stockchief_runtime.agent_preorder_shortfalls(notified_by) WHERE notified_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_preorder_fills'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_preorder_shortfalls'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_preorder_fills'::regclass,'stockchief_runtime.agent_preorder_shortfalls'::regclass);
