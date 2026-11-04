-- Migration 195 reached only the copy frozen on 2026-11-02. Accounts can be on any
-- earlier copy of a plan (monthly offer, kits, plan services and so on). Custom roles
-- and approval limits come with every copy of a plan whose current offer includes them.
WITH current_offer AS (
 SELECT DISTINCT ON (v.plan_id) v.plan_id,
  EXISTS(SELECT 1 FROM jsonb_array_elements(v.entitlements) e WHERE e->>'capability'='authority.advanced' AND (e->>'enabled')::bigint=1) AS included,
  (SELECT m FROM jsonb_array_elements(v.meters) m WHERE m->>'meter'='custom_roles' LIMIT 1) AS roles_meter
 FROM commercial_plan_versions v WHERE v.status='ACTIVE' ORDER BY v.plan_id,v.version_number DESC
)
UPDATE commercial_plan_versions older SET
 entitlements=(SELECT coalesce(jsonb_agg(e),'[]'::jsonb) FROM jsonb_array_elements(older.entitlements) e WHERE e->>'capability'<>'authority.advanced')
  ||jsonb_build_array(jsonb_build_object('capability','authority.advanced','enabled',1,'configuration','{}'::jsonb)),
 meters=CASE WHEN current_offer.roles_meter IS NULL THEN older.meters ELSE
  (SELECT coalesce(jsonb_agg(m),'[]'::jsonb) FROM jsonb_array_elements(older.meters) m WHERE m->>'meter'<>'custom_roles')||jsonb_build_array(current_offer.roles_meter) END
FROM current_offer
WHERE older.status<>'ACTIVE' AND older.plan_id=current_offer.plan_id AND current_offer.included;
