ALTER TABLE shipping_label_transactions ADD COLUMN purchase_transaction_id TEXT REFERENCES shipping_label_transactions(id);
ALTER TABLE shipping_label_transactions ADD COLUMN refund_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED'
  CHECK (refund_status IN ('NOT_REQUESTED','PENDING','CONFIRMED','REJECTED','UNKNOWN'));
CREATE UNIQUE INDEX shipping_one_unresolved_void_per_purchase ON shipping_label_transactions(workspace_id,purchase_transaction_id)
  WHERE operation='VOID' AND status IN ('PENDING','SUCCEEDED','REVIEW');
