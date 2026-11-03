'use strict';

// SQL expressions supplied here are fixed source expressions, never user text.
// A funded call owned by another live goal may run in parallel. Unknown calls,
// abandoned jobs and another outstanding call in this goal still stop admission.
function blocksAdmission(call, goal) {
 return `(${call}.state='UNKNOWN' OR (${call}.state='RESERVED' AND (
  ${call}.goal_id IS NOT DISTINCT FROM ${goal} OR NOT EXISTS (
   SELECT 1 FROM stockchief_runtime.jobs live_job
   WHERE live_job.workspace_id=${call}.workspace_id
    AND live_job.kind IN('assistant.run-codex-goal','assistant.run-codex-read') AND live_job.status='RUNNING'
    AND live_job.payload->>'goalId'=${call}.goal_id
    AND live_job.payload->>'actorId'=${call}.actor_id
    AND live_job.lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)
  ))))`;
}
module.exports={blocksAdmission};
