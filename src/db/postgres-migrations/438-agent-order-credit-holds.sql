-- Job 55: the owner's overdue rule gains its limits (days overdue and the
-- overdue amount), and each credit hold on a customer order is kept with who
-- placed it, why, and how and by whom it was released.
ALTER TABLE stockchief_runtime.agent_overdue_order_rules
 ADD COLUMN days_overdue integer NOT NULL DEFAULT 1 CHECK(days_overdue BETWEEN 1 AND 365),
 ADD COLUMN minimum_overdue_minor bigint NOT NULL DEFAULT 0 CHECK(minimum_overdue_minor BETWEEN 0 AND 100000000000000),
 ADD COLUMN currency text CHECK(currency IS NULL OR currency ~ '^[A-Z]{3}$'),
 ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 ADD CONSTRAINT agent_overdue_order_rules_amount_currency CHECK(minimum_overdue_minor=0 OR currency IS NOT NULL);

CREATE TABLE stockchief_runtime.agent_order_credit_holds (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sales_order_id text NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('HELD','RELEASED')),
 placed_by_kind text NOT NULL CHECK(placed_by_kind IN ('RULE','PERSON')),
 placed_by text REFERENCES users(id) ON DELETE SET NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 600),
 evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
 placed_at timestamptz NOT NULL DEFAULT now(),
 released_kind text CHECK(released_kind IN ('PAYMENT','PERSON','ORDER_CLOSED','RULE_OFF')),
 released_by text REFERENCES users(id) ON DELETE SET NULL,
 release_note text CHECK(release_note IS NULL OR length(release_note)<=300),
 released_at timestamptz,
 CHECK((status='RELEASED')=(released_at IS NOT NULL AND released_kind IS NOT NULL))
);
-- One hold at a time per order; earlier holds and releases stay as history.
CREATE UNIQUE INDEX agent_order_credit_holds_active ON stockchief_runtime.agent_order_credit_holds(workspace_id,sales_order_id) WHERE status='HELD';
CREATE INDEX agent_order_credit_holds_order ON stockchief_runtime.agent_order_credit_holds(sales_order_id,placed_at DESC);
CREATE INDEX agent_order_credit_holds_customer ON stockchief_runtime.agent_order_credit_holds(customer_id);
CREATE INDEX agent_order_credit_holds_placer ON stockchief_runtime.agent_order_credit_holds(placed_by) WHERE placed_by IS NOT NULL;
CREATE INDEX agent_order_credit_holds_releaser ON stockchief_runtime.agent_order_credit_holds(released_by) WHERE released_by IS NOT NULL;

-- Holds appear in Needs you as soon as they change.
CREATE TRIGGER read_model_insert AFTER INSERT ON stockchief_runtime.agent_order_credit_holds REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_update AFTER UPDATE ON stockchief_runtime.agent_order_credit_holds REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();
CREATE TRIGGER read_model_delete AFTER DELETE ON stockchief_runtime.agent_order_credit_holds REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model();

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_order_credit_holds'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_order_credit_holds'::regclass,true FROM workspaces;
