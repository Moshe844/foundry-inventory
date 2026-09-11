'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

// Keep recognising pre-rename backups so an upgrade never strands a valid
// restore point. New artifacts use the customer-facing product name.
const BACKUP_PATTERN = /^(?:foundry|keeper)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.sqlite$/;

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
      bytes: fs.statSync(resolved).size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex'),
      path: resolved };
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
  const destination = path.join(directory, `foundry-${stamp(options.now)}.sqlite`);
  let verification;
  try {
    await db.backup(destination);
    verification = verify(destination);
    if (!verification.ok) {
      throw new Error(`Backup integrity check failed: ${verification.integrity.join(', ')}`);
    }
  } catch (error) {
    // An interrupted online backup must never look like a restore point. The
    // manifest is the commit record, and partial SQLite sidecars are removed.
    for (const suffix of ['', '-journal', '-wal', '-shm', '.json']) {
      try { fs.rmSync(`${destination}${suffix}`, { force: true }); } catch { /* best effort */ }
    }
    throw error;
  }
  const manifest = {
    createdAt: new Date(options.now || Date.now()).toISOString(),
    retentionDays: Number(options.retentionDays || 30),
    verification,
  };
  fs.writeFileSync(`${destination}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const removed = prune(directory, manifest.retentionDays, options.now || Date.now());
  try {
    require('./checkpoints').record(db, 'backup.created', 'PASS', {
      path: destination, bytes: verification.bytes, workspaceCount: verification.workspaceCount,
      movementCount: verification.movementCount, journalCount: verification.journalCount,
    });
  } catch { /* backup remains valid even if evidence recording is unavailable */ }
  return { path: destination, manifestPath: `${destination}.json`, verification, removed };
}

/**
 * Performs an actual restore into a new file and verifies the restored copy.
 * It intentionally refuses to overwrite a live database; production cutover
 * is a separate, operator-controlled step after Foundry has been stopped.
 */
function restoreTo(backupPath, destinationPath) {
  const source = path.resolve(backupPath);
  const destination = path.resolve(destinationPath);
  if (source === destination) throw new Error('Restore destination must be different from the backup.');
  if (fs.existsSync(destination)) throw new Error('Restore destination already exists; refusing to overwrite it.');
  const sourceVerification = verify(source);
  if (!sourceVerification.ok) throw new Error('The backup failed its integrity check and will not be restored.');
  let committed = false;
  const manifestPath = `${source}.json`;
  if (fs.existsSync(manifestPath)) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch { throw new Error('The backup manifest is not valid JSON.'); }
    const expected = manifest && manifest.verification;
    committed = expected?.ok === true
      && expected.sha256 === sourceVerification.sha256
      && Number(expected.bytes) === sourceVerification.bytes
      && Number(expected.workspaceCount) === sourceVerification.workspaceCount
      && Number(expected.movementCount) === sourceVerification.movementCount
      && Number(expected.journalCount) === sourceVerification.journalCount;
    if (!committed) throw new Error('The backup does not match its verified manifest.');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const restored = verify(destination);
  if (!restored.ok || restored.workspaceCount !== sourceVerification.workspaceCount
      || restored.movementCount !== sourceVerification.movementCount
      || restored.journalCount !== sourceVerification.journalCount) {
    fs.rmSync(destination, { force: true });
    throw new Error('Restored database did not match the verified backup.');
  }
  return { source: sourceVerification, restored, committed, manifestPath: committed ? manifestPath : null };
}

function startScheduler(db, options = {}) {
  const intervalMs = Math.max(60_000, Number(options.intervalMs || 24 * 60 * 60 * 1000));
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try { await create(db, options); }
    catch (error) {
      console.error('[foundry] database backup failed', error);
      try {
        require('./checkpoints').record(db, 'backup.created', 'FAIL', { error: error.message });
        require('./monitoring').raise(db, {
          severity: 'CRITICAL', kind: 'backup.failed', title: 'Foundry backup failed',
          detail: error.message, fingerprint: 'backup.failed',
        });
      } catch { /* the original backup failure is still logged */ }
    }
    finally { running = false; }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  if (options.runOnStart) void run();
  return () => { stopped = true; clearInterval(timer); };
}

module.exports = { create, verify, restoreTo, prune, startScheduler, BACKUP_PATTERN };
