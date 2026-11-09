ALTER TABLE stockchief_runtime.agent_filed_documents ADD COLUMN product_facts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(product_facts)='array');
ALTER TABLE stockchief_runtime.agent_filed_documents ADD COLUMN facts_revision integer NOT NULL DEFAULT 0 CHECK(facts_revision>=0);
ALTER TABLE stockchief_runtime.agent_filed_documents ADD COLUMN facts_recorded_at timestamptz;
ALTER TABLE stockchief_runtime.agent_filed_documents ADD COLUMN facts_recorded_by text REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX agent_document_facts_actor ON stockchief_runtime.agent_filed_documents(facts_recorded_by) WHERE facts_recorded_by IS NOT NULL;
