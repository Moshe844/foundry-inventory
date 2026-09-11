'use strict';

const os = require('node:os');
const config = require('../config');
const jobs = require('./job-queue');
const outbox = require('./outbox');
const email = require('./email');
const monitoring = require('./monitoring');

function dispatchers(db, options = {}) {
  return {
    email: email.dispatcher({ db, ...(options.email || {}) }),
    'monitoring.webhook': monitoring.webhookDispatcher(db, options.monitoring || {}),
    'outbound.webhook': require('../connections/outbound-webhooks').dispatcher(db, options.webhooks || {}),
    ...(options.dispatchers || {}),
  };
}

function start(db, options = {}) {
  const intervalMs = Math.max(100, Number(options.intervalMs || config.operations.pollIntervalMs));
  const leaseMs = Math.max(5000, Number(options.leaseMs || config.operations.leaseMs));
  const owner = options.owner || `${process.pid}@${os.hostname()}:runtime`;
  const handlers = options.handlers || {};
  const outbound = dispatchers(db, options);
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return null;
    running = true;
    try {
      const recoveredJobs = jobs.recoverExpired(db);
      const recoveredMessages = outbox.recoverExpired(db);
      const job = await jobs.processOne(db, handlers, { owner, leaseMs });
      const message = await outbox.processOne(db, outbound, { owner, leaseMs });
      if (job && job.status === 'DEAD') {
        monitoring.raise(db, { severity: 'ERROR', kind: 'job.dead', title: 'A background job needs review',
          detail: `${job.kind} exhausted ${job.attemptCount} attempts.`, fingerprint: `job.dead:${job.id}` });
      }
      if (message && message.status === 'DEAD' && message.destination !== 'monitoring.webhook') {
        if (message.destination === 'outbound.webhook') {
          db.prepare(`UPDATE outbound_webhook_deliveries SET status = 'DEAD',
            last_error = COALESCE(?, last_error) WHERE outbox_message_id = ?`)
            .run(message.lastError || 'Delivery attempts exhausted.', message.id);
        }
        monitoring.raise(db, { severity: 'ERROR', kind: 'outbox.dead', title: 'An external message needs review',
          detail: `${message.messageType} could not be delivered.`, fingerprint: `outbox.dead:${message.id}` });
      }
      return { recoveredJobs, recoveredMessages, job, message };
    } finally { running = false; }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  if (options.runOnStart !== false) setImmediate(() => { void tick(); });
  return { tick, stop() { stopped = true; clearInterval(timer); } };
}

module.exports = { dispatchers, start };
