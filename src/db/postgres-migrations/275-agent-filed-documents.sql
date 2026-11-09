CREATE TABLE stockchief_runtime.agent_filed_documents (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 source_attachment_id text REFERENCES connection_email_attachments(id) ON DELETE SET NULL,
 source_message_id text,
 source_hash text NOT NULL,
 source_text_hash text NOT NULL,
 filename text NOT NULL,
 mime_type text,
 content bytea NOT NULL CHECK(octet_length(content)>0 AND octet_length(content)<=20971520),
 extracted_text text NOT NULL,
 document_kind text NOT NULL CHECK(document_kind IN ('other','packing_slip','bill_of_lading','customs','specification','safety_sheet','contract')),
 target_kind text NOT NULL CHECK(target_kind IN ('purchase_order','sales_order','item')),
 target_id text NOT NULL,
 target_reference text NOT NULL,
 filed_by text REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,source_hash,target_kind,target_id)
);
CREATE INDEX agent_filed_document_history ON stockchief_runtime.agent_filed_documents(workspace_id,created_at DESC,id);
CREATE INDEX agent_filed_document_target ON stockchief_runtime.agent_filed_documents(workspace_id,target_kind,target_id,created_at DESC,id DESC);
CREATE INDEX agent_filed_document_source ON stockchief_runtime.agent_filed_documents(source_attachment_id) WHERE source_attachment_id IS NOT NULL;
CREATE INDEX agent_filed_document_actor ON stockchief_runtime.agent_filed_documents(filed_by) WHERE filed_by IS NOT NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_filed_documents'::regclass,'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_filed_documents'::regclass,true FROM workspaces;
