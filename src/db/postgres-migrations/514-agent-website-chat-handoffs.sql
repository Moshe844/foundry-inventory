-- Job 84: the owner's rules for website stock answers, and the questions that
-- go to a person instead.
--
-- Which locations count: an assistant may count several internal locations.
-- NULL keeps the one location it was published with. "Low" is said at or
-- below low_stock_at when exact numbers are not shown.
ALTER TABLE stockchief_runtime.agent_website_stock_chats
  ADD COLUMN location_ids jsonb CHECK (location_ids IS NULL OR jsonb_typeof(location_ids)='array'),
  ADD COLUMN low_stock_at integer CHECK (low_stock_at IS NULL OR low_stock_at BETWEEN 1 AND 1000000);

-- Answers and hand-offs counted per assistant per hour, so no visitor can run
-- an assistant past its hourly allowance.
CREATE TABLE stockchief_runtime.agent_website_chat_usage (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id text NOT NULL REFERENCES stockchief_runtime.agent_website_stock_chats(id) ON DELETE CASCADE,
  hour timestamptz NOT NULL,
  answers integer NOT NULL DEFAULT 0 CHECK (answers>=0),
  handoffs integer NOT NULL DEFAULT 0 CHECK (handoffs>=0),
  PRIMARY KEY (chat_id,hour)
);
CREATE INDEX agent_website_chat_usage_workspace ON stockchief_runtime.agent_website_chat_usage(workspace_id,hour);

-- A visitor's question outside the owner's rules, sent to a person. The
-- visitor's address is never kept, only a one-way hash used to limit repeats.
CREATE TABLE stockchief_runtime.agent_website_chat_handoffs (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  chat_id text NOT NULL REFERENCES stockchief_runtime.agent_website_stock_chats(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 500),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  contact text CHECK (contact IS NULL OR length(contact) BETWEEN 3 AND 200),
  visitor text NOT NULL CHECK (length(visitor)=64),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE')),
  done_by text REFERENCES users(id) ON DELETE SET NULL,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id),
  CHECK (status='OPEN' OR done_at IS NOT NULL)
);
CREATE INDEX agent_website_chat_handoff_open ON stockchief_runtime.agent_website_chat_handoffs(workspace_id,created_at DESC) WHERE status='OPEN';
CREATE INDEX agent_website_chat_handoff_recent ON stockchief_runtime.agent_website_chat_handoffs(workspace_id,created_at DESC,id);
CREATE INDEX agent_website_chat_handoff_visitor ON stockchief_runtime.agent_website_chat_handoffs(chat_id,visitor,created_at DESC);
CREATE INDEX agent_website_chat_handoff_done_by ON stockchief_runtime.agent_website_chat_handoffs(done_by) WHERE done_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_website_chat_usage'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_website_chat_handoffs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN (VALUES
    ('stockchief_runtime.agent_website_chat_usage'::regclass),
    ('stockchief_runtime.agent_website_chat_handoffs'::regclass)) r(relation);
