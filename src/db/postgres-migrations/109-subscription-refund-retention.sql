ALTER TABLE account_subscriptions ADD COLUMN refunded_at TIMESTAMPTZ;
ALTER TABLE account_subscriptions ADD COLUMN refund_deletion_at TIMESTAMPTZ;
CREATE TABLE commercial_subscription_refund_retention (
 refund_id TEXT PRIMARY KEY REFERENCES commercial_stripe_refunds(id),
 account_id TEXT NOT NULL REFERENCES accounts(id),
 stripe_subscription_id TEXT NOT NULL,
 refunded_at TIMESTAMPTZ NOT NULL,
 delete_after TIMESTAMPTZ NOT NULL CHECK(delete_after>=refunded_at+interval '720 hours'),
 workspace_ids JSONB NOT NULL,
 cancellation_confirmed_at TIMESTAMPTZ,
 purged_at TIMESTAMPTZ,
 status TEXT NOT NULL DEFAULT 'CANCELLATION_PENDING' CHECK(status IN ('CANCELLATION_PENDING','READ_ONLY','PURGED','REVIEW')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE commercial_retained_model_receipts (
 hold_id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),provider TEXT NOT NULL,model TEXT NOT NULL,
 maximum_minor NUMERIC NOT NULL,actual_minor NUMERIC,status TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL,retained_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION stockchief_workspace_purge_allowed(wanted TEXT) RETURNS BOOLEAN LANGUAGE sql VOLATILE AS $$
 SELECT coalesce(current_setting('stockchief.purge_workspace',true)=wanted,false) AND EXISTS (
 SELECT 1 FROM commercial_subscription_refund_retention r JOIN workspaces w ON w.owner_account_id=r.account_id
 JOIN commercial_stripe_refunds f ON f.id=r.refund_id JOIN account_subscriptions s ON s.account_id=r.account_id
 WHERE w.id=wanted AND r.workspace_ids ? wanted AND f.status='succeeded' AND r.status='READ_ONLY'
 AND r.cancellation_confirmed_at IS NOT NULL AND r.delete_after<=clock_timestamp() AND r.refunded_at<=clock_timestamp()-interval '720 hours'
 AND s.stripe_subscription_id=r.stripe_subscription_id AND s.refunded_at IS NOT NULL)
$$;
CREATE OR REPLACE FUNCTION stockchief_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF TG_OP='DELETE' AND stockchief_workspace_purge_allowed(to_jsonb(OLD)->>'workspace_id') THEN RETURN OLD;END IF;
 RAISE EXCEPTION USING MESSAGE=TG_ARGV[0],ERRCODE='integrity_constraint_violation';END; $$;
CREATE OR REPLACE FUNCTION stockchief_runtime.keep_pricing_history() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF TG_OP='DELETE' AND stockchief_workspace_purge_allowed(to_jsonb(OLD)->>'workspace_id') THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Historical pricing is immutable';END; $$;

UPDATE account_subscriptions SET status='SUSPENDED',updated_at=now() WHERE source='SELF_SERVICE_TRIAL';
UPDATE accounts a SET plan='commercial_pending' WHERE EXISTS(SELECT 1 FROM account_subscriptions s WHERE s.account_id=a.id AND s.source='SELF_SERVICE_TRIAL');
