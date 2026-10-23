ALTER TABLE import_plans ADD COLUMN IF NOT EXISTS apply_checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN import_plans.apply_checkpoint IS
 'Execution progress bound to the immutable approval hash. Each saved batch commits its stock, accounting, source details and checkpoint together.';
CREATE TABLE import_catalogue_bindings (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 import_id TEXT NOT NULL REFERENCES import_plans(id),
 product_key TEXT NOT NULL,
 variant_key TEXT NOT NULL,
 item_id TEXT NOT NULL REFERENCES items(id),
 sku_id TEXT NOT NULL REFERENCES skus(id),
 PRIMARY KEY(workspace_id,import_id,product_key,variant_key)
);
COMMENT ON TABLE import_catalogue_bindings IS
 'Durable workflow identity references for approved imported variants, including rows without supplied codes. Stock and accounting stay in their canonical engines.';
