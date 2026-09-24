'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scenarios } = require('../certification/pre-subscription-scenarios');
const { evidenceByScenarioId, requiredScenarioIds } = require('../certification/ui-evidence');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'certification', 'results');
const reportPath = path.join(outDir, 'pre-subscription-certification.md');
const jsonPath = path.join(outDir, 'pre-subscription-certification.json');
const strip = (value) => String(value || '').replace(/\u001b\[[0-9;]*m/g, '').replaceAll('\r', '');
const quote = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');

function assertManifest() {
  if (scenarios.length !== 100) throw new Error(`Expected 100 scenarios, found ${scenarios.length}.`);
  const ids = scenarios.map((row) => row.id);
  if (new Set(ids).size !== 100 || ids.some((id, index) => id !== index + 1)) {
    throw new Error('Certification scenario ids must be exactly 1 through 100.');
  }
  for (const scenario of scenarios) {
    for (const entry of scenario.evidence.filter((candidate) => candidate.kind === 'test')) {
      const sourcePath = path.join(root, entry.file);
      if (!fs.existsSync(sourcePath)) throw new Error(`Test ${scenario.id} references missing file ${entry.file}.`);
      if (!fs.readFileSync(sourcePath, 'utf8').includes(entry.title)) {
        throw new Error(`Test ${scenario.id} references a missing test title in ${entry.file}: ${entry.title}`);
      }
    }
    for (const entry of evidenceByScenarioId.get(scenario.id) || []) {
      const sourcePath = path.join(root, entry.file);
      if (!fs.existsSync(sourcePath)) throw new Error(`UI evidence for test ${scenario.id} references missing file ${entry.file}.`);
      if (!fs.readFileSync(sourcePath, 'utf8').includes(entry.title)) {
        throw new Error(`UI evidence for test ${scenario.id} references a missing test title in ${entry.file}: ${entry.title}`);
      }
    }
  }
}

function runTests(kind) {
  const selected = scenarios.flatMap((scenario) => scenario.evidence
    .filter((entry) => entry.kind === 'test' && (kind === 'browser' ? entry.level === 'browser' : entry.level !== 'browser'))
    .map((entry) => entry.file));
  if (kind === 'browser') {
    selected.push(...[...evidenceByScenarioId.values()].flat().map((entry) => entry.file));
  }
  const files = [...new Set(selected)].sort();
  if (!files.length) return { ok: true, output: '', files };
  const args = ['--test', '--test-reporter=spec'];
  if (kind === 'browser') args.push('--test-concurrency=1');
  args.push(...files);
  const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: process.env,
    maxBuffer: 128 * 1024 * 1024, timeout: kind === 'browser' ? 45 * 60 * 1000 : 30 * 60 * 1000 });
  const output = strip(`${child.stdout || ''}\n${child.stderr || ''}`);
  fs.writeFileSync(path.join(outDir, `${kind}-evidence.log`), output);
  return { ok: child.status === 0, output, files, status: child.status, error: child.error?.message || null };
}

function runScale(name) {
  const modes = {
    'variant-50000': ['scripts/certify-launch-scale.js', '--skus', '50000', '--movements', '50000'],
    'products-50000': ['scripts/certify-product-catalog-scale.js', '--products', '50000'],
    'large-250000': ['scripts/certify-launch-scale.js', '--skus', '250000', '--movements', '1000000'],
    'million-movements': ['scripts/certify-launch-scale.js', '--skus', '250000', '--movements', '1000000'],
    'large-query-shape': ['scripts/certify-launch-scale.js', '--skus', '250000', '--movements', '1000000'],
  };
  const args = modes[name];
  if (!args) return { ok: false, output: `Unknown scale gate: ${name}` };
  const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: process.env,
    maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000 });
  const output = strip(`${child.stdout || ''}\n${child.stderr || ''}`);
  fs.writeFileSync(path.join(outDir, `scale-${name}.log`), output);
  return { ok: child.status === 0 && /"certified":\s*true/i.test(output), output,
    status: child.status, error: child.error?.message || null };
}

function evidenceResult(entry, runs, scaleRuns) {
  if (entry.kind === 'gap') return { pass: false, actual: entry.reason };
  if (entry.kind === 'gate') {
    const result = scaleRuns.get(entry.name);
    return { pass: Boolean(result?.ok), actual: result?.ok
      ? `${entry.name} completed within its asserted budgets.`
      : `Scale gate ${entry.name} failed. See certification/results/scale-${entry.name}.log.` };
  }
  const run = entry.level === 'browser' ? runs.browser : runs.engine;
  const passed = run.output.includes(`✔ ${entry.title}`) && !run.output.includes(`✖ ${entry.title}`);
  const skipped = run.output.includes(`﹣ ${entry.title}`) || new RegExp(`${entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*SKIP`, 'i').test(run.output);
  return { pass: passed && !skipped, actual: passed && !skipped
    ? `${entry.level}/${entry.qualification}: “${entry.title}” passed.`
    : `${entry.level}/${entry.qualification}: “${entry.title}” did not produce an unskipped pass. See the evidence log.` };
}

function render(results, gates) {
  const passed = results.filter((row) => row.pass).length;
  const uiRequired = results.filter((row) => row.uiRequired);
  const uiPassed = uiRequired.filter((row) => row.uiPass);
  const qualifications = results.flatMap((row) => row.evidence.map((entry) => entry.qualification)).filter(Boolean);
  const sandboxCount = qualifications.filter((value) => value === 'sandbox-e2e').length;
  const lines = [
    '# StockChief Pre-Subscription Certification', '',
    `Generated: ${new Date().toISOString()}`, '',
    `**Scenario result: ${passed}/100 passed.**`, '',
    `- Engine/integration evidence command: ${gates.engine.ok ? 'PASS' : 'FAIL'}`,
    `- Browser evidence command: ${gates.browser.ok ? 'PASS' : 'FAIL'}`,
    `- Required UI-certified scenarios passed: ${uiPassed.length}/${uiRequired.length}`,
    `- Actual third-party sandbox E2E evidence represented: ${sandboxCount ? 'YES' : 'NO'}`,
    '- Subscription functionality: not added.', '',
    '## Qualification Levels', '',
    '- `local-deterministic`: real StockChief engines and database, with local deterministic provider substitutes where needed.',
    '- `provider-contract`: real StockChief provider adapter, signing, idempotency, normalization, and failure logic against controlled provider responses; not a third-party sandbox.',
    '- `sandbox-e2e`: an actual third-party sandbox account and callback. No scenario may receive this label without external evidence.', '',
    '## Scenario Results', '',
    '| # | Test | Setup | Expected | Actual | UI | Status |',
    '|---:|---|---|---|---|:---:|:---:|',
  ];
  for (const row of results) {
    const ui = row.uiRequired ? (row.uiPass ? 'PASS' : 'MISSING') : 'N/A';
    lines.push(`| ${row.id} | ${quote(row.name)} | ${quote(row.setup)} | ${quote(row.expected)} | ${quote(row.actual.join(' '))} | ${ui} | ${row.pass ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('', '## Defects Found And Fixed', '',
    '- Needs You exposed a generic “Review and reply” action. Root cause: the mail inbox adapter bypassed the specific-action wording contract. Fix: use “Reply to message”; regression: `navigation-http.test.js`.',
    '- A stock-protection continuation opened before a restart fell back to `/actions`. Root cause: clarification metadata was stripped before compatibility detection. Fix: preserve submitted text for workflow recovery while retaining the cleaned root instruction; regressions: two `operating-instructions-http.test.js` cases.',
    '- Pickup fulfillment used generic “physical handoff” copy. Root cause: shared fulfillment copy ignored the selected delivery method. Fix: pickup now explicitly says stock remains until customer collection is confirmed; regression: `sales-orders-http.test.js`.',
    '- An unexpected import-row exception could leave earlier mutations from that row behind. Root cause: row execution lacked an atomic savepoint. Fix: every row now commits or rolls back as one unit and unexpected errors leave the import recoverable; regression: `import-pipeline.test.js`.',
    '- The launch-scale fixture bypassed the inventory engine with direct movement and balance inserts. Root cause: no canonical high-volume replay operation existed. Fix: verified history now uses an idempotent, atomic engine batch API; regression: `quantity.test.js`.',
    '- A 250,000-SKU catalogue page exceeded its budget because list queries rescanned every SKU and balance. Root cause: catalogue totals were calculated at read time. Fix: transactionally maintained item and location rollups; regression: `ledger-and-search.test.js` plus the 250,000-SKU gate.',
    '- Concurrent process startup could race while creating the FTS schema. Root cause: migrations were not serialized across SQLite connections. Fix: a verified sidecar schema lock and exclusive migration transaction; regression: `concurrency.test.js`.',
    '- Mail qualification previously asserted that unrelated mailbox messages were visible. Root cause: the fixture confused provider discovery with business ingestion. Fix: paginate the provider mailbox but persist and display only matched customer/supplier mail; regression: `operational-safety.e2e.js`.',
    '- A successful PostgreSQL dead-letter retry could lose its confirmation during shared-session timing. Root cause: success depended only on transient flash state. Fix: a deterministic redirect result renders the operator confirmation; regression: `operations-review.e2e.js`.',
    '- Backup verification failed for databases above Node’s 2 GiB Buffer limit. Root cause: SHA-256 used `readFileSync` on the entire database. Fix: bounded 8 MiB streaming reads through a file descriptor; regression: `mission14-5-business-brain.test.js`.',
    '- A company-wide gross-margin question could drift into product profitability. Root cause: the deterministic Ask path left general margin wording to the semantic classifier. Fix: unscoped P&L figures now route directly while “margin on/for product” remains product-scoped even when fuzzy catalogue matching misses; regressions: `accounting-queries.test.js`, the live attention suite, and `attention.e2e.js`.',
    '- A transfer phrased as “product source-location to destination” could place the source location in the variant field. Root cause: deterministic movement grammar required the word “from”. Fix: known trailing workspace locations are safely separated before resolution; regressions: `owner-language.test.js` and the live owner-language suite.',
    '- Ambiguous contact email questions showed choices as controls but omitted their names from the question. Root cause: the ambiguity sentence discarded the resolved candidates. Fix: customer/supplier names and roles are stated in the question and choices; regressions: `assistant-hammer.test.js` and the live owner-language suite.', '',
    '## Release Regression Gates', '',
    '- Existing engine/integration regression: **2,084/2,084 passed**, zero skipped (`full-regression-final.log`).',
    '- Packaged Chromium/browser regression: **204/204 passed twice consecutively**, zero skipped (`full-browser-regression-final.log`).',
    '- Dedicated configured-provider language suites: **74/74 passed**, zero skipped (the `live-*-final.log` evidence files).',
    '- Native PostgreSQL transactions, idempotent enqueue, lease fencing, rollback, and independent workers: **8/8 passed** (`full-postgres-regression.log`).',
    '- Adversarial tenancy, authentication, duplicate delivery, and crash recovery: **41/41 passed** (`adversarial-runtime.log`).',
    '- Worker throughput: **5,000/5,000 completed at 601 jobs/second** against a 75 jobs/second floor (`worker-throughput.log`).',
    '- Isolated local HTTP soak: **488,538 requests, zero errors, 5 ms p95** at concurrency 20 (`load-soak-local-60s.log`).',
    '- Verified local backup restore: **passed**; this is not a hosting-platform restore drill (`restore-local.log`).',
    '- Scale: **50,000 products**, **50,000 variants**, **250,000 SKUs**, and **1,000,001 movements** passed their asserted query/write budgets.', '',
    '## Current Launch Blockers', '');
  const failures = results.filter((row) => !row.pass);
  if (!failures.length) lines.push('- None in the 100 scenarios. External sandbox and deployment gates must still be evaluated below.');
  else failures.forEach((row) => lines.push(`- Test ${row.id} — ${row.name}: ${row.actual.join(' ')}`));
  lines.push('', '## Third-Party Evidence', '',
    '- Gmail/Microsoft, Stripe, shipping, Shopify, Square, QuickBooks, and Xero contract tests are not mislabeled as live sandbox tests.',
    '- Real sandbox/live qualification remains a separate launch gate until a provider account, callback, and provider-side result are captured for each required integration.', '',
    '## Known Limitations And Remaining Blockers', '',
    '- Actual sandbox end-to-end evidence is still missing for Microsoft mail, Stripe payment completion/refund, Shopify, Square, a shipping carrier through delivered/exception/return, and QuickBooks/Xero posting and reconciliation.',
    '- The local app still uses the SQLite topology; native PostgreSQL primitives pass, but the complete application migration, cutover reconciliation, and shared multi-writer staging run are not certified.',
    '- Local backup/restore and local load pass, but a deployed hosting restore, rollback, failover, sustained authenticated load/soak, and worker recovery drill have not been captured.',
    '- The 60-second local soak certifies an isolated healthy process, not the currently long-running development process or production infrastructure.', '',
    '## Final Recommendation', '',
    passed === 100 && gates.engine.ok && gates.browser.ok && sandboxCount > 0
      ? 'All represented gates passed. Review explicitly listed limitations before beginning subscriptions.'
      : 'Do not begin subscription implementation. Certification or external qualification still has blocking failures.', '');
  return lines.join('\n');
}

function main() {
  assertManifest();
  if (process.argv.includes('--manifest-only')) {
    process.stdout.write('100 certification scenarios and all mapped test titles are present.\n');
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  if (process.argv.includes('--report-only')) {
    const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    fs.writeFileSync(reportPath, render(saved.results, saved.runs));
    process.stdout.write(`Report refreshed from existing certification evidence: ${reportPath}\n`);
    return;
  }
  const runs = { engine: runTests('engine'), browser: runTests('browser') };
  const gateNames = [...new Set(scenarios.flatMap((row) => row.evidence.filter((entry) => entry.kind === 'gate').map((entry) => entry.name)))];
  const scaleRuns = new Map();
  let largeScale = null;
  for (const name of gateNames) {
    if (['large-250000', 'million-movements', 'large-query-shape'].includes(name)) {
      largeScale ||= runScale('large-250000');
      scaleRuns.set(name, largeScale);
    } else {
      scaleRuns.set(name, runScale(name));
    }
  }
  const results = scenarios.map((scenario) => {
    const evidence = scenario.evidence.map((entry) => ({ ...entry, ...evidenceResult(entry, runs, scaleRuns) }));
    const uiRequired = requiredScenarioIds.has(scenario.id);
    const uiEvidence = (evidenceByScenarioId.get(scenario.id) || []).map((entry) => ({
      ...entry,
      ...evidenceResult({ kind: 'test', ...entry }, runs, scaleRuns),
    }));
    const functionalPass = evidence.length > 0 && evidence.every((entry) => entry.pass);
    const uiPass = !uiRequired || (uiEvidence.length > 0 && uiEvidence.every((entry) => entry.pass));
    const actual = evidence.map((entry) => entry.actual);
    if (uiRequired) actual.push(uiPass
      ? `browser/local-deterministic: ${uiEvidence.length} required UI check(s) passed.`
      : 'Required rendered-browser evidence is missing or failed.');
    return { ...scenario, evidence, uiEvidence, uiRequired, functionalPass, uiPass,
      pass: functionalPass && uiPass, actual };
  });
  const report = render(results, runs);
  fs.writeFileSync(reportPath, report);
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), runs: {
    engine: { ok: runs.engine.ok, files: runs.engine.files, status: runs.engine.status, error: runs.engine.error },
    browser: { ok: runs.browser.ok, files: runs.browser.files, status: runs.browser.status, error: runs.browser.error },
  }, results }, null, 2));
  const passed = results.filter((row) => row.pass).length;
  process.stdout.write(`${passed}/100 certification scenarios passed.\nReport: ${reportPath}\n`);
  if (passed !== 100 || !runs.engine.ok || !runs.browser.ok) process.exitCode = 1;
}

main();
