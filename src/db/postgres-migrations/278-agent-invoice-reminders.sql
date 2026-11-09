CREATE TABLE stockchief_runtime.agent_invoice_reminder_rules (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id),
 connector_id text NOT NULL REFERENCES workspace_connectors(id),
 mailbox_account text NOT NULL,
 provider_type text NOT NULL CHECK(provider_type IN ('gmail','microsoft365')),
 recipient text NOT NULL,
 currency text NOT NULL,
 maximum_minor bigint NOT NULL CHECK(maximum_minor>0),
 days_after_due integer[] NOT NULL CHECK(cardinality(days_after_due) BETWEEN 1 AND 12 AND 1<=ALL(days_after_due) AND 365>=ALL(days_after_due) AND array_position(days_after_due,NULL) IS NULL),
 authorized_by text NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 problem text,
 retry_after timestamptz,
 PRIMARY KEY(workspace_id,customer_id)
);
CREATE INDEX agent_invoice_reminder_author ON stockchief_runtime.agent_invoice_reminder_rules(authorized_by);
CREATE INDEX agent_invoice_reminder_mailbox ON stockchief_runtime.agent_invoice_reminder_rules(connector_id);
CREATE INDEX agent_invoice_reminder_customer ON stockchief_runtime.agent_invoice_reminder_rules(customer_id);
CREATE INDEX agent_invoice_reminder_due ON accounting_customer_invoices(workspace_id,customer_id,due_date,id) WHERE status IN ('OPEN','PARTIALLY_PAID') AND balance_minor>0;
ALTER TABLE customer_communications ADD COLUMN customer_invoice_id text REFERENCES accounting_customer_invoices(id);
CREATE INDEX customer_communication_invoice ON customer_communications(workspace_id,customer_invoice_id,sent_at) WHERE customer_invoice_id IS NOT NULL;
CREATE INDEX customer_communication_invoice_reference ON customer_communications(customer_invoice_id) WHERE customer_invoice_id IS NOT NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression)
 VALUES('stockchief_runtime.agent_invoice_reminder_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_invoice_reminder_rules'::regclass,true FROM workspaces;

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase','customer-receipt','customer-reminder'));
