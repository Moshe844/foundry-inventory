-- Keep unit/weight checks in PostgreSQL for every writer, while validating a
-- statement as a set instead of reading the same product twice for every row.
-- The deferred final pieces/weight consistency constraint is retained.
SET LOCAL lock_timeout='1000ms';
CREATE FUNCTION stockchief_batch_stock_precision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE primary_column text;secondary_column text;bad_code text;bad_reason text;movement_rule text;
BEGIN
 IF TG_TABLE_NAME='balances' THEN primary_column:='on_hand';secondary_column:='secondary_on_hand';
 ELSIF TG_TABLE_NAME='movements' THEN primary_column:='quantity_delta';secondary_column:='secondary_quantity_delta';
 ELSE RAISE EXCEPTION 'Unsupported stock measure relation'; END IF;
 PERFORM i.id FROM items i JOIN (
  SELECT DISTINCT s.workspace_id,s.item_id FROM stock_measure_rows r
  JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id
 ) target ON target.workspace_id=i.workspace_id AND target.item_id=i.id
 ORDER BY i.workspace_id,i.id FOR SHARE OF i;
 IF EXISTS(SELECT 1 FROM stock_measure_rows r LEFT JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id
  LEFT JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE i.id IS NULL) THEN
  RAISE EXCEPTION 'Every stock position must identify a product in the same inventory.' USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';
 END IF;
 movement_rule:=CASE WHEN TG_TABLE_NAME='movements' THEN format(
  'WHEN i.secondary_unit_label IS NOT NULL AND (r.%1$I IS NULL OR(r.%2$I>0 AND r.%1$I<=0) OR(r.%2$I<0 AND r.%1$I>=0)) THEN ''missing_secondary''',secondary_column,primary_column) ELSE '' END;
 EXECUTE format($check$
  SELECT s.code,p.reason FROM stock_measure_rows r
  JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  CROSS JOIN LATERAL(SELECT CASE
   WHEN r.%1$I<>round(r.%1$I,i.quantity_precision) OR mod(r.%1$I,i.quantity_increment)<>0 OR abs(r.%1$I)*power(10::numeric,i.quantity_precision)>9007199254740991 THEN 'primary'
   WHEN i.secondary_unit_label IS NULL AND r.%2$I IS NOT NULL THEN 'unexpected_secondary'
   WHEN i.secondary_unit_label IS NOT NULL AND r.%2$I IS NOT NULL AND(r.%2$I<>round(r.%2$I,i.secondary_precision) OR mod(r.%2$I,i.secondary_increment)<>0 OR abs(r.%2$I)*power(10::numeric,i.secondary_precision)>9007199254740991) THEN 'secondary'
   %3$s ELSE NULL END reason)p WHERE p.reason IS NOT NULL LIMIT 1
 $check$,primary_column,secondary_column,movement_rule) INTO bad_code,bad_reason;
 IF bad_reason='primary' THEN RAISE EXCEPTION 'Stock quantity for % must match the product precision, increment and exact range.',bad_code USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';
 ELSIF bad_reason='unexpected_secondary' THEN RAISE EXCEPTION 'This product does not use a second stocking measure.' USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';
 ELSIF bad_reason='secondary' THEN RAISE EXCEPTION 'Actual stock weight must match the product precision and increment.' USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';
 ELSIF bad_reason='missing_secondary' THEN RAISE EXCEPTION 'Every catch-weight movement needs its actual measured weight.' USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';END IF;
 RETURN NULL;
END $$;
DROP TRIGGER stock_precision_guard ON balances;
DROP TRIGGER secondary_precision_guard ON balances;
DROP TRIGGER stock_precision_guard ON movements;
DROP TRIGGER secondary_precision_guard ON movements;
CREATE TRIGGER aa_stock_precision_insert AFTER INSERT ON balances REFERENCING NEW TABLE AS stock_measure_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_batch_stock_precision_guard();
CREATE TRIGGER aa_stock_precision_update AFTER UPDATE ON balances REFERENCING NEW TABLE AS stock_measure_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_batch_stock_precision_guard();
CREATE TRIGGER aa_stock_precision_insert AFTER INSERT ON movements REFERENCING NEW TABLE AS stock_measure_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_batch_stock_precision_guard();
CREATE TRIGGER aa_stock_precision_update AFTER UPDATE ON movements REFERENCING NEW TABLE AS stock_measure_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_batch_stock_precision_guard();
SET LOCAL lock_timeout='120000ms';
