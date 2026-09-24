'use strict';

const os = require('node:os');
const crypto = require('node:crypto');
const jobs = require('./postgres-job-queue');

function start(database, options = {}) {
  const owner = options.owner || `${process.pid}@${os.hostname()}:${crypto.randomUUID()}`;
  const interval = options.intervalMs ?? 1000;
  if (!Number.isSafeInteger(interval) || interval < 10) throw new TypeError('Worker interval must be at least ten milliseconds.');
  let stopped = false;
  let timer;
  let active = null;
  const tick = async () => {
    if (stopped || active) return;
    active = jobs.processOne(database, options.handlers || {}, { owner, leaseMs: options.leaseMs ?? 60000 });
    try { await active; }
    catch (error) {
      if (options.onError) options.onError(error);
      else console.error('[stockchief] PostgreSQL worker failed: %s', error.code || 'worker_error');
    } finally {
      active = null;
      if (!stopped) {
        timer = setTimeout(tick, interval);
        timer.unref();
      }
    }
  };
  tick();
  return { owner, stop: async () => {
    stopped = true;
    clearTimeout(timer);
    if (active) await active.catch(() => {});
  } };
}

module.exports = { start };
