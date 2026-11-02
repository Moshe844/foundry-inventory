'use strict';

const os = require('node:os');
const crypto = require('node:crypto');
const jobs = require('./postgres-job-queue');

function maintenanceOptions(database, options, bulkKinds) {
  const interval = options.maintenanceBulkIntervalMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 10 || interval > 60000) throw new TypeError('Maintenance bulk interval must be between ten milliseconds and one minute.');
  let nextBatchAt = 0;
  const handlers = Object.fromEntries(Object.entries(options.handlers).filter(([,handler])=>typeof handler==='function').map(([kind, handler]) => [kind,
    Object.assign(async (...args) => {
      try { return await handler(...args); }
      finally { nextBatchAt = performance.now() + interval; }
    }, handler)]));
  return {...options, handlers, shouldClaim: async () => {
    if (options.shouldClaim && !await options.shouldClaim()) return false;
    if (performance.now() >= nextBatchAt) return true;
    // Yield between committed maintenance batches while a live bulk worker is
    // using the database. No job is claimed or retried during this short wait;
    // routine work retains its own lane, and maintenance resumes immediately
    // once bulk work ends. Repeated wake signals cannot bypass the budget.
    const active = await database.query(`SELECT 1 FROM stockchief_runtime.jobs
      WHERE status='RUNNING' AND kind=ANY($1::text[])
      AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)
      LIMIT 1`, [bulkKinds]);
    return !active.rows.length;
  }};
}

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
  const concurrency=options.concurrency??1;
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new TypeError('Worker concurrency must be between one and eight.');
  const groups = new Map();
  for (const [kind,handler] of Object.entries(options.handlers || {})) {
    if (typeof handler !== 'function') continue;
    const lane = handler.workerLane || 'default';
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(lane)) throw new TypeError('Invalid worker execution lane.');
    if (!groups.has(lane)) groups.set(lane, {});
    groups.get(lane)[kind] = handler;
  }
  const bulkKinds = [...new Set(['import.execute-approved', 'erp.cutover.continue', ...Object.keys(groups.get('bulk') || {})])];
  if (groups.size <= 1) {
    const settings=groups.has('maintenance')?maintenanceOptions(database,options,bulkKinds):options;
    if(concurrency===1)return startSingle(database,settings);
    if(groups.has('maintenance'))throw new TypeError('Maintenance retains one bounded execution slot.');
    const owner=options.owner||`${process.pid}@${os.hostname()}:${crypto.randomUUID()}`;
    const workers=Array.from({length:concurrency},(_,n)=>startSingle(database,{...settings,owner:`${owner}:${n}`}));
    return {owner,wake:()=>workers.forEach(worker=>worker.wake()),stop:()=>Promise.all(workers.map(worker=>worker.stop()))};
  }
  if(concurrency!==1)throw new TypeError('Configure concurrency only for a single execution lane.');
  if (groups.size > 4) throw new TypeError('A worker may use at most four bounded execution lanes.');
  const owner = options.owner || `${process.pid}@${os.hostname()}:${crypto.randomUUID()}`;
  // Each lane retains one in-flight job and uses the same durable claims and
  // leases. A bulk transaction must not occupy routine synchronization's slot.
  const lanes = [...groups].map(([lane,handlers]) => {
    const settings = {...options, owner: `${owner}:${lane}`, handlers};
    return startSingle(database, lane==='maintenance' ? maintenanceOptions(database, settings, bulkKinds) : settings);
  });
  return {owner, wake: () => lanes.forEach(lane => lane.wake()),
    stop: async () => { await Promise.all(lanes.map(lane => lane.stop())); }};
}

module.exports = { start };
