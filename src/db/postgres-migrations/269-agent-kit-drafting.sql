-- The Agent matrix includes kit drafts on Growth. Earlier accepted offers
-- retain their own entitlement snapshots.
UPDATE commercial_plan_versions
SET entitlements=(SELECT jsonb_agg(CASE WHEN e->>'capability'='inventory.kits' THEN e || '{"enabled":1}'::jsonb ELSE e END)
 FROM jsonb_array_elements(entitlements) e) || CASE WHEN EXISTS(
 SELECT 1 FROM jsonb_array_elements(entitlements) e WHERE e->>'capability'='inventory.kits'
) THEN '[]'::jsonb ELSE '[{"capability":"inventory.kits","enabled":1,"configuration":{}}]'::jsonb END
WHERE id='agent-v3:growth' AND NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(entitlements) e WHERE e->>'capability'='inventory.kits' AND (e->>'enabled')::int=1
);
