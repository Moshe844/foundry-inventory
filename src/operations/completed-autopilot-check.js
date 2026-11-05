'use strict';
// A completed cycle can cover a queued request only if both its observation
// and completion are at least as recent as that request. Bound the history
// lookup by completion as well, so an empty result never reads old cycles.
async function find(db,workspaceId,createdAt){
 return (await db.query(`SELECT id FROM stockchief_runtime.jobs WHERE workspace_id=$1
  AND kind='autopilot.evaluate' AND status='COMPLETED' AND result->>'partial'='false'
  AND completed_at>=$2::timestamptz
  AND stockchief_movement_instant(result->>'cycleStartedAt')>=$2::timestamptz
  ORDER BY completed_at DESC LIMIT 1`,[workspaceId,createdAt])).rows[0]||null;
}
module.exports={find};
