-- Remove every attachment of the old function, including later registrations.
-- Keep the logical-byte registry and its measured customer usage intact.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT n.nspname,c.relname,g.tgname FROM pg_trigger g
 JOIN pg_class c ON c.oid=g.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE NOT g.tgisinternal AND g.tgfoid='commercial_track_storage()'::regprocedure
 LOOP EXECUTE format('DROP TRIGGER %I ON %I.%I',t.tgname,t.nspname,t.relname); END LOOP;
END $$;
DROP FUNCTION commercial_track_storage();
DROP FUNCTION commercial_check_storage(text);
UPDATE commercial_storage_usage SET baseline_bytes=greatest(0,baseline_bytes+delta_bytes-baseline_delta),delta_bytes=0,baseline_delta=0;
ALTER TABLE commercial_storage_usage ADD COLUMN measured_at timestamptz NOT NULL DEFAULT now();
-- This short row lock is used only by file/import admission and publication
-- of a measurement, never by stock movements or general business writes.
CREATE TABLE commercial_storage_admissions(account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE);
CREATE TABLE commercial_storage_reservations(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 reservation_key text NOT NULL,
 bytes bigint NOT NULL CHECK(bytes>=0),
 finished_xid xid8,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,reservation_key)
);
