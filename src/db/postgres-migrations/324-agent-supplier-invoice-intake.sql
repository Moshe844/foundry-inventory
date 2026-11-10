ALTER TABLE accounting_supplier_bill_lines ADD COLUMN secondary_quantity numeric;
ALTER TABLE accounting_supplier_bill_lines ADD COLUMN price_quantity numeric NOT NULL DEFAULT 1 CHECK(price_quantity>0);
ALTER TABLE accounting_supplier_bill_lines ADD COLUMN document_line_total_minor bigint;
ALTER TABLE accounting_supplier_bill_lines ADD COLUMN matched_receipt_minor bigint;
ALTER TABLE accounting_supplier_bill_lines ADD COLUMN tracking_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE accounting_supplier_bill_lines ADD COLUMN source_unit_cost_minor bigint;
ALTER TABLE accounting_supplier_bill_lines ADD COLUMN source_price_quantity numeric;
CREATE TABLE stockchief_runtime.agent_supplier_invoice_settings (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false, connector_ids text[] NOT NULL,
 authorized_by text NOT NULL REFERENCES users(id), revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE INDEX agent_supplier_invoice_settings_owner ON stockchief_runtime.agent_supplier_invoice_settings(authorized_by);
CREATE TABLE stockchief_runtime.agent_supplier_invoice_uploads (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 owner_id text NOT NULL REFERENCES users(id), supplier_id text NOT NULL REFERENCES suppliers(id),
 purchase_order_id text NOT NULL REFERENCES purchase_orders(id), filename text NOT NULL, content bytea NOT NULL,
 content_hash text NOT NULL, extracted_text text, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','READABLE','HELD','STOPPED')),
 problem text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,content_hash)
);
CREATE INDEX agent_supplier_invoice_upload_owner ON stockchief_runtime.agent_supplier_invoice_uploads(owner_id);
CREATE INDEX agent_supplier_invoice_upload_supplier ON stockchief_runtime.agent_supplier_invoice_uploads(supplier_id);
CREATE INDEX agent_supplier_invoice_upload_order ON stockchief_runtime.agent_supplier_invoice_uploads(purchase_order_id);
CREATE TABLE stockchief_runtime.agent_supplier_invoice_intakes (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 attachment_id text REFERENCES connection_email_attachments(id) ON DELETE CASCADE,
 source_upload_id text REFERENCES stockchief_runtime.agent_supplier_invoice_uploads(id) ON DELETE CASCADE,
 source_hash text NOT NULL, source_text_hash text NOT NULL,
 supplier_id text REFERENCES suppliers(id), purchase_order_id text REFERENCES purchase_orders(id),
 invoice_number text, document jsonb, prepared_input jsonb, comparison jsonb,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','READY','HELD','EXCEPTION','DUPLICATE','POSTED','STOPPED','CREDIT_REVIEW')),
 bill_id text REFERENCES accounting_supplier_bills(id), duplicate_bill_id text REFERENCES accounting_supplier_bills(id),
 revision integer NOT NULL DEFAULT 1, problem text, retry_after timestamptz,
 reviewed_by text REFERENCES users(id), reviewed_at timestamptz, review_note text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(attachment_id,source_upload_id)=1), UNIQUE(workspace_id,attachment_id,source_hash), UNIQUE(workspace_id,source_upload_id,source_hash)
);
CREATE INDEX agent_supplier_invoice_intake_upload ON stockchief_runtime.agent_supplier_invoice_intakes(source_upload_id);
CREATE INDEX agent_supplier_invoice_intake_attachment ON stockchief_runtime.agent_supplier_invoice_intakes(attachment_id);
CREATE INDEX agent_supplier_invoice_intake_supplier ON stockchief_runtime.agent_supplier_invoice_intakes(supplier_id);
CREATE INDEX agent_supplier_invoice_intake_order ON stockchief_runtime.agent_supplier_invoice_intakes(workspace_id,purchase_order_id,status);
CREATE INDEX agent_supplier_invoice_intake_bill ON stockchief_runtime.agent_supplier_invoice_intakes(bill_id);
CREATE INDEX agent_supplier_invoice_intake_duplicate ON stockchief_runtime.agent_supplier_invoice_intakes(duplicate_bill_id);
CREATE INDEX agent_supplier_invoice_intake_reviewer ON stockchief_runtime.agent_supplier_invoice_intakes(reviewed_by);
CREATE INDEX agent_supplier_invoice_intake_queue ON stockchief_runtime.agent_supplier_invoice_intakes(workspace_id,status,retry_after,updated_at,id);
CREATE TABLE stockchief_runtime.agent_supplier_invoice_charge_approvals (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 document_fingerprint text NOT NULL, approved_by text NOT NULL REFERENCES users(id),
 approved_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL,
 allow_price_difference boolean NOT NULL DEFAULT false, allow_charge_difference boolean NOT NULL DEFAULT false, allow_tracking_confirmation boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,document_fingerprint)
);
CREATE INDEX agent_supplier_invoice_charge_owner ON stockchief_runtime.agent_supplier_invoice_charge_approvals(approved_by);
CREATE FUNCTION stockchief_runtime.queue_supplier_invoice_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job_key text;
BEGIN
 IF NEW.extraction_status<>'READABLE' OR NEW.extracted_text IS NULL OR NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_invoice_settings s WHERE s.workspace_id=NEW.workspace_id AND s.enabled) THEN RETURN NEW; END IF;
 job_key:=NEW.id||':'||NEW.content_hash||':'||md5(NEW.extracted_text);
 INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,payload,priority,max_attempts,available_at,idempotency_key,created_at,updated_at)
 VALUES('supplier_invoice_job_'||md5(job_key),NEW.workspace_id,'agent.supplier-invoice-source',jsonb_build_object('attachmentId',NEW.id),60,8,floor(extract(epoch FROM clock_timestamp())*1000)::bigint,job_key,now(),now()) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER queue_agent_supplier_invoice AFTER INSERT OR UPDATE OF extraction_status,extracted_text ON connection_email_attachments FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.queue_supplier_invoice_source();
CREATE FUNCTION stockchief_runtime.recheck_supplier_invoice_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.quantity_received_units IS NOT DISTINCT FROM OLD.quantity_received_units AND NEW.secondary_quantity_received IS NOT DISTINCT FROM OLD.secondary_quantity_received AND NEW.unit_cost IS NOT DISTINCT FROM OLD.unit_cost THEN RETURN NEW; END IF;
 UPDATE stockchief_runtime.agent_supplier_invoice_intakes SET retry_after=NULL,updated_at=clock_timestamp() WHERE workspace_id=NEW.workspace_id AND purchase_order_id=NEW.purchase_order_id AND status IN('READY','HELD','EXCEPTION');
 RETURN NEW;
END $$;
CREATE TRIGGER recheck_agent_supplier_invoice AFTER UPDATE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.recheck_supplier_invoice_receipt();
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_supplier_invoice_uploads'::regclass,'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_invoice_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_invoice_intakes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_invoice_charge_approvals'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete) SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t WHERE t.relation IN('stockchief_runtime.agent_supplier_invoice_uploads'::regclass,'stockchief_runtime.agent_supplier_invoice_settings'::regclass,'stockchief_runtime.agent_supplier_invoice_intakes'::regclass,'stockchief_runtime.agent_supplier_invoice_charge_approvals'::regclass);

-- Every typed reader shares the same account import capacity.
CREATE OR REPLACE FUNCTION commercial_job_lane_available(target_workspace text,job_kind text) RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH category AS (SELECT CASE WHEN job_kind IN('assistant.run-goal','assistant.run-codex-goal','assistant.run-codex-read') THEN 'agent_jobs'
 WHEN job_kind LIKE 'import.%' THEN 'active_imports' END AS meter),
 policy AS (SELECT w.owner_account_id,CASE WHEN o.id IS NOT NULL THEN o.limit_units ELSE (m->>'hard_limit')::bigint END AS capacity FROM workspaces w
 LEFT JOIN account_subscriptions s ON s.account_id=w.owner_account_id LEFT JOIN commercial_plan_versions v ON v.id=s.plan_version_id AND v.plan_id=s.plan_id
 CROSS JOIN category c LEFT JOIN LATERAL (SELECT entry AS m FROM jsonb_array_elements(v.meters) entry WHERE entry->>'meter'=c.meter) version_meter ON true
 LEFT JOIN LATERAL (SELECT * FROM commercial_entitlement_overrides e WHERE (e.account_id=w.owner_account_id OR e.workspace_id=w.id) AND e.meter=c.meter AND e.starts_at<=now() AND (e.ends_at IS NULL OR e.ends_at>now()) ORDER BY CASE WHEN e.workspace_id IS NOT NULL THEN 0 ELSE 1 END,e.created_at DESC LIMIT 1) o ON true
 WHERE w.id=target_workspace)
 SELECT NOT EXISTS(SELECT 1 FROM policy p WHERE p.capacity IS NOT NULL AND p.capacity<=(
 SELECT count(*) FROM stockchief_runtime.jobs j JOIN workspaces w ON w.id=j.workspace_id CROSS JOIN category c
 WHERE w.owner_account_id=p.owner_account_id AND j.status='RUNNING' AND
 ((c.meter='agent_jobs' AND j.kind IN('assistant.run-goal','assistant.run-codex-goal','assistant.run-codex-read')) OR
 (c.meter='active_imports' AND j.kind LIKE 'import.%'))))
$$;
