-- Job 46: photos of damaged boxes taken on the phone at receiving or on a
-- delivery check, not only at a failed QC inspection. Each photo belongs to
-- exactly one QC hold, purchase receipt or delivery check.
ALTER TABLE stockchief_runtime.agent_quality_photos
 ALTER COLUMN hold_id DROP NOT NULL,
 ADD COLUMN receipt_id text REFERENCES purchase_order_receipts(id),
 ADD COLUMN delivery_comparison_id text,
 ADD CONSTRAINT agent_quality_photo_comparison FOREIGN KEY(workspace_id,delivery_comparison_id)
  REFERENCES stockchief_runtime.agent_delivery_comparisons(workspace_id,id),
 ADD CONSTRAINT agent_quality_photo_one_parent CHECK (num_nonnulls(hold_id,receipt_id,delivery_comparison_id)=1);
CREATE UNIQUE INDEX agent_quality_photo_receipt_content ON stockchief_runtime.agent_quality_photos(receipt_id,content_hash) WHERE receipt_id IS NOT NULL;
CREATE UNIQUE INDEX agent_quality_photo_comparison_content ON stockchief_runtime.agent_quality_photos(workspace_id,delivery_comparison_id,content_hash) WHERE delivery_comparison_id IS NOT NULL;
CREATE INDEX agent_quality_photo_receipt ON stockchief_runtime.agent_quality_photos(receipt_id,created_at,id) WHERE receipt_id IS NOT NULL;
-- Keep the byte representation of photos recorded before these columns.
UPDATE commercial_storage_tables SET bytes_expression=replace(bytes_expression,'(to_jsonb(t)-''content''-''email_content'')',
 '(to_jsonb(t)-''content''-''email_content''-(CASE WHEN t.receipt_id IS NULL AND t.delivery_comparison_id IS NULL THEN ARRAY[''receipt_id'',''delivery_comparison_id''] ELSE ARRAY[]::text[] END))')
WHERE relation='stockchief_runtime.agent_quality_photos'::regclass;
