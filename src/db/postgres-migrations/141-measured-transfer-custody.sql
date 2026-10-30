ALTER TABLE inventory_transfer_lines
 ADD COLUMN requested_secondary_quantity numeric,
 ADD COLUMN approved_secondary_quantity numeric,
 ADD COLUMN shipped_secondary_quantity numeric,
 ADD COLUMN received_secondary_quantity numeric NOT NULL DEFAULT 0,
 ADD COLUMN lost_secondary_quantity numeric NOT NULL DEFAULT 0,
 ADD COLUMN damaged_secondary_quantity numeric NOT NULL DEFAULT 0;
