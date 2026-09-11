'use strict';

const config = require('../config');
const readiness = require('./readiness');
const { newId, nowIso } = require('../lib/util');

function run(db, options = {}) {
  const id = newId('cert');
  const startedAt = nowIso();
  const applicationRef = options.applicationRef || config.operations.releaseRef;
  const environment = options.environment || 'production';
  db.prepare(`INSERT INTO production_certification_runs
    (id, application_ref, environment, status, started_at, summary)
    VALUES (?, ?, ?, 'RUNNING', ?, '{}')`).run(id, applicationRef, environment, startedAt);
  const state = readiness.snapshot(db, { ...options, env: environment });
  const insert = db.prepare(`INSERT INTO production_certification_checks
    (id, run_id, check_key, status, evidence, checked_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const item of state.checks) {
    const status = item.status === 'PASS' ? 'PASS' : item.status === 'BLOCKED' ? 'BLOCKED' : 'SKIPPED';
    insert.run(newId('certcheck'), id, item.key, status,
      JSON.stringify({ message: item.message, ...item.evidence }), nowIso());
  }
  const completedAt = nowIso();
  db.prepare(`UPDATE production_certification_runs SET status = ?, completed_at = ?, summary = ? WHERE id = ?`)
    .run(state.ok ? 'PASSED' : 'FAILED', completedAt,
      JSON.stringify({ blockers: state.blockers, pass: state.checks.filter((row) => row.status === 'PASS').length,
        total: state.checks.length }), id);
  return { id, applicationRef, environment, status: state.ok ? 'PASSED' : 'FAILED', ...state };
}

module.exports = { run };
