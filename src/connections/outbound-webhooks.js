'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const credentials = require('./credentials');
const outbox = require('../operations/outbox');
const { ValidationError } = require('../domain/errors');
const { newId, nowIso, requireText } = require('../lib/util');

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const parse = (value, fallback = []) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

function validateEndpoint(value) {
  let url; try { url = new URL(requireText(value, 'Webhook URL', { max: 500 })); }
  catch { throw new ValidationError('Enter a valid webhook URL.'); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !((config.env !== 'production') && local)) {
    throw new ValidationError('Outbound webhooks require HTTPS (localhost is allowed only outside production).');
  }
  if (url.username || url.password) throw new ValidationError('Webhook URLs cannot contain credentials.');
  return url.toString();
}

function create(db, ctx, input = {}) {
  const name = requireText(input.name, 'Webhook name', { max: 100 });
  const endpoint = validateEndpoint(input.endpointUrl);
  const eventTypes = [...new Set((Array.isArray(input.eventTypes) ? input.eventTypes : [input.eventTypes])
    .filter(Boolean).map(String))];
  if (!eventTypes.length) throw new ValidationError('Choose at least one event type.');
  const secret = `whsec_${crypto.randomBytes(32).toString('base64url')}`;
  const sealed = credentials.encrypt({ secret });
  const id = newId('whsub'); const now = nowIso();
  db.prepare(`INSERT INTO outbound_webhook_subscriptions
    (id, workspace_id, name, endpoint_url, event_types, signing_secret_hash,
     signing_secret_encrypted, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, name, endpoint, JSON.stringify(eventTypes), digest(secret),
      JSON.stringify(sealed), ctx.actorId, now, now);
  return { id, name, endpointUrl: endpoint, eventTypes, secret };
}

function list(db, workspaceId) {
  return db.prepare(`SELECT * FROM outbound_webhook_subscriptions WHERE workspace_id = ?
    ORDER BY created_at DESC`).all(workspaceId).map((row) => ({ ...row, eventTypes: parse(row.event_types) }));
}

function revoke(db, workspaceId, id) {
  const changed = db.prepare(`UPDATE outbound_webhook_subscriptions SET status = 'REVOKED', updated_at = ?
    WHERE workspace_id = ? AND id = ? AND status <> 'REVOKED'`).run(nowIso(), workspaceId, id);
  if (!changed.changes) throw new ValidationError('That webhook is already revoked or does not exist.');
}

function enqueueForEvent(db, event) {
  const subscriptions = db.prepare(`SELECT * FROM outbound_webhook_subscriptions
    WHERE workspace_id = ? AND status = 'ACTIVE'`).all(event.workspaceId);
  for (const subscription of subscriptions) {
    const types = parse(subscription.event_types);
    if (!types.includes('*') && !types.includes(event.type)) continue;
    const payload = { id: event.id, type: event.type, occurredAt: event.createdAt,
      workspaceId: event.workspaceId, data: event.payload };
    const deliveryId = newId('whdel'); const now = nowIso();
    const inserted = db.prepare(`INSERT INTO outbound_webhook_deliveries
      (id, workspace_id, subscription_id, domain_event_id, event_type, payload_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(subscription_id, domain_event_id) DO NOTHING`)
      .run(deliveryId, event.workspaceId, subscription.id, event.id, event.type,
        digest(JSON.stringify(payload)), now);
    if (!inserted.changes) continue;
    const queued = outbox.enqueue(db, { workspaceId: event.workspaceId, destination: 'outbound.webhook',
      messageType: event.type, payload: { deliveryId, subscriptionId: subscription.id, payload },
      idempotencyKey: `webhook:${subscription.id}:${event.id}` });
    db.prepare('UPDATE outbound_webhook_deliveries SET outbox_message_id = ? WHERE id = ?')
      .run(queued.message.id, deliveryId);
  }
}

function revealSecret(row) {
  const sealed = parse(row.signing_secret_encrypted, {});
  return credentials.decrypt({ ciphertext: sealed.ciphertext, iv: sealed.iv, auth_tag: sealed.authTag }).secret;
}

function dispatcher(db, options = {}) {
  const request = options.fetchImpl || global.fetch;
  return async (message) => {
    const delivery = db.prepare(`SELECT d.*, s.endpoint_url, s.signing_secret_encrypted, s.status AS subscription_status
      FROM outbound_webhook_deliveries d JOIN outbound_webhook_subscriptions s ON s.id = d.subscription_id
      WHERE d.id = ?`).get(message.payload.deliveryId);
    if (!delivery || delivery.subscription_status !== 'ACTIVE') return { skipped: true };
    const body = JSON.stringify(message.payload.payload); const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', revealSecret(delivery)).update(`${timestamp}.${body}`).digest('hex');
    try {
      const response = await request(delivery.endpoint_url, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-foundry-event-id': delivery.domain_event_id,
        'x-foundry-timestamp': timestamp, 'x-foundry-signature': `v1=${signature}`,
        'idempotency-key': delivery.domain_event_id }, body });
      if (!response.ok) throw Object.assign(new Error(`Webhook returned HTTP ${response.status}.`), { responseStatus: response.status });
      const now = nowIso();
      db.prepare(`UPDATE outbound_webhook_deliveries SET status = 'DELIVERED', attempt_count = attempt_count + 1,
        response_status = ?, delivered_at = ?, last_error = NULL WHERE id = ?`).run(response.status, now, delivery.id);
      db.prepare(`UPDATE outbound_webhook_subscriptions SET last_success_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ?`).run(now, now, delivery.subscription_id);
      return { status: response.status };
    } catch (error) {
      db.prepare(`UPDATE outbound_webhook_deliveries SET status = 'FAILED', attempt_count = attempt_count + 1,
        response_status = ?, last_error = ? WHERE id = ?`).run(error.responseStatus || null,
        String(error.message).slice(0, 500), delivery.id);
      db.prepare(`UPDATE outbound_webhook_subscriptions SET last_error = ?, updated_at = ? WHERE id = ?`)
        .run(String(error.message).slice(0, 500), nowIso(), delivery.subscription_id);
      throw error;
    }
  };
}

module.exports = { create, list, revoke, enqueueForEvent, dispatcher, validateEndpoint, digest };
