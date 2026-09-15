'use strict';

const { fork } = require('node:child_process');

function databasePath(db) {
  const main = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main');
  return main && main.file;
}

function handler(db) {
  return (job, context = {}) => new Promise((resolve, reject) => {
    const target = job.payload || {};
    // A worker may have died after the atomic deletion committed but before it
    // marked the durable job complete. Treat absence as verified success.
    const exists = db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(target.workspaceId);
    if (!exists) return resolve({ workspaceId: target.workspaceId, alreadyDeleted: true });

    const file = databasePath(db);
    if (!file) return reject(Object.assign(new Error('The inventory database path is unavailable.'), {
      code: 'database_path_unavailable', retryable: false,
    }));

    const child = fork(require.resolve('./workspace-delete-child'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    let settled = false;
    const heartbeat = setInterval(() => {
      if (typeof context.heartbeat === 'function') context.heartbeat();
    }, 15_000);
    heartbeat.unref();

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      fn(value);
    };
    child.once('message', (message) => {
      if (message && message.ok) finish(resolve, message.result || {});
      else {
        const detail = message && message.error || {};
        finish(reject, Object.assign(new Error(detail.message || 'Inventory deletion failed.'), {
          code: detail.code || 'workspace_delete_failed',
        }));
      }
    });
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code) => {
      if (!settled) finish(reject, Object.assign(
        new Error(`Inventory deletion process stopped before completion (exit ${code}).`),
        { code: 'workspace_delete_process_stopped' }
      ));
    });
    child.send({
      databasePath: file,
      accountId: target.accountId,
      workspaceId: target.workspaceId,
      confirmName: target.confirmName,
    });
  });
}

module.exports = { handler, databasePath };
