'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const config = require('../src/config');
const { openPostgres } = require('../src/db/postgres');
const checkpoints = require('../src/operations/postgres-checkpoints');
const suites = require('./browser-certification-suites');

function checkoutRelease() {
  const git = args => execFileSync('git', args, { cwd: config.rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let checkout;
  let hasGitCheckout = false;
  try { checkout = git(['rev-parse', 'HEAD']); hasGitCheckout = true; }
  catch {
    checkout = process.env.RENDER_GIT_COMMIT;
    if (!checkout) throw new Error('Browser certification needs a Git checkout or an immutable Render build.');
  }
  if (!/^[0-9a-f]{40}$/.test(checkout)) throw new Error('An exact commit is required for browser certification.');
  if (config.operations.releaseRef !== 'development' && config.operations.releaseRef !== checkout) {
    throw new Error('The configured release differs from the code under test.');
  }
  if (hasGitCheckout && git(['status', '--porcelain'])) {
    throw new Error('Commit the code and tests before certifying the release.');
  }
  return checkout;
}

function fixtureEnvironment(connectionString, release, live = false) {
  const osKeys = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'home', 'userprofile',
    'localappdata', 'appdata', 'programfiles', 'programfiles(x86)', 'temp', 'tmp', 'tmpdir', 'lang',
    'node_extra_ca_certs', 'playwright_browsers_path', 'stockchief_postgres_bin']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => osKeys.has(key.toLowerCase())));
  Object.assign(env, {
    NODE_ENV: 'test',
    FOUNDRY_SKIP_LOCAL_ENV: '1',
    FOUNDRY_RELEASE_REF: release,
    STOCKCHIEF_POSTGRES_FIXTURE_URL: connectionString,
  });
  if (live) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    env.STOCKCHIEF_ASK_LIVE_PROBE = '1';
  }
  return env;
}

function runSuite(files, env, concurrency) {
  const ca = process.execArgv.filter(arg => arg === '--use-system-ca');
  const result = spawnSync(process.execPath, [...ca, '--test', '--test-force-exit', '--test-reporter=tap',
    `--test-concurrency=${concurrency}`, ...files], {
    cwd: config.rootDir, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const summary = Object.fromEntries(Array.from(result.stdout?.matchAll(
    /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm,
  ) || [], ([, key, count]) => [key, Number(count)]));
  if (result.status !== 0 || !(summary.tests >= files.length) || summary.pass !== summary.tests
      || ['fail', 'cancelled', 'skipped', 'todo'].some(key => summary[key] !== 0)) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw result.error || new Error('Browser certification failed or did not run every required test. No passing evidence was recorded.');
  }
  return summary;
}

function validateEvidence(evidence, release) {
  const exactSuite = (have, expected) => JSON.stringify(have) === JSON.stringify(expected);
  const passed = (summary, files) => summary && Number.isSafeInteger(summary.tests) && summary.tests >= files.length
    && summary.tests === summary.pass && ['fail', 'cancelled', 'skipped', 'todo'].every(key => summary[key] === 0);
  const runs = evidence?.runs;
  if (evidence?.releaseRef !== release || evidence.engine !== 'postgresql' || evidence.fullSuite !== true
      || !Array.isArray(runs) || runs.length < 2 || evidence.consecutivePasses !== runs.length
      || !exactSuite(evidence.files, suites.browser) || !exactSuite(evidence.liveAiFiles, suites.liveAi)
      || new Set(runs.map(run => run.id)).size !== runs.length
      || !runs.every(run => run.id && passed(run.browser, suites.browser) && passed(run.liveAi, suites.liveAi))) {
    throw new Error('The evidence does not contain two complete PostgreSQL browser and live AI passes for the exact release.');
  }
}

async function recordEvidence(databaseUrl, evidence) {
  validateEvidence(evidence, checkoutRelease());
  const db = openPostgres(databaseUrl, { applicationName: 'stockchief-browser-certification', max: 1 });
  try { await checkpoints.record(db, 'browser.regression', 'PASS', evidence); }
  finally { await db.close(); }
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { 'evidence-file': { type: 'string' } },
    allowPositionals: true,
  });
  const count = Number(positionals[0] || 2);
  if (positionals.length > 1 || !Number.isSafeInteger(count) || count < 2) {
    throw new Error('Use at least two consecutive browser certification runs.');
  }
  if (!config.ai.configured) throw new Error('Browser certification requires the existing live AI test credential.');
  const releaseRef = checkoutRelease();
  const databaseUrl = process.env.FOUNDRY_DATABASE_URL || process.env.DATABASE_URL;
  const suppliedFixture = process.env.STOCKCHIEF_POSTGRES_FIXTURE_URL;
  const cluster = suppliedFixture ? null : await require('../tests/helpers/postgres-cluster')
    .startCluster({ maxLocksPerTransaction: 512 });
  const fixtureUrl = suppliedFixture || cluster.connectionString;
  const runs = [];
  try {
    for (let index = 1; index <= count; index++) {
      console.log(`PostgreSQL browser certification ${index}/${count}`);
      const browser = runSuite(suites.browser, fixtureEnvironment(fixtureUrl, releaseRef), 4);
      console.log(`Browser and service checks passed ${browser.pass}/${browser.tests}. Starting the live AI check.`);
      const liveAi = runSuite(suites.liveAi, fixtureEnvironment(fixtureUrl, releaseRef, true), 1);
      runs.push({ id: randomUUID(), browser, liveAi, completedAt: new Date().toISOString() });
      console.log(`Live AI checks passed ${liveAi.pass}/${liveAi.tests}.`);
    }
  } finally { await cluster?.stop(); }
  if (checkoutRelease() !== releaseRef) throw new Error('The checked-out release changed during certification.');
  const evidence = { releaseRef, engine: 'postgresql', fullSuite: true, consecutivePasses: runs.length,
    command: 'npm run certify:browser', files: suites.browser, liveAiFiles: suites.liveAi, runs };
  validateEvidence(evidence, releaseRef);
  if (values['evidence-file']) writeFileSync(values['evidence-file'], JSON.stringify(evidence, null, 2) + '\n');
  if (databaseUrl) {
    await recordEvidence(databaseUrl, evidence);
    console.log(`Recorded ${runs.length} complete browser passes in PostgreSQL for ${releaseRef}.`);
  } else {
    console.log(JSON.stringify(evidence));
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { recordEvidence, validateEvidence };
