-- Keep accepted snapshots available for audit. Only subscriptions pinned to the
-- current agent offer (or current Custom contract template) follow its correction.
DO $$
DECLARE
  prior commercial_plan_versions%ROWTYPE;
  proposed jsonb;
  next_id text;
  target integer;
BEGIN
  FOR prior IN SELECT * FROM commercial_plan_versions
    WHERE status='ACTIVE' AND (configuration->>'offerId'='agent-v3' OR plan_id='enterprise')
    ORDER BY plan_id FOR UPDATE
  LOOP
    target := CASE WHEN prior.plan_id='starter' THEN 0 ELSE 1 END;
    INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled)
      VALUES(prior.plan_id,'communications.ai_drafts',target)
      ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=EXCLUDED.enabled;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(prior.entitlements) e
      WHERE e->>'capability'='communications.ai_drafts' AND (e->>'enabled')::integer=target)
    THEN CONTINUE; END IF;
    SELECT COALESCE(jsonb_agg(e ORDER BY e->>'capability'),'[]'::jsonb) INTO proposed
      FROM jsonb_array_elements(prior.entitlements) e WHERE e->>'capability'<>'communications.ai_drafts';
    proposed := proposed || jsonb_build_array(jsonb_build_object('capability','communications.ai_drafts','enabled',target,
      'configuration',COALESCE((SELECT e->'configuration' FROM jsonb_array_elements(prior.entitlements) e
        WHERE e->>'capability'='communications.ai_drafts' LIMIT 1),'{}'::jsonb)));
    next_id := 'agent-mail:'||prior.id;
    UPDATE commercial_plan_versions SET status='RETIRED',effective_until=now() WHERE id=prior.id;
    INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,
      entitlements,meters,approved_by_account_id,configuration)
      SELECT next_id,prior.plan_id,max(version_number)+1,'ACTIVE',prior.currency,prior.monthly_amount_minor,prior.annual_amount_minor,
        proposed,prior.meters,prior.approved_by_account_id,prior.configuration FROM commercial_plan_versions WHERE plan_id=prior.plan_id;
    INSERT INTO commercial_change_audit(id,subject_type,subject_id,action,before_state,after_state,reason)
      SELECT 'agent-mail:'||s.id,'subscription_feature_benefit',s.account_id,'version_changed',
        jsonb_build_object('planVersionId',prior.id),jsonb_build_object('planVersionId',next_id),
        'Apply approved Agent plan v3 email drafting permission.' FROM account_subscriptions s WHERE s.plan_version_id=prior.id;
    UPDATE account_subscriptions SET plan_version_id=next_id,updated_at=now() WHERE plan_version_id=prior.id;
  END LOOP;
END $$;
