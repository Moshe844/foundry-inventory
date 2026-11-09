CREATE TABLE stockchief_runtime.product_class_months (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, month_start date NOT NULL,
  currency text, PRIMARY KEY(workspace_id,month_start)
);
CREATE TABLE stockchief_runtime.product_class_values (
  workspace_id text NOT NULL, month_start date NOT NULL, item_id text NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  class text NOT NULL CHECK(class IN ('A','B','C','Review')), consumption_minor numeric,
  PRIMARY KEY(workspace_id,month_start,item_id),
  FOREIGN KEY(workspace_id,month_start) REFERENCES stockchief_runtime.product_class_months(workspace_id,month_start) ON DELETE CASCADE
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
SELECT r::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))' FROM unnest(ARRAY['stockchief_runtime.product_class_months','stockchief_runtime.product_class_values']) r;
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT w.id,r::regclass,true FROM workspaces w CROSS JOIN unnest(ARRAY['stockchief_runtime.product_class_months','stockchief_runtime.product_class_values']) r;
