-- Job 69: the ship-to address is checked before any label is bought, on every
-- plan. One row per parcel and exact situation: the parcel's address, the
-- order's address and whether the customer is a business. A changed address is
-- a new row, so an old answer or decision never covers a different address.
-- The carrier's own address check is used where the connected account offers
-- one. A person decides anything that is not only a formatting change.
CREATE TABLE stockchief_runtime.agent_address_checks (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 shipment_id text NOT NULL REFERENCES sales_shipments(id) ON DELETE CASCADE,
 fingerprint text NOT NULL,
 address text NOT NULL,
 order_address text,
 provider text,
 connector_id text REFERENCES workspace_connectors(id) ON DELETE SET NULL,
 result text NOT NULL CHECK(result IN ('VERIFIED','FORMATTED','CORRECTED','UNDELIVERABLE','UNVERIFIED','UNCHECKED','FAILED')),
 residential boolean,
 po_box boolean NOT NULL DEFAULT false,
 suggested_address text,
 messages jsonb NOT NULL DEFAULT '[]'::jsonb,
 hold text CHECK(hold IN ('changed','correction','undeliverable','unverified','residential','failed')),
 hold_reason text,
 decision text CHECK(decision IN ('ACCEPTED','KEPT','FORMATTED')),
 decided_by text REFERENCES users(id) ON DELETE SET NULL,
 decided_at timestamptz,
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,shipment_id,fingerprint),
 CHECK((hold IS NULL)=(hold_reason IS NULL))
);
CREATE INDEX agent_address_check_open ON stockchief_runtime.agent_address_checks(workspace_id,checked_at DESC) WHERE hold IS NOT NULL AND decision IS NULL;
CREATE INDEX agent_address_check_shipment ON stockchief_runtime.agent_address_checks(shipment_id);
CREATE INDEX agent_address_check_connector ON stockchief_runtime.agent_address_checks(connector_id) WHERE connector_id IS NOT NULL;
CREATE INDEX agent_address_check_person ON stockchief_runtime.agent_address_checks(decided_by) WHERE decided_by IS NOT NULL;
