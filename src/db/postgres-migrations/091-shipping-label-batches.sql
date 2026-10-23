CREATE TABLE shipping_label_batches (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,currency TEXT NOT NULL,approved_amount_minor BIGINT NOT NULL CHECK(approved_amount_minor>=0),
 created_by_user_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,idempotency_key)
);
CREATE TABLE shipping_label_batch_items (
 batch_id TEXT NOT NULL,workspace_id TEXT NOT NULL,shipment_id TEXT NOT NULL,rate_id TEXT NOT NULL,
 transaction_id TEXT NOT NULL REFERENCES shipping_label_transactions(id),effect_id TEXT NOT NULL,
 quoted_amount_minor BIGINT NOT NULL CHECK(quoted_amount_minor>=0),
 PRIMARY KEY(batch_id,shipment_id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES shipping_label_batches(workspace_id,id),
 FOREIGN KEY(shipment_id) REFERENCES sales_shipments(id)
);
