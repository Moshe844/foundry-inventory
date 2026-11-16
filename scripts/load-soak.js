'use strict';

const config = require('../src/config');
const {setTimeout: delay} = require('node:timers/promises');
const { openDatabase } = require('../src/db');
const checkpoints = require('../src/operations/checkpoints');
const { openPostgres } = require('../src/db/postgres');
const postgresCheckpoints = require('../src/operations/postgres-checkpoints');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const base = String(argument('url', `http://127.0.0.1:${config.port}`)).replace(/\/$/, '');
const durationSeconds = Math.max(1, Number(argument('seconds', 900)));
const concurrency = Math.max(1, Math.min(200, Number(argument('concurrency', 20))));
const p95BudgetMs = Math.max(1, Number(argument('p95-ms', 750)));
const errorBudget = Math.max(0, Number(argument('error-rate', 0.005)));
const maxRps = Number(argument('max-rps', 0));
if (!Number.isFinite(maxRps) || maxRps < 0) throw new Error('--max-rps must be a nonnegative number.');
const requestIntervalMs = maxRps ? 1000 / maxRps : 0;
const suppliedCookie = String(process.env.FOUNDRY_LOAD_COOKIE || '').trim();
const endpointArgument = argument('paths', suppliedCookie
  ? '/,/inventory,/orders,/accounting'
  : '/healthz,/readyz,/room.css');
const endpoints = String(endpointArgument).split(',').map((value) => value.trim())
  .filter((value) => value.startsWith('/'));
if (!endpoints.length) throw new Error('At least one absolute --paths entry is required.');
const deadline = performance.now() + durationSeconds * 1000;
let nextRequestAt = performance.now();
const latencies = [];
const outcomes = Object.fromEntries(endpoints.map(path => [path, {requests: 0, statuses: {}}]));
const SAMPLE_LIMIT = 100_000;
let requests = 0;
let errors = 0;

async function client(offset) {
  let cursor = offset;
  // Authenticated runs reuse one dedicated staging cookie. Unauthenticated
  // probe/static runs intentionally create no browser session at all.
  const cookie = suppliedCookie;
  while (performance.now() < deadline) {
    if (requestIntervalMs) {
      const now = performance.now();
      const scheduled = Math.max(nextRequestAt, now);
      if (scheduled >= deadline) break;
      nextRequestAt = scheduled + requestIntervalMs;
      if (scheduled > now) await delay(scheduled - now);
      if (performance.now() >= deadline) break;
    }
    const path = endpoints[cursor % endpoints.length];
    const perPath = outcomes[path];
    const started = performance.now();
    let status;
    try {
      const response = await fetch(`${base}${path}`,
        { redirect: 'manual', signal: AbortSignal.timeout(10_000),
          headers: cookie ? { cookie } : {} });
      await response.arrayBuffer();
      status = String(response.status);
    } catch { status = 'failed_request'; }
    const latency = performance.now() - started;
    if (status === 'failed_request' || Number(status) >= 400) errors += 1;
    perPath.requests += 1;
    perPath.statuses[status] = (perPath.statuses[status] || 0) + 1;
    if (latencies.length < SAMPLE_LIMIT) latencies.push(latency);
    else {
      const replace = Math.floor(Math.random() * (requests + 1));
      if (replace < SAMPLE_LIMIT) latencies[replace] = latency;
    }
    requests += 1;
    cursor += 1;
  }
}

(async () => {
  await Promise.all(Array.from({ length: concurrency }, (_value, index) => client(index)));
  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] || 0;
  const errorRate = requests ? errors / requests : 1;
  const detail = {
    url: base, durationSeconds, concurrency, maxRps: maxRps || null, requests, errors, errorRate,
    endpoints, outcomes, authenticated: Boolean(suppliedCookie),
    p50Ms: Math.round(percentile(0.50)), p95Ms: Math.round(percentile(0.95)),
    p99Ms: Math.round(percentile(0.99)), p95BudgetMs, errorBudget,
    releaseRef: config.operations.releaseRef,
  };
  detail.budgetsPassed = detail.p95Ms <= p95BudgetMs && errorRate <= errorBudget;
  console.log(JSON.stringify(detail, null, 2));
  const connectionString=process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;
  if(connectionString){
    const database=openPostgres(connectionString,{applicationName:'stockchief-load-soak-evidence',max:2});
    try{await postgresCheckpoints.record(database,'load.soak',detail.budgetsPassed?'PASS':'FAIL',detail);}
    finally{await database.close();}
  }else{
    const db = openDatabase(config.databasePath);
    try { checkpoints.record(db, 'load.soak', detail.budgetsPassed ? 'PASS' : 'FAIL', detail); }
    finally { db.close(); }
  }
  if (!detail.budgetsPassed) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
