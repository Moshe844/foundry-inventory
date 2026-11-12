-- Bin corrections now also start from evidence: a staff scan-and-count or
-- two counts showing stock recorded in one bin and found in another (the
-- records follow the stock), or a put-away scanned to another bin than
-- planned (staff move the goods to the planned bin). Corrections the owner
-- must see first wait as proposals, and a records-only correction can be
-- undone through a reverse bin transfer.
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='stockchief_runtime.agent_bin_corrections'::regclass AND contype='c' LOOP
  EXECUTE format('ALTER TABLE stockchief_runtime.agent_bin_corrections DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE stockchief_runtime.agent_bin_corrections
 ALTER COLUMN transfer_id DROP NOT NULL,
 ADD COLUMN kind text NOT NULL DEFAULT 'MOVE',
 ADD COLUMN evidence jsonb,
 ADD COLUMN undo_transfer_id text UNIQUE REFERENCES inventory_transfers(id),
 ADD COLUMN undone_by text REFERENCES users(id),
 ADD COLUMN undone_at timestamptz,
 ADD CONSTRAINT agent_bin_correction_kind CHECK(kind IN ('MOVE','RECORD')),
 ADD CONSTRAINT agent_bin_correction_status CHECK(status IN ('PROPOSED','OPEN','SCANNED','COMPLETED','CANCELLED','UNDONE')),
 ADD CONSTRAINT agent_bin_correction_plan CHECK(scanned_plan IS NULL OR scanned_plan IN ('pro','enterprise')),
 ADD CONSTRAINT agent_bin_correction_scan CHECK(status IN ('PROPOSED','OPEN','CANCELLED') OR (scanned_by IS NOT NULL AND scan_proof IS NOT NULL AND scanned_at IS NOT NULL AND scanned_plan IS NOT NULL)),
 ADD CONSTRAINT agent_bin_correction_recovery CHECK(NOT manual_recovery OR (status IN ('COMPLETED','UNDONE') AND NOT automatic)),
 ADD CONSTRAINT agent_bin_correction_completion CHECK(status NOT IN ('COMPLETED','UNDONE') OR (out_movement_id IS NOT NULL AND in_movement_id IS NOT NULL AND completed_at IS NOT NULL)),
 ADD CONSTRAINT agent_bin_correction_reservation CHECK(status IN ('PROPOSED','CANCELLED') OR transfer_id IS NOT NULL),
 ADD CONSTRAINT agent_bin_correction_undo CHECK(status<>'UNDONE' OR (kind='RECORD' AND undo_transfer_id IS NOT NULL AND undone_by IS NOT NULL AND undone_at IS NOT NULL));
CREATE INDEX agent_bin_correction_undone_by ON stockchief_runtime.agent_bin_corrections(undone_by) WHERE undone_by IS NOT NULL;
CREATE INDEX agent_bin_correction_waiting ON stockchief_runtime.agent_bin_corrections(workspace_id,created_at DESC) WHERE status IN ('PROPOSED','OPEN','SCANNED');
ALTER TABLE stockchief_runtime.agent_bin_correction_settings
 ADD COLUMN maximum_value_minor bigint CHECK(maximum_value_minor IS NULL OR maximum_value_minor>0),
 ADD COLUMN currency text,
 ADD CONSTRAINT agent_bin_correction_value_currency CHECK(maximum_value_minor IS NULL OR currency IS NOT NULL);
