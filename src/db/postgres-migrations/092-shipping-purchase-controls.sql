ALTER TABLE shipping_label_transactions ADD COLUMN approved_amount_minor BIGINT CHECK(approved_amount_minor>=0);
CREATE TABLE shipping_purchase_limits (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),currency TEXT NOT NULL,
 per_label_minor BIGINT CHECK(per_label_minor>=0),rolling_day_minor BIGINT CHECK(rolling_day_minor>=0),
 updated_by_user_id TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL
);
CREATE TABLE shipping_purchase_limit_changes (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor_user_id TEXT NOT NULL REFERENCES users(id),
 before_value JSONB,after_value JSONB NOT NULL,created_at TEXT NOT NULL
);
ALTER TABLE shipping_rules ADD COLUMN min_weight_grams BIGINT CHECK(min_weight_grams>0);
ALTER TABLE shipping_rules ADD COLUMN max_weight_grams BIGINT CHECK(max_weight_grams>0);
ALTER TABLE shipping_rules ADD COLUMN currency TEXT;
UPDATE shipping_rules rule SET currency=settings.base_currency FROM accounting_settings settings WHERE settings.workspace_id=rule.workspace_id;
