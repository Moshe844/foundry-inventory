-- Job 63: a carrier claim can now start from the carrier's own "lost" scan
-- (job 62) or a staff or customer damage report, not only from an owner's
-- upload. Parcels whose account has no claim API get a claim pack and the
-- carrier's claim steps, filed by a person. Every claim is followed until the
-- carrier pays or denies it.
ALTER TABLE stockchief_runtime.agent_carrier_claims ALTER COLUMN connector_id DROP NOT NULL;
ALTER TABLE stockchief_runtime.agent_carrier_claims
  ADD COLUMN route text NOT NULL DEFAULT 'api' CHECK (route IN ('api','portal')),
  ADD COLUMN source text NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','carrier','staff','customer')),
  ADD COLUMN filed_reference text CHECK (filed_reference IS NULL OR length(filed_reference) BETWEEN 1 AND 120),
  ADD COLUMN filed_at timestamptz,
  ADD COLUMN filed_by text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN outcome text CHECK (outcome IN ('PAID','DENIED','CANCELLED')),
  ADD COLUMN paid_minor bigint CHECK (paid_minor IS NULL OR paid_minor>=0),
  ADD COLUMN outcome_note text CHECK (outcome_note IS NULL OR length(outcome_note)<=500),
  ADD COLUMN outcome_at timestamptz,
  ADD COLUMN checked_at timestamptz,
  ADD CONSTRAINT agent_carrier_claim_route_account CHECK (route='portal' OR connector_id IS NOT NULL),
  ADD CONSTRAINT agent_carrier_claim_paid CHECK ((outcome='PAID')=(paid_minor IS NOT NULL));
CREATE INDEX agent_carrier_claim_open ON stockchief_runtime.agent_carrier_claims(workspace_id,created_at) WHERE outcome IS NULL;
CREATE INDEX agent_carrier_claim_shipment ON stockchief_runtime.agent_carrier_claims(workspace_id,shipment_id);
CREATE INDEX agent_carrier_claim_filer ON stockchief_runtime.agent_carrier_claims(filed_by) WHERE filed_by IS NOT NULL;

-- Who receives the money and the carrier's updates, and on Custom the most
-- StockChief may claim on its own.
CREATE TABLE stockchief_runtime.agent_claim_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  claimant text NOT NULL CHECK (length(claimant) BETWEEN 1 AND 150),
  contact_email text NOT NULL CHECK (length(contact_email) BETWEEN 3 AND 240),
  auto_limit_minor bigint CHECK (auto_limit_minor IS NULL OR auto_limit_minor>0),
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_claim_settings_person ON stockchief_runtime.agent_claim_settings(updated_by) WHERE updated_by IS NOT NULL;
