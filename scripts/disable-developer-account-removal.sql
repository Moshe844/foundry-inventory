-- Operational rollback: disable developer removals and restore the original immutable-record guard.
-- Retain removal audit and anonymous AI receipts. This never restores deleted test data.
BEGIN;
DELETE FROM developer_account_administrators;
CREATE OR REPLACE FUNCTION stockchief_workspace_purge_allowed(wanted TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
 SELECT coalesce(current_setting('stockchief.purge_workspace',true)=wanted,false) AND EXISTS (
 SELECT 1 FROM commercial_subscription_refund_retention r JOIN workspaces w ON w.owner_account_id=r.account_id
 JOIN commercial_stripe_refunds f ON f.id=r.refund_id JOIN account_subscriptions s ON s.account_id=r.account_id
 WHERE w.id=wanted AND r.workspace_ids ? wanted AND f.status='succeeded' AND r.status='READ_ONLY'
 AND r.cancellation_confirmed_at IS NOT NULL AND r.delete_after<=clock_timestamp() AND r.refunded_at<=clock_timestamp()-interval '720 hours'
 AND s.stripe_subscription_id=r.stripe_subscription_id AND s.refunded_at IS NOT NULL)
$$;
COMMIT;
