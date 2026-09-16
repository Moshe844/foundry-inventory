'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeDatabase, seedWorkspace } = require('../helpers');
const alerts = require('../../src/notifications/email-alerts');
const email = require('../../src/operations/email');

test('workspace email alerts are explicit, severity-filtered and idempotent', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { email: 'owner@alerts.example' });

  const initial = alerts.get(db, workspace.workspaceId);
  assert.equal(initial.enabled, false);
  assert.deepEqual(initial.recipients, ['owner@alerts.example']);

  const saved = alerts.save(db, workspace.workspaceId, {
    enabled: true,
    minimumSeverity: 'important',
    recipients: 'ops@alerts.example, owner@alerts.example',
  });
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.recipients, ['ops@alerts.example', 'owner@alerts.example']);

  const quiet = alerts.queueMessage(db, workspace.workspaceId, {
    severity: 'watch', title: 'Worth knowing', idempotencyKey: 'watch:1',
  }, { deliveryConfigured: true, now: 1_000 });
  assert.equal(quiet.queued, 0);

  const first = alerts.queueMessage(db, workspace.workspaceId, {
    severity: 'important', title: 'Stock needs a decision',
    body: 'SKU A is at its protected limit.', recommendation: 'Review replenishment.',
    link: '/attention/att_example', idempotencyKey: 'attention:att_example:first',
  }, { deliveryConfigured: true, now: 2_000 });
  assert.equal(first.queued, 2);

  const repeated = alerts.queueMessage(db, workspace.workspaceId, {
    severity: 'important', title: 'Stock needs a decision',
    link: '/attention/att_example', idempotencyKey: 'attention:att_example:first',
  }, { deliveryConfigured: true, now: 3_000 });
  assert.equal(repeated.queued, 0, 'the same occurrence is not emailed twice');

  const rows = db.prepare("SELECT * FROM runtime_outbox WHERE message_type = 'needs_you_alert' ORDER BY created_at")
    .all();
  assert.equal(rows.length, 2);
  const message = email.unseal(JSON.parse(rows[0].payload));
  assert.match(message.subject, /^\[StockChief\] Stock needs a decision$/);
  assert.match(message.text, /protected limit/);
  assert.ok(['ops@alerts.example', 'owner@alerts.example'].includes(message.to));
  assert.doesNotMatch(rows[0].payload, /ops@alerts\.example|protected limit/,
    'recipient and message body are encrypted at rest');
});

test('action-completed notices stay in-app while actionable work can email', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { email: 'owner@alerts.example' });
  alerts.save(db, workspace.workspaceId, {
    enabled: true, minimumSeverity: 'all', recipients: 'owner@alerts.example',
  });

  const completed = alerts.queueNotification(db, workspace.workspaceId, {
    id: 'ntf_done', kind: 'action_completed', severity: 'info', title: 'Done',
  }, { deliveryConfigured: true });
  assert.equal(completed.queued, 0);

  const approval = alerts.queueNotification(db, workspace.workspaceId, {
    id: 'ntf_waiting', kind: 'approval_required', severity: 'important',
    title: 'Approve a stock transfer', body: 'StockChief is waiting for you.', link: '/needs-you',
  }, { deliveryConfigured: true });
  assert.equal(approval.queued, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runtime_outbox').get().n, 1);
});

test('email alert recipient validation rejects malformed addresses', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  assert.throws(() => alerts.save(db, workspace.workspaceId, {
    enabled: true, recipients: 'not-an-email',
  }), /valid email address/i);
});
