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

/*
 * How much model time one inventory may use.
 *
 * A runaway page, a pasted novel or a stuck retry loop used to be able to
 * spend without limit. Three ceilings, each with a plain sentence when it is
 * reached: how many model reads may run at once for one inventory, how
 * many may start in a minute, and how many tokens a day. Reads in code —
 * most of what the assistant does now — are not counted; they cost nothing.
 * Background work (the autopilot runner) has no inventory in its context and
 * is not limited here.
 */
const LIMITS = {
  get concurrent() { return Number(process.env.FOUNDRY_AI_CONCURRENT_PER_WORKSPACE || 4); },
  get perMinute() { return Number(process.env.FOUNDRY_AI_CALLS_PER_MINUTE || 60); },
  get tokensPerDay() { return Number(process.env.FOUNDRY_AI_TOKENS_PER_DAY || 3000000); },
};
const inFlight = new Map();
const recentStarts = new Map();

class CeilingError extends Error {
  constructor(message, code) { super(message); this.code = code; this.status = 429; this.retryable = false; }
}

function ceilingFor(context) {
  const ws = context && context.workspaceId;
  if (!ws) return null;
  const running = inFlight.get(ws) || 0;
  if (running >= LIMITS.concurrent) {
    return new CeilingError(`StockChief is already reading ${running} things for this inventory. Wait a moment and try again; nothing was changed.`, 'ai_busy');
  }
  const now = Date.now();
  const starts = (recentStarts.get(ws) || []).filter((t) => now - t < 60000);
  recentStarts.set(ws, starts);
  if (starts.length >= LIMITS.perMinute) {
    return new CeilingError(`This inventory has asked StockChief to read ${starts.length} things in the last minute, which is its limit. Wait a minute and try again; nothing was changed.`, 'ai_rate_limited');
  }
  if (context.db) {
    try {
      const since = new Date(now - 86400000).toISOString();
      const used = context.db.prepare(`SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) n FROM ai_calls WHERE workspace_id = ? AND kind = 'model' AND created_at >= ?`).get(ws, since).n;
      if (used >= LIMITS.tokensPerDay) {
        return new CeilingError(`This inventory has used today's allowance for model reads (${Math.round(used / 1000)}k of ${Math.round(LIMITS.tokensPerDay / 1000)}k tokens). Lookups StockChief does in code still work; model reads resume as the day rolls over. Nothing was changed.`, 'ai_daily_ceiling');
      }
    } catch { /* no table yet: no ceiling */ }
  }
  return null;
}

/** What one inventory has used, for a settings page or a test. */
function usage(db, workspaceId) {
  const since = new Date(Date.now() - 86400000).toISOString();
  const row = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) tokens FROM ai_calls WHERE workspace_id = ? AND kind = 'model' AND created_at >= ?`).get(workspaceId, since);
  return { calls: Number(row.calls), tokens: Number(row.tokens), tokensPerDay: LIMITS.tokensPerDay, inFlight: inFlight.get(workspaceId) || 0 };
}

/*
 * The last day and the last thirty, in plain terms for the settings page:
 * how many model reads, how much of the day's allowance, how many answers
 * needed no model at all, what the reads were for, and how they ended.
 */
const PURPOSE_LABELS = {
  stockchief_semantic_query: 'planning an answer to a question',
  inventory_action_intent: 'reading an instruction',
  manager_intent: 'deciding what a message is',
  assistant_understanding: 'splitting a message into its parts',
  assistant_mail_draft: 'writing a message from your records',
  assistant_general_knowledge: 'answering a general question',
  selling_price_change: 'reading a price change',
  selling_price_changes: 'reading a price list',
  operating_instruction: 'reading a standing rule',
};
function usageSummary(db, workspaceId) {
  const day = usage(db, workspaceId);
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const month = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) tokens,
      SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) ok, SUM(CASE WHEN outcome IN ('timeout', 'failed') THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN outcome = 'refused' THEN 1 ELSE 0 END) refused, ROUND(AVG(latency_ms)) avg_ms
    FROM ai_calls WHERE workspace_id = ? AND kind = 'model' AND created_at >= ?`).get(workspaceId, since30);
  const tools = db.prepare(`SELECT COUNT(*) n FROM ai_calls WHERE workspace_id = ? AND kind = 'tool' AND created_at >= ?`).get(workspaceId, since30);
  const purposes = db.prepare(`SELECT purpose, COUNT(*) n, COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) tokens
    FROM ai_calls WHERE workspace_id = ? AND kind = 'model' AND created_at >= ? GROUP BY purpose ORDER BY n DESC LIMIT 8`).all(workspaceId, since30)
    .map((r) => ({ purpose: r.purpose, label: PURPOSE_LABELS[r.purpose] || String(r.purpose).replace(/_/g, ' '), calls: Number(r.n), tokens: Number(r.tokens) }));
  const goalsWithModel = db.prepare(`SELECT COUNT(DISTINCT goal_id) n FROM ai_calls WHERE workspace_id = ? AND kind = 'model' AND goal_id IS NOT NULL AND created_at >= ?`).get(workspaceId, since30).n;
  let goals = 0;
  try { goals = db.prepare(`SELECT COUNT(*) n FROM assistant_goals g JOIN assistant_turns t ON t.id = g.turn_id WHERE t.workspace_id = ? AND g.created_at >= ? AND g.status <> 'pending'`).get(workspaceId, since30).n; } catch { goals = 0; }
  return {
    today: { calls: day.calls, tokens: day.tokens, allowance: day.tokensPerDay, pct: day.tokensPerDay ? Math.min(100, Math.round((day.tokens / day.tokensPerDay) * 100)) : 0, inFlight: day.inFlight },
    month: { calls: Number(month.calls), tokens: Number(month.tokens), ok: Number(month.ok || 0), failed: Number(month.failed || 0), refused: Number(month.refused || 0), avgMs: Number(month.avg_ms || 0), toolCalls: Number(tools.n) },
    goals: { total: Number(goals), withModel: Number(goalsWithModel), inCode: Math.max(0, Number(goals) - Number(goalsWithModel)) },
    purposes,
    limits: { concurrent: LIMITS.concurrent, perMinute: LIMITS.perMinute, tokensPerDay: LIMITS.tokensPerDay },
  };
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
      const context = current();
      const ceiling = ceilingFor(context);
      if (ceiling) {
        record({ kind: 'model', purpose: request && request.schemaName, provider: provider.name || null, model: provider.model || null,
          prompt: request && request.prompt, latencyMs: 0, outcome: 'refused', error: ceiling.code });
        throw ceiling;
      }
      const ws = context && context.workspaceId;
      if (ws) {
        inFlight.set(ws, (inFlight.get(ws) || 0) + 1);
        recentStarts.set(ws, [...(recentStarts.get(ws) || []), started]);
      }
      try {
        const raw = await provider.complete(request);
        // A name the model saw with [removed] in it comes back matchable (src/ai/guard.js).
        const out = raw && raw.data && typeof raw.data === 'object' ? { ...raw, data: require('../ai/guard').fromModel(raw.data) } : raw;
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
        // Whatever a provider throws is a provider failure at this boundary,
        // never a bare Error that a page would show as "something went wrong on our side".
        if (err && !(err instanceof require('../domain/errors').DomainError) && !err.code) {
          // Lazy: provider.js requires this module.
          const { ProviderError } = require('../ai/provider');
          throw new ProviderError('StockChief could not reach its model just now. Nothing was read and nothing changed — please try again.', { cause: err, retryable: true });
        }
        throw err;
      } finally {
        if (ws) inFlight.set(ws, Math.max(0, (inFlight.get(ws) || 1) - 1));
      }
    },
  };
  return wrapped;
}

/** Whether a provider was unreachable or timed out during this request. */
function unavailableNow() {
  const context = current();
  return Boolean(context && context.unavailable);
}

module.exports = { run, current, extend, record, forGoal, recent, observed, redact, usage, usageSummary, ceilingFor, CeilingError, LIMITS, KEEP_DAYS, unavailableNow };
