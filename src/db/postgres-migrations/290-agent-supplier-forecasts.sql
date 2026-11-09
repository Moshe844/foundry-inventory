CREATE TABLE stockchief_runtime.agent_supplier_forecast_reports (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 connector_id text NOT NULL REFERENCES workspace_connectors(id),
 prepared_by text NOT NULL REFERENCES users(id),
 request_key text NOT NULL,
 input_hash text NOT NULL,
 snapshot jsonb NOT NULL,
 source_fingerprint text NOT NULL,
 week_start date NOT NULL,
 communication_id text UNIQUE REFERENCES supplier_communications(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_supplier_forecast_reports_workspace ON stockchief_runtime.agent_supplier_forecast_reports(workspace_id,created_at,id);
CREATE INDEX agent_supplier_forecast_reports_supplier ON stockchief_runtime.agent_supplier_forecast_reports(supplier_id);
CREATE INDEX agent_supplier_forecast_reports_connector ON stockchief_runtime.agent_supplier_forecast_reports(connector_id);
CREATE INDEX agent_supplier_forecast_reports_author ON stockchief_runtime.agent_supplier_forecast_reports(prepared_by);
CREATE TABLE stockchief_runtime.agent_supplier_forecast_rules (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 connector_id text NOT NULL REFERENCES workspace_connectors(id),
 authorized_by text NOT NULL REFERENCES users(id),
 scope jsonb NOT NULL,
 scope_hash text NOT NULL,
 next_due_on date NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 retry_after timestamptz,
 problem text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,supplier_id)
);
CREATE INDEX agent_supplier_forecast_rules_due ON stockchief_runtime.agent_supplier_forecast_rules(workspace_id,next_due_on,id) WHERE enabled;
CREATE INDEX agent_supplier_forecast_rules_supplier ON stockchief_runtime.agent_supplier_forecast_rules(supplier_id);
CREATE INDEX agent_supplier_forecast_rules_connector ON stockchief_runtime.agent_supplier_forecast_rules(connector_id);
CREATE INDEX agent_supplier_forecast_rules_author ON stockchief_runtime.agent_supplier_forecast_rules(authorized_by);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_supplier_forecast_reports'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_forecast_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_supplier_forecast_reports'::regclass,'stockchief_runtime.agent_supplier_forecast_rules'::regclass]) r;
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast'));
