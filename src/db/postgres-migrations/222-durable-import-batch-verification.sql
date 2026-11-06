-- A verified stock batch and its evidence commit together. Finishing a new
-- import can reconcile these small immutable receipts rather than rereading
-- every source row, stock-cost movement and journal line a second time.
CREATE TABLE import_batch_receipts(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 import_id text NOT NULL REFERENCES import_plans(id) ON DELETE CASCADE,
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
 PRIMARY KEY(workspace_id,import_id,start_offset),
 CHECK(end_offset=start_offset+row_count),
 CHECK(value_minor=asset_minor)
);
CREATE FUNCTION stockchief_immutable_import_batch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Recorded import batch verification cannot be changed.' USING ERRCODE='23514';
END $$;
CREATE TRIGGER immutable_import_batch_receipt BEFORE UPDATE ON import_batch_receipts
 FOR EACH ROW EXECUTE FUNCTION stockchief_immutable_import_batch_receipt();
INSERT INTO commercial_storage_tables(relation,bytes_expression)
 VALUES('import_batch_receipts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'import_batch_receipts'::regclass,true FROM workspaces;
