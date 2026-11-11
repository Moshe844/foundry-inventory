
CREATE TABLE stockchief_runtime.agent_customer_checkin_rules (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 authority_kind text NOT NULL CHECK(authority_kind IN('TRAINED','CUSTOM')),
 example_id text,
 revision integer NOT NULL CHECK(revision>0),
 enabled boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(authority_kind<>'TRAINED' OR example_id IS NOT NULL)
);
CREATE TABLE stockchief_runtime.agent_customer_checkin_drafts (
 id text PRIMARY KEY REFERENCES customer_communications(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 episode text NOT NULL,
 evidence_hash text NOT NULL,
 evidence jsonb NOT NULL,
 draft_hash text NOT NULL,
 drafted_by text REFERENCES users(id) ON DELETE SET NULL,
 authority_kind text NOT NULL CHECK(authority_kind IN('INDIVIDUAL','TRAINED','CUSTOM')),
 rule_revision integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,customer_id,episode),
 CHECK((rule_revision IS NULL)=(authority_kind='INDIVIDUAL'))
);
ALTER TABLE stockchief_runtime.agent_customer_checkin_rules ADD CONSTRAINT customer_checkin_training_example
 FOREIGN KEY(example_id) REFERENCES stockchief_runtime.agent_customer_checkin_drafts(id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX customer_checkin_drafts_customer ON stockchief_runtime.agent_customer_checkin_drafts(customer_id);
CREATE INDEX customer_checkin_drafts_owner ON stockchief_runtime.agent_customer_checkin_drafts(drafted_by) WHERE drafted_by IS NOT NULL;
CREATE INDEX customer_checkin_rules_owner ON stockchief_runtime.agent_customer_checkin_rules(authorized_by) WHERE authorized_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_customer_checkin_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_customer_checkin_drafts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_customer_checkin_rules'::regclass,'stockchief_runtime.agent_customer_checkin_drafts'::regclass);
