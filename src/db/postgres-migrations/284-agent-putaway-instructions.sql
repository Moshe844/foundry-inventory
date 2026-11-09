CREATE TABLE stockchief_runtime.agent_putaway_instructions (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 receipt_line_id text NOT NULL REFERENCES purchase_order_receipt_lines(id),
 actor_id text NOT NULL REFERENCES users(id),
 automatic boolean NOT NULL DEFAULT false,
 source jsonb NOT NULL,
 fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,receipt_line_id)
);
CREATE INDEX agent_putaway_instruction_receipt ON stockchief_runtime.agent_putaway_instructions(receipt_line_id);
CREATE INDEX agent_putaway_instruction_actor ON stockchief_runtime.agent_putaway_instructions(actor_id);
CREATE INDEX agent_putaway_instruction_source ON stockchief_runtime.agent_putaway_instructions(workspace_id,(source#>>'{from,id}'),created_at DESC,id DESC);
CREATE TABLE stockchief_runtime.agent_putaway_rules (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id),
 from_location_id text NOT NULL REFERENCES locations(id),
 to_location_id text NOT NULL REFERENCES locations(id),
 example_id text NOT NULL REFERENCES stockchief_runtime.agent_putaway_instructions(id),
 actor_id text NOT NULL REFERENCES users(id),
 maximum_quantity integer NOT NULL CHECK(maximum_quantity>0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 authorized_at timestamptz NOT NULL DEFAULT now(),
 retry_after timestamptz NOT NULL DEFAULT now(),
 problem text,
 PRIMARY KEY(workspace_id,sku_id,from_location_id)
);
CREATE INDEX agent_putaway_rule_sku ON stockchief_runtime.agent_putaway_rules(sku_id);
CREATE INDEX agent_putaway_rule_source ON stockchief_runtime.agent_putaway_rules(from_location_id);
CREATE INDEX agent_putaway_rule_destination ON stockchief_runtime.agent_putaway_rules(to_location_id);
CREATE INDEX agent_putaway_rule_example ON stockchief_runtime.agent_putaway_rules(example_id);
CREATE INDEX agent_putaway_rule_actor ON stockchief_runtime.agent_putaway_rules(actor_id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_putaway_instructions'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_putaway_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r.relation,true FROM workspaces CROSS JOIN (VALUES
 ('stockchief_runtime.agent_putaway_instructions'::regclass),('stockchief_runtime.agent_putaway_rules'::regclass))r(relation);
