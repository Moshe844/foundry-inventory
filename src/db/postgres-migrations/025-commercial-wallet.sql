-- Commercial architecture approved; economics and release remain unapproved.
CREATE TABLE commercial_release_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  checkout_enabled BOOLEAN NOT NULL DEFAULT false,
  economics_approved_at TIMESTAMPTZ,
  readiness_approved_at TIMESTAMPTZ,
  approved_by_account_id TEXT REFERENCES accounts(id),
  report_reference TEXT
);
INSERT INTO commercial_release_control(singleton) VALUES(true);
UPDATE commercial_plans SET packaging_status='PROPOSED';

INSERT INTO commercial_meter_definitions(meter,label,kind,customer_visible,critical_access) VALUES
 ('ai_work_credits','AI Work Credits','USAGE',1,0),
 ('connected_operations','Connected Operations','USAGE',1,0);
UPDATE commercial_meter_definitions SET customer_visible=0 WHERE kind='USAGE'
 AND meter NOT IN ('ai_work_credits','connected_operations');
INSERT INTO commercial_plan_meters(plan_id,meter,label,included_units,hard_limit,overage_mode)
 SELECT id,category,CASE category WHEN 'ai_work_credits' THEN 'AI Work Credits' ELSE 'Connected Operations' END,
 CASE category WHEN 'ai_work_credits' THEN CASE id WHEN 'starter' THEN 500 WHEN 'growth' THEN 2500 WHEN 'pro' THEN 10000 ELSE 0 END
 ELSE CASE id WHEN 'starter' THEN 2000 WHEN 'growth' THEN 25000 WHEN 'pro' THEN 150000 ELSE 0 END END,
 NULL,'PURCHASE' FROM commercial_plans CROSS JOIN (VALUES('ai_work_credits'),('connected_operations')) categories(category);
UPDATE commercial_plan_meters SET overage_mode='PAUSE',overage_block_units=NULL,overage_amount_minor=NULL
 WHERE meter NOT IN ('ai_work_credits','connected_operations');

CREATE TABLE commercial_usage_packs (
 id TEXT PRIMARY KEY, category TEXT NOT NULL CHECK(category IN ('ai_work_credits','connected_operations')),
 version INTEGER NOT NULL, units BIGINT NOT NULL CHECK(units>0), amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
 currency TEXT NOT NULL DEFAULT 'USD', stripe_price_id TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'PROVISIONAL' CHECK(status IN ('PROVISIONAL','APPROVED','RETIRED')),
 expires_months INTEGER NOT NULL DEFAULT 12 CHECK(expires_months=12), UNIQUE(category,version,units)
);
INSERT INTO commercial_usage_packs(id,category,version,units,amount_minor) VALUES
 ('ai-500-v1','ai_work_credits',1,500,3900),('ai-2500-v1','ai_work_credits',1,2500,14900),
 ('ai-10000-v1','ai_work_credits',1,10000,49900),('ops-25000-v1','connected_operations',1,25000,3900),
 ('ops-100000-v1','connected_operations',1,100000,11900),('ops-500000-v1','connected_operations',1,500000,39900);
CREATE TABLE commercial_usage_purchases (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 pack_id TEXT NOT NULL REFERENCES commercial_usage_packs(id), category TEXT NOT NULL,
 units BIGINT NOT NULL CHECK(units>0), amount_minor BIGINT NOT NULL CHECK(amount_minor>0),currency TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('MANUAL','AUTO')),status TEXT NOT NULL DEFAULT 'CREATED'
 CHECK(status IN ('CREATED','OPEN','PAID','FAILED','EXPIRED','REFUNDED','REVIEW')),
 idempotency_key TEXT NOT NULL, stripe_session_id TEXT UNIQUE,stripe_payment_intent_id TEXT UNIQUE,
 error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),paid_at TIMESTAMPTZ,
 UNIQUE(account_id,idempotency_key)
);
CREATE TABLE commercial_usage_grants (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 category TEXT NOT NULL, purchase_id TEXT NOT NULL UNIQUE REFERENCES commercial_usage_purchases(id),
 units BIGINT NOT NULL CHECK(units>0),revoked_units BIGINT NOT NULL DEFAULT 0 CHECK(revoked_units>=0 AND revoked_units<=units),
 expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE commercial_usage_allocations (
 id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES commercial_usage_events(id),
 grant_id TEXT REFERENCES commercial_usage_grants(id),units BIGINT NOT NULL CHECK(units>0)
);
-- Retire the old implicit zero-cost estimate. Detailed costs live in the
-- versioned cost ledger; unknown estimates must remain visibly unknown.
ALTER TABLE commercial_usage_events ALTER COLUMN estimated_variable_cost_minor DROP NOT NULL;
ALTER TABLE commercial_usage_events ALTER COLUMN estimated_variable_cost_minor DROP DEFAULT;
UPDATE commercial_usage_events SET estimated_variable_cost_minor=NULL WHERE cost_rate_version IS NULL;
CREATE INDEX commercial_grant_allocations ON commercial_usage_allocations(grant_id,event_id);
-- Preserve recorded historical consumption; never reset an existing customer's balance.
-- Legacy operation units are carried forward 1:1, not retroactively repriced.
UPDATE commercial_usage_events SET detail=detail||jsonb_build_object('legacyMeter',meter,'conversion','legacy-1:1'),
 idempotency_key=meter||':'||idempotency_key,
 meter=CASE WHEN meter IN ('intelligent_operations','document_pages','processing_units') THEN 'ai_work_credits' ELSE 'connected_operations' END
 WHERE meter IN ('intelligent_operations','document_pages','processing_units','business_communications','external_events',
 'shipments_managed','automatic_actions','accounting_syncs','api_events');
INSERT INTO commercial_usage_allocations(id,event_id,units)
 SELECT 'legacy-allocation:'||id,id,units FROM commercial_usage_events
 WHERE meter IN ('ai_work_credits','connected_operations') AND status IN ('RESERVED','COMMITTED');
CREATE TABLE commercial_operation_policies (
 operation TEXT PRIMARY KEY,category TEXT NOT NULL CHECK(category IN ('ai_work_credits','connected_operations')),
 units BIGINT NOT NULL CHECK(units>0),status TEXT NOT NULL CHECK(status IN ('PROPOSED','APPROVED')),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO commercial_operation_policies(operation,category,units,status) VALUES
 ('ask','ai_work_credits',1,'PROPOSED'),('instruction','ai_work_credits',3,'PROPOSED'),('import_mapping','ai_work_credits',5,'PROPOSED');
CREATE TABLE commercial_auto_topups (
 account_id TEXT NOT NULL REFERENCES accounts(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),category TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT false,pack_id TEXT REFERENCES commercial_usage_packs(id),
 monthly_cap_minor BIGINT NOT NULL DEFAULT 0 CHECK(monthly_cap_minor>=0),payment_method_id TEXT,
 consented_at TIMESTAMPTZ,consent_version TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,workspace_id,category),CHECK(NOT enabled OR (consented_at IS NOT NULL AND pack_id IS NOT NULL AND monthly_cap_minor>0))
);
CREATE TABLE commercial_revenue_events (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),source_id TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('SUBSCRIPTION','ADDON','REFUND','DISPUTE','FEE')),
 amount_minor BIGINT NOT NULL,currency TEXT NOT NULL,
 period_start TIMESTAMPTZ,period_end TIMESTAMPTZ,occurred_at TIMESTAMPTZ NOT NULL,detail JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE commercial_critical_warnings (
 id TEXT PRIMARY KEY,account_id TEXT REFERENCES accounts(id),fingerprint TEXT NOT NULL UNIQUE,
 code TEXT NOT NULL,detail JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'OPEN',created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE commercial_cost_rates ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE commercial_cost_rates ADD COLUMN provider_version TEXT NOT NULL DEFAULT '';
DO $$ DECLARE constraint_name TEXT; BEGIN
 FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='commercial_cost_rates'::regclass AND contype='u'
 LOOP EXECUTE format('ALTER TABLE commercial_cost_rates DROP CONSTRAINT %I',constraint_name); END LOOP;
END $$;
CREATE UNIQUE INDEX commercial_model_rate_version ON commercial_cost_rates(provider,operation,unit,model,provider_version,effective_from);
ALTER TABLE commercial_cost_events ALTER COLUMN amount_minor DROP NOT NULL;
ALTER TABLE commercial_cost_events ALTER COLUMN account_id DROP NOT NULL;
CREATE UNIQUE INDEX commercial_platform_cost_key ON commercial_cost_events(provider,operation,idempotency_key) WHERE account_id IS NULL;
ALTER TABLE commercial_cost_events ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE commercial_cost_events ADD COLUMN provider_version TEXT NOT NULL DEFAULT '';
UPDATE commercial_cost_events SET amount_minor=NULL WHERE COALESCE((detail->>'costRateMissing')::boolean,false);
-- Only exact, published first-party model versions are seeded. There is no
-- wildcard model, free-provider fallback or invented infrastructure rate.
INSERT INTO commercial_cost_rates(id,provider,operation,unit,cost_per_unit_minor,currency,effective_from,source,model,provider_version)
 SELECT 'public-anthropic-2026-10-05:'||model||':'||operation,'anthropic',operation,'token',usd_per_million*100/1000000,
 'USD','2026-10-05T00:00:00Z','Verified 2026-10-05: https://platform.claude.com/docs/en/about-claude/pricing (first-party global standard)',model,'2023-06-01'
 FROM (VALUES
 ('claude-haiku-4-5-20251001','model_input',1::numeric),('claude-haiku-4-5-20251001','model_output',5),
 ('claude-haiku-4-5-20251001','cache_write_5m',1.25),('claude-haiku-4-5-20251001','cache_write_1h',2),('claude-haiku-4-5-20251001','cache_read',0.1),
 ('claude-sonnet-5','model_input',2),('claude-sonnet-5','model_output',10),('claude-sonnet-5','cache_write_5m',2.5),
 ('claude-sonnet-5','cache_write_1h',4),('claude-sonnet-5','cache_read',0.2),
 ('claude-opus-5','model_input',5),('claude-opus-5','model_output',25),('claude-opus-5','cache_write_5m',6.25),
 ('claude-opus-5','cache_write_1h',10),('claude-opus-5','cache_read',0.5)) pricing(model,operation,usd_per_million)
 ON CONFLICT DO NOTHING;
INSERT INTO commercial_critical_warnings(id,fingerprint,code,detail) VALUES
 ('critical:infrastructure-costs','infrastructure-cost-contracts','UNVERIFIED_INFRASTRUCTURE_COSTS',
 '{"severity":"CRITICAL","required":"Actual hosting, database, storage and backup rates and metered usage ingestion. Profitability is unknown until verified."}');
INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
 SELECT 'historical-cost:'||id,account_id,'historical-cost:'||id,'MISSING_HISTORICAL_COST_RATE',
 jsonb_build_object('provider',provider,'operation',operation,'costEventId',id,'severity','CRITICAL')
 FROM commercial_cost_events WHERE amount_minor IS NULL;

-- Unsupported production features cannot be made sellable by old snapshots.
UPDATE commercial_capabilities SET readiness='DISABLED' WHERE capability IN
 ('communications.ai_drafts','email.response_generation','communications.auto_send','shipping.automation','migration.assisted','support.priority');
UPDATE commercial_plan_entitlements SET enabled=0 WHERE capability IN
 ('communications.ai_drafts','email.response_generation','communications.auto_send','shipping.automation','migration.assisted','support.priority');
INSERT INTO commercial_capabilities(capability,label,category,readiness,variable_cost) VALUES
 ('warehouse.advanced','Warehouse waves, bins and scans','inventory','SELLABLE',0),
 ('accounting.post_connected','Approved external accounting posting','accounting','CONDITIONAL',1);
INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled)
 SELECT id,key,CASE WHEN id IN ('pro','enterprise') THEN 1 ELSE 0 END FROM commercial_plans
 CROSS JOIN (VALUES('api.public'),('warehouse.advanced'),('authority.advanced'),('automation.transfers'),('automation.purchasing'),('accounting.post_connected')) capabilities(key)
 ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=EXCLUDED.enabled;
INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled)
 SELECT id,key,CASE WHEN id IN ('growth','pro','enterprise') THEN 1 ELSE 0 END FROM commercial_plans
 CROSS JOIN (VALUES('communications.email_ingestion'),('communications.send_approved'),('connections.accounting'),('accounting.sync'),
 ('shipping.rates'),('shipping.labels'),('shipping.tracking'),('planning.basic'),('planning.transfer_before_buy')) capabilities(key)
 ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=EXCLUDED.enabled;
INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled)
 SELECT id,'connections.commerce',1 FROM commercial_plans ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=1;
INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled)
 SELECT id,'connections.custom_api',CASE WHEN id='enterprise' THEN 1 ELSE 0 END
 FROM commercial_plans ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=EXCLUDED.enabled;
-- Reconcile compatibility grants with canonical grants rather than maintaining a second policy.
INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled)
 SELECT id,key,1 FROM commercial_plans CROSS JOIN (VALUES('identity.core'),('workspace.core'),('payments.customer')) capabilities(key)
 ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=1;
UPDATE commercial_plan_entitlements e SET enabled=c.enabled FROM commercial_plan_entitlements c,
 (VALUES ('connection.email','communications.email_ingestion'),('email.auto_extract','communications.email_ingestion'),
 ('connection.commerce','connections.commerce'),('connection.accounting','connections.accounting'),
 ('forecasting.basic','planning.basic'),('integrations.custom','connections.custom_api')) aliases(old_key,new_key)
 WHERE e.capability=aliases.old_key AND c.capability=aliases.new_key AND e.plan_id=c.plan_id;
UPDATE commercial_entitlement_overrides SET capability=CASE capability
 WHEN 'connection.email' THEN 'communications.email_ingestion' WHEN 'email.auto_extract' THEN 'communications.email_ingestion'
 WHEN 'connection.commerce' THEN 'connections.commerce' WHEN 'connection.accounting' THEN 'connections.accounting'
 WHEN 'forecasting.basic' THEN 'planning.basic' WHEN 'replenishment.basic' THEN 'planning.basic'
 WHEN 'integrations.custom' THEN 'connections.custom_api'
 WHEN 'ask_stockchief' THEN 'ask.lookup' WHEN 'merchant_payments' THEN 'payments.customer'
 WHEN 'sales_orders' THEN 'sales_orders.core' WHEN 'purchasing' THEN 'purchasing.core' WHEN 'suppliers' THEN 'purchasing.suppliers'
 WHEN 'receiving.manual' THEN 'receiving.core' WHEN 'accounting.basic' THEN 'accounting.core' WHEN 'needs_you' THEN 'operations.alerts'
 WHEN 'documents.process' THEN 'documents.extraction' WHEN 'email.response_generation' THEN 'communications.ai_drafts' ELSE capability END;
-- New commercial foundation is an explicit migration, not a rewrite of immutable snapshots.
ALTER TABLE commercial_subscription_changes ADD COLUMN request_key TEXT;
ALTER TABLE stockchief_runtime.jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE stockchief_runtime.jobs ADD CONSTRAINT jobs_status_check
 CHECK(status IN ('PENDING','RUNNING','RETRY','COMPLETED','DEAD','CANCELLED','PAUSED'));
ALTER TABLE commercial_subscription_changes ADD COLUMN request_quote JSONB;
CREATE UNIQUE INDEX commercial_subscription_change_request ON commercial_subscription_changes(account_id,request_key)
 WHERE request_key IS NOT NULL;
UPDATE commercial_plan_versions SET status='RETIRED',effective_until=now() WHERE status='ACTIVE';
INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters)
 SELECT 'wallet-foundation:'||p.id,p.id,COALESCE((SELECT MAX(version_number) FROM commercial_plan_versions WHERE plan_id=p.id),0)+1,
 'ACTIVE',p.currency,p.monthly_amount_minor,p.annual_amount_minor,
 (SELECT jsonb_agg(jsonb_build_object('capability',e.capability,'enabled',e.enabled,'configuration',e.configuration))
 FROM commercial_plan_entitlements e WHERE e.plan_id=p.id),
 (SELECT jsonb_agg(to_jsonb(m)) FROM commercial_plan_meters m WHERE m.plan_id=p.id) FROM commercial_plans p;
INSERT INTO commercial_change_audit(id,subject_type,subject_id,action,before_state,after_state,reason)
 SELECT 'wallet-migration:'||id,'subscription',id,'foundation_migration',to_jsonb(s),
 jsonb_build_object('plan_version_id','wallet-foundation:'||plan_id),'Approved architecture; allowances remain provisional'
 FROM account_subscriptions s;
UPDATE account_subscriptions SET plan_version_id='wallet-foundation:'||plan_id;
