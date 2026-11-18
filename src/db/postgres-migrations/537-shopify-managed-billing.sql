CREATE TABLE commercial_shopify_subscriptions (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 app_id TEXT NOT NULL,
 shop_id TEXT NOT NULL,
 shop TEXT NOT NULL,
 app_handle TEXT NOT NULL,
 development_store BOOLEAN NOT NULL DEFAULT false,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','ACTIVE','CANCELLED','SUSPENDED')),
 plan_id TEXT REFERENCES commercial_plans(id),
 reserved_until TIMESTAMPTZ,
 verified_at TIMESTAMPTZ,
 first_subscription_at TIMESTAMPTZ,
 provider_state JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(app_id,shop_id), UNIQUE(app_id,shop)
);
CREATE INDEX commercial_shopify_reconcile_idx ON commercial_shopify_subscriptions(verified_at,account_id) WHERE status='ACTIVE';
CREATE TABLE commercial_shopify_guarantees (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES commercial_shopify_subscriptions(account_id),
 requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK(status IN('REQUESTED','AWAITING_SHOPIFY','PARTIAL','REFUNDED','NO_CHARGE','REVIEW')),
 subscription_started_at TIMESTAMPTZ NOT NULL,
 charges JSONB NOT NULL DEFAULT '[]',
 provider_evidence JSONB NOT NULL DEFAULT '[]',
 last_error TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(account_id)
);
