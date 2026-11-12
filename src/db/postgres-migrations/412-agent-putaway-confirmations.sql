-- Put-away plans now record who chose the bin and how much staff have put
-- away. Each staff confirmation is one ordinary bin transfer.
ALTER TABLE stockchief_runtime.agent_putaway_instructions
 ADD COLUMN status text NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','PUT_AWAY')),
 ADD COLUMN chosen_by text NOT NULL DEFAULT 'owner' CHECK(chosen_by IN ('owner','rule','agent')),
 ADD COLUMN reason text,
 ADD COLUMN put_away_quantity numeric NOT NULL DEFAULT 0 CHECK(put_away_quantity>=0),
 ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
CREATE TABLE stockchief_runtime.agent_putaway_confirmations (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 instruction_id text NOT NULL REFERENCES stockchief_runtime.agent_putaway_instructions(id) ON DELETE CASCADE,
 request_key text NOT NULL,
 transfer_id text NOT NULL UNIQUE REFERENCES inventory_transfers(id),
 location_id text NOT NULL REFERENCES locations(id),
 planned_location_id text NOT NULL REFERENCES locations(id),
 quantity numeric NOT NULL CHECK(quantity>0),
 secondary_quantity numeric CHECK(secondary_quantity IS NULL OR secondary_quantity>0),
 lot_id text REFERENCES lots(id),
 serial_unit_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
 method text NOT NULL CHECK(method IN ('scan','tap')),
 confirmed_by text NOT NULL REFERENCES users(id),
 approved_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_putaway_confirmation_instruction ON stockchief_runtime.agent_putaway_confirmations(instruction_id,created_at);
CREATE INDEX agent_putaway_confirmation_location ON stockchief_runtime.agent_putaway_confirmations(location_id);
CREATE INDEX agent_putaway_confirmation_planned ON stockchief_runtime.agent_putaway_confirmations(planned_location_id);
CREATE INDEX agent_putaway_confirmation_lot ON stockchief_runtime.agent_putaway_confirmations(lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX agent_putaway_confirmation_staff ON stockchief_runtime.agent_putaway_confirmations(confirmed_by);
CREATE INDEX agent_putaway_confirmation_approver ON stockchief_runtime.agent_putaway_confirmations(approved_by);
-- A receipt the agent could not place waits here for a person, and is
-- retried later instead of blocking newer receipts.
CREATE TABLE stockchief_runtime.agent_putaway_holds (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 receipt_line_id text NOT NULL REFERENCES purchase_order_receipt_lines(id) ON DELETE CASCADE,
 problem text NOT NULL,
 retry_after timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,receipt_line_id)
);
CREATE INDEX agent_putaway_hold_line ON stockchief_runtime.agent_putaway_holds(receipt_line_id);
-- Routine work starts from the moment the owner granted it, so turning a job
-- on never reaches back over older records.
ALTER TABLE stockchief_runtime.agent_job_modes ADD COLUMN changed_at timestamptz NOT NULL DEFAULT now();
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_putaway_confirmations'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_putaway_holds'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN ('stockchief_runtime.agent_putaway_confirmations'::regclass,'stockchief_runtime.agent_putaway_holds'::regclass);
