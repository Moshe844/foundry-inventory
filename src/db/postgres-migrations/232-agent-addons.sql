ALTER TABLE commercial_capacity_products ADD COLUMN eligible_plans text[];
-- Entered by a billing administrator after reconciling provider invoices with
-- actual credits used. No qualification is seeded by a new installation.
ALTER TABLE commercial_capacity_products ADD COLUMN ai_usage_review jsonb;
ALTER TABLE commercial_capacity_orders ADD COLUMN ai_funding jsonb;
ALTER TABLE commercial_model_grant_budgets ALTER COLUMN purchase_id DROP NOT NULL;
ALTER TABLE commercial_model_grant_budgets ADD COLUMN capacity_invoice_id text UNIQUE REFERENCES commercial_capacity_payments(invoice_id);
ALTER TABLE commercial_model_grant_budgets ADD CHECK (num_nonnulls(purchase_id,capacity_invoice_id)=1);
ALTER TABLE commercial_usage_grants ALTER COLUMN purchase_id DROP NOT NULL;
ALTER TABLE commercial_usage_grants ADD COLUMN capacity_invoice_id text UNIQUE REFERENCES commercial_capacity_payments(invoice_id);
ALTER TABLE commercial_usage_grants ADD CONSTRAINT grant_has_one_purchase
  CHECK (num_nonnulls(purchase_id,capacity_invoice_id)=1);

INSERT INTO commercial_meter_definitions(meter,label,kind,customer_visible,critical_access) VALUES
  ('agent_documents','Documents read per month','USAGE',1,0),
  ('agent_edi','EDI retailer connection add-on','PER_OPERATION',1,0);
INSERT INTO commercial_plan_meters(plan_id,meter,label,included_units,hard_limit,overage_mode)
SELECT p.id,'agent_documents','Documents read per month',limits.units,limits.units,'PAUSE'
FROM (VALUES ('starter',50),('growth',500),('pro',3000)) limits(id,units)
JOIN commercial_plans p ON p.id=limits.id;
INSERT INTO commercial_plan_meters(plan_id,meter,label,included_units,hard_limit,overage_mode)
VALUES ('pro','agent_edi','EDI retailer connection add-on',0,0,'PAUSE');
UPDATE commercial_plan_versions v SET meters=v.meters || (
  SELECT jsonb_agg(to_jsonb(m) ORDER BY m.meter) FROM commercial_plan_meters m
  WHERE m.plan_id=v.plan_id AND m.meter IN ('agent_documents','agent_edi'))
WHERE v.id IN ('agent-v3:starter','agent-v3:growth','agent-v3:pro');

INSERT INTO commercial_capacity_products(id,label,meter,units_per_pack,monthly_amount_minor,display_order,entitlements,eligible_plans,capacity_scope) VALUES
 ('agent-monthly-credits','5,000 additional AI credits','ai_work_credits',5000,4900,10,'{"ai_work_credits":5000}',ARRAY['starter','growth','pro','enterprise'],'ACCOUNT'),
 ('agent-monthly-documents','500 additional documents','agent_documents',500,4900,11,'{"agent_documents":500}',ARRAY['starter','growth','pro','enterprise'],'ACCOUNT'),
 ('agent-location-inventory','5 additional locations and 1 inventory','workspaces',1,2900,12,'{"locations":5,"workspaces":1}',ARRAY['starter','growth'],'INVENTORY'),
 ('agent-pro-edi','EDI with big retailers','agent_edi',1,29900,13,'{"agent_edi":1}',ARRAY['pro'],'ACCOUNT');
