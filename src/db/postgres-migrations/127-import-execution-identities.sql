-- Bounded execution lookups, separate from immutable source and approval data.
ALTER TABLE import_plans ADD COLUMN execution_identity_hash text;
CREATE TABLE import_execution_identities (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 import_id text NOT NULL REFERENCES import_plans(id) ON DELETE CASCADE,
 row_id text PRIMARY KEY REFERENCES import_rows(id) ON DELETE CASCADE,
 row_number bigint NOT NULL,
 product_key text NOT NULL,
 variant_key text NOT NULL,
 existing_sku_id text,
 existing_item_id text,
 selling_price_minor bigint,
 currency text,
 catalogue_update jsonb
);
CREATE INDEX import_execution_identity_page ON import_execution_identities(workspace_id,import_id,row_number,row_id);
CREATE INDEX import_execution_identity_product ON import_execution_identities(workspace_id,import_id,product_key,variant_key,row_number,row_id);
CREATE INDEX import_execution_identity_sku ON import_execution_identities(workspace_id,import_id,existing_sku_id);
CREATE INDEX import_execution_identity_product_source ON import_execution_identities(workspace_id,import_id,product_key,row_number,row_id);
