-- Match the complete scoped keyset and ordering used by frozen import pages.
-- Include the tie-breaker so row locks do not require sorting every raw row.
CREATE INDEX IF NOT EXISTS idx_import_rows_scope_cursor
  ON import_rows(workspace_id,import_id,row_number,id);
