-- Job 125: a Custom account sees stock, value, buying and sales across its
-- inventories. The worker keeps each inventory's own part current on a
-- schedule; the page combines only the parts the person may open, so access
-- is applied when the figures are read, never when they are saved.
CREATE TABLE stockchief_runtime.agent_inventory_rollups (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 refreshed_at timestamptz,
 request_key text CHECK(request_key IS NULL OR length(request_key) BETWEEN 1 AND 120),
 fingerprint text,
 summary jsonb NOT NULL DEFAULT '{}'::jsonb,
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
 held_reason text CHECK(held_reason IS NULL OR length(held_reason) BETWEEN 1 AND 300),
 held_at timestamptz,
 approved_by text REFERENCES users(id) ON DELETE SET NULL,
 approved_at timestamptz
);
CREATE INDEX agent_inventory_rollup_approver ON stockchief_runtime.agent_inventory_rollups(approved_by) WHERE approved_by IS NOT NULL;

-- One row per active product variant that holds stock, has a reorder point,
-- is on an open purchase order or sold in the last 30 days. Codes and
-- barcodes are kept with a normalised key so inventories can be matched.
CREATE TABLE stockchief_runtime.agent_inventory_rollup_items (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
 item_id text NOT NULL REFERENCES items(id) ON DELETE CASCADE,
 code text NOT NULL,
 code_key text NOT NULL,
 barcode text,
 barcode_key text,
 product text NOT NULL,
 unit text NOT NULL,
 unit_key text NOT NULL,
 on_hand numeric NOT NULL,
 is_low boolean NOT NULL,
 is_out boolean NOT NULL,
 incoming numeric NOT NULL CHECK(incoming>=0),
 sold numeric NOT NULL CHECK(sold>=0),
 PRIMARY KEY(workspace_id,sku_id)
);
CREATE INDEX agent_inventory_rollup_item_sku ON stockchief_runtime.agent_inventory_rollup_items(sku_id);
CREATE INDEX agent_inventory_rollup_item_item ON stockchief_runtime.agent_inventory_rollup_items(item_id);
CREATE INDEX agent_inventory_rollup_item_code ON stockchief_runtime.agent_inventory_rollup_items(workspace_id,code_key);
CREATE INDEX agent_inventory_rollup_item_barcode ON stockchief_runtime.agent_inventory_rollup_items(workspace_id,barcode_key) WHERE barcode_key IS NOT NULL;
