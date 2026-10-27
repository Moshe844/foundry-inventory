INSERT INTO commercial_capabilities(capability,label,category,readiness,variable_cost)
VALUES('support.chat','Support conversations in StockChief','support','SELLABLE',0);
UPDATE commercial_capabilities SET readiness='SELLABLE',updated_at=now() WHERE capability='support.priority';
UPDATE commercial_capabilities SET readiness='CONDITIONAL',updated_at=now() WHERE capability='migration.assisted';
INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled)
SELECT p.id,c.capability,CASE WHEN c.capability='support.priority' AND p.id IN ('growth','pro','enterprise')
 OR c.capability='support.chat' AND p.id IN ('pro','enterprise')
 OR c.capability='migration.assisted' AND p.id IN ('pro','enterprise') THEN 1 ELSE 0 END
FROM commercial_plans p CROSS JOIN (VALUES('support.priority'),('support.chat'),('migration.assisted')) c(capability)
ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=EXCLUDED.enabled;
CREATE TABLE support_staff_profiles(account_id TEXT PRIMARY KEY REFERENCES accounts(id),display_name TEXT NOT NULL,contact_email TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT true,accepts_chat BOOLEAN NOT NULL DEFAULT false,last_seen_at TIMESTAMPTZ);
CREATE TABLE support_service_agreements(
 owner_account_id TEXT NOT NULL REFERENCES accounts(id),revision INTEGER NOT NULL,
 manager_account_id TEXT REFERENCES support_staff_profiles(account_id) ON DELETE SET NULL,response_hours INTEGER CHECK(response_hours BETWEEN 1 AND 720),
 service_text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PREPARED' CHECK(status IN ('PREPARED','ACTIVE','SUPERSEDED')),
 prepared_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,accepted_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,accepted_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(owner_account_id,revision)
);
ALTER TABLE support_requests ADD COLUMN owner_account_id TEXT REFERENCES accounts(id);
ALTER TABLE support_requests ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 2);
ALTER TABLE support_requests ADD COLUMN channel TEXT NOT NULL DEFAULT 'EMAIL' CHECK(channel IN ('EMAIL','CHAT','ONBOARDING','MIGRATION'));
ALTER TABLE support_requests ADD COLUMN assigned_to TEXT REFERENCES support_staff_profiles(account_id) ON DELETE SET NULL;
ALTER TABLE support_requests ADD COLUMN first_response_due_at TIMESTAMPTZ;
ALTER TABLE support_requests ADD COLUMN first_response_at TIMESTAMPTZ;
ALTER TABLE support_requests ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE support_requests r SET owner_account_id=coalesce((SELECT owner_account_id FROM workspaces WHERE id=r.workspace_id),r.account_id);
CREATE TABLE support_messages(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,author_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,author_role TEXT NOT NULL CHECK(author_role IN ('CUSTOMER','SUPPORT')),body TEXT NOT NULL,request_key TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(request_id,request_key));
CREATE INDEX support_queue ON support_requests(status,priority DESC,created_at);
UPDATE commercial_plan_versions SET status='RETIRED',effective_until=now() WHERE status='ACTIVE';
INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters)
SELECT 'plan-services-2026-10-27:'||p.id,p.id,(SELECT max(version_number)+1 FROM commercial_plan_versions WHERE plan_id=p.id),'ACTIVE',p.currency,p.monthly_amount_minor,p.annual_amount_minor,
 (SELECT jsonb_agg(jsonb_build_object('capability',e.capability,'enabled',e.enabled,'configuration',e.configuration) ORDER BY e.capability) FROM commercial_plan_entitlements e WHERE e.plan_id=p.id),
 (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.meter) FROM commercial_plan_meters m WHERE m.plan_id=p.id)
FROM commercial_plans p;
