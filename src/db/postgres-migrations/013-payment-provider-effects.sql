ALTER TABLE payment_requests
  DROP CONSTRAINT IF EXISTS payment_requests_status_check;

ALTER TABLE payment_requests
  ADD CONSTRAINT payment_requests_status_check
  CHECK (status IN ('DRAFT','PENDING','OPEN','PAID','VOID','FAILED','REVIEW'));

CREATE INDEX IF NOT EXISTS payment_requests_provider_work
  ON payment_requests(workspace_id,provider,status,updated_at)
  WHERE status IN ('PENDING','REVIEW');

CREATE INDEX IF NOT EXISTS payment_requests_active_invoice
  ON payment_requests(workspace_id,provider,invoice_id,purpose)
  WHERE invoice_id IS NOT NULL AND status IN ('PENDING','OPEN','REVIEW');
