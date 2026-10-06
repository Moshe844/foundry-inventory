-- Dollar exposure is bounded independently of customer-facing credit weights.
-- Unverified outcomes retain their worst-case hold until reconciled.
CREATE TABLE commercial_model_cost_holds (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 idempotency_key TEXT NOT NULL,
 period_start TIMESTAMPTZ NOT NULL,
 period_end TIMESTAMPTZ NOT NULL,
 model TEXT NOT NULL,
 provider TEXT NOT NULL,
 operation TEXT NOT NULL,
 maximum_minor NUMERIC(20,6) NOT NULL CHECK(maximum_minor>0),
 actual_minor NUMERIC(20,6) CHECK(actual_minor>=0),
 status TEXT NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','SETTLED','UNKNOWN','RELEASED')),
 detail JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 settled_at TIMESTAMPTZ,
 UNIQUE(account_id,idempotency_key)
);
CREATE INDEX commercial_model_cost_holds_account_period
 ON commercial_model_cost_holds(account_id,period_start,status);
CREATE INDEX commercial_model_cost_holds_workspace_period
 ON commercial_model_cost_holds(workspace_id,period_start,status);
