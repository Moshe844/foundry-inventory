CREATE TABLE shipping_receipt_reviews (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 shipment_id TEXT NOT NULL REFERENCES sales_shipments(id),
 transaction_id TEXT NOT NULL REFERENCES shipping_label_transactions(id),
 effect_id TEXT NOT NULL REFERENCES stockchief_runtime.provider_effects(id),
 job_id TEXT NOT NULL REFERENCES stockchief_runtime.jobs(id),
 fingerprint TEXT NOT NULL,
 amount_minor BIGINT NOT NULL CHECK(amount_minor>=0),
 currency TEXT NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 UNIQUE(workspace_id,effect_id,fingerprint)
);
