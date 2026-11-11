CREATE TABLE stockchief_runtime.agent_invoice_dispute_work (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bill_id text UNIQUE REFERENCES accounting_supplier_bills(id) ON DELETE CASCADE,
  intake_id text UNIQUE REFERENCES stockchief_runtime.agent_supplier_invoice_intakes(id) ON DELETE SET NULL,
  replacement_intake_id text UNIQUE REFERENCES stockchief_runtime.agent_supplier_invoice_intakes(id) ON DELETE SET NULL,
  replacement_bill_id text UNIQUE REFERENCES accounting_supplier_bills(id) ON DELETE SET NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_check_at timestamptz,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_invoice_dispute_schedule ON stockchief_runtime.agent_invoice_dispute_work(workspace_id,next_check_at,id);
CREATE INDEX agent_invoice_dispute_bills ON accounting_supplier_bills(workspace_id,created_at,id)
  WHERE status='DISPUTED' AND journal_entry_id IS NULL;
CREATE INDEX agent_invoice_dispute_intakes ON stockchief_runtime.agent_supplier_invoice_intakes(workspace_id,created_at,id)
  WHERE status='EXCEPTION' AND comparison->>'status'='DISPUTED' AND duplicate_bill_id IS NULL AND bill_id IS NULL;
CREATE INDEX agent_invoice_dispute_mail_thread ON supplier_communications(workspace_id,connector_id,external_thread_id,supplier_id)
  WHERE invoice_dispute_bill_id IS NOT NULL AND status='SENT';

CREATE FUNCTION stockchief_runtime.queue_invoice_dispute() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_kind text;
DECLARE job_key text;
DECLARE revision integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_job_modes m
    WHERE m.workspace_id=NEW.workspace_id AND m.job_id=100 AND m.mode='routine') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='accounting_supplier_bills' THEN
    IF NEW.status<>'DISPUTED' OR NEW.journal_entry_id IS NOT NULL OR NEW.invoice_input IS NULL THEN RETURN NEW; END IF;
    source_kind:='bill';
    revision:=NEW.review_revision;
  ELSE
    IF NEW.status<>'EXCEPTION' OR NEW.comparison->>'status' IS DISTINCT FROM 'DISPUTED'
       OR NEW.duplicate_bill_id IS NOT NULL OR NEW.bill_id IS NOT NULL THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND OLD.status=NEW.status AND OLD.comparison IS NOT DISTINCT FROM NEW.comparison THEN RETURN NEW; END IF;
    source_kind:='intake';
    revision:=NEW.revision;
  END IF;
  job_key:='discover:'||source_kind||':'||NEW.id||':'||revision;
  INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,payload,priority,max_attempts,available_at,idempotency_key,created_at,updated_at)
  VALUES('invoice_dispute_'||md5(job_key),NEW.workspace_id,'agent.supplier-invoice-dispute',
    jsonb_build_object('sourceKind',source_kind,'sourceId',NEW.id),50,8,floor(extract(epoch FROM clock_timestamp())*1000)::bigint,job_key,now(),now())
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER queue_agent_invoice_dispute_intake AFTER INSERT OR UPDATE OF status,comparison ON stockchief_runtime.agent_supplier_invoice_intakes
  FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.queue_invoice_dispute();
CREATE TRIGGER queue_agent_invoice_dispute_bill AFTER INSERT OR UPDATE OF invoice_input,status ON accounting_supplier_bills
  FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.queue_invoice_dispute();

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_invoice_dispute_work'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,'stockchief_runtime.agent_invoice_dispute_work'::regclass,true FROM workspaces w;
