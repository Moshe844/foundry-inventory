'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {summarize}=require('../src/commercial/model-cost-distribution');
const root=path.resolve(__dirname,'..');const source=path.join(root,'data/commercial-real-cost-simulation.json');
const raw=fs.readFileSync(source);const report=summarize(JSON.parse(raw));
report.sourceSha256=crypto.createHash('sha256').update(raw).digest('hex');
const destination=path.join(root,'docs/commercial-model-cost-distribution-2026-10-05.json');
fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({destination,sourceSha256:report.sourceSha256,operations:report.operations},null,2));
