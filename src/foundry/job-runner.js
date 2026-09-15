'use strict';

/**
 * Background jobs for the slow part of Foundry.
 *
 * Reading a business takes two model calls and a minute or more. Doing that
 * inside a form POST leaves the browser spinning with nothing to show for it,
 * so the request starts a job and returns immediately; the page then polls and
 * reports which stage the work is actually in.
 *
 * Job state is persisted when a database is supplied. The model call still
 * runs in the web process, because replaying a paid/non-idempotent call after
 * an uncertain crash is unsafe. A restart therefore preserves the customer's
 * words and turns an interrupted job into an explicit retry instead of an
 * endless progress page.
 */

const { newId, nowIso } = require('../lib/util');

const JOBS = new Map();
const RETENTION_MS = 30 * 60 * 1000;
// A person started these jobs and is watching the progress page. Three model
// passes may legitimately take a minute, but a provider/socket retry tree must
// never leave that page spinning indefinitely. This is one budget for the
// whole job, not a fresh timeout for every pass.
const CUSTOMER_JOB_DEADLINE_MS = 3 * 60 * 1000;

/**
 * The stages a customer is actually waiting through.
 *
 * Every one of these is a real unit of work with a beginning and an end, not a
 * label invented to fill a progress bar: a file is opened, a model call reads
 * the structure, another copies out the products, another decides what is
 * worth saying. The page shows two ticks for three model calls before this,
 * which made the longest part of the wait look like nothing was happening.
 */
const STAGES = {
  queued: { label: 'Getting ready', detail: 'Foundry is about to read what you provided.' },
  extracting: {
    label: 'Opening the file',
    detail: 'Pulling out the text and tables, before any of it is interpreted.',
  },
  reading: {
    label: 'Reading your operation',
    detail: 'Working out what you track, how it is counted, and where it lives.',
  },
  records: {
    label: 'Picking out the products',
    detail: 'Every line naming a product, a code or a quantity — copied, never invented.',
  },
  preparing: {
    label: 'Putting the proposal together',
    detail: 'Lining up what it found against what this inventory already holds.',
  },
  advising: {
    label: 'Working out what to recommend',
    detail: 'Deciding what is worth telling you, and which questions actually matter.',
  },
  catalogue_reading: {
    label: 'Reading every product',
    detail: 'Copying the names, codes, options, quantities, locations and kit components you supplied.',
  },
  catalogue_preparing: {
    label: 'Building the exact preview',
    detail: 'Grouping only matching product records and checking every proposed change before showing it to you.',
  },
  done: { label: 'Ready', detail: 'Foundry has a proposal for you.' },
  failed: { label: 'Something went wrong', detail: 'Foundry could not finish reading that.' },
};

/*
 * The two ways in run different work, so they wait through different steps.
 * Showing a file-opening step to somebody who typed a paragraph is the kind of
 * invented progress this screen exists to avoid.
 */
const TRACKS = {
  document: ['extracting', 'reading', 'preparing'],
  description: ['reading', 'records', 'advising'],
  catalogue: ['catalogue_reading', 'catalogue_preparing'],
};

/**
 * `description` is remembered only so a failed job can hand the customer their
 * own words back. Retyping a paragraph about your business because a request
 * timed out is the kind of small cruelty nobody ever reports as a bug.
 */
function createJob(workspaceId, kind = 'understanding', description = '', about = {}) {
  const id = newId('job');
  const job = {
    id,
    workspaceId,
    kind,
    description,
    // What is being read, in the customer's own terms: their filename, or the
    // opening of what they typed. A progress screen that cannot name its own
    // subject reads like a stock loading animation.
    track: TRACKS[about.track] ? about.track : 'description',
    subject: about.subject || '',
    subjectDetail: about.subjectDetail || '',
    status: 'queued',
    stage: 'queued',
    // When each stage began, so a finished step can say how long it took
    // instead of only the total ticking upward.
    timeline: {},
    result: null,
    error: null,
    startedAt: Date.now(),
    createdAt: nowIso(),
  };
  JOBS.set(id, job);
  if (about.db) persistNew(about.db, job);
  sweep(about.db);
  return id;
}

function setStage(jobId, stage, db) {
  const job = loadJob(jobId, db);
  if (!job || job.status === 'failed' || job.status === 'done') return;
  // A stage that is entered twice keeps the first time: the work started then.
  if (!Object.prototype.hasOwnProperty.call(job.timeline, stage)) {
    job.timeline[stage] = Date.now() - job.startedAt;
  }
  job.stage = stage;
  job.status = 'running';
  persistState(db, job);
}

function completeJob(jobId, result, db) {
  const job = loadJob(jobId, db);
  if (!job || job.status === 'failed' || job.status === 'done') return;
  job.status = 'done';
  job.stage = 'done';
  job.result = result;
  job.timeline.done = Date.now() - job.startedAt;
  job.finishedAt = Date.now();
  persistState(db, job);
}

function failJob(jobId, error, db) {
  const job = loadJob(jobId, db);
  if (!job || job.status === 'failed' || job.status === 'done') return;
  job.status = 'failed';
  job.stage = 'failed';
  // Only ever surface a message that is safe and useful to a customer.
  //
  // A retryable provider failure is not the same thing as an unreadable file,
  // and telling somebody their description could not be understood when the
  // real problem is the network sends them off rewriting a paragraph that was
  // fine. Those messages are already written for a customer, so they are used
  // as they are.
  const retryable = Boolean(error && error.retryable);
  job.error = {
    message:
      error && error.message && ((error.status && error.status < 500) || retryable)
        ? error.message
        : 'Foundry could not finish reading that. Please try again.',
    code: (error && error.code) || 'unknown',
  };
  job.finishedAt = Date.now();
  persistState(db, job);
}

/** Workspace scoped: a job id from another tenant is simply not found. */
function getJob(jobId, workspaceId, db) {
  const job = loadJob(jobId, db);
  if (!job || job.workspaceId !== workspaceId) return null;
  if ((job.status === 'queued' || job.status === 'running') && Date.now() >= job.deadlineAt) {
    failJob(jobId, Object.assign(
      new Error('Foundry was interrupted before it finished. Nothing was changed. Please try again.'),
      { code: 'job_interrupted', status: 503, retryable: true }
    ), db);
  }
  const current = loadJob(jobId, db) || job;
  const order = TRACKS[current.track] || TRACKS.description;
  return {
    id: current.id,
    kind: current.kind,
    status: current.status,
    description: current.description || '',
    track: current.track,
    subject: current.subject || '',
    subjectDetail: current.subjectDetail || '',
    stage: current.stage,
    stageLabel: (STAGES[current.stage] || STAGES.queued).label,
    stageDetail: (STAGES[current.stage] || STAGES.queued).detail,
    steps: order.map((key) => ({ key, label: STAGES[key].label, detail: STAGES[key].detail })),
    timeline: { ...current.timeline },
    elapsedMs: (current.finishedAt || Date.now()) - current.startedAt,
    result: current.result,
    error: current.error,
  };
}

/**
 * Runs `work` in the background, handing it a `setStage` callback. Never
 * rejects: a failure becomes job state the page can render.
 */
function run(jobId, work, options = {}) {
  const db = options.db;
  const deadlineMs = Number.isFinite(options.deadlineMs)
    ? Math.max(1, options.deadlineMs)
    : CUSTOMER_JOB_DEADLINE_MS;
  setImmediate(() => {
    const controller = new AbortController();
    const timeoutError = Object.assign(
      new Error(options.timeoutMessage
        || 'Foundry could not finish within three minutes. Nothing was changed. Please try again.'),
      { code: 'job_deadline_exceeded', status: 503, retryable: true }
    );
    const timer = setTimeout(() => controller.abort(timeoutError), deadlineMs);
    // The HTTP server keeps production alive. A pending provider promise must
    // not keep a test process or a shutting-down worker alive by itself.
    timer.unref?.();
    Promise.resolve()
      .then(() => work((stage) => setStage(jobId, stage, db), controller.signal))
      .then((result) => completeJob(jobId, result, db))
      .catch((error) => {
        if (!error || !error.status || error.status >= 500) {
          console.error('[foundry] job failed', error);
        }
        failJob(jobId, error, db);
      })
      .finally(() => clearTimeout(timer));
  });
}

function sweep(db) {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, job] of JOBS) {
    if ((job.finishedAt || job.startedAt) < cutoff) JOBS.delete(id);
  }
  if (db) {
    db.prepare(`DELETE FROM foundry_ui_jobs
      WHERE COALESCE(finished_at, started_at) < ?
        AND status IN ('done','failed')`).run(cutoff);
  }
}

function parseJson(value, fallback) {
  try { return value == null ? fallback : JSON.parse(value); } catch (_error) { return fallback; }
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    description: row.description || '',
    track: row.track,
    subject: row.subject || '',
    subjectDetail: row.subject_detail || '',
    status: row.status,
    stage: row.stage,
    timeline: parseJson(row.timeline, {}),
    result: parseJson(row.result, null),
    error: parseJson(row.error, null),
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

function loadJob(jobId, db) {
  if (db) {
    const row = db.prepare('SELECT * FROM foundry_ui_jobs WHERE id = ?').get(jobId);
    if (row) {
      const job = fromRow(row);
      JOBS.set(jobId, job);
      return job;
    }
  }
  return JOBS.get(jobId) || null;
}

function persistNew(db, job) {
  db.prepare(`INSERT INTO foundry_ui_jobs (
    id, workspace_id, kind, description, track, subject, subject_detail,
    status, stage, timeline, result, error, started_at, deadline_at,
    finished_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)`)
    .run(job.id, job.workspaceId, job.kind, job.description, job.track, job.subject,
      job.subjectDetail, job.status, job.stage, JSON.stringify(job.timeline),
      job.startedAt, job.startedAt + CUSTOMER_JOB_DEADLINE_MS, job.createdAt, job.createdAt);
  job.deadlineAt = job.startedAt + CUSTOMER_JOB_DEADLINE_MS;
}

function persistState(db, job) {
  if (!db) return;
  db.prepare(`UPDATE foundry_ui_jobs SET
    status = ?, stage = ?, timeline = ?, result = ?, error = ?,
    finished_at = ?, updated_at = ? WHERE id = ?`)
    .run(job.status, job.stage, JSON.stringify(job.timeline || {}),
      job.result == null ? null : JSON.stringify(job.result),
      job.error == null ? null : JSON.stringify(job.error),
      job.finishedAt || null, nowIso(), job.id);
}

/** Test seam. */
function reset() {
  JOBS.clear();
}

module.exports = {
  createJob, run, getJob, setStage, completeJob, failJob, reset,
  STAGES, TRACKS, CUSTOMER_JOB_DEADLINE_MS,
};
