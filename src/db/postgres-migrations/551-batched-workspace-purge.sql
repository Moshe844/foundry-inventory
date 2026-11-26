-- A very large inventory is removed in many short transactions rather than one.
-- The approval still has to be acted on before it expires: execution_started_at
-- is set, under the same review that checks the expiry, in the transaction that
-- moves the request to EXECUTING. Once started inside that window, the purge may
-- finish after it. Every other condition is unchanged and is re-checked on every
-- batch: the owner-console operator, MFA, disabled target access, environment,
-- workspace ownership and the explicitly named workspace.
ALTER TABLE developer_account_deletions ADD COLUMN execution_started_at TIMESTAMPTZ;
ALTER TABLE developer_account_deletions ADD CONSTRAINT developer_account_deletions_started_in_time
 CHECK(execution_started_at IS NULL OR execution_started_at<=expires_at);

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
 AND d.status='EXECUTING' AND (d.expires_at>clock_timestamp() OR d.execution_started_at IS NOT NULL)
 AND w.id=wanted AND d.workspace_ids ? wanted
 AND d.environment=current_setting('stockchief.runtime_environment',true)
 AND ((d.authority='DEVELOPER_TEST' AND d.environment='staging'
 AND EXISTS(SELECT 1 FROM developer_account_administrators a WHERE a.account_id=d.actor_account_id))
 OR (d.authority='PLATFORM_OWNER'
 AND EXISTS(SELECT 1 FROM platform_console_operators o JOIN platform_console_mfa m ON m.account_id=o.account_id
 WHERE o.account_id=d.actor_account_id AND o.active=true AND o.role='OWNER')
 AND EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=d.target_account_id AND a.disabled_at IS NOT NULL))))
 )
$$;
