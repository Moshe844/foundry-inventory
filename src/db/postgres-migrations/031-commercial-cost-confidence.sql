-- A monetary estimate is useful for provisional pricing, but must never be
-- indistinguishable from an invoice or a dated provider contract.
ALTER TABLE commercial_cost_rates ADD COLUMN pricing_basis TEXT NOT NULL DEFAULT 'UNVERIFIED'
 CHECK(pricing_basis IN ('UNVERIFIED','VERIFIED_PUBLIC','VERIFIED_CONTRACT','CONSERVATIVE_ESTIMATE'));
ALTER TABLE commercial_cost_rates ADD COLUMN confidence TEXT NOT NULL DEFAULT 'LOW'
 CHECK(confidence IN ('LOW','MEDIUM','HIGH'));
UPDATE commercial_cost_rates SET pricing_basis='VERIFIED_PUBLIC',confidence='HIGH'
 WHERE id LIKE 'public-anthropic-2026-10-05:%'
   AND source LIKE 'Verified 2026-10-05:%';

-- Failed schema/interpretation attempts still incur provider token costs even
-- when customer credits are reversed. A durable per-account ceiling prevents
-- indefinitely repeating those free-to-the-customer attempts across workers.
CREATE TABLE commercial_model_daily_attempts (
 account_id TEXT NOT NULL REFERENCES accounts(id),
 day DATE NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0 AND failures<=attempts),
 PRIMARY KEY(account_id,day)
);
