-- Job 178: procedures are also written for picking and for customer returns,
-- the owner can edit the staff text, and on Pro and Custom StockChief can
-- publish its updates to staff on its own.
ALTER TABLE stockchief_runtime.agent_team_procedure_sets DROP CONSTRAINT agent_team_procedure_sets_kind_check;
ALTER TABLE stockchief_runtime.agent_team_procedure_sets
 ADD CONSTRAINT agent_team_procedure_sets_kind_check CHECK(kind IN ('receiving','picking','dispatch','counting','returns')),
 ADD COLUMN auto_publish boolean NOT NULL DEFAULT false;
ALTER TABLE stockchief_runtime.agent_team_procedure_publications
 ADD COLUMN automatic boolean NOT NULL DEFAULT false,
 ADD COLUMN edited boolean NOT NULL DEFAULT false;
CREATE INDEX agent_procedure_return_history ON customer_returns(workspace_id,received_at DESC,id DESC) WHERE received_at IS NOT NULL;
CREATE INDEX agent_procedure_wave_history ON fulfillment_waves(workspace_id,created_at DESC,id DESC) WHERE status IN ('PICKING','PACKED','COMPLETED','BLOCKED');
