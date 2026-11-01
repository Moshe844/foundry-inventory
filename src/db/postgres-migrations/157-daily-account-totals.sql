-- Transactional read model of immutable posted journal lines. The original
-- entries and lines remain the source for all document and audit evidence.
CREATE TABLE accounting_daily_account_totals(
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL,
 posting_date TEXT NOT NULL,
 currency TEXT NOT NULL,
 debit_minor NUMERIC NOT NULL,
 credit_minor NUMERIC NOT NULL,
 line_count BIGINT NOT NULL CHECK(line_count>0),
 PRIMARY KEY(workspace_id,account_id,posting_date,currency)
);
CREATE FUNCTION stockchief_add_daily_journal_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO accounting_daily_account_totals(workspace_id,account_id,posting_date,currency,debit_minor,credit_minor,line_count)
 SELECT l.workspace_id,l.account_id,e.posting_date,l.currency,sum(l.debit_minor),sum(l.credit_minor),count(*)
 FROM changed_journal_lines l JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id
 WHERE e.status='POSTED' GROUP BY l.workspace_id,l.account_id,e.posting_date,l.currency
 ORDER BY l.workspace_id,l.account_id,e.posting_date,l.currency
 ON CONFLICT(workspace_id,account_id,posting_date,currency) DO UPDATE
 SET debit_minor=accounting_daily_account_totals.debit_minor+EXCLUDED.debit_minor,
 credit_minor=accounting_daily_account_totals.credit_minor+EXCLUDED.credit_minor,
 line_count=accounting_daily_account_totals.line_count+EXCLUDED.line_count;
 RETURN NULL;
END;
$$;
-- Trigger creation locks the source against concurrent inserts through the
-- backfill transaction, so each existing or new line contributes exactly once.
CREATE TRIGGER daily_journal_totals AFTER INSERT ON accounting_journal_lines
 REFERENCING NEW TABLE AS changed_journal_lines FOR EACH STATEMENT EXECUTE FUNCTION stockchief_add_daily_journal_totals();
INSERT INTO accounting_daily_account_totals(workspace_id,account_id,posting_date,currency,debit_minor,credit_minor,line_count)
 SELECT l.workspace_id,l.account_id,e.posting_date,l.currency,sum(l.debit_minor),sum(l.credit_minor),count(*)
 FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id
 WHERE e.status='POSTED' GROUP BY l.workspace_id,l.account_id,e.posting_date,l.currency;
