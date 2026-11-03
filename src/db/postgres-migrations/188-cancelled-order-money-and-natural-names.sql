-- A cancelled order's money and parcels, and product names in number order.

-- Parcels left open by an order that was cancelled. A saved label still needs a
-- person to void it, so those stay as they are.
UPDATE sales_shipments s SET status='CANCELLED',
  updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM sales_orders o
WHERE o.workspace_id=s.workspace_id AND o.id=s.sales_order_id AND o.status='CANCELLED'
  AND s.status IN ('PICKING','PACKED') AND s.customer_return_id IS NULL
  AND coalesce(s.label_status,'') NOT IN ('PURCHASED','PENDING','REVIEW','VOID_PENDING')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.provider_packages) package WHERE package->>'externalLabel'='true');

-- A deposit handed back after its order was cancelled.
CREATE TABLE accounting_deposit_refunds (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sales_order_id TEXT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount_minor BIGINT NOT NULL CHECK (amount_minor>0),
  currency TEXT NOT NULL,
  refund_date TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  journal_entry_id TEXT NOT NULL REFERENCES accounting_journal_entries(id),
  source_key TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id,source_key)
);
CREATE INDEX idx_deposit_refunds_order ON accounting_deposit_refunds(workspace_id,sales_order_id);

-- "Item 2" before "Item 10". Without ICU the name order is unchanged, never an error.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_collation WHERE collprovider='i') THEN
    EXECUTE 'CREATE COLLATION stockchief_natural (provider=icu,locale=''und-u-kn-true'')';
  ELSE
    EXECUTE 'CREATE COLLATION stockchief_natural FROM "default"';
  END IF;
END $$;
CREATE INDEX idx_items_workspace_natural_name ON items(workspace_id,name COLLATE stockchief_natural,id);
