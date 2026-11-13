-- Each unstarted root scan reads current claims, so one active scan can cover
-- every redundant root scan for the same inventory. Preserve all continuations
-- and any scan with an execution attempt or a scheduled retry.
WITH scans AS (
  SELECT id,workspace_id,status,attempt_count,payload,
    row_number() OVER (PARTITION BY workspace_id ORDER BY
      CASE WHEN status IN ('RUNNING','RETRY') OR attempt_count>0 THEN 0
           WHEN payload ? 'afterId' THEN 1 ELSE 2 END,created_at,id) AS position
  FROM stockchief_runtime.jobs
  WHERE kind='agent.supplier-claims' AND workspace_id IS NOT NULL
    AND status IN ('PENDING','RUNNING','RETRY')
), cancelled AS (
  UPDATE stockchief_runtime.jobs j
  SET status='CANCELLED',updated_at=now(),completed_at=now(),
    result=jsonb_build_object('skipped','duplicate supplier claim scan')
  FROM scans s WHERE j.id=s.id AND s.position>1 AND j.status='PENDING'
    AND j.attempt_count=0 AND NOT (j.payload ? 'afterId')
  RETURNING j.id
)
INSERT INTO stockchief_runtime.job_events(id,job_id,event_type,detail,created_at)
SELECT 'supplier-scan-deduplication:'||id,id,'DUPLICATE_CANCELLED',
  jsonb_build_object('reason','duplicate supplier claim scan'),now() FROM cancelled;
