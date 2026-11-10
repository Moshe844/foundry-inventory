-- Customer paperwork uses the existing posted receivable; it never posts money.
CREATE TABLE stockchief_runtime.agent_customer_invoice_rules (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id), currency text NOT NULL,
 maximum_minor bigint NOT NULL CHECK(maximum_minor>0),
 customer_hash text NOT NULL, authorized_by text NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(workspace_id,customer_id,currency)
);
CREATE INDEX agent_customer_invoice_rule_customer ON stockchief_runtime.agent_customer_invoice_rules(customer_id);
CREATE INDEX agent_customer_invoice_rule_owner ON stockchief_runtime.agent_customer_invoice_rules(authorized_by);
CREATE TABLE stockchief_runtime.agent_customer_invoice_work (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 invoice_id text NOT NULL REFERENCES accounting_customer_invoices(id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 1, completed_revision bigint NOT NULL DEFAULT 0,
 problem text, retry_after timestamptz, changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,invoice_id)
);
CREATE INDEX agent_customer_invoice_work_due ON stockchief_runtime.agent_customer_invoice_work(workspace_id,retry_after,changed_at,invoice_id) WHERE revision>completed_revision;
CREATE INDEX agent_customer_invoice_work_invoice ON stockchief_runtime.agent_customer_invoice_work(invoice_id);
CREATE TABLE stockchief_runtime.agent_customer_invoice_documents (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 invoice_id text NOT NULL REFERENCES accounting_customer_invoices(id) ON DELETE CASCADE,
 owner_id text NOT NULL REFERENCES users(id), automatic boolean NOT NULL,
 source_hash text NOT NULL, source_snapshot jsonb NOT NULL, html text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,invoice_id,source_hash)
);
CREATE INDEX agent_customer_invoice_document_invoice ON stockchief_runtime.agent_customer_invoice_documents(invoice_id);
CREATE INDEX agent_customer_invoice_document_owner ON stockchief_runtime.agent_customer_invoice_documents(owner_id);
CREATE INDEX agent_customer_invoice_document_recent ON stockchief_runtime.agent_customer_invoice_documents(workspace_id,created_at DESC,id DESC);
CREATE TABLE stockchief_runtime.agent_customer_invoice_examples (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 document_id text NOT NULL REFERENCES stockchief_runtime.agent_customer_invoice_documents(id) ON DELETE CASCADE,
 owner_id text NOT NULL REFERENCES users(id), reviewed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,document_id,owner_id)
);
CREATE INDEX agent_customer_invoice_example_document ON stockchief_runtime.agent_customer_invoice_examples(document_id);
CREATE INDEX agent_customer_invoice_example_owner ON stockchief_runtime.agent_customer_invoice_examples(owner_id);
CREATE FUNCTION stockchief_runtime.capture_customer_invoice_work() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_revision bigint; job_key text;
BEGIN
 IF NEW.sales_order_id IS NULL OR NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_customer_invoice_rules r WHERE r.workspace_id=NEW.workspace_id AND r.customer_id=NEW.customer_id AND r.currency=NEW.currency) THEN RETURN NEW; END IF;
 -- Updates in one financial transaction coalesce into one durable worker job.
 INSERT INTO stockchief_runtime.agent_customer_invoice_work(workspace_id,invoice_id) VALUES(NEW.workspace_id,NEW.id)
 ON CONFLICT(workspace_id,invoice_id) DO UPDATE SET revision=agent_customer_invoice_work.revision+1,problem=NULL,retry_after=NULL,changed_at=clock_timestamp()
 RETURNING revision INTO current_revision;
 job_key:=NEW.id||':'||pg_current_xact_id()::text;
 INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,payload,priority,max_attempts,available_at,idempotency_key,created_at,updated_at)
 VALUES('invoicejob_'||md5(job_key),NEW.workspace_id,'agent.customer-invoice',jsonb_build_object('invoiceId',NEW.id),65,8,floor(extract(epoch FROM clock_timestamp())*1000)::bigint,job_key,now(),now()) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_agent_customer_invoice AFTER INSERT OR UPDATE ON accounting_customer_invoices FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.capture_customer_invoice_work();
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_customer_invoice_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_customer_invoice_work'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_customer_invoice_documents'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_customer_invoice_examples'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete) SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t WHERE t.relation IN('stockchief_runtime.agent_customer_invoice_rules'::regclass,'stockchief_runtime.agent_customer_invoice_work'::regclass,'stockchief_runtime.agent_customer_invoice_documents'::regclass,'stockchief_runtime.agent_customer_invoice_examples'::regclass);
