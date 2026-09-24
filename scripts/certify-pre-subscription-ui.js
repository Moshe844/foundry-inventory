'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scenarios } = require('../certification/pre-subscription-scenarios');
const { evidenceByScenarioId, requiredScenarioIds } = require('../certification/ui-evidence');

const root = path.resolve(__dirname, '..');
const resultsDirectory = path.join(root, 'certification', 'results');
const logPath = path.join(resultsDirectory, 'ui-first-evidence.log');
const reportPath = path.join(resultsDirectory, 'ui-first-certification.md');
const jsonPath = path.join(resultsDirectory, 'ui-first-certification.json');

function strip(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '').replaceAll('\r', '');
}

function quote(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function main() {
  fs.mkdirSync(resultsDirectory, { recursive: true });
  const files = [...new Set([...evidenceByScenarioId.values()].flat().map((entry) => entry.file))].sort();
  const reportOnly = process.argv.includes('--report-only');
  const child = reportOnly ? null : spawnSync(process.execPath, [
    '-r', './tests/helpers/test-models.js', '--test', '--test-concurrency=1', ...files,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 45 * 60 * 1000,
  });
  const output = reportOnly
    ? strip(fs.readFileSync(logPath, 'utf8'))
    : strip(`${child.stdout || ''}\n${child.stderr || ''}`);
  if (!reportOnly) fs.writeFileSync(logPath, output);
  const browserCommandPassed = reportOnly
    ? !output.includes('\n✖ failing tests:')
    : child.status === 0;

  const rows = scenarios.filter((scenario) => requiredScenarioIds.has(scenario.id)).map((scenario) => {
    const evidence = evidenceByScenarioId.get(scenario.id) || [];
    const checks = evidence.map((entry) => ({
      ...entry,
      pass: output.includes(`✔ ${entry.title}`) && !output.includes(`✖ ${entry.title}`),
    }));
    return {
      id: scenario.id,
      name: scenario.name,
      pass: checks.length > 0 && checks.every((entry) => entry.pass),
      evidence: checks,
      missing: checks.length === 0,
    };
  });
  const passed = rows.filter((row) => row.pass).length;
  const lines = [
    '# StockChief UI-First Pre-Subscription Certification', '',
    `Generated: ${new Date().toISOString()}`, '',
    `**Required UI scenarios: ${passed}/${rows.length} passed.**`, '',
    `- Rendered Chromium suite: ${browserCommandPassed ? 'PASS' : 'FAIL'}`,
    `- Evidence source: ${reportOnly ? 'most recent saved browser run' : 'browser run executed for this report'}`,
    '- A scenario passes this gate only when it has named rendered-browser evidence.',
    '- Engine, HTTP, provider-contract, and direct database tests cannot satisfy this UI gate.', '',
    '| # | Scenario | Browser evidence | Status |',
    '|---:|---|---|:---:|',
  ];
  for (const row of rows) {
    const evidence = row.evidence.length
      ? row.evidence.map((entry) => `${entry.file}: ${entry.title}${entry.pass ? '' : ' (failed)'}`).join('; ')
      : 'No browser journey implemented.';
    lines.push(`| ${row.id} | ${quote(row.name)} | ${quote(evidence)} | ${row.pass ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('', '## Missing Browser Journeys', '');
  for (const row of rows.filter((entry) => !entry.pass)) {
    lines.push(`- Test ${row.id} — ${row.name}: ${row.missing ? 'no rendered-browser evidence exists' : 'mapped browser evidence failed'}.`);
  }
  fs.writeFileSync(reportPath, lines.join('\n'));
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    browserCommandPassed,
    passed,
    required: rows.length,
    rows,
  }, null, 2));
  process.stdout.write(`${passed}/${rows.length} required UI scenarios passed.\nReport: ${reportPath}\n`);
  if (!browserCommandPassed || passed !== rows.length) process.exitCode = 1;
}

main();
