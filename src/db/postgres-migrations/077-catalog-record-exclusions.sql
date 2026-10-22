-- Provider eligibility is distinct from an owner's deliberate exclusion.
-- A changed provider record can become eligible again on a later sync.
ALTER TABLE connection_external_records
  DROP CONSTRAINT IF EXISTS connection_external_records_mapping_status_check;
ALTER TABLE connection_external_records
  ADD CONSTRAINT connection_external_records_mapping_status_check
  CHECK (mapping_status IN ('UNMAPPED','MAPPED','IGNORED','EXCLUDED'));
