'use strict';

const config = require('../src/config');
const { openDatabase } = require('../src/db');
const checkpoints = require('../src/operations/checkpoints');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const url = String(arg('url') || '').replace(/\/$/, '');
const expectedRef = arg('expected-ref');
const provider = arg('provider');
const evidence = arg('evidence');
if (!/^https:\/\//.test(url) || !expectedRef || !provider || !evidence) {
  console.error('Usage: node scripts/verify-hosting-rollback.js --url https://... --expected-ref PREVIOUS_RELEASE --provider HOST --evidence TICKET_OR_LOG_URL');
  process.exit(2);
}

(async () => {
  const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (!response.ok || body.ok !== true || body.database !== 'available') {
    throw new Error(`Rolled-back service is not healthy (${response.status}).`);
  }
  if (body.releaseRef !== expectedRef) {
    throw new Error(`Expected release ${expectedRef}, but the service reports ${body.releaseRef || 'no release ref'}.`);
  }
  const db = openDatabase(config.databasePath);
  try {
    checkpoints.record(db, 'deployment.rollback', 'PASS', {
      hostingVerified: true, provider, expectedRef, evidence, url,
      schemaVersion: body.schemaVersion,
    });
  } finally { db.close(); }
  console.log(`Hosting rollback to ${expectedRef} is healthy and recorded.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });

