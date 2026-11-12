-- Job 65: the owner's rules for sharing scarce stock between open orders,
-- and the customer tiers those rules can use.
CREATE TABLE stockchief_runtime.agent_stock_sharing_rules (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 criteria text[] NOT NULL CHECK(cardinality(criteria) BETWEEN 1 AND 4 AND criteria <@ ARRAY['tier','promised','ordered','priority']::text[]),
 fill text NOT NULL CHECK(fill IN ('complete','share')),
 max_units integer NOT NULL CHECK(max_units BETWEEN 1 AND 1000000),
 enabled boolean NOT NULL DEFAULT true,
 automatic boolean NOT NULL DEFAULT false,
 taught_run_id text REFERENCES stockchief_runtime.agent_backorder_runs(id) ON DELETE SET NULL,
 taught_revision integer,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((taught_run_id IS NULL)=(taught_revision IS NULL))
);
CREATE INDEX agent_stock_sharing_rule_owner ON stockchief_runtime.agent_stock_sharing_rules(authorized_by) WHERE authorized_by IS NOT NULL;
CREATE INDEX agent_stock_sharing_rule_example ON stockchief_runtime.agent_stock_sharing_rules(taught_run_id) WHERE taught_run_id IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_customer_tiers (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 tier smallint NOT NULL CHECK(tier BETWEEN 1 AND 3),
 updated_by text REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,customer_id)
);
CREATE INDEX agent_customer_tier_customer ON stockchief_runtime.agent_customer_tiers(customer_id);
CREATE INDEX agent_customer_tier_editor ON stockchief_runtime.agent_customer_tiers(updated_by) WHERE updated_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_stock_sharing_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_customer_tiers'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_stock_sharing_rules'::regclass,'stockchief_runtime.agent_customer_tiers'::regclass);
