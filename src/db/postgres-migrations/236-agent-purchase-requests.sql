CREATE TABLE stockchief_runtime.purchase_requests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by text NOT NULL REFERENCES users(id),
  request_key text NOT NULL,
  sku_id text NOT NULL REFERENCES skus(id),
  location_id text NOT NULL REFERENCES locations(id),
  quantity numeric NOT NULL CHECK(quantity>0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','DECLINED')),
  decided_by text REFERENCES users(id),
  purchase_order_id text UNIQUE REFERENCES purchase_orders(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE(workspace_id,requested_by,request_key),
  CHECK ((status='APPROVED')=(purchase_order_id IS NOT NULL))
);
CREATE INDEX purchase_request_inbox ON stockchief_runtime.purchase_requests(workspace_id,status,created_at);
ALTER TABLE accounting_supplier_bills ADD COLUMN agreed_discount_terms text;
