ALTER TABLE stockchief_runtime.supplier_link_submissions
  ADD COLUMN ship_date_email jsonb,
  ADD CONSTRAINT supplier_ship_date_email_has_confirmation CHECK (
    ship_date_email IS NULL OR (kind='confirm' AND ship_date IS NOT NULL AND ship_date_email->>'id' IS NOT NULL));

CREATE UNIQUE INDEX supplier_ship_date_original_email ON stockchief_runtime.supplier_link_submissions
  (workspace_id,(ship_date_email->>'id')) WHERE ship_date_email IS NOT NULL;

UPDATE commercial_storage_tables SET bytes_expression=replace(bytes_expression,'to_jsonb(t)',
  '(CASE WHEN t.ship_date_email IS NULL THEN to_jsonb(t)-''ship_date_email'' ELSE to_jsonb(t) END)')
WHERE relation='stockchief_runtime.supplier_link_submissions'::regclass;
