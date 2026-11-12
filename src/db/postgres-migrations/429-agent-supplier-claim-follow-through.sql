-- Job 45: a staff damage report from the receiving form is claim evidence,
-- every claim says what it asks for, and a sent claim is followed through to
-- the supplier's reply, a credit note, replacement goods or a recorded close.

-- Staff mark a receipt line "arrived damaged" on the receiving form. Those
-- units are written off at once; this row keeps the report with its receipt.
CREATE TABLE stockchief_runtime.agent_receipt_damage_reports (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 receipt_line_id text NOT NULL UNIQUE REFERENCES purchase_order_receipt_lines(id),
 quantity numeric(20,6) NOT NULL CHECK (quantity>0),
 note text NOT NULL CHECK (length(note) BETWEEN 1 AND 1000),
 removal_key text NOT NULL,
 reported_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_receipt_damage_report_workspace ON stockchief_runtime.agent_receipt_damage_reports(workspace_id,created_at,id);
CREATE INDEX agent_receipt_damage_report_reporter ON stockchief_runtime.agent_receipt_damage_reports(reported_by);

ALTER TABLE stockchief_runtime.agent_supplier_claims
 ADD COLUMN damage_report_id text REFERENCES stockchief_runtime.agent_receipt_damage_reports(id),
 ADD COLUMN chase_after_days integer CHECK (chase_after_days BETWEEN 1 AND 60),
 ADD COLUMN outcome text CHECK (outcome IN ('REFUNDED','DECLINED','WITHDRAWN')),
 ADD COLUMN outcome_detail jsonb,
 ADD COLUMN outcome_by text REFERENCES users(id),
 ADD COLUMN outcome_at timestamptz,
 DROP CONSTRAINT agent_supplier_claim_one_source,
 ADD CONSTRAINT agent_supplier_claim_one_source CHECK (
  (hold_id IS NOT NULL AND delivery_comparison_id IS NULL AND purchase_order_line_id IS NULL AND damage_report_id IS NULL) OR
  (hold_id IS NULL AND delivery_comparison_id IS NOT NULL AND purchase_order_line_id IS NOT NULL AND damage_report_id IS NULL) OR
  (hold_id IS NULL AND delivery_comparison_id IS NULL AND purchase_order_line_id IS NULL AND damage_report_id IS NOT NULL)),
 ADD CONSTRAINT agent_supplier_claim_outcome CHECK (
  (outcome IS NULL AND outcome_detail IS NULL AND outcome_by IS NULL AND outcome_at IS NULL) OR
  (outcome IS NOT NULL AND outcome_detail IS NOT NULL AND outcome_by IS NOT NULL AND outcome_at IS NOT NULL AND communication_id IS NOT NULL));
CREATE UNIQUE INDEX agent_supplier_claim_report ON stockchief_runtime.agent_supplier_claims(damage_report_id) WHERE damage_report_id IS NOT NULL;
CREATE INDEX agent_supplier_claim_outcome_owner ON stockchief_runtime.agent_supplier_claims(outcome_by) WHERE outcome_by IS NOT NULL;
CREATE INDEX agent_supplier_claim_open ON stockchief_runtime.agent_supplier_claims(workspace_id,id) WHERE communication_id IS NOT NULL AND outcome IS NULL;

-- One row per reminder. A reminder is a supplier email, so it is sent once.
CREATE TABLE stockchief_runtime.agent_supplier_claim_chases (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 claim_id text NOT NULL REFERENCES stockchief_runtime.agent_supplier_claims(id),
 number integer NOT NULL CHECK (number BETWEEN 1 AND 2),
 communication_id text NOT NULL UNIQUE REFERENCES supplier_communications(id),
 automatic boolean NOT NULL,
 rule_id text REFERENCES stockchief_runtime.agent_supplier_claim_rules(id),
 rule_revision integer,
 approved_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(claim_id,number),
 CHECK (automatic=(rule_id IS NOT NULL AND rule_revision IS NOT NULL))
);
CREATE INDEX agent_supplier_claim_chase_workspace ON stockchief_runtime.agent_supplier_claim_chases(workspace_id,created_at,id);
CREATE INDEX agent_supplier_claim_chase_rule ON stockchief_runtime.agent_supplier_claim_chases(rule_id) WHERE rule_id IS NOT NULL;
CREATE INDEX agent_supplier_claim_chase_approver ON stockchief_runtime.agent_supplier_claim_chases(approved_by);

-- A posted supplier credit or a later receipt that the owner links to a
-- claim. Each credit and each receipt line settles at most one claim.
CREATE TABLE stockchief_runtime.agent_supplier_claim_settlements (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 claim_id text NOT NULL REFERENCES stockchief_runtime.agent_supplier_claims(id),
 credit_id text UNIQUE REFERENCES accounting_supplier_credits(id),
 receipt_line_id text UNIQUE REFERENCES purchase_order_receipt_lines(id),
 linked_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (num_nonnulls(credit_id,receipt_line_id)=1)
);
CREATE INDEX agent_supplier_claim_settlement_claim ON stockchief_runtime.agent_supplier_claim_settlements(workspace_id,claim_id);
CREATE INDEX agent_supplier_claim_settlement_owner ON stockchief_runtime.agent_supplier_claim_settlements(linked_by);

-- Keep the byte representation of claims recorded before these columns.
UPDATE commercial_storage_tables SET bytes_expression=replace(bytes_expression,'to_jsonb(t)',
 '(CASE WHEN t.damage_report_id IS NULL AND t.chase_after_days IS NULL AND t.outcome IS NULL THEN to_jsonb(t)-ARRAY[''damage_report_id'',''chase_after_days'',''outcome'',''outcome_detail'',''outcome_by'',''outcome_at'']::text[] ELSE to_jsonb(t) END)')
WHERE relation='stockchief_runtime.agent_supplier_claims'::regclass;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_receipt_damage_reports'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_claim_chases'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_claim_settlements'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_receipt_damage_reports'::regclass,
  'stockchief_runtime.agent_supplier_claim_chases'::regclass,'stockchief_runtime.agent_supplier_claim_settlements'::regclass])r;
