-- Reserve immutable number ranges before independent stock batches begin.
-- Canonical journals and balanced posting checks remain unchanged.
CREATE UNIQUE INDEX import_plans_workspace_identity ON import_plans(workspace_id,id);
CREATE TABLE import_journal_reservations(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 import_id text NOT NULL,
 approval_hash text NOT NULL,
 start_number bigint NOT NULL CHECK(start_number>0),
 number_count integer NOT NULL CHECK(number_count>0),
 posting_date text NOT NULL,
 period_id text NOT NULL REFERENCES accounting_periods(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,import_id),
 FOREIGN KEY(workspace_id,import_id) REFERENCES import_plans(workspace_id,id) ON DELETE CASCADE,
 CHECK(start_number+number_count-1<=9007199254740991)
);
CREATE TRIGGER immutable_import_journal_reservation BEFORE UPDATE ON import_journal_reservations
 FOR EACH ROW EXECUTE FUNCTION stockchief_forbid_change('Approved import journal numbers cannot be changed.');
INSERT INTO commercial_storage_tables(relation,bytes_expression)
 VALUES('import_journal_reservations'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'import_journal_reservations'::regclass,true FROM workspaces;

-- ON CONFLICT ... WHERE still locks its conflicting row. A reserved header
-- is already below a committed counter, so omit that row before the upsert.
-- Unreserved legacy inserts still advance the counter atomically.
CREATE OR REPLACE FUNCTION stockchief_capture_journal_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO stockchief_runtime.business_number_counters AS saved(workspace_id,kind,prefix,last_number)
 SELECT n.workspace_id,'accounting_journal_entries','JE',n.last_number
 FROM(SELECT workspace_id,greatest(0,max(entry_number)) last_number FROM journal_number_rows GROUP BY workspace_id)n
 LEFT JOIN stockchief_runtime.business_number_counters c ON c.workspace_id=n.workspace_id AND c.kind='accounting_journal_entries' AND c.prefix='JE'
 WHERE c.last_number IS NULL OR c.last_number<n.last_number
 ON CONFLICT(workspace_id,kind,prefix) DO UPDATE SET last_number=EXCLUDED.last_number
 WHERE saved.last_number<EXCLUDED.last_number;
 RETURN NULL;
END $$;
