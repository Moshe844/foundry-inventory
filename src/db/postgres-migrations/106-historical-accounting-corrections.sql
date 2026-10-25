CREATE TABLE accounting_history_corrections (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id),
 source_entry_id text NOT NULL REFERENCES accounting_journal_entries(id),
 kind text NOT NULL CHECK(kind IN ('calendar','pending_return_cost')),
 target_date text NOT NULL,
 adjustment_entry_ids jsonb NOT NULL,
 evidence jsonb NOT NULL,
 approved_by_user_id text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,source_entry_id,kind)
);
CREATE TRIGGER accounting_history_corrections_immutable BEFORE UPDATE OR DELETE ON accounting_history_corrections
 FOR EACH ROW EXECUTE FUNCTION stockchief_forbid_change('Accounting corrections are immutable; retain the original evidence.');
