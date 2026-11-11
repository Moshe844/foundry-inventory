
CREATE TABLE stockchief_runtime.agent_quote_companion_rules (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 anchor_sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 currency text NOT NULL,
 companions jsonb NOT NULL CHECK(jsonb_typeof(companions)='array' AND jsonb_array_length(companions)>0),
 maximum_added_minor bigint NOT NULL CHECK(maximum_added_minor>0),
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 owner_id text REFERENCES users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,customer_id,location_id,currency)
);
CREATE INDEX quote_companion_rules_owner ON stockchief_runtime.agent_quote_companion_rules(owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX quote_companion_rules_customer ON stockchief_runtime.agent_quote_companion_rules(customer_id);
CREATE INDEX quote_companion_rules_location ON stockchief_runtime.agent_quote_companion_rules(location_id);
CREATE INDEX quote_companion_rules_anchor ON stockchief_runtime.agent_quote_companion_rules(anchor_sku_id);

CREATE TABLE stockchief_runtime.agent_quote_companion_work (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 quote_id text PRIMARY KEY REFERENCES sales_quotations(id) ON DELETE CASCADE,
 rule_id text REFERENCES stockchief_runtime.agent_quote_companion_rules(id) ON DELETE SET NULL,
 rule_revision integer,
 state text NOT NULL CHECK(state IN('QUEUED','HELD','COMPLETED')),
 issue text,
 approved_by text REFERENCES users(id) ON DELETE SET NULL,
 revision_id text UNIQUE REFERENCES sales_quotations(id) ON DELETE CASCADE,
 source_fingerprint text,
 evidence jsonb,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quote_companion_work_workspace ON stockchief_runtime.agent_quote_companion_work(workspace_id,updated_at DESC);
CREATE INDEX quote_companion_work_rule ON stockchief_runtime.agent_quote_companion_work(rule_id) WHERE rule_id IS NOT NULL;
CREATE INDEX quote_companion_work_owner ON stockchief_runtime.agent_quote_companion_work(approved_by) WHERE approved_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_quote_companion_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_quote_companion_work'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_quote_companion_rules'::regclass,'stockchief_runtime.agent_quote_companion_work'::regclass);
