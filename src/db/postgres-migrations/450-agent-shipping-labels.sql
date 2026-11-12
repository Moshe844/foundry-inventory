-- Jobs 58 and 59: for each packed parcel StockChief compares the current
-- quotes from every connected shipping account, picks the cheapest one that
-- arrives by the promised date, and buys its label within the owner's limits
-- or prepares it for one tap. One row per parcel as it was quoted: a changed
-- parcel is a new row, so an old choice never buys a label for new facts.
ALTER TABLE shipment_rates ADD COLUMN ship_date text;

CREATE TABLE stockchief_runtime.agent_label_runs (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 shipment_id text NOT NULL REFERENCES sales_shipments(id) ON DELETE CASCADE,
 fingerprint text NOT NULL,
 status text NOT NULL CHECK(status IN ('HELD','SUGGESTED','CHOSEN','QUEUED','DECLINED')),
 mode text NOT NULL CHECK(mode IN ('watch','suggest','draft','automatic')),
 promised_date text,
 rate_id text,
 carrier text,
 service text,
 amount_minor bigint CHECK(amount_minor IS NULL OR amount_minor>=0),
 currency text,
 arrival_date text,
 guaranteed boolean,
 hold text CHECK(hold IN ('promise','parcel','rates','address','late')),
 reason text,
 label_reason text,
 effect_id text,
 transaction_id text,
 decided_by text REFERENCES users(id) ON DELETE SET NULL,
 decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,shipment_id,fingerprint),
 CHECK(status='HELD' OR rate_id IS NOT NULL AND amount_minor IS NOT NULL AND currency IS NOT NULL),
 CHECK((status='HELD')=(hold IS NOT NULL))
);
CREATE INDEX agent_label_run_open ON stockchief_runtime.agent_label_runs(workspace_id,updated_at DESC) WHERE status IN ('HELD','SUGGESTED','CHOSEN');
CREATE INDEX agent_label_run_shipment ON stockchief_runtime.agent_label_runs(shipment_id,updated_at DESC);
CREATE INDEX agent_label_run_person ON stockchief_runtime.agent_label_runs(decided_by) WHERE decided_by IS NOT NULL;

-- Growth: the owner's saved rule lets StockChief choose the rate on its own.
CREATE TABLE stockchief_runtime.agent_shipping_rate_rules (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT true,
 authorized_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_shipping_rate_rule_owner ON stockchief_runtime.agent_shipping_rate_rules(authorized_by);
