ALTER TABLE stockchief_runtime.agent_operational_notices
  DROP CONSTRAINT agent_operational_notices_job_id_check,
  ADD CONSTRAINT agent_operational_notices_job_id_check
    CHECK (job_id IN (10,50,67,77,80,87,110,116,124,167,168,169,170,171,204,206,209));
