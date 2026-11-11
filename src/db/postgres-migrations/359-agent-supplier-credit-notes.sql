CREATE TABLE stockchief_runtime.agent_supplier_credit_work (
  intake_id text PRIMARY KEY REFERENCES stockchief_runtime.agent_supplier_invoice_intakes(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  next_check_at timestamptz,
  result jsonb NOT NULL,
  CHECK (jsonb_typeof(result)='object')
);
CREATE INDEX agent_supplier_credit_pending ON stockchief_runtime.agent_supplier_credit_work(workspace_id,next_check_at,intake_id);
CREATE INDEX agent_supplier_credit_intake_number ON stockchief_runtime.agent_supplier_invoice_intakes(workspace_id,supplier_id,lower(btrim(invoice_number)),created_at,id)
  WHERE status='CREDIT_REVIEW';
CREATE INDEX agent_supplier_credit_note_number ON accounting_supplier_credits(workspace_id,supplier_id,lower(btrim(credit_number)))
  WHERE credit_number IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_supplier_credit_applications (
  credit_id text PRIMARY KEY REFERENCES accounting_supplier_credits(id) ON DELETE CASCADE,
  intake_id text REFERENCES stockchief_runtime.agent_supplier_invoice_intakes(id) ON DELETE SET NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  supplier_return_id text REFERENCES supplier_returns(id) ON DELETE SET NULL,
  return_cost_minor bigint CHECK (return_cost_minor>=0),
  source_hash text NOT NULL,
  source_number text NOT NULL,
  approval_fingerprint text NOT NULL,
  tax_minor bigint NOT NULL CHECK (tax_minor>=0),
  evidence jsonb NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,approval_fingerprint)
);
CREATE INDEX agent_supplier_credit_applications_hash ON stockchief_runtime.agent_supplier_credit_applications(workspace_id,source_hash);
CREATE INDEX agent_supplier_credit_applications_source ON stockchief_runtime.agent_supplier_credit_applications(intake_id);
CREATE INDEX agent_supplier_credit_applications_return ON stockchief_runtime.agent_supplier_credit_applications(supplier_return_id);
CREATE INDEX agent_supplier_credit_applications_workspace ON stockchief_runtime.agent_supplier_credit_applications(workspace_id,approved_at);

CREATE FUNCTION stockchief_runtime.queue_supplier_credit_note() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job_key text;
BEGIN
 IF NEW.status<>'CREDIT_REVIEW' OR NEW.document->>'documentType' IS DISTINCT FROM 'credit'
   OR NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_job_modes m WHERE m.workspace_id=NEW.workspace_id AND m.job_id=105 AND m.mode='routine') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.status=NEW.status AND OLD.document IS NOT DISTINCT FROM NEW.document THEN RETURN NEW; END IF;
 job_key:=NEW.id||':'||NEW.revision;
 INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,payload,priority,max_attempts,available_at,idempotency_key,created_at,updated_at)
 VALUES('supplier_credit_job_'||md5(job_key),NEW.workspace_id,'agent.supplier-credit-source',jsonb_build_object('intakeId',NEW.id),60,8,
        floor(extract(epoch FROM clock_timestamp())*1000)::bigint,job_key,now(),now()) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER queue_agent_supplier_credit_note AFTER INSERT OR UPDATE OF status,document ON stockchief_runtime.agent_supplier_invoice_intakes
FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.queue_supplier_credit_note();

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_supplier_credit_work'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_credit_applications'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_supplier_credit_work'::regclass,'stockchief_runtime.agent_supplier_credit_applications'::regclass);
