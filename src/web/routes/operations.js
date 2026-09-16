'use strict';

const express = require('express');
const config = require('../../config');
const readiness = require('../../operations/readiness');
const certification = require('../../operations/certification');
const jobs = require('../../operations/job-queue');
const outbox = require('../../operations/outbox');
const monitoring = require('../../operations/monitoring');
const checkpoints = require('../../operations/checkpoints');
const { requirePermission } = require('../middleware');
const permissions = require('../../actions/permissions');

const router = express.Router();
router.use('/settings/operations', requirePermission(permissions.ADMIN, 'manage production operations'));

router.get('/settings/operations', (req, res) => {
  res.page('settings/operations', {
    title: 'Production operations', nav: 'settings',
    // This screen certifies the production target even when an engineer opens
    // it on localhost. Development readiness may be healthy while the release
    // is still missing external alert, email, backup or browser evidence.
    readiness: readiness.snapshot(req.db, { env: 'production' }),
    deadJobs: jobs.listDead(req.db),
    deadMessages: outbox.listDead(req.db),
    alerts: req.db.prepare(`SELECT * FROM operational_alerts
      WHERE status != 'RESOLVED' ORDER BY last_seen_at DESC LIMIT 100`).all(),
    runs: req.db.prepare(`SELECT * FROM production_certification_runs
      ORDER BY started_at DESC LIMIT 20`).all(),
    backTo: { href: '/settings', label: 'Settings' },
  });
});

router.post('/settings/operations/jobs/:id/retry', (req, res) => {
  const job = jobs.retryDead(req.db, req.params.id, { by: req.user.id });
  req.flash(job ? 'success' : 'warn', job ? 'The job is queued for a controlled retry.' : 'That job is not dead-lettered.');
  res.redirect(303, '/settings/operations#dead-letters');
});

router.post('/settings/operations/outbox/:id/retry', (req, res) => {
  const message = outbox.retryDead(req.db, req.params.id);
  req.flash(message ? 'success' : 'warn', message ? 'The message is queued for a controlled retry.' : 'That message is not dead-lettered.');
  res.redirect(303, '/settings/operations#dead-letters');
});

router.post('/settings/operations/alerts/test', (req, res) => {
  const alert = monitoring.raise(req.db, {
    severity: 'WARNING', kind: 'certification.injected',
    title: 'StockChief production alert test',
    detail: 'This is an intentional Mission 4 alert. A monitored responder must acknowledge it.',
    fingerprint: `certification.injected:${Date.now()}`,
  });
  req.flash(config.operations.alertWebhookUrl ? 'success' : 'warn',
    config.operations.alertWebhookUrl
      ? `Alert ${alert.id} is queued. Mission 4 passes only after the responder acknowledges it.`
      : 'The alert was recorded, but no external alert webhook is configured.');
  res.redirect(303, '/settings/operations#alerts');
});

router.post('/settings/operations/alerts/:id/resolve', (req, res) => {
  monitoring.resolve(req.db, req.params.id);
  req.flash('success', 'The operational incident is resolved; its evidence remains recorded.');
  res.redirect(303, '/settings/operations#alerts');
});

router.post('/settings/operations/certify', (req, res) => {
  const result = certification.run(req.db, { environment: 'production' });
  req.flash(result.ok ? 'success' : 'warn', result.ok
    ? `Certification ${result.id} passed.`
    : `Certification ${result.id} is blocked by: ${result.blockers.join(', ')}.`);
  res.redirect(303, '/settings/operations#certification');
});

router.post('/settings/operations/support-evidence', (req, res) => {
  const tester = String(req.body.tester || '').trim().slice(0, 160);
  const evidence = String(req.body.evidence || '').trim().slice(0, 1000);
  if (!config.supportEmail || req.body.monitored !== 'yes' || !tester || !evidence) {
    req.flash('warn', 'Configure the support email, complete the send-and-reply test, and identify its evidence.');
  } else {
    checkpoints.record(req.db, 'support.mailbox', 'PASS', {
      monitored: true, mailbox: config.supportEmail, tester, evidence,
    });
    req.flash('success', 'Monitored support ownership is recorded.');
  }
  res.redirect(303, '/settings/operations#human-gates');
});

router.post('/settings/operations/zero-training', (req, res) => {
  const tester = String(req.body.tester || '').trim().slice(0, 160);
  const evidence = String(req.body.evidence || '').trim().slice(0, 2000);
  if (req.body.independent !== 'yes' || !tester || !evidence) {
    req.flash('warn', 'Name the independent tester and record what they completed and what confused them.');
  } else {
    checkpoints.record(req.db, 'zero_training.walkthrough', 'PASS', {
      independentUser: true, tester, evidence,
      scope: ['Inventory','Purchasing','supplier email','Sales Orders','Needs You','Accounting'],
    });
    req.flash('success', 'The independent zero-training walkthrough is recorded.');
  }
  res.redirect(303, '/settings/operations#human-gates');
});

module.exports = router;
