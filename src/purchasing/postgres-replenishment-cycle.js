'use strict';

const decision=require('./replenishment-decision');
// Import recovery uses the same 15-minute liveness window. A live queue lease
// also covers a long catalogue batch; abandoned executions cannot block forever.
const activeImportSql=`EXISTS(SELECT 1 FROM import_executions execution
 JOIN import_plans plan ON plan.id=execution.import_id AND plan.workspace_id=execution.workspace_id
 WHERE execution.workspace_id=$1 AND execution.status='EXECUTING' AND (
 greatest(execution.started_at,coalesce(plan.apply_checkpoint->>'updatedAt',execution.started_at))
  >to_char((CURRENT_TIMESTAMP-interval '15 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 OR EXISTS(SELECT 1 FROM stockchief_runtime.jobs active WHERE active.workspace_id=execution.workspace_id
  AND active.kind='import.execute-approved' AND active.payload->>'planId'=execution.import_id
  AND active.status='RUNNING' AND active.lease_expires_at>extract(epoch FROM CURRENT_TIMESTAMP)*1000)))`;

async function lockStorageOwner(database,workspaceId){
 // Positive business writes take this account lock. Take it before source
 // version/workspace locks, otherwise import A->version and planner version->A
 // deadlock (including when two inventories share one paying account).
 await database.query("SELECT pg_advisory_xact_lock(hashtextextended('storage-quota:'||owner_account_id,0)) FROM workspaces WHERE id=$1",[workspaceId]);
}
async function begin(database,workspaceId,cycleId,{continuation=false}={}){
 if((await database.query('SELECT '+activeImportSql+' AS active',[workspaceId])).rows[0].active){
  await lockStorageOwner(database,workspaceId);
  await database.query(`UPDATE workspace_autopilot SET next_evaluation_at=
   to_char((CURRENT_TIMESTAMP+interval '2 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE workspace_id=$1`,[workspaceId]);
  return {skipped:'import_in_progress'};
 }
 await lockStorageOwner(database,workspaceId);
 const existing=(await database.query('SELECT *,started_at>CURRENT_TIMESTAMP-interval \'5 minutes\' AS recent FROM stockchief_runtime.replenishment_planning_runs WHERE workspace_id=$1 FOR UPDATE',[workspaceId])).rows[0];
 if(existing?.cycle_id===cycleId)return {planningRevision:String(existing.revision)};
 if(continuation)return {skipped:'superseded_planning_cycle'};
 if(existing?.recent){
  await database.query(`UPDATE workspace_autopilot SET next_evaluation_at=to_char(($2::timestamptz+interval '5 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE workspace_id=$1`,[workspaceId,existing.started_at]);
  return {skipped:'planning_debounced'};
 }
 await database.query('DELETE FROM stockchief_runtime.replenishment_planning_eligible WHERE workspace_id=$1',[workspaceId]);
 await database.query('DELETE FROM stockchief_runtime.replenishment_planning_demand WHERE workspace_id=$1',[workspaceId]);
 // This is the only inventory-wide demand aggregate in a durable cycle.
 await database.query(`INSERT INTO stockchief_runtime.replenishment_planning_demand(workspace_id,sku_id,location_id,issue_events,issued)
  SELECT workspace_id,sku_id,location_id,count(*),sum(issued) FROM stockchief_runtime.replenishment_demand_events
  WHERE workspace_id=$1 AND occurred_at>=CURRENT_TIMESTAMP-make_interval(days=>$2) AND occurred_at<=CURRENT_TIMESTAMP
  GROUP BY workspace_id,sku_id,location_id`,[workspaceId,decision.WINDOW_DAYS]);
 await database.query(`INSERT INTO stockchief_runtime.replenishment_planning_eligible(workspace_id,sku_id)
  SELECT $1,sku_id FROM reorder_policies WHERE workspace_id=$1 UNION
  SELECT $1,sku_id FROM stockchief_runtime.replenishment_planning_demand WHERE workspace_id=$1 AND issue_events>=$2`,[workspaceId,decision.MIN_ISSUE_EVENTS]);
 const revision=(await database.query(`UPDATE workspace_autopilot SET replenishment_dirty_at=NULL
  WHERE workspace_id=$1 RETURNING replenishment_revision::text AS revision`,[workspaceId])).rows[0]?.revision||'0';
 await database.query(`INSERT INTO stockchief_runtime.replenishment_planning_runs(workspace_id,cycle_id,revision,started_at)
  VALUES($1,$2,$3,CURRENT_TIMESTAMP) ON CONFLICT(workspace_id) DO UPDATE SET cycle_id=excluded.cycle_id,
  revision=excluded.revision,started_at=excluded.started_at,completed_at=NULL`,[workspaceId,cycleId,revision]);
 return {planningRevision:revision};
}
module.exports={activeImportSql,lockStorageOwner,begin};
