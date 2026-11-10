CREATE TABLE stockchief_runtime.agent_product_source_readings (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 item_id text NOT NULL REFERENCES items(id),
 actor_id text REFERENCES users(id) ON DELETE SET NULL,
 job_id text REFERENCES stockchief_runtime.jobs(id) ON DELETE SET NULL,
 source_attachment_id text REFERENCES connection_email_attachments(id) ON DELETE SET NULL,
 source_filed_id text REFERENCES stockchief_runtime.agent_filed_documents(id) ON DELETE SET NULL,
 filename text NOT NULL,source_hash text NOT NULL,content bytea NOT NULL,
 document_kind text NOT NULL CHECK(document_kind IN('specification','safety_sheet')),
 identity_hash text NOT NULL,
 target_confirmed boolean NOT NULL DEFAULT false,
 automatic boolean NOT NULL DEFAULT false,
 enrich boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','RUNNING','READY','SAVED','FAILED')),
 source_pages jsonb NOT NULL DEFAULT '[]',raw_facts jsonb NOT NULL DEFAULT '[]',issues jsonb NOT NULL DEFAULT '[]',
 funding_key text,document_key text,call_key text,owns_funding boolean NOT NULL DEFAULT false,owns_document boolean NOT NULL DEFAULT false,
 credits_used integer NOT NULL DEFAULT 0,documents_used integer NOT NULL DEFAULT 0,
 attempt integer NOT NULL DEFAULT 0,revision integer NOT NULL DEFAULT 1,problem text,
 held_count integer NOT NULL DEFAULT 0,acknowledged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,item_id,source_hash,identity_hash)
);
CREATE INDEX agent_product_source_actor ON stockchief_runtime.agent_product_source_readings(actor_id);
CREATE INDEX agent_product_source_item ON stockchief_runtime.agent_product_source_readings(item_id);
CREATE INDEX agent_product_source_job ON stockchief_runtime.agent_product_source_readings(job_id);
CREATE INDEX agent_product_source_attachment ON stockchief_runtime.agent_product_source_readings(source_attachment_id) WHERE source_attachment_id IS NOT NULL;
CREATE INDEX agent_product_source_filed ON stockchief_runtime.agent_product_source_readings(source_filed_id) WHERE source_filed_id IS NOT NULL;
CREATE INDEX agent_product_source_cache ON stockchief_runtime.agent_product_source_readings(workspace_id,source_hash,status);
CREATE TABLE stockchief_runtime.agent_sourced_product_facts (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 reading_id text NOT NULL REFERENCES stockchief_runtime.agent_product_source_readings(id) ON DELETE CASCADE,
 item_id text NOT NULL REFERENCES items(id),sku_id text REFERENCES skus(id),
 fact_hash text NOT NULL,fact jsonb NOT NULL,
 saved_by text REFERENCES users(id) ON DELETE SET NULL,
 saved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,reading_id,fact_hash)
);
CREATE INDEX agent_product_fact_item ON stockchief_runtime.agent_sourced_product_facts(workspace_id,item_id,saved_at,id);
CREATE INDEX agent_product_fact_reading ON stockchief_runtime.agent_sourced_product_facts(reading_id);
CREATE INDEX agent_product_fact_sku ON stockchief_runtime.agent_sourced_product_facts(sku_id) WHERE sku_id IS NOT NULL;
CREATE INDEX agent_product_fact_actor ON stockchief_runtime.agent_sourced_product_facts(saved_by) WHERE saved_by IS NOT NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_product_source_readings'::regclass,'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))'),
 ('stockchief_runtime.agent_sourced_product_facts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_product_source_readings'::regclass,'stockchief_runtime.agent_sourced_product_facts'::regclass])r;
CREATE OR REPLACE FUNCTION commercial_job_lane_available(target_workspace text,job_kind text) RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH category AS (SELECT CASE WHEN job_kind IN('assistant.run-goal','assistant.run-codex-goal','assistant.run-codex-read') THEN 'agent_jobs'
 WHEN job_kind LIKE 'import.%' THEN 'active_imports' END AS meter),
 policy AS (SELECT w.owner_account_id,CASE WHEN o.id IS NOT NULL THEN o.limit_units ELSE (m->>'hard_limit')::bigint END AS capacity FROM workspaces w
 LEFT JOIN account_subscriptions s ON s.account_id=w.owner_account_id LEFT JOIN commercial_plan_versions v ON v.id=s.plan_version_id AND v.plan_id=s.plan_id
 CROSS JOIN category c LEFT JOIN LATERAL (SELECT entry AS m FROM jsonb_array_elements(v.meters) entry WHERE entry->>'meter'=c.meter) version_meter ON true
 LEFT JOIN LATERAL (SELECT * FROM commercial_entitlement_overrides e WHERE (e.account_id=w.owner_account_id OR e.workspace_id=w.id) AND e.meter=c.meter AND e.starts_at<=now() AND (e.ends_at IS NULL OR e.ends_at>now()) ORDER BY CASE WHEN e.workspace_id IS NOT NULL THEN 0 ELSE 1 END,e.created_at DESC LIMIT 1) o ON true
 WHERE w.id=target_workspace)
 SELECT NOT EXISTS(SELECT 1 FROM policy p WHERE p.capacity IS NOT NULL AND p.capacity<=(
 SELECT count(*) FROM stockchief_runtime.jobs j JOIN workspaces w ON w.id=j.workspace_id CROSS JOIN category c
 WHERE w.owner_account_id=p.owner_account_id AND j.status='RUNNING' AND
 ((c.meter='agent_jobs' AND j.kind IN('assistant.run-goal','assistant.run-codex-goal','assistant.run-codex-read')) OR
 (c.meter='active_imports' AND j.kind LIKE 'import.%'))))
$$;

-- Preserve every earlier activity while adding owner-measured completed source work.
DO $activity$
DECLARE existing text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT existing FROM pg_constraint WHERE conrelid='stockchief_runtime.agent_time_samples'::regclass AND conname='agent_time_samples_activity_check';
 ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
 EXECUTE 'ALTER TABLE stockchief_runtime.agent_time_samples ADD CONSTRAINT agent_time_samples_activity_check CHECK (('||existing||') OR activity=''product-facts'')';
END $activity$;
