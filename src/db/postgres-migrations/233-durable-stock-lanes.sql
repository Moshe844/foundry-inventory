ALTER TABLE import_execution_identities ADD COLUMN execution_lane smallint CHECK(execution_lane BETWEEN 0 AND 3);
ALTER TABLE import_execution_identities ADD COLUMN parallel_stock boolean NOT NULL DEFAULT false;
CREATE INDEX import_identity_stock_lanes ON import_execution_identities(
 workspace_id,import_id,execution_lane,(coalesce(existing_item_id,product_key)),
 (coalesce(existing_sku_id,product_key||':'||variant_key)),row_number,row_id)
 WHERE execution_lane IS NOT NULL;

CREATE TABLE import_execution_lanes(
 workspace_id text NOT NULL,
 import_id text NOT NULL,
 lane smallint NOT NULL CHECK(lane BETWEEN 0 AND 3),
 approval_hash text NOT NULL,
 planned_rows bigint NOT NULL CHECK(planned_rows>=0),
 saved_rows bigint NOT NULL DEFAULT 0 CHECK(saved_rows>=0),
 quantity_delta numeric NOT NULL DEFAULT 0,
 journal_offset integer NOT NULL CHECK(journal_offset>=0),
 journal_count integer NOT NULL CHECK(journal_count>=0),
 cursor_item text NOT NULL DEFAULT '',
 cursor_key text NOT NULL DEFAULT '',
 cursor_row bigint NOT NULL DEFAULT -1,
 cursor_id text NOT NULL DEFAULT '',
 complete boolean NOT NULL DEFAULT false,
 default_reorders_covered boolean NOT NULL DEFAULT true,
 PRIMARY KEY(workspace_id,import_id,lane),
 FOREIGN KEY(workspace_id,import_id) REFERENCES import_plans(workspace_id,id) ON DELETE CASCADE,
 CHECK(saved_rows<=planned_rows)
);
CREATE TABLE import_lane_batch_receipts(
 workspace_id text NOT NULL,
 import_id text NOT NULL,
 lane smallint NOT NULL,
 start_offset bigint NOT NULL CHECK(start_offset>=0),
 end_offset bigint NOT NULL,
 row_count integer NOT NULL CHECK(row_count>0 AND row_count<=2000),
 approval_hash text NOT NULL,
 source_rows_hash text NOT NULL,
 quantity_delta numeric NOT NULL,
 cost_records integer NOT NULL CHECK(cost_records>=0 AND cost_records<=row_count),
 value_minor bigint NOT NULL,
 asset_minor bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,import_id,lane,start_offset),
 FOREIGN KEY(workspace_id,import_id,lane) REFERENCES import_execution_lanes(workspace_id,import_id,lane) ON DELETE CASCADE,
 CHECK(end_offset=start_offset+row_count),CHECK(value_minor=asset_minor)
);
CREATE TRIGGER immutable_import_lane_batch_receipt BEFORE UPDATE ON import_lane_batch_receipts
 FOR EACH ROW EXECUTE FUNCTION stockchief_immutable_import_batch_receipt();
CREATE FUNCTION stockchief_frozen_import_lane() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.execution_lane,NEW.parallel_stock) IS DISTINCT FROM (OLD.execution_lane,OLD.parallel_stock)
  AND EXISTS(SELECT 1 FROM import_plans p WHERE p.workspace_id=OLD.workspace_id AND p.id=OLD.import_id
   AND p.apply_checkpoint->>'stockLaneVersion'='1') THEN
  RAISE EXCEPTION 'The saved import execution order cannot change.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER frozen_import_lane BEFORE UPDATE OF execution_lane,parallel_stock ON import_execution_identities
 FOR EACH ROW EXECUTE FUNCTION stockchief_frozen_import_lane();
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('import_execution_lanes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('import_lane_batch_receipts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN(VALUES('import_execution_lanes'::regclass),('import_lane_batch_receipts'::regclass))r(relation);
