-- Job 66 on its own (Custom): a packed shipment that repeats an authorized
-- freight lane and pallet profile is quoted and booked by the routine. When a
-- fact does not match (oversized pallets, a quote in another currency, a
-- changed address or freight account), it stops and asks instead. One row per
-- shipment says why, until the shipment changes or a person quotes it.
CREATE TABLE stockchief_runtime.agent_freight_holds (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 shipment_id text NOT NULL REFERENCES sales_shipments(id) ON DELETE CASCADE,
 template_id text NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 600),
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,shipment_id)
);
CREATE INDEX agent_freight_holds_shipment ON stockchief_runtime.agent_freight_holds(shipment_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_freight_holds'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_freight_holds'::regclass,true FROM workspaces;
