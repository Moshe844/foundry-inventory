CREATE TABLE stockchief_runtime.agent_count_sources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  filename text NOT NULL,
  source_hash text NOT NULL,
  content bytea NOT NULL,
  format text NOT NULL CHECK(format IN ('sheet','visual')),
  location_ids text[] NOT NULL CHECK(cardinality(location_ids)>0),
  rule_id text,
  rule_revision text,
  job_id text REFERENCES stockchief_runtime.jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','REVIEW','APPROVED','POSTED','HELD')),
  revision integer NOT NULL DEFAULT 1,
  layout_hash text,
  evidence_hash text,
  reading_note text,
  issue text,
  approved_at timestamptz,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,source_hash)
);

ALTER TABLE movements DROP CONSTRAINT movements_quantity_delta_check;
ALTER TABLE movements ADD CONSTRAINT movements_quantity_delta_check CHECK (
  quantity_delta<>0 OR (operation='adjust' AND reason_code='cycle_count_measure'
    AND secondary_quantity_delta IS NOT NULL AND secondary_quantity_delta<>0)
) NOT VALID;
ALTER TABLE accounting_inventory_cost_movements DROP CONSTRAINT accounting_inventory_cost_movements_quantity_delta_check;
ALTER TABLE accounting_inventory_cost_movements ADD CONSTRAINT accounting_inventory_cost_movements_quantity_delta_check CHECK (
  quantity_delta<>0 OR (cost_source_type='physical_count_measure_correction' AND cost_delta_minor=0
    AND secondary_quantity_delta IS NOT NULL AND secondary_quantity_delta<>0 AND journal_entry_id IS NULL)
) NOT VALID;
CREATE INDEX agent_count_sources_recent ON stockchief_runtime.agent_count_sources(workspace_id,created_at DESC,id);
CREATE INDEX agent_count_sources_jobs ON stockchief_runtime.agent_count_sources(job_id) WHERE job_id IS NOT NULL;
CREATE FUNCTION stockchief_immutable_count_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.source_hash IS DISTINCT FROM OLD.source_hash
     OR NEW.location_ids IS DISTINCT FROM OLD.location_ids OR NEW.format IS DISTINCT FROM OLD.format THEN
    RAISE EXCEPTION 'The original count source and location scope are immutable.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stockchief_keep_count_original
BEFORE UPDATE OF content,source_hash,location_ids,format ON stockchief_runtime.agent_count_sources
FOR EACH ROW EXECUTE FUNCTION stockchief_immutable_count_original();

CREATE TABLE stockchief_runtime.agent_count_source_rows (
  workspace_id text NOT NULL,
  source_id text NOT NULL,
  number integer NOT NULL,
  source_row jsonb NOT NULL,
  observed jsonb NOT NULL,
  checked boolean NOT NULL DEFAULT false,
  preview jsonb,
  issue text,
  effect jsonb,
  PRIMARY KEY(workspace_id,source_id,number),
  FOREIGN KEY(workspace_id,source_id) REFERENCES stockchief_runtime.agent_count_sources(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_count_source_pending_rows ON stockchief_runtime.agent_count_source_rows(workspace_id,source_id,number) WHERE effect IS NULL;
CREATE INDEX agent_count_source_pending_position ON stockchief_runtime.agent_count_source_rows
  (workspace_id,source_id,((preview#>>'{expected,position}'))) WHERE effect IS NULL;

CREATE TABLE stockchief_runtime.agent_count_source_rules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision text NOT NULL,
  label text NOT NULL,
  format text NOT NULL CHECK(format IN ('sheet','visual')),
  location_ids text[] NOT NULL CHECK(cardinality(location_ids)>0),
  maximum_rows integer NOT NULL CHECK(maximum_rows>0),
  example_id text REFERENCES stockchief_runtime.agent_count_sources(id) ON DELETE SET NULL,
  layout_hash text,
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE(workspace_id,id)
);
CREATE INDEX agent_count_source_rules_workspace ON stockchief_runtime.agent_count_source_rules(workspace_id,enabled);
CREATE INDEX agent_count_source_rules_example ON stockchief_runtime.agent_count_source_rules(example_id) WHERE example_id IS NOT NULL;
CREATE INDEX agent_count_source_rules_owner ON stockchief_runtime.agent_count_source_rules(authorized_by) WHERE authorized_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_count_sources'::regclass,'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))'),
 ('stockchief_runtime.agent_count_source_rows'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_count_source_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables r
 WHERE r.relation IN('stockchief_runtime.agent_count_sources'::regclass,'stockchief_runtime.agent_count_source_rows'::regclass,
                     'stockchief_runtime.agent_count_source_rules'::regclass);
