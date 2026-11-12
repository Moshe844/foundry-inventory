-- Job 93: when an item needs buying and the owner wants competition (a new
-- item, a purchase above a value, or named items or categories), StockChief
-- asks the suppliers named in the owner's rule for quotes. Each RFQ keeps the
-- rule that raised it; each supplier email keeps its reminder and the reply
-- recorded as a quotation. Nothing here places an order or accepts a price.
CREATE TABLE stockchief_runtime.agent_rfq_competition_rules (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 new_items boolean NOT NULL DEFAULT false,
 threshold_minor bigint CHECK(threshold_minor>0),
 currency text CHECK(currency ~ '^[A-Z]{3}$'),
 sku_ids text[] NOT NULL DEFAULT '{}',
 categories text[] NOT NULL DEFAULT '{}',
 supplier_ids text[] NOT NULL CHECK(cardinality(supplier_ids) BETWEEN 2 AND 20),
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 connector_id text NOT NULL REFERENCES workspace_connectors(id) ON DELETE CASCADE,
 reply_days integer NOT NULL CHECK(reply_days BETWEEN 1 AND 60),
 delivery_days integer NOT NULL CHECK(delivery_days BETWEEN 1 AND 365),
 chase_days integer NOT NULL CHECK(chase_days BETWEEN 1 AND 60),
 max_requests_per_week integer NOT NULL CHECK(max_requests_per_week BETWEEN 1 AND 20),
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 authorized_by text NOT NULL REFERENCES users(id),
 example_request_id text REFERENCES stockchief_runtime.agent_rfq_requests(id) ON DELETE SET NULL,
 last_note text,
 last_run_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(new_items OR threshold_minor IS NOT NULL OR cardinality(sku_ids)>0 OR cardinality(categories)>0),
 CHECK((threshold_minor IS NULL)=(currency IS NULL))
);
CREATE INDEX agent_rfq_competition_list ON stockchief_runtime.agent_rfq_competition_rules(workspace_id,created_at DESC,id DESC);
CREATE INDEX agent_rfq_competition_owner ON stockchief_runtime.agent_rfq_competition_rules(authorized_by);
CREATE INDEX agent_rfq_competition_example ON stockchief_runtime.agent_rfq_competition_rules(example_request_id);
CREATE INDEX agent_rfq_competition_location ON stockchief_runtime.agent_rfq_competition_rules(location_id);
CREATE INDEX agent_rfq_competition_connector ON stockchief_runtime.agent_rfq_competition_rules(connector_id);

ALTER TABLE stockchief_runtime.agent_rfq_requests
 ADD COLUMN competition_rule_id text REFERENCES stockchief_runtime.agent_rfq_competition_rules(id) ON DELETE SET NULL,
 ADD COLUMN trigger_key text,
 ADD COLUMN needs_person text,
 ADD COLUMN closed_at timestamptz,
 ADD COLUMN closed_by text REFERENCES users(id);
CREATE INDEX agent_rfq_request_closer ON stockchief_runtime.agent_rfq_requests(closed_by) WHERE closed_by IS NOT NULL;
CREATE UNIQUE INDEX agent_rfq_request_trigger ON stockchief_runtime.agent_rfq_requests(workspace_id,trigger_key) WHERE trigger_key IS NOT NULL;
CREATE INDEX agent_rfq_request_competition ON stockchief_runtime.agent_rfq_requests(competition_rule_id) WHERE competition_rule_id IS NOT NULL;

ALTER TABLE stockchief_runtime.agent_rfq_deliveries
 ADD COLUMN competition_rule_id text REFERENCES stockchief_runtime.agent_rfq_competition_rules(id) ON DELETE SET NULL,
 ADD COLUMN competition_revision integer,
 ADD COLUMN reply_message_id text REFERENCES connection_email_messages(id) ON DELETE SET NULL,
 ADD COLUMN quote_document_id text REFERENCES supplier_documents(id) ON DELETE SET NULL,
 ADD COLUMN chase_communication_id text REFERENCES supplier_communications(id),
 ADD COLUMN chase_automatic boolean,
 ADD COLUMN chased_at timestamptz;
ALTER TABLE stockchief_runtime.agent_rfq_deliveries DROP CONSTRAINT agent_rfq_deliveries_check;
ALTER TABLE stockchief_runtime.agent_rfq_deliveries ADD CONSTRAINT agent_rfq_deliveries_check
 CHECK(automatic=(rule_id IS NOT NULL OR competition_rule_id IS NOT NULL) AND NOT(rule_id IS NOT NULL AND competition_rule_id IS NOT NULL));
CREATE INDEX agent_rfq_delivery_competition ON stockchief_runtime.agent_rfq_deliveries(competition_rule_id,created_at) WHERE competition_rule_id IS NOT NULL;
CREATE INDEX agent_rfq_delivery_reply ON stockchief_runtime.agent_rfq_deliveries(reply_message_id) WHERE reply_message_id IS NOT NULL;
CREATE INDEX agent_rfq_delivery_quote ON stockchief_runtime.agent_rfq_deliveries(quote_document_id) WHERE quote_document_id IS NOT NULL;
CREATE INDEX agent_rfq_delivery_chase ON stockchief_runtime.agent_rfq_deliveries(chase_communication_id) WHERE chase_communication_id IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_rfq_competition_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_rfq_competition_rules'::regclass,true FROM workspaces;
