'use strict';

// A large inventory deletion is intentionally isolated from both the HTTP
// process and the durable-job coordinator. better-sqlite3 is synchronous: if
// this work ran in either process, one long transaction would stop that
// process from serving pages or renewing its job lease.
const Database = require('better-sqlite3');
const workspaceDeletion = require('../domain/workspace-deletion');

let handled = false;
process.on('message', async (input) => {
  if (handled) return;
  handled = true;
  let db;
  try {
    db = new Database(input.databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 10000');
    // Deleting a large workspace is exactly the kind of burst that grew the
    // log to 4.2 GB. Same ceiling as openDatabase; see the note there.
    db.pragma('journal_size_limit = 67108864');
    const result = await workspaceDeletion.deleteWorkspaceInBatches(
      db,
      input.accountId,
      input.workspaceId,
      { confirmName: input.confirmName, preAuthorized: true, batchSize: 1000, pauseMs: 25 }
    );
    if (process.send) process.send({ ok: true, result });
  } catch (error) {
    if (process.send) process.send({
      ok: false,
      error: { message: String(error && error.message || error), code: error && error.code },
    });
  } finally {
    if (db) db.close();
    setImmediate(() => process.exit(0));
  }
});
