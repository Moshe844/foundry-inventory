CREATE INDEX import_approved_column_source ON import_plans(workspace_id,source_name,sheet_index,approved_at DESC,id DESC)
  WHERE status='SUCCEEDED' AND approval_status='APPROVED' AND records_invalid=0;
