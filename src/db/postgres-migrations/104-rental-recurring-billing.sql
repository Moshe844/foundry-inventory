CREATE TABLE custody_billing_policies (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), agreement_id text NOT NULL REFERENCES custody_agreements(id),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','PAUSED','STOPPED','NEEDS_REVIEW','COMPLETE')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), interval_unit text NOT NULL CHECK(interval_unit IN ('DAY','WEEK','MONTH')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0), currency text NOT NULL, description text NOT NULL, time_zone text NOT NULL,
 tax_rate_id text, pricing_basis jsonb NOT NULL, due_days integer NOT NULL CHECK(due_days BETWEEN 0 AND 365), prorate_final boolean NOT NULL,
 max_periods integer NOT NULL CHECK(max_periods BETWEEN 1 AND 1200), max_total_minor bigint NOT NULL CHECK(max_total_minor>0),
 billed_periods integer NOT NULL DEFAULT 0 CHECK(billed_periods>=0), billed_total_minor bigint NOT NULL DEFAULT 0 CHECK(billed_total_minor>=0),
 anchor_at timestamptz, stopped_at timestamptz, next_due_at timestamptz, last_error text,
 authorized_by_user_id text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,agreement_id), CHECK(billed_periods<=max_periods), CHECK(billed_total_minor<=max_total_minor)
);
CREATE TABLE custody_billing_periods (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), policy_id text NOT NULL REFERENCES custody_billing_policies(id),
 period_index integer NOT NULL CHECK(period_index>=0), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>=0),
 total_minor bigint NOT NULL CHECK(total_minor>=0), invoice_id text REFERENCES accounting_customer_invoices(id), prorated boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,policy_id,period_index)
);
CREATE INDEX custody_billing_due ON custody_billing_policies(next_due_at,status) WHERE next_due_at IS NOT NULL;
