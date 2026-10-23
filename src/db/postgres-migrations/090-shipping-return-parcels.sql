ALTER TABLE sales_shipments ADD COLUMN customer_return_id TEXT REFERENCES customer_returns(id);
ALTER TABLE sales_shipments ADD COLUMN return_outbound_shipment_id TEXT REFERENCES sales_shipments(id);
ALTER TABLE sales_shipments ADD COLUMN return_origin JSONB;
ALTER TABLE sales_shipments ADD COLUMN return_quantities JSONB;
CREATE UNIQUE INDEX one_active_return_postage_parcel ON sales_shipments(workspace_id,customer_return_id)
 WHERE customer_return_id IS NOT NULL AND status<>'CANCELLED';
