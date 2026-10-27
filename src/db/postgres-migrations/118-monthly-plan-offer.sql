-- New monthly offers. Existing financial and entitlement snapshots stay intact.
INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters)
SELECT 'before-monthly-offer-2026-10-27:'||p.id,p.id,
 COALESCE((SELECT MAX(version_number) FROM commercial_plan_versions WHERE plan_id=p.id),0)+1,
 'RETIRED',p.currency,p.monthly_amount_minor,p.annual_amount_minor,
 (SELECT jsonb_agg(jsonb_build_object('capability',e.capability,'enabled',e.enabled,'configuration',e.configuration) ORDER BY e.capability) FROM commercial_plan_entitlements e WHERE e.plan_id=p.id),
 (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.meter) FROM commercial_plan_meters m WHERE m.plan_id=p.id)
FROM commercial_plans p WHERE EXISTS(SELECT 1 FROM account_subscriptions s WHERE s.plan_id=p.id AND s.plan_version_id IS NULL);
UPDATE account_subscriptions s SET plan_version_id='before-monthly-offer-2026-10-27:'||s.plan_id
WHERE s.plan_version_id IS NULL AND EXISTS(SELECT 1 FROM commercial_plan_versions v WHERE v.id='before-monthly-offer-2026-10-27:'||s.plan_id);

INSERT INTO commercial_meter_definitions(meter,label,kind,customer_visible,critical_access)
VALUES('emails_sent','Emails sent','USAGE',1,0) ON CONFLICT(meter) DO NOTHING;
INSERT INTO commercial_plan_meters(plan_id,meter,label,included_units,hard_limit,overage_mode)
SELECT id,'emails_sent','Emails sent',CASE id WHEN 'starter' THEN 1000 WHEN 'growth' THEN 10000 WHEN 'pro' THEN 50000 ELSE NULL END,
 CASE id WHEN 'starter' THEN 1000 WHEN 'growth' THEN 10000 WHEN 'pro' THEN 50000 ELSE NULL END,'PAUSE'
FROM commercial_plans ON CONFLICT(plan_id,meter) DO NOTHING;
UPDATE commercial_plan_meters SET included_units=CASE plan_id WHEN 'starter' THEN 3000 WHEN 'growth' THEN 10000 WHEN 'pro' THEN 25000 END,
 hard_limit=NULL,overage_mode='PURCHASE' WHERE meter='ai_work_credits' AND plan_id IN ('starter','growth','pro');
UPDATE commercial_plan_meters SET included_units=CASE plan_id WHEN 'starter' THEN 3 WHEN 'growth' THEN 10 WHEN 'pro' THEN 25 END,
 hard_limit=CASE plan_id WHEN 'starter' THEN 3 WHEN 'growth' THEN 10 WHEN 'pro' THEN 25 END
WHERE meter='members' AND plan_id IN ('starter','growth','pro');
UPDATE commercial_plan_meters SET included_units=CASE plan_id WHEN 'starter' THEN 2 WHEN 'growth' THEN 10 ELSE NULL END,
 hard_limit=CASE plan_id WHEN 'starter' THEN 2 WHEN 'growth' THEN 10 ELSE NULL END
WHERE meter='locations' AND plan_id IN ('starter','growth','pro');
UPDATE commercial_plans SET public_name='Custom',updated_at=now() WHERE id='enterprise';


-- Each published allowance is enforced at the canonical write boundary.
INSERT INTO commercial_meter_definitions(meter,label,kind,customer_visible,critical_access) VALUES
 ('products','Products','STRUCTURAL',1,1),('scheduled_reports','Scheduled reports','STRUCTURAL',1,0),
 ('sales_channels','Sales channels','STRUCTURAL',1,1),('shipping_accounts','Shipping accounts','STRUCTURAL',1,1);
INSERT INTO commercial_plan_meters(plan_id,meter,label,included_units,hard_limit,overage_mode)
SELECT p.id,m.meter,m.label,
 CASE m.meter WHEN 'products' THEN CASE p.id WHEN 'starter' THEN 5000 WHEN 'growth' THEN 50000 WHEN 'pro' THEN 250000 END
 WHEN 'scheduled_reports' THEN CASE WHEN p.id='starter' THEN 3 END ELSE CASE WHEN p.id='starter' THEN 1 END END,
 CASE m.meter WHEN 'products' THEN CASE p.id WHEN 'starter' THEN 5000 WHEN 'growth' THEN 50000 WHEN 'pro' THEN 250000 END
 WHEN 'scheduled_reports' THEN CASE WHEN p.id='starter' THEN 3 END ELSE CASE WHEN p.id='starter' THEN 1 END END,'PAUSE'
FROM commercial_plans p CROSS JOIN commercial_meter_definitions m WHERE m.meter IN ('products','scheduled_reports','sales_channels','shipping_accounts');
UPDATE commercial_plan_meters SET included_units=NULL,hard_limit=NULL WHERE meter IN ('connections','connected_operations');
UPDATE commercial_meter_definitions SET customer_visible=0 WHERE meter='connected_operations';
INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled) SELECT 'starter',capability,1 FROM unnest(ARRAY['shipping.rates','shipping.labels','shipping.tracking']) capability
ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=1;
UPDATE commercial_plans SET annual_amount_minor=monthly_amount_minor*10,trial_days=0 WHERE id IN ('starter','growth','pro');
ALTER TABLE commercial_plan_meters ADD COLUMN rollover_months INTEGER NOT NULL DEFAULT 0 CHECK(rollover_months IN (0,1));
UPDATE commercial_plan_meters SET rollover_months=1 WHERE meter='ai_work_credits' AND plan_id IN ('starter','growth','pro');

ALTER TABLE commercial_plan_meters ADD COLUMN credit_unit_scale INTEGER NOT NULL DEFAULT 1 CHECK(credit_unit_scale>0);
ALTER TABLE commercial_plan_meters ADD COLUMN provider_budget_minor_per_credit NUMERIC(16,6) CHECK(provider_budget_minor_per_credit>0);
UPDATE commercial_plan_meters SET credit_unit_scale=20,provider_budget_minor_per_credit=1.5 WHERE meter='ai_work_credits';
UPDATE commercial_plan_versions SET status='RETIRED',effective_until=now()
WHERE status='ACTIVE' AND plan_id IN ('starter','growth','pro','enterprise');
INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters)
SELECT 'monthly-offer-2026-10-27:'||p.id,p.id,
 COALESCE((SELECT MAX(version_number) FROM commercial_plan_versions WHERE plan_id=p.id),0)+1,
 'ACTIVE',p.currency,p.monthly_amount_minor,p.annual_amount_minor,
 (SELECT jsonb_agg(jsonb_build_object('capability',e.capability,'enabled',e.enabled,'configuration',e.configuration) ORDER BY e.capability) FROM commercial_plan_entitlements e WHERE e.plan_id=p.id),
 (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.meter) FROM commercial_plan_meters m WHERE m.plan_id=p.id)
FROM commercial_plans p WHERE p.id IN ('starter','growth','pro','enterprise');
INSERT INTO commercial_change_audit(id,subject_type,subject_id,action,before_state,after_state,reason)
SELECT 'monthly-offer-2026-10-27:'||id,'plan',id,'new_monthly_offer',NULL,
 jsonb_build_object('version','monthly-offer-2026-10-27:'||id,'existingSubscriptionsPreserved',true),
 'Owner supplied monthly pricing; advertise only implemented entitlements. No checkout or paid-test funding enabled.'
FROM commercial_plans WHERE id IN ('starter','growth','pro','enterprise');

CREATE TABLE commercial_usage_periods (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),meter TEXT NOT NULL,
 period_start TIMESTAMPTZ NOT NULL,period_end TIMESTAMPTZ NOT NULL,base_units BIGINT NOT NULL CHECK(base_units>=0),
 carry_units BIGINT NOT NULL CHECK(carry_units>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(period_end>period_start),UNIQUE(account_id,meter,period_start)
);
ALTER TABLE commercial_usage_allocations ADD COLUMN rollover_id TEXT REFERENCES commercial_usage_periods(id);
ALTER TABLE commercial_usage_allocations ADD CONSTRAINT usage_allocation_one_source CHECK(grant_id IS NULL OR rollover_id IS NULL);
CREATE INDEX commercial_rollover_allocations ON commercial_usage_allocations(rollover_id,event_id) WHERE rollover_id IS NOT NULL;
ALTER TABLE commercial_usage_packs DROP CONSTRAINT commercial_usage_packs_category_check;
ALTER TABLE commercial_usage_packs ADD CONSTRAINT commercial_usage_packs_category_check CHECK(category IN ('ai_work_credits','connected_operations','emails_sent'));
ALTER TABLE commercial_operation_policies DROP CONSTRAINT commercial_operation_policies_category_check;
ALTER TABLE commercial_operation_policies ADD CONSTRAINT commercial_operation_policies_category_check CHECK(category IN ('ai_work_credits','connected_operations','emails_sent'));
INSERT INTO commercial_usage_packs(id,category,version,units,amount_minor,status) VALUES('emails-10000-v3','emails_sent',3,10000,1500,'PROVISIONAL');

CREATE TABLE commercial_capacity_products(id TEXT PRIMARY KEY,label TEXT NOT NULL,meter TEXT NOT NULL,units_per_pack INTEGER NOT NULL CHECK(units_per_pack>0),monthly_amount_minor BIGINT NOT NULL CHECK(monthly_amount_minor>0),currency TEXT NOT NULL DEFAULT 'USD',stripe_price_id TEXT UNIQUE,active BOOLEAN NOT NULL DEFAULT true,display_order INTEGER NOT NULL);
INSERT INTO commercial_capacity_products(id,label,meter,units_per_pack,monthly_amount_minor,display_order) VALUES('extra-user','Extra user','members',1,2000,1),('extra-inventory','Extra inventory','workspaces',1,9900,2),('extra-locations','10 extra locations','locations',10,4900,3);
CREATE TABLE commercial_capacity_orders(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),product_id TEXT NOT NULL REFERENCES commercial_capacity_products(id),quantity INTEGER NOT NULL CHECK(quantity>0),units BIGINT NOT NULL CHECK(units>0),amount_minor BIGINT NOT NULL CHECK(amount_minor>0),currency TEXT NOT NULL,price_id TEXT NOT NULL,stripe_customer_id TEXT NOT NULL,stripe_subscription_id TEXT UNIQUE,stripe_session_id TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACTIVE','CANCELLED')),paid_through TIMESTAMPTZ,cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,last_event_at TIMESTAMPTZ,request_key TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(account_id,request_key));
CREATE TABLE commercial_capacity_payments(invoice_id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES commercial_capacity_orders(id),period_start TIMESTAMPTZ NOT NULL,period_end TIMESTAMPTZ NOT NULL,amount_minor BIGINT NOT NULL,provider_event_id TEXT NOT NULL UNIQUE,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),CHECK(period_end>period_start));

ALTER TABLE commercial_usage_packs ADD COLUMN max_provider_cost_share NUMERIC(6,4) CHECK(max_provider_cost_share>0 AND max_provider_cost_share<1);
INSERT INTO commercial_usage_packs(id,category,version,units,amount_minor,status,provider_cost_budget_minor,conservative_cost_per_credit_minor,cost_model_key,cost_budget_source,approved_model_rate_ceiling,max_provider_cost_share)
SELECT v.id,'ai_work_credits',3,v.units,v.amount,'PROVISIONAL',v.units*1.5,1.5,'work-credit-2026-10-27','Each complex request reserves additional credits for cumulative provider-cost bounds. New pricing allocates at most 60% of pack revenue; existing terms and Staging funding unchanged.',coalesce((SELECT approved_model_rate_ceiling FROM commercial_usage_packs WHERE id='ai-2500-v2'),'{}'::jsonb),0.60
FROM (VALUES('ai-2500-v3',2500,7900),('ai-10000-v3',10000,27900)) v(id,units,amount);

ALTER TABLE commercial_usage_packs ADD COLUMN credit_unit_scale INTEGER NOT NULL DEFAULT 1 CHECK(credit_unit_scale>0);
UPDATE commercial_usage_packs SET credit_unit_scale=20 WHERE category='ai_work_credits' AND version=3;
ALTER TABLE commercial_usage_purchases ADD COLUMN max_provider_cost_share NUMERIC(6,4);
ALTER TABLE commercial_usage_purchases ADD COLUMN credit_unit_scale INTEGER NOT NULL DEFAULT 1;
UPDATE commercial_usage_packs SET approved_model_rate_ceiling=approved_model_rate_ceiling||coalesce((
 SELECT jsonb_object_agg(r.rate_key,r.rates) FROM (
  SELECT provider||'/'||model||'/'||provider_version rate_key,jsonb_object_agg(operation,cost_per_unit_minor) rates FROM (
   SELECT DISTINCT ON(provider,model,provider_version,operation) provider,model,provider_version,operation,cost_per_unit_minor
   FROM commercial_cost_rates WHERE provider='openai' AND unit='token' AND pricing_basis IN ('VERIFIED_PUBLIC','VERIFIED_CONTRACT')
   AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now()) ORDER BY provider,model,provider_version,operation,effective_from DESC
  ) costs GROUP BY provider,model,provider_version HAVING count(*) FILTER(WHERE operation IN ('model_input','cache_write_1h','model_output'))=3
 ) r),'{}'::jsonb) WHERE category='ai_work_credits' AND version=3;
