ALTER TABLE stockchief_runtime.agent_supplier_invoice_uploads
  ALTER COLUMN content DROP NOT NULL,
  ADD COLUMN supplier_submission_id text REFERENCES stockchief_runtime.supplier_link_submissions(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT agent_supplier_invoice_one_original CHECK (num_nonnulls(content,supplier_submission_id)=1);

CREATE UNIQUE INDEX agent_supplier_invoice_portal_submission ON stockchief_runtime.agent_supplier_invoice_uploads
  (supplier_submission_id) WHERE supplier_submission_id IS NOT NULL;

UPDATE commercial_storage_tables SET bytes_expression=
  'coalesce(octet_length(t.content),0)+octet_length(convert_to((CASE WHEN t.supplier_submission_id IS NULL THEN to_jsonb(t)-ARRAY[''content'',''supplier_submission_id'']::text[] ELSE to_jsonb(t)-''content'' END)::text,''UTF8''))'
WHERE relation='stockchief_runtime.agent_supplier_invoice_uploads'::regclass;
