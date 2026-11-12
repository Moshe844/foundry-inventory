-- Job 54: the latest automatic check of each customer order for stock,
-- credit, address and price problems, and the owner's limit for what counts
-- as a big discount off the list price.
CREATE TABLE stockchief_runtime.agent_order_checks (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sales_order_id text NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
 order_version integer NOT NULL CHECK(order_version>0),
 status text NOT NULL CHECK(status IN ('CLEAR','FLAGGED')),
 findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(findings)='array'),
 trigger text NOT NULL CHECK(trigger IN ('created','confirmed','changed','routine')),
 checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,sales_order_id)
);
CREATE INDEX agent_order_checks_order ON stockchief_runtime.agent_order_checks(sales_order_id);
CREATE INDEX agent_order_checks_flagged ON stockchief_runtime.agent_order_checks(workspace_id,checked_at) WHERE status='FLAGGED';

CREATE TABLE stockchief_runtime.agent_order_check_settings (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 discount_alert_bps integer NOT NULL CHECK(discount_alert_bps BETWEEN 100 AND 10000),
 updated_by text REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_order_check_settings_editor ON stockchief_runtime.agent_order_check_settings(updated_by) WHERE updated_by IS NOT NULL;

-- Flags appear in Needs you as soon as a check changes them.
CREATE TRIGGER read_model_insert AFTER INSERT ON stockchief_runtime.agent_order_checks REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_update AFTER UPDATE ON stockchief_runtime.agent_order_checks REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_delete AFTER DELETE ON stockchief_runtime.agent_order_checks REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_order_checks'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_order_check_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_order_checks'::regclass,'stockchief_runtime.agent_order_check_settings'::regclass);
