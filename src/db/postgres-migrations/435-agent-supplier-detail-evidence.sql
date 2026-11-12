-- Job 96: supplier details are read from ordinary emails and their attachments,
-- including pack sizes, the supplier's own lead time and a new order address.
ALTER TABLE stockchief_runtime.agent_supplier_term_heads DROP CONSTRAINT agent_supplier_term_heads_field_check;
ALTER TABLE stockchief_runtime.agent_supplier_term_heads ADD CONSTRAINT agent_supplier_term_heads_field_check
 CHECK(field IN ('lead_time_days','minimum_order_quantity','units_per_purchase_unit','default_lead_time_days','contact_name','phone','email'));
-- A person can keep current values instead of an update, and undo an applied one.
ALTER TABLE stockchief_runtime.agent_supplier_term_sources
 ADD COLUMN dismissed_at timestamptz,
 ADD COLUMN dismissed_by text REFERENCES users(id),
 ADD COLUMN undone_at timestamptz,
 ADD COLUMN undone_by text REFERENCES users(id),
 ADD CHECK(dismissed_at IS NULL OR dismissed_by IS NOT NULL),
 ADD CHECK(undone_at IS NULL OR (undone_by IS NOT NULL AND processed_at IS NOT NULL));
CREATE INDEX agent_supplier_term_source_dismissed_by ON stockchief_runtime.agent_supplier_term_sources(dismissed_by);
CREATE INDEX agent_supplier_term_source_undone_by ON stockchief_runtime.agent_supplier_term_sources(undone_by);
CREATE INDEX agent_supplier_term_source_waiting ON stockchief_runtime.agent_supplier_term_sources(workspace_id,message_id)
 WHERE processed_at IS NULL AND dismissed_at IS NULL;
