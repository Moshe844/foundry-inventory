-- While the worker was behind, the workflow scheduler queued a new check for each
-- due item every minute, so thousands of identical checks waited. The scheduler
-- now skips items that already have a waiting check. Keep the oldest waiting
-- check per workflow item and cancel the identical ones queued after it.
UPDATE stockchief_runtime.jobs j
   SET status='CANCELLED', updated_at=now(), completed_at=now(),
       result=jsonb_build_object('skipped','duplicate workflow check')
 WHERE j.kind='workflow.follow-through'
   AND j.status='PENDING'
   AND EXISTS (
     SELECT 1 FROM stockchief_runtime.jobs o
      WHERE o.workspace_id=j.workspace_id
        AND o.kind='workflow.follow-through'
        AND o.status IN ('PENDING','RUNNING','RETRY')
        AND o.payload->>'workId'=j.payload->>'workId'
        AND (o.created_at,o.id)<(j.created_at,j.id));
