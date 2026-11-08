-- Journal numbering is an atomic allocation, not a repeated history scan.
-- Keep the existing journal lock during rolling upgrades. The statement-level
-- trigger also advances the counter for the preceding deployed writer.
-- CREATE TRIGGER takes the write-excluding table lock before the backfill.
-- READ COMMITTED migration snapshots see preceding inserts after that lock.
-- Backfill and trigger become visible together when the migration commits.
CREATE FUNCTION stockchief_capture_journal_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.business_number_counters AS saved(workspace_id,kind,prefix,last_number)
 SELECT workspace_id,'accounting_journal_entries','JE',greatest(0,max(entry_number)) FROM journal_number_rows GROUP BY workspace_id
 ON CONFLICT(workspace_id,kind,prefix) DO UPDATE SET last_number=EXCLUDED.last_number
 WHERE saved.last_number<EXCLUDED.last_number;
 RETURN NULL;
END $$;
CREATE TRIGGER capture_journal_number AFTER INSERT ON accounting_journal_entries
 REFERENCING NEW TABLE AS journal_number_rows FOR EACH STATEMENT
 EXECUTE FUNCTION stockchief_capture_journal_number();

INSERT INTO stockchief_runtime.business_number_counters AS saved(workspace_id,kind,prefix,last_number)
 SELECT workspace_id,'accounting_journal_entries','JE',greatest(0,max(entry_number)) FROM accounting_journal_entries GROUP BY workspace_id
 ON CONFLICT(workspace_id,kind,prefix) DO UPDATE SET last_number=EXCLUDED.last_number
 WHERE saved.last_number<EXCLUDED.last_number;
