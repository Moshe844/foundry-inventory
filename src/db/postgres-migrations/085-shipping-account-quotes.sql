-- A shipping offer belongs to the business account that quoted it. Never
-- substitute a newly connected account when the worker purchases a label.
ALTER TABLE shipment_rates ADD COLUMN connector_id TEXT REFERENCES workspace_connectors(id);
ALTER TABLE shipment_rates ADD COLUMN account_fingerprint TEXT;
ALTER TABLE shipment_rates ADD COLUMN parcel_fingerprint TEXT;
ALTER TABLE shipment_rates ADD COLUMN provider_shipment_ids JSONB NOT NULL DEFAULT '[]';
ALTER TABLE sales_shipments ADD COLUMN shipping_connector_id TEXT REFERENCES workspace_connectors(id);
ALTER TABLE sales_shipments ADD COLUMN shipping_quote_problems JSONB NOT NULL DEFAULT '[]';

ALTER TABLE shipment_rates DROP CONSTRAINT shipment_rates_shipment_id_provider_rate_id_key;
ALTER TABLE shipment_rates ADD CONSTRAINT shipment_rates_account_offer_key
  UNIQUE(shipment_id,connector_id,provider_rate_id);

-- Existing rates intentionally have no account binding. They must be quoted
-- again before purchase; historical completed labels remain untouched.
CREATE INDEX idx_shipping_account_shipments ON sales_shipments(workspace_id,shipping_connector_id);
