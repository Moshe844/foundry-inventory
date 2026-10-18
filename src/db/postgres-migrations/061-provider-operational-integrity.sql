-- Provider delivery identity is separate from its immutable business effect.
ALTER TABLE connector_feed_events ADD COLUMN effect_key TEXT;
CREATE UNIQUE INDEX connector_tenant_identity ON workspace_connectors(workspace_id,id);
ALTER TABLE connector_feed_events ADD FOREIGN KEY(workspace_id,connector_id)
 REFERENCES workspace_connectors(workspace_id,id);
CREATE UNIQUE INDEX connector_feed_effect_identity
 ON connector_feed_events(workspace_id,connector_id,effect_key) WHERE effect_key IS NOT NULL;
CREATE TABLE connection_event_deliveries (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 connector_id TEXT NOT NULL,
 delivery_id TEXT NOT NULL, effect_key TEXT NOT NULL,
 content_hash TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,connector_id,delivery_id),
 FOREIGN KEY(workspace_id,connector_id) REFERENCES workspace_connectors(workspace_id,id)
);
CREATE TABLE connection_event_conflicts (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL,
 delivery_id TEXT NOT NULL, effect_key TEXT, content_hash TEXT NOT NULL,
 evidence JSONB NOT NULL, reason TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,connector_id,delivery_id,content_hash),
 FOREIGN KEY(workspace_id,connector_id) REFERENCES workspace_connectors(workspace_id,id)
);
ALTER TABLE sales_order_lines ADD COLUMN external_line_id TEXT;
-- External orders can legitimately repeat a SKU at different prices. Keep
-- the old uniqueness rule for local lines, and use external line identity
-- for provider-owned lines instead of collapsing their money.
ALTER TABLE sales_order_lines DROP CONSTRAINT sales_order_lines_sales_order_id_sku_id_key;
CREATE UNIQUE INDEX sales_order_local_line_identity
 ON sales_order_lines(workspace_id,sales_order_id,sku_id) WHERE external_line_id IS NULL;
CREATE UNIQUE INDEX sales_order_external_line_identity
 ON sales_order_lines(workspace_id,sales_order_id,external_line_id) WHERE external_line_id IS NOT NULL;
ALTER TABLE sales_orders ADD COLUMN charges_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sales_orders ADD COLUMN priced_subtotal_minor BIGINT;
ALTER TABLE sales_orders ADD COLUMN pricing_total_minor BIGINT;
ALTER TABLE accounting_customer_invoices ADD COLUMN charges_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE accounting_customer_invoice_lines ADD COLUMN charges_minor BIGINT NOT NULL DEFAULT 0;
CREATE TABLE connection_webhook_receipts (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, connector_id TEXT NOT NULL,
 delivery_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 ciphertext TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','PROCESSING','COMPLETED','NEEDS_MAPPING','NEEDS_REVIEW','RETRY_PENDING')),
 attempt_count INTEGER NOT NULL DEFAULT 0, lease_until TIMESTAMPTZ, claim_token TEXT,
 result JSONB, error_code TEXT, error_message TEXT,
 received_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,connector_id,delivery_id),
 FOREIGN KEY(workspace_id,connector_id) REFERENCES workspace_connectors(workspace_id,id),
 CHECK ((status='PROCESSING')=(claim_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX connection_webhook_pending ON connection_webhook_receipts(workspace_id,connector_id,status,received_at);
