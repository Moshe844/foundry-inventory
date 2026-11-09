ALTER TABLE sales_quotations ADD COLUMN line_units jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(line_units)='object');

ALTER TABLE stockchief_runtime.agent_quote_followups
 ADD COLUMN presentation_basis text NOT NULL DEFAULT 'owner_confirmed' CHECK(presentation_basis IN ('owner_confirmed','mailbox_accepted')),
 ADD COLUMN presentation_email_id text REFERENCES customer_communications(id),
 ADD CHECK((presentation_basis='owner_confirmed' AND presentation_email_id IS NULL) OR (presentation_basis='mailbox_accepted' AND presentation_email_id IS NOT NULL AND presentation_channel='email'));
CREATE INDEX agent_quote_followup_email_evidence ON stockchief_runtime.agent_quote_followups(presentation_email_id);
UPDATE commercial_storage_usage u SET baseline_complete=false
 WHERE (u.relation='stockchief_runtime.agent_quote_followups'::regclass
 AND EXISTS(SELECT 1 FROM stockchief_runtime.agent_quote_followups r WHERE r.workspace_id=u.workspace_id))
 OR (u.relation='sales_quotations'::regclass
 AND EXISTS(SELECT 1 FROM sales_quotations q WHERE q.workspace_id=u.workspace_id));
