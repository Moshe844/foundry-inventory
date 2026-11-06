-- Catalogue construction reads only identities that do not already have a
-- SKU. Stock receipts must not maintain two additional wide product indexes
-- for every existing-SKU source row. Keep the source/order, SKU lookup and
-- primary-key indexes; no source, receipt or foreign key is removed.
SET LOCAL lock_timeout='1000ms';
DROP INDEX import_execution_identity_product;
CREATE INDEX import_execution_identity_product ON import_execution_identities
 (workspace_id,import_id,product_key,variant_key,row_number,row_id)
 WHERE existing_sku_id IS NULL;
DROP INDEX import_execution_identity_product_source;
CREATE INDEX import_execution_identity_product_source ON import_execution_identities
 (workspace_id,import_id,product_key,row_number,row_id)
 WHERE existing_sku_id IS NULL;
SET LOCAL lock_timeout='120000ms';
