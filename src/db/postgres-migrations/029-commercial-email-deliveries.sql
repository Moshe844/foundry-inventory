-- Durable acceptance receipts plus a bounded provider-idempotency retry window.
CREATE TABLE commercial_email_deliveries (
 job_id TEXT PRIMARY KEY REFERENCES stockchief_runtime.jobs(id),
 payload_sha256 TEXT NOT NULL,
 first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 provider_id TEXT,
 accepted_attempt INTEGER CHECK(accepted_attempt>0),
 accepted_at TIMESTAMPTZ
);
