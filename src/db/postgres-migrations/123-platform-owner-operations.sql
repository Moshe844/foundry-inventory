-- Account access is independent of subscription billing. No existing customer state changes.
CREATE TABLE platform_account_access (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 disabled_at TIMESTAMPTZ,
 reason TEXT NOT NULL,
 changed_by TEXT NOT NULL REFERENCES accounts(id),
 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_account_action_request ON commercial_change_audit
 (actor_account_id,(after_state->>'requestKey'))
 WHERE subject_type='platform_account_access' AND after_state->>'requestKey' IS NOT NULL;

-- Reuse the existing account-removal queue, review and tenant-purge engine.
ALTER TABLE developer_account_deletions DROP CONSTRAINT developer_account_deletions_environment_check;
ALTER TABLE developer_account_deletions ADD CONSTRAINT developer_account_deletions_environment_check
 CHECK(environment IN ('staging','production'));
ALTER TABLE developer_account_deletions ADD COLUMN authority TEXT NOT NULL DEFAULT 'DEVELOPER_TEST'
 CHECK(authority IN ('DEVELOPER_TEST','PLATFORM_OWNER'));
ALTER TABLE developer_account_deletions ADD COLUMN reason TEXT;
ALTER TABLE developer_account_deletions ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX platform_deletion_request ON developer_account_deletions(actor_account_id,request_key)
 WHERE request_key IS NOT NULL;

-- A business owner can approve support inspection without first opening a chat.
ALTER TABLE platform_support_access ALTER COLUMN request_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION stockchief_workspace_purge_allowed(wanted TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
 SELECT coalesce(current_setting('stockchief.purge_workspace',true)=wanted,false) AND (
 EXISTS (
 SELECT 1 FROM commercial_subscription_refund_retention r JOIN workspaces w ON w.owner_account_id=r.account_id
 JOIN commercial_stripe_refunds f ON f.id=r.refund_id JOIN account_subscriptions s ON s.account_id=r.account_id
 WHERE w.id=wanted AND r.workspace_ids ? wanted AND f.status='succeeded' AND r.status='READ_ONLY'
 AND r.cancellation_confirmed_at IS NOT NULL AND r.delete_after<=clock_timestamp() AND r.refunded_at<=clock_timestamp()-interval '720 hours'
 AND s.stripe_subscription_id=r.stripe_subscription_id AND s.refunded_at IS NOT NULL)
 OR EXISTS (
 SELECT 1 FROM developer_account_deletions d JOIN workspaces w ON w.owner_account_id=d.target_account_id
 WHERE d.id=current_setting('stockchief.developer_purge_request',true)
 AND d.status='EXECUTING' AND d.expires_at>clock_timestamp() AND w.id=wanted AND d.workspace_ids ? wanted
 AND d.environment=current_setting('stockchief.runtime_environment',true)
 AND ((d.authority='DEVELOPER_TEST' AND d.environment='staging'
 AND EXISTS(SELECT 1 FROM developer_account_administrators a WHERE a.account_id=d.actor_account_id))
 OR (d.authority='PLATFORM_OWNER'
 AND EXISTS(SELECT 1 FROM platform_console_operators o JOIN platform_console_mfa m ON m.account_id=o.account_id
 WHERE o.account_id=d.actor_account_id AND o.active=true AND o.role='OWNER')
 AND EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=d.target_account_id AND a.disabled_at IS NOT NULL))))
 )
$$;
