'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateEvidence } = require('../../scripts/certify-browser-regression');
const suites = require('../../scripts/browser-certification-suites');

const release = 'e'.repeat(40);
function passingEvidence() {
  const summary = files => ({ tests: files.length, pass: files.length, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  return {
    releaseRef: release,
    engine: 'postgresql',
    fullSuite: true,
    consecutivePasses: 2,
    files: [...suites.browser],
    liveAiFiles: [...suites.liveAi],
    runs: ['one', 'two'].map(id => ({ id, browser: summary(suites.browser), liveAi: summary(suites.liveAi) })),
  };
}

test('browser evidence accepts two complete native runs for the exact release', () => {
  assert.doesNotThrow(() => validateEvidence(passingEvidence(), release));
});

test('browser evidence rejects foreign releases, partial suites, skipped live AI and duplicate runs', () => {
  const changes = [
    evidence => { evidence.releaseRef = 'a'.repeat(40); },
    evidence => { evidence.engine = 'sqlite'; },
    evidence => { evidence.files.pop(); },
    evidence => { evidence.runs.pop(); },
    evidence => { evidence.runs[1].liveAi.skipped = 1; },
    evidence => { evidence.runs[1].browser.pass--; },
    evidence => { evidence.runs[1].id = evidence.runs[0].id; },
  ];
  for (const change of changes) {
    const evidence = passingEvidence();
    change(evidence);
    assert.throws(() => validateEvidence(evidence, release), /two complete PostgreSQL browser and live AI passes/);
  }
});
