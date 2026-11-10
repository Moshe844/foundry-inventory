CREATE TABLE stockchief_runtime.agent_return_disposition_rules (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 sku_id text NOT NULL REFERENCES skus(id),condition_code text NOT NULL,condition_label text NOT NULL,
 outcome text NOT NULL CHECK(outcome IN('RESTOCK','REPAIR','SCRAP')),destination_id text REFERENCES locations(id),
 maximum_units integer NOT NULL CHECK(maximum_units BETWEEN 1 AND 100000),enabled boolean NOT NULL DEFAULT true,
 routine_enabled boolean NOT NULL DEFAULT false,trained_assessment_id text,authorized_by text NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,sku_id,condition_code),CHECK((outcome='SCRAP')=(destination_id IS NULL))
);
CREATE INDEX agent_disposition_rule_sku ON stockchief_runtime.agent_return_disposition_rules(sku_id);
CREATE INDEX agent_disposition_rule_destination ON stockchief_runtime.agent_return_disposition_rules(destination_id);
CREATE INDEX agent_disposition_rule_owner ON stockchief_runtime.agent_return_disposition_rules(authorized_by);
CREATE TABLE stockchief_runtime.agent_return_assessments (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 return_id text NOT NULL REFERENCES customer_returns(id),observed_by text NOT NULL REFERENCES users(id),
 source_snapshot jsonb NOT NULL,observations jsonb NOT NULL,source_hash text NOT NULL,
 status text NOT NULL DEFAULT 'OBSERVED' CHECK(status IN('OBSERVED','READY','APPLIED','STOPPED')),
 proposal jsonb,problem text,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 applied_by text REFERENCES users(id),applied_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX agent_return_assessment_active ON stockchief_runtime.agent_return_assessments(workspace_id,return_id) WHERE status IN('OBSERVED','READY');
CREATE INDEX agent_return_assessment_return ON stockchief_runtime.agent_return_assessments(return_id);
CREATE INDEX agent_return_assessment_observer ON stockchief_runtime.agent_return_assessments(observed_by);
CREATE INDEX agent_return_assessment_reviewer ON stockchief_runtime.agent_return_assessments(applied_by);
CREATE INDEX agent_return_assessment_pending ON stockchief_runtime.agent_return_assessments(workspace_id,created_at) WHERE status IN('OBSERVED','READY');
ALTER TABLE stockchief_runtime.agent_return_disposition_rules ADD FOREIGN KEY(trained_assessment_id) REFERENCES stockchief_runtime.agent_return_assessments(id);
CREATE INDEX agent_disposition_rule_example ON stockchief_runtime.agent_return_disposition_rules(trained_assessment_id);
CREATE TABLE stockchief_runtime.agent_return_repair_holds (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 assessment_id text NOT NULL REFERENCES stockchief_runtime.agent_return_assessments(id),
 return_line_id text NOT NULL UNIQUE REFERENCES customer_return_lines(id),sku_id text NOT NULL REFERENCES skus(id),
 location_id text NOT NULL REFERENCES locations(id),quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),
 status text NOT NULL DEFAULT 'HELD' CHECK(status IN('HELD','RELEASED')),released_by text REFERENCES users(id),
 release_note text,released_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_return_repair_assessment ON stockchief_runtime.agent_return_repair_holds(assessment_id);
CREATE INDEX agent_return_repair_sku ON stockchief_runtime.agent_return_repair_holds(sku_id);
CREATE INDEX agent_return_repair_location ON stockchief_runtime.agent_return_repair_holds(location_id);
CREATE INDEX agent_return_repair_reviewer ON stockchief_runtime.agent_return_repair_holds(released_by);
CREATE INDEX agent_return_repair_pending ON stockchief_runtime.agent_return_repair_holds(workspace_id,created_at) WHERE status='HELD';
CREATE FUNCTION stockchief_runtime.return_repair_hold_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' AND OLD.status='HELD' THEN
  UPDATE balances SET quality_held=quality_held-OLD.quantity WHERE workspace_id=OLD.workspace_id AND sku_id=OLD.sku_id AND location_id=OLD.location_id;
 END IF;
 IF TG_OP<>'DELETE' AND NEW.status='HELD' THEN
  UPDATE balances SET quality_held=quality_held+NEW.quantity WHERE workspace_id=NEW.workspace_id AND sku_id=NEW.sku_id AND location_id=NEW.location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Returned repair stock has no physical balance'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER agent_return_repair_balance AFTER INSERT OR UPDATE OR DELETE ON stockchief_runtime.agent_return_repair_holds
 FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.return_repair_hold_balance();
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_return_disposition_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_return_assessments'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_return_repair_holds'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_return_disposition_rules'::regclass,'stockchief_runtime.agent_return_assessments'::regclass,'stockchief_runtime.agent_return_repair_holds'::regclass])r;

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK(activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase','delivery-qc','supplier-rfq','supplier-claim','customer-reservation','customer-priority','channel-buffer','annual-stocktake','partial-shipment','return-label','export-papers','return-disposition'));
