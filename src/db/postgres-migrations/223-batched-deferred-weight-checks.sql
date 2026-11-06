-- Constraint triggers cannot be statement-level and deferred together.
-- Collect changed positions in a session-local, non-WAL set, then run one
-- deferred check per transaction. Every position is retained, including
-- ordinary stock whose product metadata changes later in the transaction.
CREATE TABLE stockchief_runtime.measured_check_transactions(transaction_id xid8 PRIMARY KEY);
CREATE FUNCTION stockchief_collect_secondary_positions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM measure_changed_rows) THEN RETURN NULL; END IF;
 IF to_regclass('pg_temp.stockchief_measured_positions') IS NULL THEN
  CREATE TEMP TABLE stockchief_measured_positions(
   workspace_id text NOT NULL,sku_id text NOT NULL,location_id text NOT NULL,
   PRIMARY KEY(workspace_id,sku_id,location_id)) ON COMMIT DELETE ROWS;
 END IF;
 INSERT INTO pg_temp.stockchief_measured_positions(workspace_id,sku_id,location_id)
 SELECT DISTINCT workspace_id,sku_id,location_id FROM measure_changed_rows
 ORDER BY workspace_id,sku_id,location_id ON CONFLICT DO NOTHING;
 INSERT INTO stockchief_runtime.measured_check_transactions(transaction_id)
 VALUES(pg_current_xact_id()) ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
DROP TRIGGER secondary_position_complete ON balances;
CREATE OR REPLACE FUNCTION stockchief_secondary_position_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_temp.stockchief_measured_positions p
  CROSS JOIN LATERAL(SELECT on_hand,secondary_on_hand,workspace_id,sku_id FROM balances b
   WHERE b.sku_id=p.sku_id AND b.location_id=p.location_id AND b.workspace_id=p.workspace_id OFFSET 0)b
  JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE i.secondary_unit_label IS NOT NULL AND
   (coalesce(b.secondary_on_hand,0)<0 OR (b.on_hand=0) IS DISTINCT FROM (coalesce(b.secondary_on_hand,0)=0))) THEN
  RAISE EXCEPTION 'Pieces and actual weight must describe the same physical stock position.'
   USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';
 END IF;
 DELETE FROM stockchief_runtime.measured_check_transactions WHERE transaction_id=NEW.transaction_id;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER secondary_position_complete AFTER INSERT ON stockchief_runtime.measured_check_transactions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION stockchief_secondary_position_complete();
CREATE TRIGGER secondary_positions_insert AFTER INSERT ON balances
 REFERENCING NEW TABLE AS measure_changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_collect_secondary_positions();
CREATE TRIGGER secondary_positions_update AFTER UPDATE ON balances
 REFERENCING NEW TABLE AS measure_changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_collect_secondary_positions();
