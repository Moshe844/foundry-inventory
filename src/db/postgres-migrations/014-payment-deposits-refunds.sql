ALTER TABLE payment_provider_events
  ADD COLUMN IF NOT EXISTS external_payment_id text;

ALTER TABLE payment_provider_events
  ADD COLUMN IF NOT EXISTS external_refund_id text;

CREATE TABLE IF NOT EXISTS payment_refund_requests (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_return_id text NOT NULL REFERENCES customer_returns(id) ON DELETE RESTRICT,
  payment_request_id text NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  external_payment_id text NOT NULL,
  external_refund_id text,
  accounting_refund_id text REFERENCES accounting_sale_refunds(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SUCCEEDED','FAILED','REVIEW')),
  last_error text,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(workspace_id,customer_return_id),
  UNIQUE(workspace_id,provider,external_refund_id)
);

CREATE INDEX IF NOT EXISTS payment_refund_requests_provider_work
  ON payment_refund_requests(workspace_id,provider,status,updated_at)
  WHERE status IN ('PENDING','REVIEW');

CREATE INDEX IF NOT EXISTS payment_provider_events_external_payment
  ON payment_provider_events(workspace_id,provider,external_payment_id)
  WHERE external_payment_id IS NOT NULL;
