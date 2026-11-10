ALTER TABLE balances ADD COLUMN quality_held numeric(20,6) NOT NULL DEFAULT 0;
ALTER TABLE balances ADD CONSTRAINT balances_quality_hold CHECK
 (quality_held>=0 AND (quality_held=0 OR on_hand>=quality_held));
CREATE INDEX balances_quality_pending ON balances(workspace_id,sku_id,location_id) WHERE quality_held>0;

CREATE TABLE stockchief_runtime.agent_quality_policies (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),sku_id text NOT NULL REFERENCES skus(id),
 location_id text NOT NULL REFERENCES locations(id),checklist jsonb NOT NULL,
 max_units integer NOT NULL CHECK(max_units BETWEEN 1 AND 100000),
 enabled boolean NOT NULL DEFAULT true,automatic_enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 authorized_by text NOT NULL REFERENCES users(id),trained_hold_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,supplier_id,sku_id,location_id)
);
CREATE INDEX agent_quality_policy_supplier ON stockchief_runtime.agent_quality_policies(supplier_id);
CREATE INDEX agent_quality_policy_sku ON stockchief_runtime.agent_quality_policies(sku_id);
CREATE INDEX agent_quality_policy_location ON stockchief_runtime.agent_quality_policies(location_id);
CREATE INDEX agent_quality_policy_owner ON stockchief_runtime.agent_quality_policies(authorized_by);
CREATE TABLE stockchief_runtime.agent_quality_holds (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 policy_id text NOT NULL REFERENCES stockchief_runtime.agent_quality_policies(id),
 receipt_line_id text NOT NULL UNIQUE REFERENCES purchase_order_receipt_lines(id),
 sku_id text NOT NULL,location_id text NOT NULL,quantity integer NOT NULL CHECK(quantity>0),
 policy_revision integer NOT NULL,checklist jsonb NOT NULL,
 status text NOT NULL DEFAULT 'HELD' CHECK(status IN ('HELD','FAILED','PASSED')),
 created_by text NOT NULL REFERENCES users(id),automatic boolean NOT NULL,
 inspected_by text REFERENCES users(id),inspected_at timestamptz,inspection jsonb,
 released_by text REFERENCES users(id),released_at timestamptz,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(sku_id,location_id) REFERENCES balances(sku_id,location_id),
 CHECK((status='PASSED')=(released_at IS NOT NULL)),
 CHECK(status='HELD' OR (inspected_by IS NOT NULL AND inspection IS NOT NULL))
);
CREATE INDEX agent_quality_hold_policy ON stockchief_runtime.agent_quality_holds(policy_id);
CREATE INDEX agent_quality_hold_position ON stockchief_runtime.agent_quality_holds(sku_id,location_id);
CREATE INDEX agent_quality_hold_creator ON stockchief_runtime.agent_quality_holds(created_by);
CREATE INDEX agent_quality_hold_inspector ON stockchief_runtime.agent_quality_holds(inspected_by);
CREATE INDEX agent_quality_hold_releaser ON stockchief_runtime.agent_quality_holds(released_by);
CREATE INDEX agent_quality_hold_pending ON stockchief_runtime.agent_quality_holds(workspace_id,created_at,id) WHERE status<>'PASSED';
CREATE INDEX agent_quality_hold_list ON stockchief_runtime.agent_quality_holds(workspace_id,created_at DESC,id DESC);

-- Delta updates serialize on the balance row, including concurrent inspections.
-- No trigger runs for unrelated bulk balance inserts or opening stock imports.
CREATE FUNCTION stockchief_runtime.apply_quality_hold_delta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE balances b SET quality_held=b.quality_held+d.quantity FROM
   (SELECT sku_id,location_id,sum(quantity) quantity FROM new_holds WHERE status<>'PASSED' GROUP BY sku_id,location_id)d
   WHERE b.sku_id=d.sku_id AND b.location_id=d.location_id;
 ELSIF TG_OP='DELETE' THEN
  UPDATE balances b SET quality_held=b.quality_held-d.quantity FROM
   (SELECT sku_id,location_id,sum(quantity) quantity FROM old_holds WHERE status<>'PASSED' GROUP BY sku_id,location_id)d
   WHERE b.sku_id=d.sku_id AND b.location_id=d.location_id;
 ELSE
  UPDATE balances b SET quality_held=b.quality_held+d.quantity FROM
   (SELECT sku_id,location_id,sum(quantity) quantity FROM (
     SELECT sku_id,location_id,quantity FROM new_holds WHERE status<>'PASSED'
     UNION ALL SELECT sku_id,location_id,-quantity FROM old_holds WHERE status<>'PASSED'
    )changes GROUP BY sku_id,location_id HAVING sum(quantity)<>0)d
   WHERE b.sku_id=d.sku_id AND b.location_id=d.location_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER quality_hold_insert AFTER INSERT ON stockchief_runtime.agent_quality_holds
 REFERENCING NEW TABLE AS new_holds FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.apply_quality_hold_delta();
CREATE TRIGGER quality_hold_update AFTER UPDATE ON stockchief_runtime.agent_quality_holds
 REFERENCING OLD TABLE AS old_holds NEW TABLE AS new_holds FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.apply_quality_hold_delta();
CREATE TRIGGER quality_hold_delete AFTER DELETE ON stockchief_runtime.agent_quality_holds
 REFERENCING OLD TABLE AS old_holds FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.apply_quality_hold_delta();

-- An older running server must fail the receipt rather than bypass a configured hold.
CREATE FUNCTION stockchief_runtime.require_receipt_quality_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM purchase_order_receipts r JOIN purchase_orders o ON o.id=r.purchase_order_id AND o.workspace_id=r.workspace_id
   JOIN stockchief_runtime.agent_quality_policies p ON p.workspace_id=o.workspace_id AND p.supplier_id=o.supplier_id
    AND p.sku_id=NEW.sku_id AND p.location_id=NEW.location_id AND p.enabled
   WHERE r.id=NEW.receipt_id AND r.workspace_id=NEW.workspace_id)
  AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_quality_holds h WHERE h.receipt_line_id=NEW.id)
 THEN RAISE EXCEPTION 'Quality inspection hold required. Review this delivery using the current receiving form.' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER receipt_quality_required AFTER INSERT ON purchase_order_receipt_lines
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.require_receipt_quality_hold();
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_quality_policies'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_quality_holds'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_quality_policies'::regclass,'stockchief_runtime.agent_quality_holds'::regclass])r;
UPDATE commercial_storage_usage SET baseline_complete=false WHERE relation='balances'::regclass;

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase','delivery-qc'));
