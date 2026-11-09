CREATE TABLE stockchief_runtime.purchase_budgets (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month_start date NOT NULL CHECK(extract(day from month_start)=1),
  category text NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY(workspace_id,month_start,category,currency)
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
  VALUES('stockchief_runtime.purchase_budgets'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.purchase_budgets'::regclass,true FROM workspaces;
