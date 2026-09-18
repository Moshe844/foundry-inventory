'use strict';

/**
 * One boundary for every outside service.
 *
 * Stripe, the carriers, the mailboxes and the accounting providers each had
 * their own bare `fetch`: no time limit, no retry, and a 503 or a dropped
 * connection reported in the same words as a rejected request — "Stripe
 * refused the request (503)" — which is the one thing it was not. Here:
 *
 * - every request has a time limit;
 * - a request that is safe to repeat (a GET, or a write carrying an
 *   idempotency key) is retried on a network failure, a timeout, 429 or
 *   5xx, with backoff; a write without a key is never retried, because the
 *   first attempt may have landed;
 * - what remains after retries is `ProviderUnavailableError` — the service
 *   could not be reached or was not working — which is a different state
 *   from a request the service looked at and refused (4xx), and is reported
 *   as such all the way up;
 * - every attempt is on the record with its outcome and latency, beside the
 *   model calls, so "why did that fail" has an answer.
 *
 * Nothing here decides what a refusal means: the adapter that knows the
 * provider still reads the 4xx body. This only decides reached / not reached.
 */

const { DomainError } = require('../domain/errors');

class ProviderUnavailableError extends DomainError {
  constructor(provider, message, options = {}) {
    super(message, { code: 'provider_unavailable', status: 503 });
    this.provider = provider;
    this.retryable = true;
    this.attempts = options.attempts || 1;
    this.cause = options.cause || null;
    this.httpStatus = options.httpStatus || null;
  }
}

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isIdempotent(init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const headers = init.headers || {};
  return Object.keys(headers).some((key) => key.toLowerCase() === 'idempotency-key' || key.toLowerCase() === 'x-idempotency-key');
}

function retryAfterMs(response) {
  const header = response && response.headers && response.headers.get && response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 30_000)) : null;
}

function record(provider, detail) {
  try {
    require('../assistant/calls').record({ kind: 'provider', purpose: provider, provider, model: null, prompt: null, ...detail });
  } catch { /* the record is best-effort; the call is not */ }
}

function noteUnavailable(provider, error) {
  try {
    const calls = require('../assistant/calls');
    const context = calls.current();
    if (context) context.unavailable = { service: provider, at: Date.now(), error: String(error && error.message || '') };
  } catch { /* no request context */ }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ provider: string, timeoutMs?: number, retries?: number, fetch?: Function, sleep?: Function }} options
 * @returns {Promise<Response>} a response the caller reads; 4xx are returned, not thrown
 */
async function providerFetch(url, init = {}, options = {}) {
  const provider = options.provider || 'provider';
  const timeoutMs = options.timeoutMs || 20_000;
  const doFetch = options.fetch || fetch;
  const wait = options.sleep || sleep;
  const retries = isIdempotent(init) ? (options.retries === undefined ? 2 : options.retries) : 0;
  let attempt = 0;
  let lastError = null;
  let lastStatus = null;
  while (attempt <= retries) {
    attempt += 1;
    const started = Date.now();
    let response;
    try {
      response = await doFetch(url, { ...init, signal: init.signal || AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      lastError = cause;
      const timedOut = cause && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      record(provider, { latencyMs: Date.now() - started, outcome: timedOut ? 'timeout' : 'unreachable', error: String(cause && cause.message || cause) });
      if (attempt <= retries) { await wait(backoff(attempt)); continue; }
      const error = new ProviderUnavailableError(provider, `${provider} could not be reached${timedOut ? ' in time' : ''}. Nothing was changed there; StockChief will try again.`, { attempts: attempt, cause });
      noteUnavailable(provider, error);
      throw error;
    }
    if (RETRY_STATUSES.has(response.status)) {
      lastStatus = response.status;
      record(provider, { latencyMs: Date.now() - started, outcome: response.status === 429 ? 'rate_limited' : 'provider_error', error: `HTTP ${response.status}` });
      if (attempt <= retries) { await wait(retryAfterMs(response) ?? backoff(attempt)); continue; }
      const error = new ProviderUnavailableError(provider, response.status === 429
        ? `${provider} is rate-limiting requests right now. Nothing was changed there; StockChief will try again shortly.`
        : `${provider} is not working right now (HTTP ${response.status}). Nothing was changed there; StockChief will try again.`, { attempts: attempt, httpStatus: response.status });
      noteUnavailable(provider, error);
      throw error;
    }
    record(provider, { latencyMs: Date.now() - started, outcome: response.ok ? 'ok' : 'rejected', error: response.ok ? null : `HTTP ${response.status}` });
    return response;
  }
  // Unreachable: the loop always returns or throws.
  throw new ProviderUnavailableError(provider, `${provider} could not be reached.`, { attempts: attempt, cause: lastError, httpStatus: lastStatus });
}

function backoff(attempt) {
  return Math.min(250 * 2 ** (attempt - 1), 4_000);
}

module.exports = { providerFetch, ProviderUnavailableError, isIdempotent, RETRY_STATUSES };
