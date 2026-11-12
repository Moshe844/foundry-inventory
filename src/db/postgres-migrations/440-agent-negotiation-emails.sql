-- Job 94: negotiation emails built from recorded facts (late deliveries, short
-- deliveries, price increases, cheaper quotes, volume), each linked to its
-- evidence. A person edits and sends them; on Custom a taught rule sends the
-- routine "please confirm your lead times" note on its own. Nothing here
-- commits money.
CREATE TABLE stockchief_runtime.agent_negotiation_drafts (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
 communication_id text NOT NULL REFERENCES supplier_communications(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('negotiation','lead_time_check')),
 facts jsonb NOT NULL,
 period_from date NOT NULL,
 period_to date NOT NULL,
 routine_key text,
 automatic boolean NOT NULL DEFAULT false,
 rule_revision text,
 needs_person text,
 sent_by text REFERENCES users(id),
 queued_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,communication_id),
 CHECK(period_from<=period_to)
);
CREATE UNIQUE INDEX agent_negotiation_draft_routine ON stockchief_runtime.agent_negotiation_drafts(workspace_id,routine_key) WHERE routine_key IS NOT NULL;
CREATE INDEX agent_negotiation_draft_list ON stockchief_runtime.agent_negotiation_drafts(workspace_id,supplier_id,created_at DESC,id DESC);
CREATE INDEX agent_negotiation_draft_supplier ON stockchief_runtime.agent_negotiation_drafts(supplier_id);
CREATE INDEX agent_negotiation_draft_communication ON stockchief_runtime.agent_negotiation_drafts(communication_id);
CREATE INDEX agent_negotiation_draft_sender ON stockchief_runtime.agent_negotiation_drafts(sent_by) WHERE sent_by IS NOT NULL;

ALTER TABLE stockchief_runtime.supplier_negotiation_rules
 ADD COLUMN connector_id text REFERENCES workspace_connectors(id) ON DELETE SET NULL,
 ADD COLUMN every_days integer NOT NULL DEFAULT 90 CHECK(every_days BETWEEN 30 AND 365),
 ADD COLUMN last_sent_on date,
 ADD COLUMN last_note text,
 ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX supplier_negotiation_rule_connector ON stockchief_runtime.supplier_negotiation_rules(connector_id) WHERE connector_id IS NOT NULL;
CREATE INDEX supplier_negotiation_rule_owner ON stockchief_runtime.supplier_negotiation_rules(owner_id);
CREATE INDEX supplier_negotiation_rule_supplier ON stockchief_runtime.supplier_negotiation_rules(supplier_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_negotiation_drafts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_negotiation_drafts'::regclass,true FROM workspaces;
