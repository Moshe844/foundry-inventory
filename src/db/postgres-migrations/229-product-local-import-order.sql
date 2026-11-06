-- Group a product's variants together before their stock is applied. Random
-- SKU IDs scatter one parent's stock rollup across most batches in a large
-- catalogue; the product prefix bounds that work without changing the order
-- of repeated receipts for any SKU. Frozen older plans retain their existing
-- source/SKU cursor and index until they complete.
CREATE INDEX import_execution_identity_item_order ON import_execution_identities
 (workspace_id,import_id,(coalesce(existing_item_id,product_key)),
  (coalesce(existing_sku_id,product_key||':'||variant_key)),row_number,row_id);

-- A just-staged source can have empty-table statistics. In that case the
-- planner otherwise predicts one row, walks a different scope index and sorts
-- the complete remaining source at every cursor. Keep the ordering preference
-- local to this bounded page, restoring the caller's settings on return.
CREATE FUNCTION stockchief_import_item_page(text,text,text,text,bigint,text,integer)
 RETURNS TABLE(row_id text,row_number bigint,execution_key text,item_key text)
 LANGUAGE sql STABLE ROWS 2000 SET enable_sort='off' AS $$
 SELECT row_id,row_number,coalesce(existing_sku_id,product_key||':'||variant_key),coalesce(existing_item_id,product_key)
 FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2
 AND (coalesce(existing_item_id,product_key),coalesce(existing_sku_id,product_key||':'||variant_key),row_number,row_id)>($3,$4,$5,$6)
 ORDER BY coalesce(existing_item_id,product_key),coalesce(existing_sku_id,product_key||':'||variant_key),row_number,row_id
 LIMIT least(greatest($7,1),2000)
$$;
