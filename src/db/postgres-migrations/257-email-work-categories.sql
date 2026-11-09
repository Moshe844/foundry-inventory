ALTER TABLE connection_email_messages ADD COLUMN agent_category text;
ALTER TABLE connection_email_set_aside ADD COLUMN agent_category text;
CREATE INDEX email_work_category ON connection_email_messages(workspace_id,agent_category,received_at DESC);
CREATE INDEX aside_work_category ON connection_email_set_aside(workspace_id,agent_category,received_at DESC);
