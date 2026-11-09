CREATE TABLE stockchief_runtime.agent_bin_corrections (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 request_key text NOT NULL,
 transfer_id text NOT NULL UNIQUE REFERENCES inventory_transfers(id),
 source jsonb NOT NULL,
 fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','SCANNED','COMPLETED','CANCELLED')),
 opened_by text NOT NULL REFERENCES users(id),
 scanned_by text REFERENCES users(id),
 scan_proof jsonb,
 scanned_at timestamptz,
 scanned_plan text CHECK(scanned_plan IN ('pro','enterprise')),
 approved_by text REFERENCES users(id),
 automatic boolean NOT NULL DEFAULT false,
 manual_recovery boolean NOT NULL DEFAULT false,
 out_movement_id text UNIQUE REFERENCES movements(id),
 in_movement_id text UNIQUE REFERENCES movements(id),
 problem text,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(workspace_id,request_key),
 CHECK(status IN ('OPEN','CANCELLED') OR (scanned_by IS NOT NULL AND scan_proof IS NOT NULL AND scanned_at IS NOT NULL AND scanned_plan IS NOT NULL)),
 CHECK(NOT manual_recovery OR (status='COMPLETED' AND NOT automatic)),
 CHECK(status<>'COMPLETED' OR (out_movement_id IS NOT NULL AND in_movement_id IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX agent_bin_correction_inventory ON stockchief_runtime.agent_bin_corrections(workspace_id,created_at DESC,id);
CREATE INDEX agent_bin_correction_completed ON stockchief_runtime.agent_bin_corrections(workspace_id,completed_at) WHERE status='COMPLETED' AND NOT manual_recovery;
CREATE INDEX agent_bin_correction_opened_by ON stockchief_runtime.agent_bin_corrections(opened_by);
CREATE INDEX agent_bin_correction_scanned_by ON stockchief_runtime.agent_bin_corrections(scanned_by);
CREATE INDEX agent_bin_correction_approved_by ON stockchief_runtime.agent_bin_corrections(approved_by);
CREATE TABLE stockchief_runtime.agent_bin_correction_settings (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 maximum_units integer NOT NULL CHECK(maximum_units BETWEEN 1 AND 100000),
 authorized_by text NOT NULL REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE INDEX agent_bin_correction_setting_owner ON stockchief_runtime.agent_bin_correction_settings(authorized_by);
CREATE TABLE stockchief_runtime.agent_bin_correction_rules (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 scope_hash text NOT NULL,
 scope jsonb NOT NULL,
 maximum_units integer NOT NULL CHECK(maximum_units BETWEEN 1 AND 100000),
 authorized_by text NOT NULL REFERENCES users(id),
 example_id text NOT NULL REFERENCES stockchief_runtime.agent_bin_corrections(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 PRIMARY KEY(workspace_id,scope_hash)
);
CREATE INDEX agent_bin_correction_rule_owner ON stockchief_runtime.agent_bin_correction_rules(authorized_by);
CREATE INDEX agent_bin_correction_rule_example ON stockchief_runtime.agent_bin_correction_rules(example_id);
CREATE INDEX agent_bin_correction_rule_sku ON stockchief_runtime.agent_bin_correction_rules(workspace_id,(scope->>'skuId'));
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_bin_corrections'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_bin_correction_settings'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_bin_correction_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_bin_corrections'::regclass,'stockchief_runtime.agent_bin_correction_settings'::regclass,'stockchief_runtime.agent_bin_correction_rules'::regclass]) r;
ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction'));
-- Older application instances must not release or dispatch a reservation
-- owned by a newer scanned correction while versions overlap in a rollout.
CREATE FUNCTION stockchief_runtime.guard_bin_correction_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE correction record;
BEGIN
 SELECT b.id,b.status INTO correction FROM stockchief_runtime.agent_bin_corrections b
 JOIN public.workspaces w ON w.id=b.workspace_id AND w.deletion_requested_at IS NULL
 WHERE b.workspace_id=NEW.workspace_id AND b.transfer_id=NEW.id AND b.status IN ('OPEN','SCANNED');
 IF FOUND THEN
  IF NEW.status='CANCELLED' AND correction.status='SCANNED' THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='This bin correction already has physical movement evidence. Review and settle its original correction.';
  END IF;
  IF current_setting('stockchief.bin_correction_id',true) IS DISTINCT FROM correction.id THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Use the original bin correction to change its reserved stock.';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_bin_correction_reservation BEFORE UPDATE OF status ON inventory_transfers
 FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
 EXECUTE FUNCTION stockchief_runtime.guard_bin_correction_reservation();
