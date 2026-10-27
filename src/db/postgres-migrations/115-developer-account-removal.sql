CREATE TABLE developer_account_administrators (account_id TEXT PRIMARY KEY REFERENCES accounts(id),granted_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE developer_account_deletions (
 id TEXT PRIMARY KEY,
 actor_account_id TEXT NOT NULL REFERENCES accounts(id),
 target_account_id TEXT NOT NULL,
 email_digest TEXT NOT NULL,
 review_hash TEXT NOT NULL,
 workspace_ids JSONB NOT NULL,
 environment TEXT NOT NULL CHECK(environment='staging'),
 status TEXT NOT NULL CHECK(status IN ('QUEUED','EXECUTING','COMPLETED')),
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 completed_at TIMESTAMPTZ
);
CREATE TABLE commercial_deleted_ai_receipts (
 receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('native','model_hold')),
 receipt_id TEXT NOT NULL,
 funding_workspace_id TEXT NOT NULL,
 charged_micro_usd BIGINT NOT NULL CHECK(charged_micro_usd>=0),
 retained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(receipt_kind,receipt_id)
);
CREATE INDEX deleted_ai_receipts_funding ON commercial_deleted_ai_receipts(funding_workspace_id);
CREATE OR REPLACE FUNCTION stockchief_workspace_purge_allowed(wanted TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
 SELECT coalesce(current_setting('stockchief.purge_workspace',true)=wanted,false) AND (
 EXISTS (
 SELECT 1 FROM commercial_subscription_refund_retention r JOIN workspaces w ON w.owner_account_id=r.account_id
 JOIN commercial_stripe_refunds f ON f.id=r.refund_id JOIN account_subscriptions s ON s.account_id=r.account_id
 WHERE w.id=wanted AND r.workspace_ids ? wanted AND f.status='succeeded' AND r.status='READ_ONLY'
 AND r.cancellation_confirmed_at IS NOT NULL AND r.delete_after<=clock_timestamp() AND r.refunded_at<=clock_timestamp()-interval '720 hours'
 AND s.stripe_subscription_id=r.stripe_subscription_id AND s.refunded_at IS NOT NULL)
 OR (
 current_setting('stockchief.runtime_environment',true)='staging' AND EXISTS (
 SELECT 1 FROM developer_account_deletions d JOIN developer_account_administrators a ON a.account_id=d.actor_account_id
 JOIN workspaces w ON w.owner_account_id=d.target_account_id
 WHERE d.id=current_setting('stockchief.developer_purge_request',true) AND d.environment='staging'
 AND d.status='EXECUTING' AND d.expires_at>clock_timestamp() AND w.id=wanted AND d.workspace_ids ? wanted)))
$$;
