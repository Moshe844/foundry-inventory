'use strict';

/**
 * The boundary every outside service is reached through: a time limit, a
 * retry only when repeating is safe, and "could not be reached" kept apart
 * from "looked at it and refused". Proved here against a fake fetch — this
 * is the behaviour of the boundary, not of any provider.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { providerFetch, ProviderUnavailableError, isIdempotent } = require('../../src/lib/provider-http');

function response(status, body = '{}', headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, text: async () => body, json: async () => JSON.parse(body) };
}
const noSleep = async () => {};

test('a GET that hits a 503 twice and then succeeds is retried and returns the success', async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push(init.method || 'GET'); return seen.length < 3 ? response(503) : response(200, '{"ok":true}'); };
  const res = await providerFetch('https://api.example.test/x', {}, { provider: 'Example', fetch, sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 3);
});

test('a POST without an idempotency key is never retried: the first attempt may have landed', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return response(502); };
  await assert.rejects(providerFetch('https://api.example.test/x', { method: 'POST', body: 'a=1' }, { provider: 'Example', fetch, sleep: noSleep }),
    (err) => err instanceof ProviderUnavailableError && err.code === 'provider_unavailable' && err.status === 503 && err.httpStatus === 502 && /not working right now/.test(err.message));
  assert.equal(calls, 1);
});

test('a POST with an idempotency key is retried, because repeating it is safe', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return calls < 2 ? response(500) : response(200); };
  const res = await providerFetch('https://api.example.test/x', { method: 'POST', headers: { 'Idempotency-Key': 'k1' } }, { provider: 'Example', fetch, sleep: noSleep });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.equal(isIdempotent({ method: 'POST', headers: { 'idempotency-key': 'x' } }), true);
  assert.equal(isIdempotent({ method: 'POST' }), false);
});

test('a 4xx is returned to the adapter, not thrown: the service looked and refused', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return response(402, '{"error":{"message":"card declined"}}'); };
  const res = await providerFetch('https://api.example.test/x', {}, { provider: 'Example', fetch, sleep: noSleep });
  assert.equal(res.status, 402);
  assert.equal(calls, 1, 'a refusal is not retried');
});

test('a dropped connection or a timeout ends as "could not be reached", after the retries a GET is allowed', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; const e = new Error('socket hang up'); throw e; };
  await assert.rejects(providerFetch('https://api.example.test/x', {}, { provider: 'Example', fetch, sleep: noSleep }),
    (err) => err instanceof ProviderUnavailableError && /could not be reached/.test(err.message) && err.attempts === 3);
  assert.equal(calls, 3);
  const timeout = async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
  await assert.rejects(providerFetch('https://api.example.test/x', { method: 'POST' }, { provider: 'Example', fetch: timeout, sleep: noSleep }),
    (err) => err instanceof ProviderUnavailableError && /could not be reached in time/.test(err.message));
});

test('429 honours Retry-After and reads as rate-limited, not refused', async () => {
  let calls = 0; const waits = [];
  const fetch = async () => { calls += 1; return calls < 2 ? response(429, '{}', { 'retry-after': '2' }) : response(200); };
  const res = await providerFetch('https://api.example.test/x', {}, { provider: 'Example', fetch, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(res.status, 200);
  assert.deepEqual(waits, [2000]);
  const always = async () => response(429);
  await assert.rejects(providerFetch('https://api.example.test/x', {}, { provider: 'Example', fetch: always, sleep: noSleep }), /rate-limiting/);
});

test('the adapters reach their services through the boundary', () => {
  const fs = require('node:fs');
  for (const file of ['src/payments/providers/stripe.js', 'src/payments/connect.js', 'src/shipping/providers/shipengine.js', 'src/shipping/providers/shipstation.js', 'src/shipping/providers/shippo.js', 'src/shipping/providers/easypost.js', 'src/shipping/providers/easypost-partner.js', 'src/connections/providers/common.js']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /providerFetch\(/, `${file} uses the boundary`);
    assert.doesNotMatch(source.replace(/providerFetch\(/g, ''), /\bawait fetch\(/, `${file} has no bare fetch left`);
  }
});
