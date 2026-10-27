-- Additive: no passwords, memberships, billing or existing sessions are changed.
INSERT INTO commercial_capabilities(capability,label,category,readiness,variable_cost)
VALUES('identity.sso','Company single sign-on','foundation','CONDITIONAL',0);
INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled)
SELECT id,'identity.sso',CASE WHEN id='enterprise' THEN 1 ELSE 0 END FROM commercial_plans;
CREATE TABLE business_sso_configurations(
 id TEXT PRIMARY KEY,owner_account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
 label TEXT NOT NULL,issuer TEXT NOT NULL,client_id TEXT NOT NULL,sealed_secret JSONB NOT NULL,
 metadata JSONB NOT NULL,enabled BOOLEAN NOT NULL DEFAULT false,revision INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE business_sso_identities(
 id TEXT PRIMARY KEY,configuration_id TEXT NOT NULL REFERENCES business_sso_configurations(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL REFERENCES accounts(id),subject TEXT NOT NULL,
 configuration_revision INTEGER NOT NULL,enabled BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_login_at TIMESTAMPTZ,
 UNIQUE(configuration_id,subject),UNIQUE(configuration_id,account_id)
);
CREATE TABLE business_sso_attempts(
 state_hash TEXT PRIMARY KEY,configuration_id TEXT NOT NULL REFERENCES business_sso_configurations(id) ON DELETE CASCADE,
 configuration_revision INTEGER NOT NULL,session_hash TEXT NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('LINK','LOGIN')),account_id TEXT REFERENCES accounts(id),
 sealed JSONB NOT NULL,redirect_uri TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,used_at TIMESTAMPTZ,
 CHECK(purpose<>'LINK' OR account_id IS NOT NULL)
);
CREATE INDEX business_sso_attempt_expiry ON business_sso_attempts(expires_at);
CREATE INDEX business_sso_attempt_rate ON business_sso_attempts(session_hash,created_at);
-- Only the new Custom offer receives the added entitlement. Saved terms remain
-- immutable until their owner explicitly reviews the updated same-price offer.
UPDATE commercial_plan_versions SET status='RETIRED',effective_until=now()
WHERE plan_id='enterprise' AND status='ACTIVE';
INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters)
SELECT 'company-sso-2026-10-27:enterprise',p.id,
 (SELECT max(version_number)+1 FROM commercial_plan_versions WHERE plan_id=p.id),'ACTIVE',p.currency,p.monthly_amount_minor,p.annual_amount_minor,
 (SELECT jsonb_agg(jsonb_build_object('capability',e.capability,'enabled',e.enabled,'configuration',e.configuration) ORDER BY e.capability) FROM commercial_plan_entitlements e WHERE e.plan_id=p.id),
 (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.meter) FROM commercial_plan_meters m WHERE m.plan_id=p.id)
FROM commercial_plans p WHERE p.id='enterprise';
