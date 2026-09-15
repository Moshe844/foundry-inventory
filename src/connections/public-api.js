'use strict';

const crypto = require('node:crypto');
const { AuthenticationError, ValidationError } = require('../domain/errors');
const { newId, nowIso, requireText } = require('../lib/util');
const { inTransaction } = require('../db');

const PREFIX = 'fnd_api_';
const ALLOWED_SCOPES = Object.freeze([
  'inventory:read', 'inventory:write', 'events:read',
  // A source connector can stage and validate evidence. Approval, mutation and
  // cutover remain owner actions in Foundry.
  'migration:read', 'migration:write',
]);
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const parse = (value, fallback = []) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

function create(db, ctx, input = {}) {
  const name = requireText(input.name, 'API client name', { max: 100 });
  const requested = Array.isArray(input.scopes) ? input.scopes : [input.scopes].filter(Boolean);
  const scopes = [...new Set(requested.map(String))];
  if (!scopes.length || scopes.some((scope) => !ALLOWED_SCOPES.includes(scope))) {
    throw new ValidationError('Choose at least one supported API scope.');
  }
  const visible = crypto.randomBytes(6).toString('hex');
  const token = `${PREFIX}${visible}.${crypto.randomBytes(32).toString('base64url')}`;
  const id = newId('apiclient'); const now = nowIso();
  db.prepare(`INSERT INTO public_api_clients
    (id, workspace_id, name, scopes, token_prefix, token_hash, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, name, JSON.stringify(scopes), `${PREFIX}${visible}`, hash(token), ctx.actorId, now);
  return { id, token, prefix: `${PREFIX}${visible}`, name, scopes };
}

function authenticate(db, authorization, requiredScope) {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || ''));
  if (!match || !match[1].startsWith(PREFIX)) throw new AuthenticationError('Use a valid Foundry API bearer token.');
  const row = db.prepare(`SELECT c.*, u.account_id FROM public_api_clients c
    JOIN users u ON u.id = c.created_by_user_id AND u.workspace_id = c.workspace_id
    WHERE c.token_hash = ? AND c.revoked_at IS NULL`).get(hash(match[1]));
  if (!row) throw new AuthenticationError('This API token is invalid or revoked.');
  const scopes = parse(row.scopes);
  if (requiredScope && !scopes.includes(requiredScope)) {
    const error = new AuthenticationError(`This API token does not have ${requiredScope} authority.`);
    error.status = 403; throw error;
  }
  db.prepare('UPDATE public_api_clients SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { clientId: row.id, workspaceId: row.workspace_id, actorId: row.created_by_user_id,
    accountId: row.account_id, scopes };
}

function list(db, workspaceId) {
  return db.prepare(`SELECT id, name, scopes, token_prefix, created_at, last_used_at, revoked_at
    FROM public_api_clients WHERE workspace_id = ? ORDER BY created_at DESC`).all(workspaceId)
    .map((row) => ({ ...row, scopes: parse(row.scopes) }));
}

function revoke(db, workspaceId, id) {
  const changed = db.prepare(`UPDATE public_api_clients SET revoked_at = ?
    WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL`).run(nowIso(), workspaceId, id);
  if (!changed.changes) throw new ValidationError('That API client is already revoked or does not exist.');
}

function executeCommand(db, auth, input, handler) {
  const key = requireText(input.idempotencyKey, 'Idempotency-Key header', { max: 200 });
  const commandType = requireText(input.commandType, 'Command type', { max: 100 });
  const requestHash = hash(JSON.stringify(input.body || {}));
  return inTransaction(db, () => {
    const prior = db.prepare(`SELECT * FROM public_api_commands WHERE client_id = ? AND idempotency_key = ?`)
      .get(auth.clientId, key);
    if (prior) {
      if (prior.request_hash !== requestHash || prior.command_type !== commandType) {
        throw new ValidationError('That Idempotency-Key was already used for a different command.');
      }
      return { result: JSON.parse(prior.result), replayed: true };
    }
    const result = handler();
    db.prepare(`INSERT INTO public_api_commands
      (id, workspace_id, client_id, idempotency_key, command_type, request_hash, result, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId('apicmd'), auth.workspaceId, auth.clientId, key, commandType, requestHash,
        JSON.stringify(result), nowIso());
    return { result, replayed: false };
  });
}

module.exports = { PREFIX, ALLOWED_SCOPES, create, authenticate, list, revoke, executeCommand, hash };
