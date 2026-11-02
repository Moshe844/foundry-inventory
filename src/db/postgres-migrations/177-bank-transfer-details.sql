-- The bank details a business gives customers who pay by transfer. Shown on
-- the order page when a payment is collected by bank transfer; nothing here
-- moves money or is used to reconcile.
CREATE TABLE IF NOT EXISTS workspace_bank_transfer_details (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  bank_name TEXT,
  account_name TEXT NOT NULL,
  routing_number TEXT,
  account_number TEXT NOT NULL,
  note TEXT,
  updated_by_user_id TEXT,
  updated_at TEXT NOT NULL
);
