'use strict';

/**
 * Durable owner email alerts.
 *
 * Detection and email delivery are deliberately separate. Detection commits
 * the Needs You item first; this module then puts an encrypted message in the
 * existing retrying outbox. A provider outage can therefore never roll back an
 * inventory movement or make an attention item disappear.
 */

const config = require('../config');
const credentials = require('../connections/credentials');
const outbox = require('../operations/outbox');
const { ValidationError } = require('../domain/errors');
const { nowIso } = require('../lib/util');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LEVEL = { critical: 3, important: 2, watch: 1, info: 1 };

function uniqueEmails(values) {
  const list = Array.isArray(values) ? values : String(values || '').split(/[\s,;]+/);
  return [...new Set(list.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function ownerEmails(db, workspaceId) {
  return uniqueEmails(db.prepare(`SELECT a.email FROM users u
    JOIN accounts a ON a.id = u.account_id
    WHERE u.workspace_id = ? AND u.role = 'owner' AND a.password_hash != ''
    ORDER BY u.created_at`).all(workspaceId).map((row) => row.email));
}

function parse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function get(db, workspaceId) {
  const row = db.prepare('SELECT * FROM notification_email_settings WHERE workspace_id = ?')
    .get(workspaceId);
  const stored = row ? uniqueEmails(parse(row.recipients, [])) : [];
  return {
    enabled: Boolean(row && row.enabled),
    minimumSeverity: row ? row.minimum_severity : 'important',
    recipients: stored.length ? stored : ownerEmails(db, workspaceId),
    usesOwnerFallback: stored.length === 0,
    deliveryConfigured: config.email.configured,
    updatedAt: row ? row.updated_at : null,
  };
}

function save(db, workspaceId, input = {}) {
  const enabled = input.enabled === true || input.enabled === 1 || input.enabled === '1';
  const minimumSeverity = ['critical', 'important', 'all'].includes(input.minimumSeverity)
    ? input.minimumSeverity : 'important';
  const recipients = uniqueEmails(input.recipients);
  const invalid = recipients.filter((email) => !EMAIL.test(email));
  if (invalid.length) throw new ValidationError(`Enter a valid email address: ${invalid[0]}`);
  const effective = recipients.length ? recipients : ownerEmails(db, workspaceId);
  if (enabled && effective.length === 0) {
    throw new ValidationError('Add at least one alert recipient before enabling email alerts.');
  }
  const now = nowIso();
  db.prepare(`INSERT INTO notification_email_settings
    (workspace_id, enabled, minimum_severity, recipients, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET enabled = excluded.enabled,
      minimum_severity = excluded.minimum_severity, recipients = excluded.recipients,
      updated_at = excluded.updated_at`)
    .run(workspaceId, enabled ? 1 : 0, minimumSeverity, JSON.stringify(recipients), now, now);
  return get(db, workspaceId);
}

function allowed(setting, severity) {
  if (!setting.enabled) return false;
  if (setting.minimumSeverity === 'all') return true;
  return (LEVEL[severity] || 0) >= LEVEL[setting.minimumSeverity];
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function absoluteLink(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const origin = config.connections.publicOrigin;
  return origin ? `${origin.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}` : null;
}

function queueMessage(db, workspaceId, input, options = {}) {
  const setting = get(db, workspaceId);
  if (!allowed(setting, input.severity || 'info')) return { queued: 0, reason: 'below_preference' };
  const deliveryConfigured = options.deliveryConfigured === undefined
    ? config.email.configured : Boolean(options.deliveryConfigured);
  if (!deliveryConfigured) return { queued: 0, reason: 'delivery_not_configured' };

  const link = absoluteLink(input.link);
  const detail = [input.body, input.recommendation].filter(Boolean).join('\n\n');
  let queued = 0;
  for (const to of setting.recipients) {
    const text = [input.title, detail, link ? `Open in StockChief: ${link}` : null]
      .filter(Boolean).join('\n\n');
    const html = `<h2>${escapeHtml(input.title)}</h2>`
      + (detail ? `<p>${escapeHtml(detail).replace(/\n/g, '<br>')}</p>` : '')
      + (link ? `<p><a href="${escapeHtml(link)}">Open this in StockChief</a></p>` : '')
      + '<p style="color:#667085">This message was sent because this inventory is configured to email newly opened actionable items. Rechecking the same item does not send it again.</p>';
    const sealed = credentials.encrypt({
      to,
      subject: `[StockChief] ${input.title}`,
      text,
      html,
    });
    const result = outbox.enqueue(db, {
      workspaceId,
      destination: 'email',
      messageType: input.messageType || 'needs_you_alert',
      idempotencyKey: `${input.idempotencyKey}:${to}`,
      payload: { sealed },
      now: options.now,
    });
    if (result.created) queued += 1;
  }
  return { queued, reason: queued ? null : 'already_queued' };
}

function queueAttention(db, workspaceId, occurrences, options = {}) {
  const results = [];
  for (const occurrence of occurrences || []) {
    const item = db.prepare(`SELECT id, severity, title, concise_summary, recommendation
      FROM attention_items WHERE id = ? AND workspace_id = ?`).get(occurrence.attentionId, workspaceId);
    if (!item) continue;
    results.push(queueMessage(db, workspaceId, {
      severity: item.severity,
      title: item.title,
      body: item.concise_summary,
      recommendation: item.recommendation,
      link: `/attention/${item.id}`,
      idempotencyKey: `attention:${item.id}:${occurrence.occurrenceKey}`,
    }, options));
  }
  return results;
}

function queueNotification(db, workspaceId, notification, options = {}) {
  if (!notification || notification.kind === 'action_completed') {
    return { queued: 0, reason: 'not_actionable' };
  }
  return queueMessage(db, workspaceId, {
    severity: notification.severity || 'info',
    title: notification.title,
    body: notification.body,
    link: notification.link || '/needs-you',
    idempotencyKey: `notification:${notification.id}`,
  }, options);
}

function queueTest(db, workspaceId, options = {}) {
  return queueMessage(db, workspaceId, {
    severity: 'critical',
    title: 'StockChief email alerts are working',
    body: 'This is a delivery test. No inventory condition was created and nothing was changed.',
    link: '/settings#email-alerts',
    idempotencyKey: `email-alert-test:${Date.now()}`,
    messageType: 'email_alert_test',
  }, options);
}

module.exports = {
  uniqueEmails, ownerEmails, get, save, allowed, queueMessage,
  queueAttention, queueNotification, queueTest,
};
