'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');
const { openDatabase } = require('../src/db');
const jobs = require('../src/operations/job-queue');
const checkpoints = require('../src/operations/checkpoints');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const count = Math.max(1000, Number(argument('jobs', 1000)));
const minimumPerSecond = Math.max(1, Number(argument('minimum-per-second', 75)));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-worker-throughput-'));
const databasePath = path.join(directory, 'runtime.sqlite');

(async () => {
  const db = openDatabase(databasePath);
  const started = performance.now();
  try {
    for (let index = 0; index < count; index += 1) {
      jobs.enqueue(db, {
        kind: 'certification.noop', idempotencyKey: `throughput:${index}`,
        payload: { index }, maxAttempts: 1,
      });
    }
    for (let index = 0; index < count; index += 1) {
      const completed = await jobs.processOne(db, {
        'certification.noop': async (job) => ({ index: job.payload.index }),
      }, { owner: 'mission4-throughput', leaseMs: 30_000 });
      if (!completed || completed.status !== 'COMPLETED') {
        throw new Error(`Worker stopped before completing job ${index + 1}.`);
      }
    }
    const completedCount = db.prepare("SELECT COUNT(*) AS n FROM runtime_jobs WHERE status = 'COMPLETED'").get().n;
    if (completedCount !== count) throw new Error(`Expected ${count} completed jobs; found ${completedCount}.`);
    const durationMs = performance.now() - started;
    const jobsPerSecond = Math.round((count / durationMs) * 1000);
    const detail = {
      jobs: count, completed: completedCount, durationMs: Math.round(durationMs),
      jobsPerSecond, minimumPerSecond,
      budgetPassed: jobsPerSecond >= minimumPerSecond,
      durable: true, leases: true, completionEvents: true,
      releaseRef: config.operations.releaseRef,
    };
    console.log(JSON.stringify(detail, null, 2));
    const evidenceDb = openDatabase(config.databasePath);
    try { checkpoints.record(evidenceDb, 'worker.throughput', detail.budgetPassed ? 'PASS' : 'FAIL', detail); }
    finally { evidenceDb.close(); }
    if (!detail.budgetPassed) process.exitCode = 1;
  } finally {
    db.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
