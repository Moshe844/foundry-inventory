'use strict';

/**
 * Background jobs for the slow part of Foundry.
 *
 * Reading a business takes two model calls and a minute or more. Doing that
 * inside a form POST leaves the browser spinning with nothing to show for it,
 * so the request starts a job and returns immediately; the page then polls and
 * reports which stage the work is actually in.
 *
 * Jobs live in memory: they are short, single-process, and their real output —
 * the understanding — is persisted by the service as usual. A server restart
 * mid-job loses the job, not the customer's work, and the page offers to try
 * again rather than hanging forever.
 */

const { newId, nowIso } = require('../lib/util');

const JOBS = new Map();
const RETENTION_MS = 30 * 60 * 1000;

/** The stages a customer is actually waiting through, in order. */
const STAGES = {
  queued: { label: 'Getting ready', detail: 'Foundry is about to read what you provided.' },
  reading: {
    label: 'Reading your operation',
    detail: 'Working out what you track, how it is counted, and where it lives.',
  },
  advising: {
    label: 'Working out what to recommend',
    detail: 'Deciding what is worth telling you, and which questions actually matter.',
  },
  done: { label: 'Ready', detail: 'Foundry has a proposal for you.' },
  failed: { label: 'Something went wrong', detail: 'Foundry could not finish reading that.' },
};

function createJob(workspaceId, kind = 'understanding') {
  const id = newId('job');
  JOBS.set(id, {
    id,
    workspaceId,
    kind,
    status: 'queued',
    stage: 'queued',
    result: null,
    error: null,
    startedAt: Date.now(),
    createdAt: nowIso(),
  });
  sweep();
  return id;
}

function setStage(jobId, stage) {
  const job = JOBS.get(jobId);
  if (!job || job.status === 'failed' || job.status === 'done') return;
  job.stage = stage;
  job.status = 'running';
}

function completeJob(jobId, result) {
  const job = JOBS.get(jobId);
  if (!job) return;
  job.status = 'done';
  job.stage = 'done';
  job.result = result;
  job.finishedAt = Date.now();
}

function failJob(jobId, error) {
  const job = JOBS.get(jobId);
  if (!job) return;
  job.status = 'failed';
  job.stage = 'failed';
  // Only ever surface a message that is safe and useful to a customer.
  job.error = {
    message:
      error && error.status && error.status < 500
        ? error.message
        : 'Foundry could not finish reading that. Please try again.',
    code: (error && error.code) || 'unknown',
  };
  job.finishedAt = Date.now();
}

/** Workspace scoped: a job id from another tenant is simply not found. */
function getJob(jobId, workspaceId) {
  const job = JOBS.get(jobId);
  if (!job || job.workspaceId !== workspaceId) return null;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    stageLabel: (STAGES[job.stage] || STAGES.queued).label,
    stageDetail: (STAGES[job.stage] || STAGES.queued).detail,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    result: job.result,
    error: job.error,
  };
}

/**
 * Runs `work` in the background, handing it a `setStage` callback. Never
 * rejects: a failure becomes job state the page can render.
 */
function run(jobId, work) {
  setImmediate(() => {
    Promise.resolve()
      .then(() => work((stage) => setStage(jobId, stage)))
      .then((result) => completeJob(jobId, result))
      .catch((error) => {
        if (!error || !error.status || error.status >= 500) {
          console.error('[foundry] job failed', error);
        }
        failJob(jobId, error);
      });
  });
}

function sweep() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, job] of JOBS) {
    if ((job.finishedAt || job.startedAt) < cutoff) JOBS.delete(id);
  }
}

/** Test seam. */
function reset() {
  JOBS.clear();
}

module.exports = { createJob, run, getJob, setStage, completeJob, failJob, reset, STAGES };
