'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const { newId, nowIso } = require('../lib/util');

const stable = (value) => JSON.stringify(value || {});
const digest = (value) => crypto.createHash('sha256').update(stable(value)).digest('hex');

function receive(db, source, externalEventId, payload = {}) {
  if (!source || !externalEventId) throw new TypeError('Inbox events require a source and external id.');
  return inTransaction(db, () => {
    const prior = db.prepare(`SELECT * FROM runtime_inbox WHERE source = ? AND external_event_id = ?`)
      .get(source, externalEventId);
    const payloadHash = digest(payload);
    if (prior) {
      if (prior.payload_hash !== payloadHash) {
        return { row: prior, duplicate: true, conflict: true };
      }
      return { row: prior, duplicate: true, conflict: false };
    }
    const id = newId('inbox');
    db.prepare(`INSERT INTO runtime_inbox
      (id, source, external_event_id, payload_hash, payload, status, received_at)
      VALUES (?, ?, ?, ?, ?, 'RECEIVED', ?)`)
      .run(id, source, externalEventId, payloadHash, stable(payload), nowIso());
    return { row: db.prepare('SELECT * FROM runtime_inbox WHERE id = ?').get(id), duplicate: false, conflict: false };
  });
}

function process(db, source, externalEventId, handler) {
  return inTransaction(db, () => {
    const row = db.prepare(`SELECT * FROM runtime_inbox WHERE source = ? AND external_event_id = ?`)
      .get(source, externalEventId);
    if (!row) throw new Error('Inbox event was not received.');
    if (row.status === 'COMPLETED') return { duplicate: true, outcome: JSON.parse(row.outcome || '{}') };
    db.prepare(`UPDATE runtime_inbox SET status = 'PROCESSING', attempt_count = attempt_count + 1,
      last_error = NULL WHERE id = ?`).run(row.id);
    try {
      const outcome = handler(JSON.parse(row.payload));
      db.prepare(`UPDATE runtime_inbox SET status = 'COMPLETED', outcome = ?, processed_at = ? WHERE id = ?`)
        .run(JSON.stringify(outcome || {}), nowIso(), row.id);
      return { duplicate: false, outcome };
    } catch (error) {
      db.prepare(`UPDATE runtime_inbox SET status = 'FAILED', last_error = ?, processed_at = ? WHERE id = ?`)
        .run(String(error.message || error), nowIso(), row.id);
      throw error;
    }
  });
}

module.exports = { receive, process, digest };

