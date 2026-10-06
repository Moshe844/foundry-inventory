-- Optional external accounting and merchant-payment integrations are excluded
-- from INITIAL self-service launch until provider contract/production evidence
-- is verified. Native accounting, manual shipping and historical data remain.
-- Existing subscription snapshots are immutable and not changed here.
UPDATE commercial_plan_entitlements SET enabled=0
 WHERE plan_id IN ('starter','growth','pro')
 AND capability IN ('connections.accounting','accounting.sync','accounting.post_connected',
  'connection.accounting','payments.customer','merchant_payments');
UPDATE commercial_plan_versions v SET entitlements=(
 SELECT jsonb_agg(jsonb_build_object('capability',e.capability,'enabled',e.enabled,
  'configuration',e.configuration) ORDER BY e.capability)
 FROM commercial_plan_entitlements e WHERE e.plan_id=v.plan_id)
 WHERE v.status='ACTIVE' AND v.plan_id IN ('starter','growth','pro');
