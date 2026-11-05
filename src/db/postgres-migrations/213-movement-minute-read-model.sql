-- Canonical movements stay immutable. Each transaction owns its own delta
-- rows, avoiding a shared business/day counter in the stock write path.
CREATE TABLE stockchief_runtime.movement_bucket_state(
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 initialized boolean NOT NULL DEFAULT false
);
CREATE TABLE stockchief_runtime.movement_buckets(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 bucket_at timestamptz NOT NULL,
 quantity_delta numeric NOT NULL,
 PRIMARY KEY(workspace_id,bucket_at)
);
CREATE TABLE stockchief_runtime.movement_bucket_pending(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 bucket_at timestamptz NOT NULL,
 change_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 quantity_delta numeric NOT NULL,
 PRIMARY KEY(workspace_id,bucket_at,change_xid)
);
CREATE INDEX movement_bucket_pending_oldest ON stockchief_runtime.movement_bucket_pending(workspace_id,change_xid,bucket_at);
ALTER TABLE stockchief_runtime.movement_bucket_pending SET(autovacuum_vacuum_scale_factor=0.02,autovacuum_vacuum_insert_scale_factor=0.02,autovacuum_analyze_scale_factor=0.02);
CREATE FUNCTION stockchief_queue_movement_bucket() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.movement_bucket_pending(workspace_id,bucket_at,quantity_delta)
 SELECT m.workspace_id,date_bin('1 minute',stockchief_movement_instant(m.occurred_at),'2000-01-01 00:00:00+00'::timestamptz),sum(m.quantity_delta)
 FROM new_movements m JOIN workspaces w ON w.id=m.workspace_id
 WHERE stockchief_movement_instant(m.occurred_at) IS NOT NULL GROUP BY 1,2
 ON CONFLICT(workspace_id,bucket_at,change_xid) DO UPDATE SET quantity_delta=stockchief_runtime.movement_bucket_pending.quantity_delta+EXCLUDED.quantity_delta;
 RETURN NULL;
END $$;
CREATE TRIGGER zz_movement_bucket_capture AFTER INSERT ON movements
 REFERENCING NEW TABLE AS new_movements FOR EACH STATEMENT EXECUTE FUNCTION stockchief_queue_movement_bucket();
-- Historical initialization belongs to the bounded worker, not this migration
-- or the serializable runtime sweep. Until then, readers use canonical history.
INSERT INTO stockchief_runtime.movement_bucket_state(workspace_id) SELECT id FROM workspaces;
