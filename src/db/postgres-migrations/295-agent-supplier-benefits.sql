CREATE TABLE stockchief_runtime.agent_supplier_benefit_programs (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 title text NOT NULL,
 source_reference text NOT NULL,
 currency text NOT NULL,
 starts_on date NOT NULL,
 ends_on date NOT NULL,
 claim_on date,
 claim_by date,
 scope jsonb NOT NULL,
 terms jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 authorized_by text NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(starts_on<=ends_on),
 CHECK(claim_on IS NULL OR claim_on>=starts_on),
 CHECK(claim_by IS NULL OR claim_on IS NOT NULL AND claim_by>=claim_on)
);
CREATE INDEX agent_supplier_benefit_workspace ON stockchief_runtime.agent_supplier_benefit_programs(workspace_id,enabled,updated_at,id);
CREATE INDEX agent_supplier_benefit_supplier ON stockchief_runtime.agent_supplier_benefit_programs(supplier_id);
CREATE INDEX agent_supplier_benefit_owner ON stockchief_runtime.agent_supplier_benefit_programs(authorized_by);
CREATE UNIQUE INDEX agent_supplier_benefit_reference ON stockchief_runtime.agent_supplier_benefit_programs(workspace_id,supplier_id,lower(source_reference),starts_on,ends_on,currency);
CREATE TABLE stockchief_runtime.agent_supplier_benefit_observations (
 program_id text PRIMARY KEY REFERENCES stockchief_runtime.agent_supplier_benefit_programs(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 source_fingerprint text NOT NULL,
 program_revision integer NOT NULL,
 result jsonb NOT NULL,
 needs_review boolean NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_supplier_benefit_observation_workspace ON stockchief_runtime.agent_supplier_benefit_observations(workspace_id,needs_review,observed_at,program_id);
CREATE TABLE stockchief_runtime.agent_supplier_benefit_claims (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 program_id text NOT NULL REFERENCES stockchief_runtime.agent_supplier_benefit_programs(id),
 request_key text NOT NULL,
 source_fingerprint text NOT NULL,
 source_snapshot jsonb NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 external_reference text NOT NULL,
 submitted_on date NOT NULL,
 status text NOT NULL DEFAULT 'SUBMITTED' CHECK(status IN ('SUBMITTED','ACKNOWLEDGED','WITHDRAWN')),
 acknowledgement_reference text,
 acknowledgement_on date,
 withdrawn_reference text,
 withdrawn_on date,
 recorded_by text NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status<>'ACKNOWLEDGED' OR acknowledgement_reference IS NOT NULL AND acknowledgement_on IS NOT NULL),
 CHECK(status<>'WITHDRAWN' OR withdrawn_reference IS NOT NULL AND withdrawn_on IS NOT NULL),
 UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_supplier_benefit_claim_program ON stockchief_runtime.agent_supplier_benefit_claims(program_id);
CREATE INDEX agent_supplier_benefit_claim_workspace ON stockchief_runtime.agent_supplier_benefit_claims(workspace_id,program_id,status);
CREATE INDEX agent_supplier_benefit_claim_owner ON stockchief_runtime.agent_supplier_benefit_claims(recorded_by);
CREATE UNIQUE INDEX agent_supplier_benefit_claim_reference ON stockchief_runtime.agent_supplier_benefit_claims(workspace_id,program_id,external_reference);
-- Programme qualification uses bill dates and canonical matched product lines;
-- it never infers an earned rebate from a draft or placed purchase order.
CREATE INDEX agent_supplier_benefit_bill_period ON accounting_supplier_bills(workspace_id,supplier_id,issue_date,id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_supplier_benefit_programs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_benefit_observations'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_benefit_claims'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_supplier_benefit_programs'::regclass,'stockchief_runtime.agent_supplier_benefit_observations'::regclass,'stockchief_runtime.agent_supplier_benefit_claims'::regclass]) r;
