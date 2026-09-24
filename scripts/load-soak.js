'use strict';

const config = require('../src/config');
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
const suppliedCookie = String(process.env.FOUNDRY_LOAD_COOKIE || '').trim();
const endpointArgument = argument('paths', suppliedCookie
  ? '/,/inventory,/orders,/accounting'
  : '/healthz,/readyz,/room.css');
const endpoints = String(endpointArgument).split(',').map((value) => value.trim())
  .filter((value) => value.startsWith('/'));
if (!endpoints.length) throw new Error('At least one absolute --paths entry is required.');
const deadline = Date.now() + durationSeconds * 1000;
const latencies = [];
const SAMPLE_LIMIT = 100_000;
let requests = 0;
let errors = 0;

async function client(offset) {
  let cursor = offset;
  // Authenticated runs reuse one dedicated staging cookie. Unauthenticated
  // probe/static runs intentionally create no browser session at all.
  const cookie = suppliedCookie;
  while (Date.now() < deadline) {
    const started = performance.now();
    try {
      const response = await fetch(`${base}${endpoints[cursor % endpoints.length]}`,
        { redirect: 'manual', signal: AbortSignal.timeout(10_000),
          headers: cookie ? { cookie } : {} });
      if (response.status >= 400) errors += 1;
      await response.arrayBuffer();
    } catch { errors += 1; }
    const latency = performance.now() - started;
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
    url: base, durationSeconds, concurrency, requests, errors, errorRate,
    endpoints, authenticated: Boolean(suppliedCookie),
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
