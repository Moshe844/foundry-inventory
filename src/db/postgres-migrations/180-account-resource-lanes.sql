CREATE TABLE commercial_api_minute_usage(
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 minute_start timestamptz NOT NULL,
 requests integer NOT NULL CHECK(requests>0),
 PRIMARY KEY(account_id,minute_start)
);
CREATE FUNCTION commercial_job_lane_available(target_workspace text,job_kind text) RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH category AS (SELECT CASE WHEN job_kind IN('assistant.run-goal','assistant.run-codex-goal') THEN 'agent_jobs'
 WHEN job_kind IN('import.analyse-source','import.execute-approved','import.revise-preview') THEN 'active_imports' END AS meter),
 policy AS (SELECT w.owner_account_id,CASE WHEN o.id IS NOT NULL THEN o.limit_units ELSE (m->>'hard_limit')::bigint END AS capacity FROM workspaces w
 LEFT JOIN account_subscriptions s ON s.account_id=w.owner_account_id LEFT JOIN commercial_plan_versions v ON v.id=s.plan_version_id AND v.plan_id=s.plan_id
 CROSS JOIN category c LEFT JOIN LATERAL (SELECT entry AS m FROM jsonb_array_elements(v.meters) entry WHERE entry->>'meter'=c.meter) version_meter ON true
 LEFT JOIN LATERAL (SELECT * FROM commercial_entitlement_overrides e WHERE (e.account_id=w.owner_account_id OR e.workspace_id=w.id) AND e.meter=c.meter AND e.starts_at<=now() AND (e.ends_at IS NULL OR e.ends_at>now()) ORDER BY CASE WHEN e.workspace_id IS NOT NULL THEN 0 ELSE 1 END,e.created_at DESC LIMIT 1) o ON true
 WHERE w.id=target_workspace)
 SELECT NOT EXISTS(SELECT 1 FROM policy p WHERE p.capacity IS NOT NULL AND p.capacity<=(
 SELECT count(*) FROM stockchief_runtime.jobs j JOIN workspaces w ON w.id=j.workspace_id CROSS JOIN category c
 WHERE w.owner_account_id=p.owner_account_id AND j.status='RUNNING' AND
 ((c.meter='agent_jobs' AND j.kind IN('assistant.run-goal','assistant.run-codex-goal')) OR
 (c.meter='active_imports' AND j.kind IN('import.analyse-source','import.execute-approved','import.revise-preview')))))
$$;
