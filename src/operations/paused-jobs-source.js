'use strict';
// Only these fields participate in entitlement checks. Keep the existing
// status, ordering, bounded batch and row locks when loading paused work.
function source(){return `SELECT id,workspace_id,last_error FROM stockchief_runtime.jobs WHERE status='PAUSED'
 AND workspace_id IS NOT NULL ORDER BY updated_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`;}
module.exports={source};
