'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const BACKUP_PATTERN = /^keeper-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.sqlite$/;

function stamp(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 19).replaceAll(':', '-');
}

function verify(backupPath) {
  const resolved = path.resolve(backupPath);
  const db = new Database(resolved, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = db.pragma('integrity_check');
    const integrity = integrityRows.map((row) => Object.values(row)[0]);
    const ok = integrity.length === 1 && integrity[0] === 'ok';
    const tableCount = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
    const workspaceCount = db.prepare("SELECT COUNT(*) AS n FROM workspaces").get().n;
    const movementCount = db.prepare("SELECT COUNT(*) AS n FROM movements").get().n;
    const journalCount = db.prepare("SELECT COUNT(*) AS n FROM accounting_journal_entries").get().n;
    return { ok, integrity, tableCount, workspaceCount, movementCount, journalCount,
      bytes: fs.statSync(resolved).size, path: resolved };
  } finally {
    db.close();
  }
}

function prune(directory, retentionDays, now = Date.now()) {
  if (!fs.existsSync(directory)) return [];
  const cutoff = now - retentionDays * 86400000;
  const removed = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !BACKUP_PATTERN.test(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (fs.statSync(target).mtimeMs >= cutoff) continue;
    fs.rmSync(target, { force: true });
    const manifest = `${target}.json`;
    if (fs.existsSync(manifest)) fs.rmSync(manifest, { force: true });
    removed.push(target);
  }
  return removed;
}

async function create(db, options = {}) {
  const directory = path.resolve(options.directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `keeper-${stamp(options.now)}.sqlite`);
  await db.backup(destination);
  const verification = verify(destination);
  if (!verification.ok) {
    fs.rmSync(destination, { force: true });
    throw new Error(`Backup integrity check failed: ${verification.integrity.join(', ')}`);
  }
  const manifest = {
    createdAt: new Date(options.now || Date.now()).toISOString(),
    retentionDays: Number(options.retentionDays || 30),
    verification,
  };
  fs.writeFileSync(`${destination}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const removed = prune(directory, manifest.retentionDays, options.now || Date.now());
  return { path: destination, manifestPath: `${destination}.json`, verification, removed };
}

/**
 * Performs an actual restore into a new file and verifies the restored copy.
 * It intentionally refuses to overwrite a live database; production cutover
 * is a separate, operator-controlled step after Keeper has been stopped.
 */
function restoreTo(backupPath, destinationPath) {
  const source = path.resolve(backupPath);
  const destination = path.resolve(destinationPath);
  if (source === destination) throw new Error('Restore destination must be different from the backup.');
  if (fs.existsSync(destination)) throw new Error('Restore destination already exists; refusing to overwrite it.');
  const sourceVerification = verify(source);
  if (!sourceVerification.ok) throw new Error('The backup failed its integrity check and will not be restored.');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const restored = verify(destination);
  if (!restored.ok || restored.workspaceCount !== sourceVerification.workspaceCount
      || restored.movementCount !== sourceVerification.movementCount
      || restored.journalCount !== sourceVerification.journalCount) {
    fs.rmSync(destination, { force: true });
    throw new Error('Restored database did not match the verified backup.');
  }
  return { source: sourceVerification, restored };
}

function startScheduler(db, options = {}) {
  const intervalMs = Math.max(60_000, Number(options.intervalMs || 24 * 60 * 60 * 1000));
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try { await create(db, options); }
    catch (error) { console.error('[keeper] database backup failed', error); }
    finally { running = false; }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  if (options.runOnStart) void run();
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = { create, verify, restoreTo, prune, startScheduler, BACKUP_PATTERN };
