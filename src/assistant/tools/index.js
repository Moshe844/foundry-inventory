'use strict';

/**
 * The tool registry: every way the assistant can read, change, draft or
 * navigate, declared once.
 *
 * A tool has an id, a kind, a JSON schema for its input, the permission it
 * needs, a handler and a typed result. Calling one validates the input
 * against the schema, checks the permission against the membership, runs the
 * handler, and records the call — purpose, latency, outcome — beside the
 * model calls in ai_calls. Reads wrap the record and lookup services, writes
 * wrap the action and price readers (which prepare proposals, never run
 * them), drafts wrap the outbound message service, and navigation wraps the
 * product brain.
 *
 * What this buys: there is one list of what StockChief can do, one place a
 * permission is checked before a route can forget to, and one record a
 * wrong answer can be traced through.
 */

const { ValidationError } = require('../../domain/errors');
const { validate } = require('../../foundry/validator');
const permissions = require('../../actions/permissions');
const calls = require('../calls');

const KINDS = ['read', 'write', 'draft', 'navigate'];
const TOOLS = new Map();

/** A plain sentence for a permission refused, never a code. */
function refusal(tool, membership) {
  const role = membership && membership.role ? ` (${membership.role})` : '';
  return `Your role${role} does not allow StockChief to ${tool.verb} on your behalf. Ask an inventory owner if you need that.`;
}

function define(tool) {
  if (!tool || typeof tool.id !== 'string' || !/^[a-z]+\.[a-z_]+$/.test(tool.id)) throw new Error(`A tool needs an id like "records.query": ${tool && tool.id}`);
  if (!KINDS.includes(tool.kind)) throw new Error(`Tool ${tool.id}: kind must be one of ${KINDS.join(', ')}`);
  if (!tool.input || tool.input.type !== 'object') throw new Error(`Tool ${tool.id}: input must be a JSON schema object`);
  if (typeof tool.handler !== 'function') throw new Error(`Tool ${tool.id}: a handler is required`);
  if (!tool.permission) throw new Error(`Tool ${tool.id}: a permission is required`);
  if (!tool.verb) throw new Error(`Tool ${tool.id}: say what it does, as a verb phrase, for refusals`);
  TOOLS.set(tool.id, Object.freeze({ ...tool }));
  return tool;
}

function get(id) {
  return TOOLS.get(id) || null;
}

/** Every tool, for a page or a prompt: id, kind, what it does, what it needs. */
function list() {
  return [...TOOLS.values()].map((t) => ({ id: t.id, kind: t.kind, description: t.description, permission: t.permission, input: t.input }));
}

/**
 * Calls a tool. The result is the handler's, wrapped: { tool, kind, ok,
 * result }. A refused permission or invalid input is a ValidationError with
 * a sentence the page can show; the handler's own errors pass through.
 */
async function call(db, ctx, membership, id, input, options = {}) {
  const tool = TOOLS.get(id);
  if (!tool) throw new ValidationError(`StockChief has no tool called “${String(id).slice(0, 60)}”.`);
  const started = Date.now();
  const finish = (outcome, error) => calls.record({ kind: 'tool', purpose: id, latencyMs: Date.now() - started, outcome, error,
    workspaceId: ctx && ctx.workspaceId, actorId: ctx && ctx.actorId, db });
  const checked = validate(tool.input, input && typeof input === 'object' ? input : {}, { key: `tool:${id}` });
  if (!checked.ok) {
    finish('invalid_input', checked.errors.join('; '));
    throw new ValidationError(`StockChief could not use ${tool.verb}: ${checked.errors.slice(0, 3).join('; ')}.`);
  }
  if (membership && !permissions.can(membership, tool.permission)) {
    finish('refused', `permission ${tool.permission}`);
    throw new ValidationError(refusal(tool, membership));
  }
  try {
    const result = await tool.handler(db, ctx, membership, checked.data, options);
    finish('ok');
    return { tool: id, kind: tool.kind, ok: true, result };
  } catch (err) {
    finish(err && err.status && err.status < 500 ? 'refused' : 'failed', err && err.message);
    throw err;
  }
}

/** The handler's result alone, for a route that already knows the tool. */
async function use(db, ctx, membership, id, input, options = {}) {
  return (await call(db, ctx, membership, id, input, options)).result;
}

module.exports = { define, get, list, call, use, KINDS };

// The tools register themselves on load.
require('./records');
require('./lookup');
require('./question');
require('./action');
require('./price');
require('./instruction');
require('./message');
require('./navigate');
