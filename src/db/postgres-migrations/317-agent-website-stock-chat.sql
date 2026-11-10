CREATE TABLE stockchief_runtime.agent_website_stock_chats (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id),label text NOT NULL,sku_ids jsonb NOT NULL,
 source_snapshot jsonb NOT NULL,source_hash text NOT NULL,delivery_answer text NOT NULL,
 show_quantity boolean NOT NULL DEFAULT false,embed_origins jsonb NOT NULL,
 token_hash text NOT NULL UNIQUE,enabled boolean NOT NULL DEFAULT true,
 authorized_by text NOT NULL REFERENCES users(id),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(workspace_id,label)
);
CREATE INDEX agent_stock_chat_location ON stockchief_runtime.agent_website_stock_chats(location_id);
CREATE INDEX agent_stock_chat_owner ON stockchief_runtime.agent_website_stock_chats(authorized_by);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_website_stock_chats'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_website_stock_chats'::regclass,true FROM workspaces;
