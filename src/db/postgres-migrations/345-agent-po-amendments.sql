ALTER TABLE stockchief_runtime.supplier_link_submissions
  ADD COLUMN amendment jsonb,
  DROP CONSTRAINT supplier_link_submissions_kind_check,
  ADD CONSTRAINT supplier_link_submissions_kind_check
    CHECK(kind IN ('confirm','date','invoice','ship-notice','unavailable','amendment')),
  ADD CONSTRAINT supplier_link_amendment_facts
    CHECK ((kind='amendment')=(amendment IS NOT NULL) AND (amendment IS NULL OR contents IS NULL));

ALTER TABLE stockchief_runtime.agent_po_date_heads
  ALTER COLUMN expected_date DROP NOT NULL,
  ALTER COLUMN original_expected_date DROP NOT NULL,
  ADD COLUMN original_goods_minor bigint;

ALTER TABLE purchase_order_lines
  ADD COLUMN supplier_amendment_closed_at text,
  DROP CONSTRAINT purchase_order_lines_quantity_units_check,
  DROP CONSTRAINT purchase_order_lines_quantity_purchase_units_check,
  ADD CONSTRAINT purchase_line_order_quantities CHECK (
    (quantity_units>0 AND quantity_purchase_units>0) OR
    (quantity_units=0 AND quantity_purchase_units=0 AND supplier_amendment_closed_at IS NOT NULL)
  ),
  ADD CONSTRAINT supplier_amendment_closed_line CHECK (
    supplier_amendment_closed_at IS NULL OR
    (quantity_units=quantity_received_units AND coalesce(secondary_quantity_ordered,0)=secondary_quantity_received)
  );

CREATE INDEX agent_po_link_amendment_review
  ON stockchief_runtime.supplier_link_submissions(workspace_id,created_at,id) WHERE kind='amendment';
CREATE INDEX agent_po_amendment_weekly_commitment
  ON purchase_order_events(workspace_id,created_at) WHERE event='supplier_purchase_amended';

-- Keep the byte representation of already measured date-only responses.
UPDATE commercial_storage_tables SET bytes_expression=replace(bytes_expression,'to_jsonb(t)',
  '(CASE WHEN t.amendment IS NULL THEN to_jsonb(t)-''amendment'' ELSE to_jsonb(t) END)')
WHERE relation='stockchief_runtime.supplier_link_submissions'::regclass;
UPDATE commercial_storage_tables SET bytes_expression=replace(bytes_expression,'to_jsonb(t)',
  '(CASE WHEN t.original_goods_minor IS NULL THEN to_jsonb(t)-''original_goods_minor'' ELSE to_jsonb(t) END)')
WHERE relation='stockchief_runtime.agent_po_date_heads'::regclass;
UPDATE commercial_storage_tables SET bytes_expression=replace(bytes_expression,'to_jsonb(t)',
  '(CASE WHEN t.supplier_amendment_closed_at IS NULL THEN to_jsonb(t)-''supplier_amendment_closed_at'' ELSE to_jsonb(t) END)')
WHERE relation='purchase_order_lines'::regclass;

DO $$
DECLARE previous text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous FROM pg_constraint
 WHERE conrelid='stockchief_runtime.agent_time_samples'::regclass AND conname='agent_time_samples_activity_check';
 ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
 EXECUTE 'ALTER TABLE stockchief_runtime.agent_time_samples ADD CONSTRAINT agent_time_samples_activity_check CHECK (('||previous||') OR activity=''po-supplier-amendment'')';
END $$;
