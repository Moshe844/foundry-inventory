'use strict';
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { build } = require('../src/commercial/cost-scenarios');
function main() {
  const root = path.resolve(__dirname, '..');
  const inputs = { modelEvidence: 'docs/commercial-cost-measurements-2026-10-05.json',
    renderEvidence: 'data/commercial-render-cost-evidence-2026-10-05.json',
    emailEvidence: 'data/commercial-email-cost-evidence-2026-10-05.json' };
  const sources = {}; const evidence = {};
  for (const [key, relativePath] of Object.entries(inputs)) {
    const raw = fs.readFileSync(path.join(root, relativePath));
    sources[key] = { path: relativePath, sha256: crypto.createHash('sha256').update(raw).digest('hex') };
    evidence[key] = JSON.parse(raw);
  }
  const report = { generatedAt: new Date().toISOString(), sources, ...build(evidence) };
  const destination = path.join(root, 'data/commercial-cost-sensitivity-2026-10-05.json');
  fs.writeFileSync(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ destination, checkoutEnabled: false, finalPricesApproved: false,
    baseScenarios: report.scenarios.filter(row => row.loadMultiplier === 1 && row.hostingMultiplier === 1) }, null, 2));
}
if (require.main === module) main();
module.exports = { main };
