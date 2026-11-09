CREATE UNIQUE INDEX security_event_history_agent_undo_receipt ON security_event_history(workspace_id,reference) WHERE action='Agent action undone';
CREATE INDEX assistant_agent_work_digest_history ON stockchief_runtime.assistant_action_proposals(workspace_id,executed_at,id) WHERE status='EXECUTED';
CREATE INDEX work_items_agent_work_digest_history ON work_items(workspace_id,completed_at,id) WHERE execution_status='COMPLETED' AND verification_status='VERIFIED';
ALTER TABLE stockchief_runtime.agent_operational_notices DROP CONSTRAINT agent_operational_notices_job_id_check;
ALTER TABLE stockchief_runtime.agent_operational_notices ADD CHECK(job_id IN (67,87,124,167,168,169,170,171,204,206,209));
