'use strict';

/**
 * The record of every model call and every tool call.
 *
 * A wrong answer used to be untraceable: nothing said which prompt produced
 * it, how long the model took, or whether the schema came back valid. Now
 * each call is one row in ai_calls — purpose, provider, model, tokens,
 * latency, outcome — tied to the workspace, the person and the goal it
 * served when those are known.
 *
 * Who is asking travels through AsyncLocalStorage rather than through every
 * function signature: the request middleware opens a context, the assistant
 * adds the goal when it opens one, and the provider wrapper reads it.
 *
 * The prompt is stored redacted. Quoted text and figures are masked, so the
 * shape of what was asked survives for diagnosis while product names,
 * quantities and prices do not. Rows older than thirty days are pruned on
 * the way in; nothing here is ever read back into a prompt.
 */

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const KEEP_DAYS = 30;

/** Runs fn with a call context: { db, workspaceId, actorId, goalId }. */
function run(context, fn) {
  return storage.run({ ...context }, fn);
}

/** The current context, or null outside a request. */
function current() {
  return storage.getStore() || null;
}

/** Adds to the current context (the goal, once the assistant has one). */
function extend(fields) {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

function redact(prompt) {
  const text = String(prompt || '');
  return text
    .replace(/"(?:[^"\\]|\\.){0,400}"/g, '"…"')
    .replace(/“[^”]{0,400}”/g, '“…”')
    .replace(/\d[\d,.]*/g, '#')
    .slice(0, 4000);
}

function hash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
}

let lastPrune = 0;

/**
 * Writes one row. Never throws: a logger that fails must not turn a good
 * answer into an error. Returns the row id, or null when nothing was written.
 */
function record(entry, explicitContext = null) {
  const context = explicitContext || current();
  const db = (context && context.db) || entry.db || null;
  if (!db) return null;
  try {
    const id = `call_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ai_calls
      (id, workspace_id, actor_id, goal_id, kind, purpose, provider, model, prompt_hash, prompt_redacted,
       input_tokens, output_tokens, latency_ms, outcome, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, (context && context.workspaceId) || entry.workspaceId || null, (context && context.actorId) || entry.actorId || null,
        (context && context.goalId) || entry.goalId || null, entry.kind, String(entry.purpose || 'unknown').slice(0, 120),
        entry.provider || null, entry.model || null, entry.prompt !== undefined ? hash(entry.prompt) : null,
        entry.prompt !== undefined ? redact(entry.prompt) : null,
        Number.isFinite(entry.inputTokens) ? entry.inputTokens : null, Number.isFinite(entry.outputTokens) ? entry.outputTokens : null,
        Math.max(0, Math.round(entry.latencyMs || 0)), entry.outcome || 'ok', entry.error ? String(entry.error).slice(0, 500) : null, now);
    if (Date.now() - lastPrune > 60 * 60 * 1000) {
      lastPrune = Date.now();
      db.prepare('DELETE FROM ai_calls WHERE created_at < ?').run(new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
    }
    return id;
  } catch (err) {
    if (!/no such table/.test(String(err && err.message))) console.error('[foundry] could not record the call', err);
    return null;
  }
}

/** What a goal cost: how many model calls and how long they took. */
function forGoal(db, goalId) {
  if (!db || !goalId) return { modelCalls: 0, toolCalls: 0, modelMs: 0 };
  try {
    const row = db.prepare(`SELECT
        SUM(CASE WHEN kind = 'model' THEN 1 ELSE 0 END) model_calls,
        SUM(CASE WHEN kind = 'tool' THEN 1 ELSE 0 END) tool_calls,
        SUM(CASE WHEN kind = 'model' THEN latency_ms ELSE 0 END) model_ms
      FROM ai_calls WHERE goal_id = ?`).get(goalId);
    return { modelCalls: Number(row.model_calls || 0), toolCalls: Number(row.tool_calls || 0), modelMs: Number(row.model_ms || 0) };
  } catch { return { modelCalls: 0, toolCalls: 0, modelMs: 0 }; }
}

/** Recent calls for a workspace, newest first. */
function recent(db, workspaceId, { limit = 50 } = {}) {
  return db.prepare('SELECT * FROM ai_calls WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?').all(workspaceId, limit);
}

/**
 * A provider whose every call is on the record. Same shape as the provider
 * it wraps; the request passes through untouched.
 */
function observed(provider) {
  if (!provider || typeof provider.complete !== 'function' || provider.__observed) return provider;
  const wrapped = {
    ...provider,
    name: provider.name,
    model: provider.model,
    __observed: true,
    async complete(request) {
      const started = Date.now();
      try {
        const out = await provider.complete(request);
        record({ kind: 'model', purpose: request && request.schemaName, provider: provider.name || (out && out.usage && out.usage.provider) || null,
          model: (out && out.usage && out.usage.model) || provider.model || null, prompt: request && request.prompt,
          inputTokens: out && out.usage ? out.usage.inputTokens : null, outputTokens: out && out.usage ? out.usage.outputTokens : null,
          latencyMs: (out && out.usage && out.usage.latencyMs) || (Date.now() - started), outcome: 'ok' });
        return out;
      } catch (err) {
        const outcome = err && err.code === 'ai_refusal' ? 'refused' : err && err.code === 'ai_invalid_output' ? 'invalid_output'
          : /abort|timeout|took too long/i.test(String(err && err.message)) ? 'timeout' : 'failed';
        record({ kind: 'model', purpose: request && request.schemaName, provider: provider.name || null, model: provider.model || null,
          prompt: request && request.prompt, latencyMs: Date.now() - started, outcome, error: err && err.message });
        throw err;
      }
    },
  };
  return wrapped;
}

module.exports = { run, current, extend, record, forGoal, recent, observed, redact, KEEP_DAYS };
