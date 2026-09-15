'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const active = new Map();

function queue(databasePath,ctx,membership,packageId) {
  if (active.has(packageId)) return false;
  const worker = new Worker(path.join(__dirname,'cutover-worker.js'),{
    workerData:{ databasePath,ctx:{ workspaceId:ctx.workspaceId,actorId:ctx.actorId,accountId:ctx.accountId },
      membership:{ id:membership.id,role:membership.role,account_id:membership.account_id },packageId },
  });
  active.set(packageId,worker);
  worker.on('message',(message) => {
    if (message.type === 'error') console.error(`[migration ${packageId}] background cutover stopped: ${message.message}`);
  });
  worker.on('error',(error) => console.error(`[migration ${packageId}] worker failed: ${error.message || error}`));
  worker.on('exit',() => active.delete(packageId));
  return true;
}

/** A package in APPLYING already has owner approval. Resume after a process
 * restart from its immutable record statuses; APPLIED rows are never selected
 * again. */
function resumeInterrupted(db,databasePath) {
  const rows = db.prepare(`SELECT p.id,p.workspace_id,p.approved_by_user_id,u.account_id,u.role
    FROM migration_packages p LEFT JOIN users u ON u.id=p.approved_by_user_id
    WHERE p.status='APPLYING'`).all();
  for (const row of rows) {
    if (!row.approved_by_user_id || !row.role) continue;
    queue(databasePath,{ workspaceId:row.workspace_id,actorId:row.approved_by_user_id,accountId:row.account_id },
      { id:row.approved_by_user_id,role:row.role,account_id:row.account_id },row.id);
  }
  return rows.length;
}

module.exports = { queue,resumeInterrupted,isActive:(packageId) => active.has(packageId) };
