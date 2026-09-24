CREATE TABLE IF NOT EXISTS stockchief_runtime.inventory_movement_serial_units (
  workspace_id text NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  movement_id text NOT NULL REFERENCES public.movements(id) ON DELETE CASCADE,
  serial_unit_id text NOT NULL REFERENCES public.serial_units(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (movement_id, serial_unit_id)
);

CREATE INDEX IF NOT EXISTS inventory_movement_serial_units_serial
  ON stockchief_runtime.inventory_movement_serial_units(workspace_id, serial_unit_id, created_at DESC);

ALTER TABLE public.accounting_sale_refunds
  ADD COLUMN IF NOT EXISTS inventory_journal_entry_id text
    REFERENCES public.accounting_journal_entries(id) ON DELETE RESTRICT;
