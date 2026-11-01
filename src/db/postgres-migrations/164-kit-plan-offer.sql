UPDATE commercial_capabilities SET readiness='SELLABLE' WHERE capability='inventory.kits';
INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled)
 SELECT id,'inventory.kits',CASE WHEN id IN('pro','enterprise') THEN 1 ELSE 0 END FROM commercial_plans
 ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=EXCLUDED.enabled;
-- Add the tested feature to the new same-price offer. Existing agreed terms,
-- charges and renewal dates stay pinned until their owner accepts the offer.
UPDATE commercial_plan_versions SET status='RETIRED',effective_until=now() WHERE status='ACTIVE' AND plan_id IN('pro','enterprise');
INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters)
SELECT 'kits-2026-11-01:'||p.id,p.id,(SELECT max(version_number)+1 FROM commercial_plan_versions WHERE plan_id=p.id),'ACTIVE',p.currency,p.monthly_amount_minor,p.annual_amount_minor,
 (SELECT jsonb_agg(jsonb_build_object('capability',e.capability,'enabled',e.enabled,'configuration',e.configuration) ORDER BY e.capability) FROM commercial_plan_entitlements e WHERE e.plan_id=p.id),
 (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.meter) FROM commercial_plan_meters m WHERE m.plan_id=p.id)
FROM commercial_plans p WHERE p.id IN('pro','enterprise');
