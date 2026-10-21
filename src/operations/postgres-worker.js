'use strict';

const os = require('node:os');
const crypto = require('node:crypto');
const jobs = require('./postgres-job-queue');

function startSingle(database, options = {}) {
  const owner = options.owner || `${process.pid}@${os.hostname()}:${crypto.randomUUID()}`;
  const interval = options.intervalMs ?? 1000;
  if (!Number.isSafeInteger(interval) || interval < 10) throw new TypeError('Worker interval must be at least ten milliseconds.');
  let stopped = false;
  let timer;
  let active = null;
  let wakeRequested=false;
  const tick = async () => {
    if (stopped || active) return;
    active = (async()=>{
      if(options.shouldClaim&&!await options.shouldClaim())return;
      return jobs.processOne(database, options.handlers || {}, { owner, leaseMs: options.leaseMs ?? 60000 });
    })();
    try { await active; }
    catch (error) {
      if (options.onError) options.onError(error);
      else console.error('[stockchief] PostgreSQL worker failed: %s', error.code || 'worker_error');
    } finally {
      active = null;
      if (!stopped) {
        timer = setTimeout(tick, wakeRequested?0:interval);wakeRequested=false;
        timer.unref();
      }
    }
  };
  tick();
  return { owner, wake:()=>{
    if(stopped)return;clearTimeout(timer);
    if(active)wakeRequested=true;else tick();
  }, stop: async () => {
    stopped = true;
    clearTimeout(timer);
    if (active) await active.catch(() => {});
  } };
}

function start(database, options = {}) {
  const groups = new Map();
  for (const [kind,handler] of Object.entries(options.handlers || {})) {
    if (typeof handler !== 'function') continue;
    const lane = handler.workerLane || 'default';
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(lane)) throw new TypeError('Invalid worker execution lane.');
    if (!groups.has(lane)) groups.set(lane, {});
    groups.get(lane)[kind] = handler;
  }
  if (groups.size <= 1) return startSingle(database, options);
  if (groups.size > 4) throw new TypeError('A worker may use at most four bounded execution lanes.');
  const owner = options.owner || `${process.pid}@${os.hostname()}:${crypto.randomUUID()}`;
  // Each lane retains one in-flight job and uses the same durable claims and
  // leases. A bulk transaction must not occupy routine synchronization's slot.
  const lanes = [...groups].map(([lane,handlers]) => startSingle(database,
    {...options, owner: `${owner}:${lane}`, handlers}));
  return {owner, wake: () => lanes.forEach(lane => lane.wake()),
    stop: async () => { await Promise.all(lanes.map(lane => lane.stop())); }};
}

module.exports = { start };
