'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { completeWithin } = require('../../src/ai/deadline');

test('a provider that ignores cancellation cannot outlive the reading deadline',async () => {
  const provider = { complete:() => new Promise(() => {}) };
  await assert.rejects(completeWithin(provider,{},10),{code:'ai_timeout',status:503});
});

test('an enclosing job deadline keeps its actual reason even when the provider rejects on abort',async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('Catalogue review deadline'),{code:'job_deadline_exceeded',status:503});
  const provider = { complete:(request) => new Promise((resolve,reject) => {
    request.signal.addEventListener('abort',() => reject(request.signal.reason),{once:true});
  }) };
  const completion = completeWithin(provider,{signal:controller.signal},1000);
  setTimeout(() => controller.abort(reason),10);
  await assert.rejects(completion,(error) => error === reason);
});

test('an already cancelled job never starts another provider request',async () => {
  const controller = new AbortController();
  const reason = new Error('Cancelled before reading');
  controller.abort(reason);
  let calls = 0;
  await assert.rejects(completeWithin({complete:async () => {calls += 1;}},{signal:controller.signal},1000),
    (error) => error === reason);
  assert.equal(calls,0);
});
