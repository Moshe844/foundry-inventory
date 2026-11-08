CREATE TABLE stockchief_runtime.manager_presentation (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_period text NOT NULL CHECK(report_period IN('default','last_7_days','last_30_days','last_month','year_to_date')),
  download_format text NOT NULL CHECK(download_format IN('default','csv','xlsx','pdf')),
  inbox_sort text NOT NULL CHECK(inbox_sort IN('priority','newest','oldest')),
  revision integer NOT NULL CHECK(revision>0),
  PRIMARY KEY(workspace_id,actor_id)
);
INSERT INTO commercial_storage_tables(relation,bytes_expression)
VALUES('stockchief_runtime.manager_presentation'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
SELECT id,'stockchief_runtime.manager_presentation'::regclass,true FROM workspaces;
