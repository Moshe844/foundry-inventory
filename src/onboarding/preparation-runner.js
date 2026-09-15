'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const migration = require('./canonical-migration');
const ownerMigration = require('./owner-migration');

const active = new Map();

function queue(db,databasePath,ctx,membership,packageId) {
  if (active.has(packageId)) return false;
  const pkg = migration.getPackage(db,ctx.workspaceId,packageId);
  if (pkg.status === 'READY' || pkg.status === 'CUTOVER_ACTIVE') return false;
  migration.setPreparationProgress(db,ctx.workspaceId,packageId,{
    status:'RUNNING',stage:'UNDERSTANDING',completed:0,total:0,
    detail:'Foundry is identifying each dataset and its exact source meaning.',
  });
  const worker = new Worker(path.join(__dirname,'preparation-worker.js'),{
    workerData:{ databasePath,ctx:{ workspaceId:ctx.workspaceId,actorId:ctx.actorId,accountId:ctx.accountId },
      membership:{ id:membership.id,role:membership.role,account_id:membership.account_id },packageId },
  });
  active.set(packageId,worker);
  worker.on('message',(message) => {
    if (message.type === 'error') console.error(`[migration ${packageId}] preparation stopped: ${message.message}`);
  });
  worker.on('error',(error) => {
    console.error(`[migration ${packageId}] preparation worker failed: ${error.message || error}`);
    try {
      migration.setPreparationProgress(db,ctx.workspaceId,packageId,{
        status:'FAILED',stage:'STOPPED',detail:'Preparation stopped safely. The source snapshot is still saved.',
        error:String(error.message || error),
      });
    } catch (_) {}
  });
  worker.on('exit',() => active.delete(packageId));
  return true;
}

function resumeInterrupted(db,databasePath) {
  const rows = db.prepare(`SELECT p.id,p.workspace_id,p.created_by_user_id,p.preparation_status,u.account_id,u.role
    FROM migration_packages p LEFT JOIN users u ON u.id=p.created_by_user_id
    WHERE p.preparation_status IN ('RUNNING','WAITING')
      AND p.status IN ('STAGING','VALIDATING','NEEDS_ATTENTION')`).all();
  let resumed = 0;
  for (const row of rows) {
    if (!row.created_by_user_id || !row.role) continue;
    if (row.preparation_status === 'WAITING') {
      const review = ownerMigration.sourceReviewCached(db,row.workspace_id,row.id);
      if (!ownerMigration.canResolveOperationalTruthByPolicy(review)) continue;
    }
    queue(db,databasePath,{ workspaceId:row.workspace_id,actorId:row.created_by_user_id,accountId:row.account_id },
      { id:row.created_by_user_id,role:row.role,account_id:row.account_id },row.id);
    resumed += 1;
  }
  return resumed;
}

module.exports = { queue,resumeInterrupted,isActive:(packageId) => active.has(packageId) };
