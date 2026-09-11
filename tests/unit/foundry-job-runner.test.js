'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../../src/foundry/job-runner');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a customer-started Foundry job has one deadline and cancels its work', async () => {
  jobs.reset();
  const id = jobs.createJob('ws_deadline');
  let sawAbort = false;

  jobs.run(id, async (_setStage, signal) => {
    await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(signal.reason);
      }, { once: true });
    });
  }, { deadlineMs: 20 });

  await wait(60);
  const job = jobs.getJob(id, 'ws_deadline');
  assert.equal(sawAbort, true, 'the in-flight provider work receives cancellation');
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'job_deadline_exceeded');
  assert.match(job.error.message, /nothing was changed/i);
});

test('late completion cannot overwrite a terminal failed Foundry job', async () => {
  jobs.reset();
  const id = jobs.createJob('ws_race');
  jobs.failJob(id, Object.assign(new Error('Stopped safely.'), { code: 'stopped', retryable: true }));
  jobs.completeJob(id, { understandingId: 'too_late' });

  const job = jobs.getJob(id, 'ws_race');
  assert.equal(job.status, 'failed');
  assert.equal(job.result, null);
  assert.equal(job.error.code, 'stopped');
});
