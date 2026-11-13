-- Job 212: StockChief follows a read procedure. Every clause of a complete
-- reading ends either as an exact standing rule prepared for the owner
-- (linked through agent_sop_proposals) or kept for people, with the reason.
-- The source remembers the job that followed it and any stop.
ALTER TABLE stockchief_runtime.agent_sop_sources
  ADD COLUMN follow_job_id text,
  ADD COLUMN follow_problem text;
CREATE TABLE stockchief_runtime.agent_sop_clause_outcomes (
  workspace_id text NOT NULL,
  source_id text NOT NULL,
  quote_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('RULE','KEPT')),
  reason text CHECK (reason IS NULL OR length(reason)<=1000),
  proposal_id text REFERENCES operating_instruction_proposals(id) ON DELETE SET NULL,
  decided_by text,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,source_id,quote_id),
  FOREIGN KEY (workspace_id,source_id) REFERENCES stockchief_runtime.agent_sop_sources(workspace_id,id) ON DELETE CASCADE
);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_sop_clause_outcomes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_sop_clause_outcomes'::regclass,true FROM workspaces;

-- Job 213: a playbook run goes step by step. It keeps the next step to run,
-- stops with a reason when a step fails or leaves work for a person, and
-- continues from there. A claim keeps two workers from running one run.
ALTER TABLE stockchief_runtime.agent_playbook_runs
  ADD COLUMN status text NOT NULL DEFAULT 'DONE' CHECK (status IN ('RUNNING','DONE','STOPPED','HELD','WAITING')),
  ADD COLUMN next_step integer NOT NULL DEFAULT 0 CHECK (next_step>=0),
  ADD COLUMN reason text CHECK (reason IS NULL OR length(reason)<=1000),
  ADD COLUMN scheduled boolean NOT NULL DEFAULT false,
  ADD COLUMN actor_id text,
  ADD COLUMN claimed_until timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX agent_playbook_runs_open ON stockchief_runtime.agent_playbook_runs(workspace_id,playbook_id,created_at DESC)
  WHERE status IN ('RUNNING','STOPPED','WAITING');

-- Procedure rules waiting for the owner (212) and stopped playbooks (213)
-- reach Needs you as agent notices. Join whatever job list is there by now.
DO $$
DECLARE allowed text; job int;
BEGIN
  FOREACH job IN ARRAY ARRAY[212,213] LOOP
    SELECT pg_get_constraintdef(oid) INTO allowed FROM pg_constraint
     WHERE conname='agent_operational_notices_job_id_check' AND conrelid='stockchief_runtime.agent_operational_notices'::regclass;
    IF allowed IS NULL OR position('ARRAY[' IN allowed)=0 THEN
      RAISE EXCEPTION 'The notice job list has an unexpected form.';
    END IF;
    IF allowed !~ ('\m'||job||'\M') THEN
      EXECUTE 'ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check, ADD CONSTRAINT agent_operational_notices_job_id_check '
        ||replace(allowed,'ARRAY[','ARRAY['||job||', ');
    END IF;
  END LOOP;
END $$;
