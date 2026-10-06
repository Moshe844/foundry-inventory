-- Owner-approved launch candidate, not authorization to charge customers.
-- Existing subscription snapshots are left untouched; only new local/test
-- subscriptions select these active candidate snapshots.
UPDATE commercial_plan_meters SET included_units=CASE plan_id
 WHEN 'starter' THEN 650 WHEN 'growth' THEN 2500 WHEN 'pro' THEN 8500 END,
 hard_limit=NULL,overage_mode='PURCHASE'
 WHERE meter='ai_work_credits' AND plan_id IN ('starter','growth','pro');
UPDATE commercial_plan_meters SET included_units=CASE plan_id
 WHEN 'starter' THEN 2000 WHEN 'growth' THEN 20000 WHEN 'pro' THEN 70000 END,
 hard_limit=NULL,overage_mode='PURCHASE'
 WHERE meter='connected_operations' AND plan_id IN ('starter','growth','pro');
UPDATE commercial_operation_policies SET units=CASE operation
 WHEN 'ask' THEN 1 WHEN 'instruction' THEN 7 WHEN 'import_mapping' THEN 5 END,
 status='PROPOSED',updated_at=now()
 WHERE operation IN ('ask','instruction','import_mapping');

-- The internal budget is a lifetime cap for provider spend funded by one paid
-- AI grant, not a monthly reset or an additional customer-visible balance.
ALTER TABLE commercial_usage_packs ADD COLUMN provider_cost_budget_minor NUMERIC(20,6)
 CHECK(provider_cost_budget_minor>0);
ALTER TABLE commercial_usage_packs ADD COLUMN conservative_cost_per_credit_minor NUMERIC(20,6)
 CHECK(conservative_cost_per_credit_minor>0);
ALTER TABLE commercial_usage_packs ADD COLUMN cost_model_key TEXT;
ALTER TABLE commercial_usage_packs ADD COLUMN cost_budget_source TEXT;
ALTER TABLE commercial_usage_packs ADD COLUMN approved_model_rate_ceiling JSONB;
ALTER TABLE commercial_usage_purchases ADD COLUMN provider_cost_budget_minor NUMERIC(20,6);
ALTER TABLE commercial_usage_purchases ADD COLUMN conservative_cost_per_credit_minor NUMERIC(20,6);
ALTER TABLE commercial_usage_purchases ADD COLUMN cost_model_key TEXT;
ALTER TABLE commercial_usage_purchases ADD COLUMN cost_budget_source TEXT;
ALTER TABLE commercial_usage_purchases ADD COLUMN approved_model_rate_ceiling JSONB;
UPDATE commercial_usage_packs SET status='RETIRED' WHERE status='PROVISIONAL';
INSERT INTO commercial_usage_packs(id,category,version,units,amount_minor,currency,status,expires_months,
 provider_cost_budget_minor,conservative_cost_per_credit_minor,cost_model_key,cost_budget_source,approved_model_rate_ceiling) VALUES
 ('ai-500-v2','ai_work_credits',2,500,4900,'USD','PROVISIONAL',12,1470,1.70,
  'stockchief-ai-mix-2026-10-05','2026-10-05:98-real-attempts:2x-highest-p95-per-credit',
  '{"anthropic/claude-haiku-4-5-20251001/2023-06-01":{"model_input":0.0001,"cache_write_1h":0.0002,"model_output":0.0005},"anthropic/claude-sonnet-5/2023-06-01":{"model_input":0.0002,"cache_write_1h":0.0004,"model_output":0.001}}'),
 ('ai-2500-v2','ai_work_credits',2,2500,23900,'USD','PROVISIONAL',12,7170,1.70,
  'stockchief-ai-mix-2026-10-05','2026-10-05:98-real-attempts:2x-highest-p95-per-credit',
  '{"anthropic/claude-haiku-4-5-20251001/2023-06-01":{"model_input":0.0001,"cache_write_1h":0.0002,"model_output":0.0005},"anthropic/claude-sonnet-5/2023-06-01":{"model_input":0.0002,"cache_write_1h":0.0004,"model_output":0.001}}'),
 ('ops-10000-v2','connected_operations',2,10000,7900,'USD','PROVISIONAL',12,NULL,NULL,NULL,NULL,NULL),
 ('ops-50000-v2','connected_operations',2,50000,34900,'USD','PROVISIONAL',12,NULL,NULL,NULL,NULL,NULL);

CREATE TABLE commercial_model_grant_budgets (
 grant_id TEXT PRIMARY KEY REFERENCES commercial_usage_grants(id),
 purchase_id TEXT NOT NULL UNIQUE REFERENCES commercial_usage_purchases(id),
 account_id TEXT NOT NULL REFERENCES accounts(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 budget_minor NUMERIC(20,6) NOT NULL CHECK(budget_minor>0),
 pack_units BIGINT NOT NULL CHECK(pack_units>0),
 purchase_amount_minor BIGINT NOT NULL CHECK(purchase_amount_minor>0),
 cost_model_key TEXT NOT NULL,
 source TEXT NOT NULL,
 approved_model_rate_ceiling JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commercial_model_grant_budgets_owner ON commercial_model_grant_budgets(account_id,workspace_id);

CREATE TABLE commercial_model_cost_hold_allocations (
 id TEXT PRIMARY KEY,
 hold_id TEXT NOT NULL REFERENCES commercial_model_cost_holds(id) ON DELETE CASCADE,
 source TEXT NOT NULL CHECK(source IN ('INCLUDED','PURCHASED')),
 grant_id TEXT REFERENCES commercial_model_grant_budgets(grant_id),
 maximum_minor NUMERIC(20,6) NOT NULL CHECK(maximum_minor>=0),
 actual_minor NUMERIC(20,6) CHECK(actual_minor>=0),
 CHECK((source='INCLUDED' AND grant_id IS NULL) OR (source='PURCHASED' AND grant_id IS NOT NULL))
);
CREATE UNIQUE INDEX commercial_model_cost_one_included_allocation
 ON commercial_model_cost_hold_allocations(hold_id) WHERE source='INCLUDED';
CREATE UNIQUE INDEX commercial_model_cost_one_grant_allocation
 ON commercial_model_cost_hold_allocations(hold_id,grant_id) WHERE source='PURCHASED';
CREATE INDEX commercial_model_cost_grant_exposure
 ON commercial_model_cost_hold_allocations(grant_id,hold_id);

-- Pre-existing provider holds have no grant funding provenance. Conservatively
-- charge them to the included/base ceiling, retaining their original identity.
INSERT INTO commercial_model_cost_hold_allocations(id,hold_id,source,maximum_minor,actual_minor)
 SELECT 'historical-base:'||id,id,'INCLUDED',maximum_minor,actual_minor
 FROM commercial_model_cost_holds;

UPDATE commercial_plan_versions SET status='RETIRED',effective_until=now()
 WHERE status='ACTIVE' AND plan_id IN ('starter','growth','pro');
INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters)
 SELECT 'launch-candidate-2026-10:'||p.id,p.id,
  COALESCE((SELECT MAX(version_number) FROM commercial_plan_versions WHERE plan_id=p.id),0)+1,
  'ACTIVE',p.currency,p.monthly_amount_minor,p.annual_amount_minor,
  (SELECT jsonb_agg(jsonb_build_object('capability',e.capability,'enabled',e.enabled,'configuration',e.configuration)
   ORDER BY e.capability) FROM commercial_plan_entitlements e WHERE e.plan_id=p.id),
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.meter) FROM commercial_plan_meters m WHERE m.plan_id=p.id)
 FROM commercial_plans p WHERE p.id IN ('starter','growth','pro');
UPDATE commercial_plans SET packaging_status='PROPOSED',packaging_approved_at=NULL,
 packaging_approved_by_account_id=NULL,updated_at=now()
 WHERE id IN ('starter','growth','pro');
