-- Job 97: claims are prepared and sent to the supplier through the outbox,
-- tracked to the supplier's credit note, and agreements can be read from email.
ALTER TABLE stockchief_runtime.agent_supplier_benefit_programs
 ADD COLUMN connector_id text REFERENCES workspace_connectors(id),
 ADD COLUMN claim_limit_minor bigint CHECK(claim_limit_minor IS NULL OR claim_limit_minor>0),
 ADD COLUMN alert_percent integer NOT NULL DEFAULT 10 CHECK(alert_percent BETWEEN 1 AND 50),
 ADD COLUMN source_message_id text REFERENCES connection_email_messages(id);
CREATE INDEX agent_supplier_benefit_connector ON stockchief_runtime.agent_supplier_benefit_programs(connector_id);
CREATE INDEX agent_supplier_benefit_source_message ON stockchief_runtime.agent_supplier_benefit_programs(source_message_id);

ALTER TABLE stockchief_runtime.agent_supplier_benefit_claims
 ADD COLUMN origin text NOT NULL DEFAULT 'external' CHECK(origin IN ('external','prepared')),
 ADD COLUMN communication_id text REFERENCES supplier_communications(id),
 ADD COLUMN automatic boolean NOT NULL DEFAULT false,
 ADD COLUMN credited_minor bigint NOT NULL DEFAULT 0 CHECK(credited_minor>=0),
 ADD COLUMN reviewed_by text REFERENCES users(id),
 ADD COLUMN reviewed_at timestamptz,
 ADD COLUMN problem text;
ALTER TABLE stockchief_runtime.agent_supplier_benefit_claims ALTER COLUMN submitted_on DROP NOT NULL;
ALTER TABLE stockchief_runtime.agent_supplier_benefit_claims DROP CONSTRAINT agent_supplier_benefit_claims_status_check;
ALTER TABLE stockchief_runtime.agent_supplier_benefit_claims
 ADD CONSTRAINT agent_supplier_benefit_claims_status_check CHECK(status IN ('PREPARED','SENDING','SUBMITTED','ACKNOWLEDGED','WITHDRAWN','CREDITED')),
 ADD CONSTRAINT agent_supplier_benefit_claims_submitted_check CHECK(status IN ('PREPARED','SENDING') OR submitted_on IS NOT NULL),
 ADD CONSTRAINT agent_supplier_benefit_claims_prepared_check CHECK(origin='prepared' OR status NOT IN ('PREPARED','SENDING','CREDITED')),
 ADD CONSTRAINT agent_supplier_benefit_claims_credit_check CHECK(credited_minor<=amount_minor);
CREATE UNIQUE INDEX agent_supplier_benefit_claim_open ON stockchief_runtime.agent_supplier_benefit_claims(workspace_id,program_id) WHERE status IN ('PREPARED','SENDING');
CREATE INDEX agent_supplier_benefit_claim_message ON stockchief_runtime.agent_supplier_benefit_claims(communication_id);
CREATE INDEX agent_supplier_benefit_claim_reviewer ON stockchief_runtime.agent_supplier_benefit_claims(reviewed_by);

-- Each posted supplier credit counts toward at most one rebate claim.
CREATE TABLE stockchief_runtime.agent_supplier_benefit_claim_credits (
 credit_id text PRIMARY KEY REFERENCES accounting_supplier_credits(id) ON DELETE CASCADE,
 claim_id text NOT NULL REFERENCES stockchief_runtime.agent_supplier_benefit_claims(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 automatic boolean NOT NULL,
 linked_by text NOT NULL REFERENCES users(id),
 linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_supplier_benefit_claim_credit_claim ON stockchief_runtime.agent_supplier_benefit_claim_credits(claim_id);
CREATE INDEX agent_supplier_benefit_claim_credit_workspace ON stockchief_runtime.agent_supplier_benefit_claim_credits(workspace_id,linked_at);
CREATE INDEX agent_supplier_benefit_claim_credit_owner ON stockchief_runtime.agent_supplier_benefit_claim_credits(linked_by);

-- Rebate terms read from a supplier email wait here until a person checks and
-- accepts them. Accepting supplier terms always needs a person.
CREATE TABLE stockchief_runtime.agent_supplier_benefit_offers (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 message_id text NOT NULL REFERENCES connection_email_messages(id),
 source_hash text NOT NULL,
 reading jsonb NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','SAVED','DISMISSED')),
 program_id text REFERENCES stockchief_runtime.agent_supplier_benefit_programs(id),
 decided_by text REFERENCES users(id),
 decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,message_id),
 CHECK(status='OPEN' OR decided_by IS NOT NULL AND decided_at IS NOT NULL),
 CHECK(status<>'SAVED' OR program_id IS NOT NULL)
);
CREATE INDEX agent_supplier_benefit_offer_open ON stockchief_runtime.agent_supplier_benefit_offers(workspace_id,status,created_at,id);
CREATE INDEX agent_supplier_benefit_offer_supplier ON stockchief_runtime.agent_supplier_benefit_offers(supplier_id);
CREATE INDEX agent_supplier_benefit_offer_message ON stockchief_runtime.agent_supplier_benefit_offers(message_id);
CREATE INDEX agent_supplier_benefit_offer_program ON stockchief_runtime.agent_supplier_benefit_offers(program_id);
CREATE INDEX agent_supplier_benefit_offer_owner ON stockchief_runtime.agent_supplier_benefit_offers(decided_by);
CREATE INDEX agent_supplier_benefit_credit_lookup ON accounting_supplier_credits(workspace_id,supplier_id,credit_date);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_supplier_benefit_claim_credits'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_benefit_offers'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_supplier_benefit_claim_credits'::regclass,'stockchief_runtime.agent_supplier_benefit_offers'::regclass]) r;
