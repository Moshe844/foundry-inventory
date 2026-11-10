CREATE TABLE stockchief_runtime.agent_annual_stocktakes (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 owner_id text NOT NULL REFERENCES users(id),title text NOT NULL,stocktake_year integer NOT NULL CHECK(stocktake_year BETWEEN 2000 AND 2200),
 scope jsonb NOT NULL,plan_hash text NOT NULL,request_key text NOT NULL,status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','FROZEN','SIGNED_OFF','STOPPED')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 frozen_at timestamptz,signed_off_at timestamptz,stopped_at timestamptz,signoff jsonb,
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_annual_stocktake_workspace ON stockchief_runtime.agent_annual_stocktakes(workspace_id,created_at,id);
CREATE INDEX agent_annual_stocktake_owner ON stockchief_runtime.agent_annual_stocktakes(owner_id);
CREATE TABLE stockchief_runtime.agent_annual_count_teams (
 workspace_id text NOT NULL,stocktake_id text NOT NULL,location_id text NOT NULL REFERENCES locations(id),
 counter_id text NOT NULL REFERENCES users(id),campaign_id text UNIQUE REFERENCES warehouse_count_campaigns(id),
 planned_positions integer NOT NULL CHECK(planned_positions>=0),PRIMARY KEY(stocktake_id,location_id),
 FOREIGN KEY(workspace_id,stocktake_id) REFERENCES stockchief_runtime.agent_annual_stocktakes(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_annual_count_team_inventory ON stockchief_runtime.agent_annual_count_teams(workspace_id,stocktake_id);
CREATE INDEX agent_annual_count_team_location ON stockchief_runtime.agent_annual_count_teams(location_id);
CREATE INDEX agent_annual_count_team_counter ON stockchief_runtime.agent_annual_count_teams(counter_id);
ALTER TABLE locations ADD COLUMN annual_count_freeze_id text REFERENCES stockchief_runtime.agent_annual_stocktakes(id) ON DELETE SET NULL;
CREATE INDEX agent_annual_frozen_locations ON locations(annual_count_freeze_id) WHERE annual_count_freeze_id IS NOT NULL;
ALTER TABLE warehouse_count_campaign_lines ADD COLUMN counter_recorded_by text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE warehouse_count_campaign_lines ADD COLUMN counter_recorded_name text;
ALTER TABLE warehouse_count_campaign_lines ADD COLUMN counter_recorded_at timestamptz;
CREATE INDEX warehouse_count_counter_actor ON warehouse_count_campaign_lines(counter_recorded_by);
CREATE INDEX agent_annual_stocktake_frozen ON stockchief_runtime.agent_annual_stocktakes(workspace_id,frozen_at,id) WHERE status='FROZEN';
CREATE FUNCTION stockchief_runtime.require_annual_count_worker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='warehouse.count.apply' AND EXISTS(SELECT 1 FROM stockchief_runtime.agent_annual_count_teams t WHERE t.workspace_id=NEW.workspace_id AND t.campaign_id=NEW.payload->>'campaignId') THEN
  RAISE EXCEPTION 'This annual count needs a compatible stocktake worker. Review it after the current release finishes.' USING ERRCODE='23514',CONSTRAINT='annual_stocktake_freeze';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER annual_count_worker_protocol BEFORE INSERT OR UPDATE OF kind,payload ON stockchief_runtime.jobs FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.require_annual_count_worker();

-- Every stock writer, including an older worker, locks the same location row.
-- A concurrent freeze changes that row, so repeatable/serializable transactions
-- must retry instead of using a pre-freeze snapshot to slip a write through.
CREATE FUNCTION stockchief_runtime.guard_annual_count_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inventory text; place text; frozen text; allowed text; place_field text;
BEGIN
 place_field=coalesce(TG_ARGV[0],'location_id');
 IF TG_OP='UPDATE' AND (OLD.workspace_id,to_jsonb(OLD)->>place_field) IS DISTINCT FROM (NEW.workspace_id,to_jsonb(NEW)->>place_field) THEN
  SELECT annual_count_freeze_id INTO frozen FROM locations WHERE workspace_id=OLD.workspace_id AND id=to_jsonb(OLD)->>place_field FOR SHARE;
  IF frozen IS NOT NULL THEN RAISE EXCEPTION 'This location is frozen for an annual stocktake. Review the stocktake before moving stock or changing commitments.' USING ERRCODE='23514',CONSTRAINT='annual_stocktake_freeze'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN inventory=OLD.workspace_id;place=to_jsonb(OLD)->>place_field;ELSE inventory=NEW.workspace_id;place=to_jsonb(NEW)->>place_field;END IF;
 SELECT annual_count_freeze_id INTO frozen FROM locations WHERE workspace_id=inventory AND id=place FOR SHARE;
 IF frozen IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='DELETE' AND current_setting('stockchief.purge_workspace',true)=inventory AND EXISTS(SELECT 1 FROM developer_account_deletions d WHERE d.id=current_setting('stockchief.developer_purge_request',true) AND d.status='EXECUTING' AND d.workspace_ids ? inventory) THEN RETURN OLD;END IF;
 allowed=current_setting('stockchief.annual_count_campaign',true);
 IF TG_TABLE_NAME IN('balances','accounting_inventory_cost_balances') AND allowed IS NOT NULL AND EXISTS(
  SELECT 1 FROM stockchief_runtime.agent_annual_count_teams t JOIN stockchief_runtime.agent_annual_stocktakes p ON p.workspace_id=t.workspace_id AND p.id=t.stocktake_id
   JOIN warehouse_count_campaigns c ON c.workspace_id=t.workspace_id AND c.id=t.campaign_id
   JOIN warehouse_count_campaign_lines q ON q.workspace_id=c.workspace_id AND q.campaign_id=c.id AND q.location_id=place AND q.sku_id=coalesce(to_jsonb(NEW)->>'sku_id',to_jsonb(OLD)->>'sku_id') AND q.counted_quantity IS NOT NULL AND q.applied_at IS NULL
  WHERE t.workspace_id=inventory AND t.location_id=place AND t.stocktake_id=frozen AND t.campaign_id=allowed AND p.status='FROZEN' AND c.status='APPLYING'
 ) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 RAISE EXCEPTION 'This location is frozen for an annual stocktake. Review the stocktake before moving stock, changing its value or changing commitments.' USING ERRCODE='23514',CONSTRAINT='annual_stocktake_freeze';
END $$;
-- Group bulk stock changes by location. The statement-level guard retains the
-- same atomic rollback and location locks without one SPI lookup per stock row.
CREATE FUNCTION stockchief_runtime.guard_annual_stock_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed_places text; changed_stock text; place record; allowed text; invalid_row integer;
BEGIN
 IF TG_OP='INSERT' THEN changed_places='SELECT DISTINCT workspace_id,location_id FROM new_stocktake_rows';changed_stock='SELECT workspace_id,location_id,sku_id FROM new_stocktake_rows';
 ELSIF TG_OP='DELETE' THEN changed_places='SELECT DISTINCT workspace_id,location_id FROM old_stocktake_rows';changed_stock='SELECT workspace_id,location_id,sku_id FROM old_stocktake_rows';
 ELSE changed_places='SELECT workspace_id,location_id FROM new_stocktake_rows UNION SELECT workspace_id,location_id FROM old_stocktake_rows';changed_stock='SELECT workspace_id,location_id,sku_id FROM new_stocktake_rows UNION SELECT workspace_id,location_id,sku_id FROM old_stocktake_rows';END IF;
 FOR place IN EXECUTE 'SELECT l.workspace_id,l.id,l.annual_count_freeze_id FROM locations l JOIN ('||changed_places||') p ON p.workspace_id=l.workspace_id AND p.location_id=l.id ORDER BY l.workspace_id,l.id FOR SHARE OF l' LOOP
  IF place.annual_count_freeze_id IS NULL THEN CONTINUE;END IF;
  IF TG_OP='DELETE' AND current_setting('stockchief.purge_workspace',true)=place.workspace_id AND EXISTS(SELECT 1 FROM developer_account_deletions d WHERE d.id=current_setting('stockchief.developer_purge_request',true) AND d.status='EXECUTING' AND d.workspace_ids ? place.workspace_id) THEN CONTINUE;END IF;
  allowed=current_setting('stockchief.annual_count_campaign',true);
  IF TG_TABLE_NAME IN('balances','accounting_inventory_cost_balances') AND allowed IS NOT NULL AND EXISTS(
   SELECT 1 FROM stockchief_runtime.agent_annual_count_teams t JOIN stockchief_runtime.agent_annual_stocktakes p ON p.workspace_id=t.workspace_id AND p.id=t.stocktake_id JOIN warehouse_count_campaigns c ON c.workspace_id=t.workspace_id AND c.id=t.campaign_id
   WHERE t.workspace_id=place.workspace_id AND t.location_id=place.id AND t.stocktake_id=place.annual_count_freeze_id AND t.campaign_id=allowed AND p.status='FROZEN' AND c.status='APPLYING'
  ) THEN
   EXECUTE 'SELECT 1 FROM ('||changed_stock||') r LEFT JOIN warehouse_count_campaign_lines q ON q.workspace_id=r.workspace_id AND q.campaign_id=$1 AND q.location_id=r.location_id AND q.sku_id=r.sku_id WHERE r.workspace_id=$2 AND r.location_id=$3 AND (q.sku_id IS NULL OR q.counted_quantity IS NULL OR q.applied_at IS NOT NULL) LIMIT 1' INTO invalid_row USING allowed,place.workspace_id,place.id;
   IF invalid_row IS NULL THEN CONTINUE;END IF;
  END IF;
  RAISE EXCEPTION 'This location is frozen for an annual stocktake. Review the stocktake before moving stock, changing its value or changing commitments.' USING ERRCODE='23514',CONSTRAINT='annual_stocktake_freeze';
 END LOOP;
 RETURN NULL;
END $$;
DO $$DECLARE target text;BEGIN
 FOREACH target IN ARRAY ARRAY['balances','accounting_inventory_cost_balances','sales_order_allocations','sales_order_kit_allocations','custody_booking_lines'] LOOP
  EXECUTE format('CREATE TRIGGER annual_count_freeze_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_stocktake_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.guard_annual_stock_batch()',target);
  EXECUTE format('CREATE TRIGGER annual_count_freeze_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_stocktake_rows NEW TABLE AS new_stocktake_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.guard_annual_stock_batch()',target);
  EXECUTE format('CREATE TRIGGER annual_count_freeze_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_stocktake_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.guard_annual_stock_batch()',target);
 END LOOP;
END $$;
CREATE TRIGGER annual_count_transfer_source_freeze BEFORE INSERT OR UPDATE OR DELETE ON inventory_transfers FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.guard_annual_count_freeze('source_location_id');
CREATE TRIGGER annual_count_transfer_destination_freeze BEFORE INSERT OR UPDATE OR DELETE ON inventory_transfers FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.guard_annual_count_freeze('destination_location_id');
CREATE FUNCTION stockchief_runtime.guard_annual_count_location_tree() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen text;
BEGIN
 IF TG_OP='UPDATE' AND OLD.annual_count_freeze_id IS NOT NULL AND OLD.parent_location_id IS DISTINCT FROM NEW.parent_location_id THEN RAISE EXCEPTION 'Release the annual stocktake freeze before moving its location.' USING ERRCODE='23514',CONSTRAINT='annual_stocktake_freeze';END IF;
 IF NEW.parent_location_id IS NOT NULL THEN
  SELECT annual_count_freeze_id INTO frozen FROM locations WHERE workspace_id=NEW.workspace_id AND id=NEW.parent_location_id FOR SHARE;
  IF frozen IS NOT NULL THEN RAISE EXCEPTION 'This parent location is frozen for an annual stocktake. Release its freeze before adding or moving a bin.' USING ERRCODE='23514',CONSTRAINT='annual_stocktake_freeze';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER annual_count_location_tree BEFORE INSERT OR UPDATE OF parent_location_id ON locations FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.guard_annual_count_location_tree();

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_annual_stocktakes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_annual_count_teams'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_annual_stocktakes'::regclass,'stockchief_runtime.agent_annual_count_teams'::regclass])r;

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase','delivery-qc','supplier-rfq','supplier-claim','customer-reservation','customer-priority','channel-buffer','annual-stocktake'));
