-- Unit validation must depend on the changed stock, not the catalogue of
-- every other business. Keep the product locks and all exact-range checks,
-- but make each catalogue lookup an indexed primary-key probe.
CREATE OR REPLACE FUNCTION stockchief_batch_stock_precision_guard() RETURNS trigger LANGUAGE plpgsql
 SET enable_hashjoin='off' SET enable_mergejoin='off' AS $$
DECLARE primary_column text;secondary_column text;bad_code text;bad_reason text;movement_rule text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM stock_measure_rows) THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='balances' THEN primary_column:='on_hand';secondary_column:='secondary_on_hand';
 ELSIF TG_TABLE_NAME='movements' THEN primary_column:='quantity_delta';secondary_column:='secondary_quantity_delta';
 ELSE RAISE EXCEPTION 'Unsupported stock measure relation'; END IF;
 PERFORM locked.id FROM (
  SELECT DISTINCT s.workspace_id,s.item_id FROM stock_measure_rows r
  JOIN LATERAL(SELECT workspace_id,item_id FROM skus WHERE id=r.sku_id OFFSET 0) s ON s.workspace_id=r.workspace_id
  ORDER BY s.workspace_id,s.item_id OFFSET 0
 ) target CROSS JOIN LATERAL(
  SELECT id FROM items i WHERE i.id=target.item_id AND i.workspace_id=target.workspace_id OFFSET 0 FOR SHARE OF i
 ) locked;
 IF EXISTS(SELECT 1 FROM stock_measure_rows r
  LEFT JOIN LATERAL(SELECT workspace_id,item_id FROM skus WHERE id=r.sku_id OFFSET 0) s ON s.workspace_id=r.workspace_id
  LEFT JOIN LATERAL(SELECT id,workspace_id FROM items WHERE id=s.item_id OFFSET 0) i ON i.workspace_id=s.workspace_id
  WHERE i.id IS NULL) THEN
  RAISE EXCEPTION 'Every stock position must identify a product in the same inventory.' USING ERRCODE='23514',CONSTRAINT='stock_quantity_precision';
 END IF;
 movement_rule:=CASE WHEN TG_TABLE_NAME='movements' THEN format(
  'WHEN i.secondary_unit_label IS NOT NULL AND (r.%1$I IS NULL OR(r.%2$I>0 AND r.%1$I<=0) OR(r.%2$I<0 AND r.%1$I>=0)) THEN ''missing_secondary''',secondary_column,primary_column) ELSE '' END;
 EXECUTE format($check$
  SELECT s.code,p.reason FROM stock_measure_rows r
  JOIN LATERAL(SELECT code,workspace_id,item_id FROM skus WHERE id=r.sku_id OFFSET 0) s ON s.workspace_id=r.workspace_id
  JOIN LATERAL(SELECT workspace_id,quantity_precision,quantity_increment,secondary_unit_label,secondary_precision,secondary_increment
   FROM items WHERE id=s.item_id OFFSET 0) i ON i.workspace_id=s.workspace_id
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
