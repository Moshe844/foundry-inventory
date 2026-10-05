-- Refunds may succeed and subsequently fail. Preserve the provider state even
-- when failure arrives before success; immutable ledger entries compensate.
CREATE TABLE commercial_stripe_refunds (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id),
 purchase_id TEXT REFERENCES commercial_usage_purchases(id),
 payment_intent_id TEXT NOT NULL,
 amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
 currency TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','requires_action','succeeded','failed','canceled')),
 provider_created_at TIMESTAMPTZ NOT NULL,
 provider_event_id TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commercial_refunds_by_account ON commercial_stripe_refunds(account_id);
