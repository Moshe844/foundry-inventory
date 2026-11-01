-- Additive date reports can combine events within the same UTC second.
-- Keep the exact events for counts, averages, value filters and audit details.
-- IANA offsets and transitions use whole seconds, so this preserves local
-- calendar-day boundaries, including historical offsets and DST changes.
CREATE TABLE inventory_movement_second_totals(
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 occurred_second TIMESTAMPTZ NOT NULL,
 quantity_delta NUMERIC NOT NULL,
 movement_count BIGINT NOT NULL,
 PRIMARY KEY(workspace_id,occurred_second)
);
CREATE FUNCTION stockchief_add_movement_second_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO inventory_movement_second_totals AS totals(workspace_id,occurred_second,quantity_delta,movement_count)
 SELECT workspace_id,date_trunc('second',occurred_at::timestamptz,'UTC'),sum(quantity_delta),count(*)
 FROM changed_movements GROUP BY workspace_id,date_trunc('second',occurred_at::timestamptz,'UTC')
 ORDER BY workspace_id,date_trunc('second',occurred_at::timestamptz,'UTC')
 ON CONFLICT(workspace_id,occurred_second) DO UPDATE
 SET quantity_delta=totals.quantity_delta+EXCLUDED.quantity_delta,movement_count=totals.movement_count+EXCLUDED.movement_count;
 RETURN NULL;
END;
$$;
-- The trigger lock spans the backfill, so no concurrent receipt is lost or
-- included twice. Source movements retain their immutable original timestamps.
CREATE TRIGGER movement_second_totals AFTER INSERT ON movements
 REFERENCING NEW TABLE AS changed_movements FOR EACH STATEMENT EXECUTE FUNCTION stockchief_add_movement_second_totals();
INSERT INTO inventory_movement_second_totals(workspace_id,occurred_second,quantity_delta,movement_count)
 SELECT workspace_id,date_trunc('second',occurred_at::timestamptz,'UTC'),sum(quantity_delta),count(*)
 FROM movements GROUP BY workspace_id,date_trunc('second',occurred_at::timestamptz,'UTC');
