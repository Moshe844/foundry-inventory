-- Create a new version for future purchases and explicit plan-term changes.
-- Existing subscriptions and purchased usage grants retain their references.
INSERT INTO commercial_capabilities (capability,label,category,readiness,variable_cost)
VALUES ('automation.trusted_purchasing','Repeat orders for trusted suppliers and items','automation','SELLABLE',1);

INSERT INTO commercial_plan_entitlements (plan_id,capability,enabled,configuration)
VALUES ('growth','automation.trusted_purchasing',1,'{}');

UPDATE commercial_plan_meters SET included_units=5000,hard_limit=5000
WHERE plan_id='starter' AND meter='ai_work_credits';
UPDATE commercial_plan_meters SET included_units=NULL,hard_limit=NULL
WHERE plan_id='pro' AND meter='locations';

WITH previous AS (
  UPDATE commercial_plan_versions SET status='RETIRED',effective_until=now()
  WHERE plan_id IN ('starter','growth','pro') AND status='ACTIVE'
  RETURNING *
)
INSERT INTO commercial_plan_versions
  (id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters,configuration)
SELECT 'agent-v3:'||p.plan_id,p.plan_id,p.version_number+1,'ACTIVE',p.currency,
  p.monthly_amount_minor,p.annual_amount_minor,
  CASE WHEN p.plan_id='growth' THEN p.entitlements || '[{"capability":"automation.trusted_purchasing","enabled":1,"configuration":{}}]'::jsonb
       ELSE p.entitlements END,
  (SELECT jsonb_agg(CASE
    WHEN p.plan_id='starter' AND item->>'meter'='ai_work_credits' THEN item || '{"included_units":5000,"hard_limit":5000}'::jsonb
    WHEN p.plan_id='pro' AND item->>'meter'='locations' THEN item || '{"included_units":null,"hard_limit":null}'::jsonb
    ELSE item END ORDER BY item->>'meter') FROM jsonb_array_elements(p.meters) AS item),
  p.configuration || '{"offerId":"agent-v3"}'::jsonb
FROM previous p;
