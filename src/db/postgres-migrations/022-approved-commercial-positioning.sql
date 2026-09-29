UPDATE commercial_plans SET
  outcome=CASE id
    WHEN 'starter' THEN 'Build one reliable operating system for inventory, purchasing, orders and money.'
    WHEN 'growth' THEN 'Let StockChief carry the operational middle across connected systems and communication.'
    WHEN 'pro' THEN 'Run supported workflows with broader authority while the owner manages exceptions.'
    WHEN 'enterprise' THEN 'Deploy StockChief around complex scale, migration and integration requirements.'
    ELSE outcome END,
  audience=CASE id
    WHEN 'starter' THEN 'Businesses leaving spreadsheets or basic stock tools.'
    WHEN 'growth' THEN 'Growing businesses ready to automate communication and operational follow-through.'
    WHEN 'pro' THEN 'Multi-location operators ready for bounded autonomous execution.'
    WHEN 'enterprise' THEN 'High-volume or specialized operations needing a tailored rollout.'
    ELSE audience END,
  packaging_reviewed_at=now(),
  updated_at=now()
WHERE id IN ('starter','growth','pro','enterprise');

INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled)
VALUES ('starter','connection.commerce',1)
ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=EXCLUDED.enabled;

UPDATE commercial_plans SET packaging_status='PROPOSED',packaging_approved_at=NULL,
  packaging_approved_by_account_id=NULL,updated_at=now()
WHERE id IN ('starter','growth','pro','enterprise') AND packaging_status<>'APPROVED';
