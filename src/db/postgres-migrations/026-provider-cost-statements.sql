-- Provider invoices are evidence, not inferred prices. Keep each imported line
-- and its allocation immutable; a corrected provider line needs a new identity.
CREATE TABLE commercial_provider_cost_statements (
 id TEXT PRIMARY KEY,
 provider TEXT NOT NULL,
 external_line_id TEXT NOT NULL,
 resource_id TEXT NOT NULL,
 period_start TIMESTAMPTZ NOT NULL,
 period_end TIMESTAMPTZ NOT NULL CHECK(period_end>period_start),
 amount_minor BIGINT NOT NULL CHECK(amount_minor>=0),
 currency TEXT NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 evidence_reference TEXT NOT NULL,
 evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 attested_by_account_id TEXT NOT NULL REFERENCES accounts(id),
 allocation_basis TEXT NOT NULL,
 source_snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(provider,external_line_id)
);
CREATE TABLE commercial_provider_cost_allocations (
 statement_id TEXT NOT NULL REFERENCES commercial_provider_cost_statements(id),
 account_id TEXT NOT NULL REFERENCES accounts(id),
 weight BIGINT NOT NULL CHECK(weight>0),
 amount_minor BIGINT NOT NULL CHECK(amount_minor>=0),
 PRIMARY KEY(statement_id,account_id)
);
