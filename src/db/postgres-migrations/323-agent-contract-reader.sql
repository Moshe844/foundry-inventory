CREATE TABLE stockchief_runtime.agent_contract_readings (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_id text REFERENCES users(id) ON DELETE SET NULL,
 job_id text REFERENCES stockchief_runtime.jobs(id) ON DELETE SET NULL,
 request_key text NOT NULL,
 filename text NOT NULL,
 source_hash text NOT NULL,
 source_filed_id text REFERENCES stockchief_runtime.agent_filed_documents(id) ON DELETE SET NULL,
 source_document_receipt text,
 automatic boolean NOT NULL DEFAULT false,
 content bytea NOT NULL CHECK(octet_length(content)>0 AND octet_length(content)<=20971520),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','READY','FAILED')),
 reading_mode text CHECK(reading_mode IN('suggest','alone')),
 source_pages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(source_pages)='array'),
 extracted_facts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(extracted_facts)='array'),
 issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(issues)='array'),
 credits_used integer NOT NULL DEFAULT 0 CHECK(credits_used>=0),
 problem text,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_contract_reading_actor ON stockchief_runtime.agent_contract_readings(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX agent_contract_reading_job ON stockchief_runtime.agent_contract_readings(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX agent_contract_reading_history ON stockchief_runtime.agent_contract_readings(workspace_id,created_at DESC,id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_contract_readings'::regclass,'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_contract_readings'::regclass,true FROM workspaces;
-- Typed handwriting jobs share the account import lane, including mixed-version deploys.
CREATE TABLE stockchief_runtime.agent_contract_reading_settings (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 revision integer NOT NULL DEFAULT 1,
 problem text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_contract_reading_authority ON stockchief_runtime.agent_contract_reading_settings(authorized_by) WHERE authorized_by IS NOT NULL;
CREATE INDEX agent_contract_reading_filed_source ON stockchief_runtime.agent_contract_readings(source_filed_id) WHERE source_filed_id IS NOT NULL;
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES('stockchief_runtime.agent_contract_reading_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete) SELECT id,'stockchief_runtime.agent_contract_reading_settings'::regclass,true FROM workspaces;
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
