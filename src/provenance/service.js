'use strict';

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { NODES, RELATIONS } = require('./registry');

function normalizeRef(value, name) {
  const type = String(value && value.type || '').trim();
  const id = String(value && value.id || '').trim();
  if (!NODES[type] || !id) throw new ValidationError(`${name} is not a registered business record.`);
  return { type, id };
}

function exists(db, workspaceId, ref) {
  const node = NODES[ref.type];
  return Boolean(db.prepare(`SELECT 1 FROM ${node.table} WHERE id = ? AND workspace_id = ?`).get(ref.id, workspaceId));
}

function relationKey(type, from, to, evidence) {
  return crypto.createHash('sha256').update([
    type, from.type, from.id, to.type, to.id,
    evidence ? evidence.type : '', evidence ? evidence.id : '',
  ].join('|')).digest('hex');
}

function record(db, workspaceId, input) {
  const type = String(input.type || '').trim().toUpperCase();
  const definition = RELATIONS[type];
  if (!definition) throw new ValidationError(`Unknown business relation: ${type || 'blank'}.`);
  const from = normalizeRef(input.from, 'The upstream record');
  const to = normalizeRef(input.to, 'The downstream record');
  const evidence = input.evidence ? normalizeRef(input.evidence, 'The evidence record') : null;
  if (!definition.from.includes(from.type) || !definition.to.includes(to.type)) {
    throw new ValidationError(`${type} cannot connect ${from.type} to ${to.type}.`);
  }
  if (!exists(db, workspaceId, from) || !exists(db, workspaceId, to)
      || (evidence && !exists(db, workspaceId, evidence))) {
    throw new NotFoundError('A business relation cannot cross workspaces or point to a missing record.');
  }
  if (input.domainEventId && !exists(db, workspaceId, { type: 'domain_event', id: input.domainEventId })) {
    throw new NotFoundError('The relation event could not be found in this workspace.');
  }
  const key = relationKey(type, from, to, evidence);
  db.prepare(`INSERT OR IGNORE INTO business_relations
    (id, workspace_id, relation_key, relation_type, from_type, from_id, to_type, to_id,
     evidence_type, evidence_id, domain_event_id, basis, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId('relation'), workspaceId, key, type, from.type, from.id, to.type, to.id,
      evidence && evidence.type, evidence && evidence.id, input.domainEventId || null,
      input.basis || 'DIRECT_RECORD', JSON.stringify(input.metadata || {}), input.createdAt || nowIso());
  return db.prepare('SELECT * FROM business_relations WHERE workspace_id = ? AND relation_key = ?')
    .get(workspaceId, key);
}

function recordMany(db, workspaceId, relations, defaults = {}) {
  return (relations || []).map((relation) => record(db, workspaceId, { ...defaults, ...relation }));
}

function parse(row) {
  return { ...row, metadata: (() => { try { return JSON.parse(row.metadata || '{}'); } catch { return {}; } })() };
}

function neighbours(db, workspaceId, ref) {
  const normalized = normalizeRef(ref, 'The starting record');
  if (!exists(db, workspaceId, normalized)) throw new NotFoundError('That business record could not be found.');
  return db.prepare(`SELECT * FROM business_relations
    WHERE workspace_id = ? AND ((from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?))
    ORDER BY created_at, id`).all(workspaceId, normalized.type, normalized.id, normalized.type, normalized.id).map(parse);
}

function trace(db, workspaceId, start, options = {}) {
  // Exact-FK backfill is idempotent and deliberately runs before a read so old
  // workspaces gain the same evidence chain without guessing relationships.
  if (options.backfill !== false) require('./backfill').backfillWorkspace(db, workspaceId);
  const root = normalizeRef(start, 'The starting record');
  if (!exists(db, workspaceId, root)) throw new NotFoundError('That business record could not be found.');
  const maxDepth = Math.max(1, Math.min(Number(options.depth || 8), 16));
  const maxRelations = Math.max(1, Math.min(Number(options.maxRelations || 500), 2000));
  const allowed = typeof options.canSee === 'function' ? options.canSee : () => true;
  const queue = [{ ...root, depth: 0 }];
  const seenNodes = new Set([`${root.type}:${root.id}`]);
  const seenRelations = new Set();
  const relations = [];
  while (queue.length && relations.length < maxRelations) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;
    for (const row of neighbours(db, workspaceId, current)) {
      if (seenRelations.has(row.id)) continue;
      const from = { type: row.from_type, id: row.from_id };
      const to = { type: row.to_type, id: row.to_id };
      if (!allowed(from) || !allowed(to)) continue;
      seenRelations.add(row.id);
      relations.push(row);
      for (const endpoint of [from, to]) {
        const key = `${endpoint.type}:${endpoint.id}`;
        if (!seenNodes.has(key)) { seenNodes.add(key); queue.push({ ...endpoint, depth: current.depth + 1 }); }
      }
    }
  }
  return { root, relations, incomplete: relations.length >= maxRelations };
}

module.exports = { record, recordMany, neighbours, trace, exists, relationKey };

