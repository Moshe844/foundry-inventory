'use strict';

const config = require('../config');
const checkpoints = require('./checkpoints');
const monitoring = require('./monitoring');

const DAY = 86_400_000;
const isoBefore = (now, days) => new Date(now - Math.max(1, Number(days)) * DAY).toISOString();

/**
 * Operational envelopes are finite. Business records, accounting entries,
 * provenance and audit history are intentionally absent: they are retained
 * until the workspace owner uses the governed deletion/export process.
 */
function apply(db, options = {}) {
  const now = Number(options.now || Date.now());
  const policy = options.policy || config.operations.retention;
  const removed = {};
  const remove = (key, sql, ...values) => { removed[key] = db.prepare(sql).run(...values).changes; };
  remove('deliveredMessages', `DELETE FROM runtime_outbox
    WHERE status IN ('DELIVERED','CANCELLED') AND updated_at < ?`, isoBefore(now, policy.deliveredMessagesDays));
  remove('completedJobs', `DELETE FROM runtime_jobs
    WHERE status IN ('COMPLETED','CANCELLED') AND updated_at < ?`, isoBefore(now, policy.deliveredMessagesDays));
  remove('inboxEvents', `DELETE FROM runtime_inbox
    WHERE status IN ('COMPLETED','REJECTED') AND processed_at < ?`, isoBefore(now, policy.inboxDays));
  remove('resolvedAlerts', `DELETE FROM operational_alerts
    WHERE status = 'RESOLVED' AND resolved_at < ?`, isoBefore(now, policy.resolvedAlertsDays));
  remove('resetTokens', `DELETE FROM password_reset_tokens
    WHERE (used_at IS NOT NULL OR expires_at < ?) AND created_at < ?`, now, isoBefore(now, policy.resetTokensDays));
  remove('certificationRuns', `DELETE FROM production_certification_runs
    WHERE completed_at IS NOT NULL AND completed_at < ?`, isoBefore(now, policy.certificationDays));
  checkpoints.record(db, 'retention.policy', 'PASS', { policy: {
    deliveredMessagesDays: policy.deliveredMessagesDays, inboxDays: policy.inboxDays,
    resolvedAlertsDays: policy.resolvedAlertsDays, resetTokensDays: policy.resetTokensDays,
    certificationDays: policy.certificationDays,
  }, removed });
  return removed;
}

function start(db, options = {}) {
  const intervalMs = Math.max(60_000, Number(options.intervalMs || config.operations.retentionIntervalMs));
  const run = () => {
    try { apply(db, options); }
    catch (error) {
      checkpoints.record(db, 'retention.policy', 'FAIL', { error: error.message });
      monitoring.raise(db, { severity: 'ERROR', kind: 'retention.failed',
        title: 'StockChief retention cleanup failed', detail: error.message, fingerprint: 'retention.failed' });
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  if (options.runOnStart !== false) setImmediate(run);
  return () => clearInterval(timer);
}

module.exports = { DAY, isoBefore, apply, start };
