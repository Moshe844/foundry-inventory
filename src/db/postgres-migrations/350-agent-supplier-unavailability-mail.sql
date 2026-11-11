ALTER TABLE stockchief_runtime.agent_backup_supplier_notices
  ADD COLUMN original_email_message_id text REFERENCES connection_email_messages(id) ON DELETE SET NULL,
  ADD COLUMN email_source jsonb;

CREATE UNIQUE INDEX supplier_unavailability_original_email ON stockchief_runtime.agent_backup_supplier_notices
  (workspace_id,original_email_message_id,line_id) WHERE original_email_message_id IS NOT NULL;
CREATE INDEX supplier_unavailability_mail_message ON stockchief_runtime.agent_backup_supplier_notices(original_email_message_id)
  WHERE original_email_message_id IS NOT NULL;

UPDATE commercial_storage_tables SET bytes_expression=replace(bytes_expression,'to_jsonb(t)',
  '(CASE WHEN t.email_source IS NULL THEN to_jsonb(t)-ARRAY[''original_email_message_id'',''email_source'']::text[] ELSE to_jsonb(t) END)')
WHERE relation='stockchief_runtime.agent_backup_supplier_notices'::regclass;
