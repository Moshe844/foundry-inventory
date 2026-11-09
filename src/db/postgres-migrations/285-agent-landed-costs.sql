ALTER TABLE landed_cost_documents ADD COLUMN request_key text,ADD COLUMN request_hash text;
ALTER TABLE landed_cost_documents ADD COLUMN approval_hash text,
 ADD COLUMN applied_journal_entry_id text REFERENCES accounting_journal_entries(id),
 ADD COLUMN reversal_journal_entry_id text REFERENCES accounting_journal_entries(id);
CREATE UNIQUE INDEX agent_landed_cost_request ON landed_cost_documents(workspace_id,request_key) WHERE request_key IS NOT NULL;
CREATE INDEX agent_landed_cost_posted_entry ON landed_cost_documents(applied_journal_entry_id) WHERE applied_journal_entry_id IS NOT NULL;
CREATE INDEX agent_landed_cost_reversed_entry ON landed_cost_documents(reversal_journal_entry_id) WHERE reversal_journal_entry_id IS NOT NULL;
ALTER TABLE landed_cost_charges ADD COLUMN source_journal_line_id text REFERENCES accounting_journal_lines(id);
CREATE INDEX agent_landed_cost_expense_source ON landed_cost_charges(source_journal_line_id) WHERE source_journal_line_id IS NOT NULL;
CREATE INDEX agent_landed_cost_bill_claim ON landed_cost_charges(workspace_id,source_bill_line_id,document_id);
INSERT INTO stockchief_runtime.business_number_counters(workspace_id,kind,prefix,last_number)
 SELECT workspace_id,'landed_cost_documents','LC',greatest(1000,max(substring(upper(document_number) FROM '^LC-([0-9]+)$')::bigint))
 FROM landed_cost_documents WHERE document_number~*'^LC-[0-9]{1,18}$' GROUP BY workspace_id
 ON CONFLICT(workspace_id,kind,prefix) DO UPDATE SET last_number=greatest(business_number_counters.last_number,EXCLUDED.last_number);
