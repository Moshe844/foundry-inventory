-- Accounts frozen on the plan copy from before 2026-11-02 keep their price and
-- limits, but custom roles and approval limits now come with any plan whose
-- current offer includes them, with nothing further to accept.
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
WHERE older.id LIKE 'before-approved-2026-11-02:%' AND older.plan_id=current_offer.plan_id AND current_offer.included;
