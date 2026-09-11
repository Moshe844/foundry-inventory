'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const outbox = require('./outbox');
const { newId, nowIso } = require('../lib/util');

function fingerprint(input) {
  if (input.fingerprint) return String(input.fingerprint);
  return crypto.createHash('sha256')
    .update(`${input.kind || 'runtime'}\0${input.title || ''}\0${input.detail || ''}`)
    .digest('hex');
}

function raise(db, input = {}, options = {}) {
  const fp = fingerprint(input);
  const now = options.nowIso || nowIso();
  let row = db.prepare(`SELECT * FROM operational_alerts WHERE fingerprint = ?
    AND status IN ('OPEN','DELIVERED','ACKNOWLEDGED')`).get(fp);
  if (row) {
    db.prepare(`UPDATE operational_alerts SET occurrence_count = occurrence_count + 1,
      last_seen_at = ?, detail = ? WHERE id = ?`).run(now, String(input.detail || row.detail), row.id);
  } else {
    const id = newId('alert');
    db.prepare(`INSERT INTO operational_alerts
      (id, severity, kind, title, detail, fingerprint, status, occurrence_count,
       first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, 'OPEN', 1, ?, ?)`)
      .run(id, input.severity || 'ERROR', input.kind || 'runtime',
        String(input.title || 'Foundry operational alert'), String(input.detail || ''), fp, now, now);
    row = db.prepare('SELECT * FROM operational_alerts WHERE id = ?').get(id);
  }
  row = db.prepare('SELECT * FROM operational_alerts WHERE id = ?').get(row.id);
  const webhookUrl = options.webhookUrl === undefined ? config.operations.alertWebhookUrl : options.webhookUrl;
  if (webhookUrl) {
    outbox.enqueue(db, {
      destination: 'monitoring.webhook',
      messageType: 'operational_alert',
      idempotencyKey: `${row.id}:${row.occurrence_count}`,
      payload: { alertId: row.id },
      now: options.now,
    });
  }
  return row;
}

function get(db, id) {
  return db.prepare('SELECT * FROM operational_alerts WHERE id = ?').get(id) || null;
}

function acknowledge(db, id, actor) {
  const changed = db.prepare(`UPDATE operational_alerts SET status = 'ACKNOWLEDGED',
    acknowledged_at = ?, acknowledged_by = ?
    WHERE id = ? AND status IN ('OPEN','DELIVERED')`)
    .run(nowIso(), String(actor || 'external responder'), id);
  if (!changed.changes) return null;
  require('./checkpoints').record(db, 'alert.acknowledged', 'PASS', { alertId: id, actor });
  return get(db, id);
}

function resolve(db, id) {
  db.prepare(`UPDATE operational_alerts SET status = 'RESOLVED', resolved_at = ?
    WHERE id = ? AND status != 'RESOLVED'`).run(nowIso(), id);
  return get(db, id);
}

function webhookDispatcher(db, options = {}) {
  return async (message) => {
    const alert = get(db, message.payload.alertId);
    if (!alert) {
      const error = new Error('Alert no longer exists.');
      error.retryable = false;
      throw error;
    }
    const url = options.url || config.operations.alertWebhookUrl;
    if (!url) {
      const error = new Error('External alert delivery is not configured.');
      error.retryable = false;
      throw error;
    }
    const origin = config.connections.publicOrigin;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.token || config.operations.alertWebhookToken
          ? { authorization: `Bearer ${options.token || config.operations.alertWebhookToken}` } : {}),
      },
      body: JSON.stringify({
        id: alert.id,
        severity: alert.severity,
        kind: alert.kind,
        title: alert.title,
        detail: alert.detail,
        occurrenceCount: alert.occurrence_count,
        firstSeenAt: alert.first_seen_at,
        lastSeenAt: alert.last_seen_at,
        acknowledgeUrl: origin ? `${origin}/api/v1/operations/alerts/${alert.id}/ack` : null,
      }),
    });
    if (!response.ok) {
      const error = new Error(`Alert endpoint returned ${response.status}.`);
      error.status = response.status;
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    db.prepare(`UPDATE operational_alerts SET status = 'DELIVERED', delivered_at = ?
      WHERE id = ? AND status = 'OPEN'`).run(nowIso(), alert.id);
    require('./checkpoints').record(db, 'alert.delivered', 'PASS', { alertId: alert.id, status: response.status });
    return { delivered: true, status: response.status };
  };
}

module.exports = { fingerprint, raise, get, acknowledge, resolve, webhookDispatcher };
