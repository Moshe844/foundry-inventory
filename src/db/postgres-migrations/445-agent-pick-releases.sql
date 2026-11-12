-- Job 56: the owner's release rule for each warehouse (how many orders go out
-- at a time, how many the warehouse can have waiting to be picked, its carrier
-- cut-off times), every release StockChief proposed or made, and the orders in
-- each release.
CREATE TABLE stockchief_runtime.agent_pick_release_rules (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 batch_orders integer NOT NULL CHECK(batch_orders BETWEEN 1 AND 500),
 capacity_orders integer CHECK(capacity_orders IS NULL OR capacity_orders BETWEEN 1 AND 100000),
 cutoffs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(cutoffs)='array' AND jsonb_array_length(cutoffs)<=10),
 automatic boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,location_id)
);
CREATE INDEX agent_pick_release_rule_location ON stockchief_runtime.agent_pick_release_rules(location_id);
CREATE INDEX agent_pick_release_rule_owner ON stockchief_runtime.agent_pick_release_rules(authorized_by) WHERE authorized_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_pick_releases (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('PROPOSED','RELEASED','UNDONE','STALE','DISCARDED')),
 authorization_kind text CHECK(authorization_kind IN ('INDIVIDUAL','AUTOMATIC')),
 plan jsonb NOT NULL,
 fingerprint text NOT NULL,
 rule_revision integer,
 request_key text NOT NULL,
 reason text,
 prepared_by text REFERENCES users(id) ON DELETE SET NULL,
 released_by text REFERENCES users(id) ON DELETE SET NULL,
 released_at timestamptz,
 undone_by text REFERENCES users(id) ON DELETE SET NULL,
 undone_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,request_key),
 CHECK((status IN ('RELEASED','UNDONE'))=(released_at IS NOT NULL AND authorization_kind IS NOT NULL)),
 CHECK((status='UNDONE')=(undone_at IS NOT NULL))
);
-- One proposal waits per warehouse; a changed situation replaces it.
CREATE UNIQUE INDEX agent_pick_release_proposed ON stockchief_runtime.agent_pick_releases(workspace_id,location_id) WHERE status='PROPOSED';
CREATE INDEX agent_pick_release_recent ON stockchief_runtime.agent_pick_releases(workspace_id,created_at DESC,id);
CREATE INDEX agent_pick_release_site ON stockchief_runtime.agent_pick_releases(location_id);
CREATE INDEX agent_pick_release_preparer ON stockchief_runtime.agent_pick_releases(prepared_by) WHERE prepared_by IS NOT NULL;
CREATE INDEX agent_pick_release_releaser ON stockchief_runtime.agent_pick_releases(released_by) WHERE released_by IS NOT NULL;
CREATE INDEX agent_pick_release_undoer ON stockchief_runtime.agent_pick_releases(undone_by) WHERE undone_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_pick_release_orders (
 workspace_id text NOT NULL,
 release_id text NOT NULL,
 sales_order_id text NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
 position integer NOT NULL CHECK(position>0),
 order_version integer NOT NULL,
 state text NOT NULL DEFAULT 'RELEASED' CHECK(state IN ('RELEASED','UNDONE')),
 undone_version integer,
 PRIMARY KEY(workspace_id,release_id,sales_order_id),
 FOREIGN KEY(workspace_id,release_id) REFERENCES stockchief_runtime.agent_pick_releases(workspace_id,id) ON DELETE CASCADE,
 CHECK((state='UNDONE')=(undone_version IS NOT NULL))
);
-- An order is released to the warehouse once at a time.
CREATE UNIQUE INDEX agent_pick_release_order_live ON stockchief_runtime.agent_pick_release_orders(workspace_id,sales_order_id) WHERE state='RELEASED';
CREATE INDEX agent_pick_release_order_order ON stockchief_runtime.agent_pick_release_orders(sales_order_id);

-- Proposals waiting for the owner appear in Needs you as soon as they change.
CREATE TRIGGER read_model_insert AFTER INSERT ON stockchief_runtime.agent_pick_releases REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_update AFTER UPDATE ON stockchief_runtime.agent_pick_releases REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_delete AFTER DELETE ON stockchief_runtime.agent_pick_releases REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_pick_release_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_pick_releases'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_pick_release_orders'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_pick_release_rules'::regclass,'stockchief_runtime.agent_pick_releases'::regclass,
  'stockchief_runtime.agent_pick_release_orders'::regclass);
